// Идентичности агентов: keeper = единственный регистратор личностей Kan.
// Ростер = каталог pi-агентов (~/.pi/agent/agents/*.md) + встроенные Agent/Keeper.
// Цепочка: инвайт почты → sign-up (пароль генерим и храним) → accept invite-link
// → api-key → ~/.secrets/kan-id-<имя> (600). Идемпотентно: есть токен — no-op;
// email уже участник — sign-in. Антиподделка: отказ зарезервированным именам
// (участники воркспейса, встроенные имена вне бутстрапа).
//
// Фундамент на стороне Kan: NEXT_PUBLIC_DISABLE_SIGN_UP=true — sign-up разрешён
// только заранее инвайченным почтам (хук user.create.before в kanbn/kan).
// Секреты живут только в ~/.secrets; на борду не попадают никогда.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KanClient, KanError } from "./kan-client.ts";
import type { HostConfig } from "./config.ts";

export const AGENTS_DOMAIN = "agents.local";
export const BUILTIN_NAMES = ["Agent", "Keeper"] as const;

export function secretsDir(): string {
  return process.env.KAN_SECRETS_DIR ?? join(homedir(), ".secrets");
}

export function agentsDir(): string {
  return process.env.KAN_AGENTS_DIR ?? join(homedir(), ".pi", "agent", "agents");
}

export function identityTokenPath(name: string): string {
  return join(secretsDir(), `kan-id-${name}`);
}

function passwordPath(name: string): string {
  return identityTokenPath(name) + ".pass";
}

export function hasIdentityToken(name: string): boolean {
  return existsSync(identityTokenPath(name));
}

export function readIdentityToken(name: string): string {
  const p = identityTokenPath(name);
  const tok = readFileSync(p, "utf8").trim();
  if (!tok) throw new Error(`пустой токен в ${p}`);
  return tok;
}

function writeSecret(path: string, value: string): void {
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function agentNamesFromCatalog(dir = agentsDir()): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f: string) => f.endsWith(".md"))
    .map((f: string) => f.slice(0, -3).trim())
    .filter((n: string) => n.length > 0);
}

// ── better-auth клиент (session-cookie; Bearer-сессия auth-эндпоинты не принимает) ──

class AuthClient {
  private baseUrl: string;
  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private async post(
    path: string,
    body: Record<string, unknown>,
    cookie?: string,
  ): Promise<{ data: Record<string, unknown> | undefined; cookie?: string }> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: this.baseUrl, // better-auth режет запросы без Origin (проверено живьём)
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const cookies = (res.headers as Headers).getSetCookie?.() ?? [];
    const session = cookies.map((c) => c.split(";")[0]).join("; ");
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`auth ${path} → ${res.status}: ${text.slice(0, 200)}`);
    }
    return { data: text ? (JSON.parse(text) as Record<string, unknown>) : undefined, cookie: session || undefined };
  }

  signUp(name: string, email: string, password: string) {
    return this.post("/api/auth/sign-up/email", { name, email, password });
  }
  signIn(email: string, password: string) {
    return this.post("/api/auth/sign-in/email", { email, password });
  }
  createApiKey(cookie: string, keyName: string) {
    return this.post("/api/auth/api-key/create", { name: keyName, prefix: "kan_" }, cookie);
  }
}

// ── регистратор ──

export interface ProvisionResult {
  name: string;
  status: "created" | "signed-in" | "skipped" | "refused" | "failed";
  detail?: string;
}

interface WorkspaceInfo {
  publicId: string;
  members: {
    publicId: string;
    email: string;
    role: string;
    status: string;
    user?: { id: string; name: string | null; email: string } | null;
  }[];
}

export class Registrar {
  private host: HostConfig;
  private kan: KanClient; // ключ регистратора: Keeper (если заведён), иначе legacy владелец
  private ownerKan: KanClient; // ключ владельца — только для бутстрапа Keeper
  private log: (msg: string) => void;
  private auth: AuthClient;
  private inviteCode: string | null = null;
  private ws: WorkspaceInfo | null = null;

  constructor(host: HostConfig, kan: KanClient, ownerKan: KanClient, log: (msg: string) => void) {
    this.host = host;
    this.kan = kan;
    this.ownerKan = ownerKan;
    this.log = log;
    this.auth = new AuthClient(host.url);
  }

  private async workspace(): Promise<WorkspaceInfo> {
    if (this.ws) return this.ws;
    const list = await this.kan.listWorkspaces();
    if (!list.length) throw new Error("нет ни одного воркспейса для ключа регистратора");
    this.ws = await this.kan.request<WorkspaceInfo>("GET", `/workspaces/${list[0].publicId}`);
    return this.ws;
  }

  /** Список участников меняется по ходу провижининга — после записи всегда освежать. */
  private refreshWorkspace(): Promise<WorkspaceInfo> {
    this.ws = null;
    return this.workspace();
  }

  /** Имя зарезервировано, если совпадает с участником воркспейса (name/email-local, без регистра). */
  async isReserved(name: string): Promise<boolean> {
    const ws = await this.workspace();
    const n = name.toLowerCase();
    return ws.members.some((m) => {
      const local = m.email.split("@")[0]?.toLowerCase();
      const uname = m.user?.name?.toLowerCase();
      return n === local || n === uname;
    });
  }

  private async inviteLinkCode(): Promise<string> {
    if (this.inviteCode) return this.inviteCode;
    const ws = await this.workspace();
    const r = await this.kan.request<{ inviteCode: string }>("POST", `/workspaces/${ws.publicId}/invites`, {});
    this.inviteCode = r.inviteCode;
    return this.inviteCode;
  }

  private async acceptInviteLink(cookie: string): Promise<void> {
    const code = await this.inviteLinkCode();
    const res = await fetch(`${this.host.url.replace(/\/$/, "")}/api/v1/invites/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: this.host.url, Cookie: cookie },
      body: JSON.stringify({ inviteCode: code }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text();
      // «already a member» — допустимо (путь sign-in)
      if (/already a member/i.test(text)) return;
      throw new Error(`accept invite → ${res.status}: ${text.slice(0, 200)}`);
    }
  }

  private async grantKeeperAdmin(): Promise<void> {
    const ws = await this.refreshWorkspace();
    const m = ws.members.find((x) => x.email.toLowerCase() === `keeper@${AGENTS_DOMAIN}` && x.status === "active");
    if (m && m.role !== "admin") {
      await this.ownerKan.request("PUT", `/workspaces/${ws.publicId}/members/${m.publicId}/role`, { role: "admin" });
      this.log(`identity: Keeper — админ воркспейса`);
    }
  }

  /** Убираем pending-строку email-инвайта: активное членство уже заведено акцептом. */
  private async dropInvitedRow(email: string): Promise<void> {
    const ws = await this.refreshWorkspace();
    for (const m of ws.members.filter((x) => x.email.toLowerCase() === email && x.status === "invited")) {
      try {
        await this.kan.request("DELETE", `/workspaces/${ws.publicId}/members/${m.publicId}`);
      } catch {
        /* мусор, не критично */
      }
    }
  }

  /** Провижининг одного имени. builtin=true — для Agent/Keeper (зарезервированность не проверяем). */
  async provision(name: string, builtin = false): Promise<ProvisionResult> {
    if (hasIdentityToken(name)) return { name, status: "skipped" };
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
      return { name, status: "refused", detail: "некорректное имя файла агента" };
    }
    if (!builtin) {
      if ((BUILTIN_NAMES as readonly string[]).includes(name)) {
        return { name, status: "refused", detail: "встроенное имя (агентский каталог не может его провижинить)" };
      }
      if (await this.isReserved(name)) {
        return { name, status: "refused", detail: "зарезервировано участником воркспейса (антиподделка)" };
      }
    }

    const email = `${name.toLowerCase()}@${AGENTS_DOMAIN}`;
    const ws = await this.workspace();

    // 1. инвайт почты (создаёт pending-инвайт, который пропускает sign-up при DISABLE_SIGN_UP)
    let alreadyMember = false;
    try {
      await this.kan.request("POST", `/workspaces/${ws.publicId}/members/invite`, { email });
    } catch (e) {
      const msg = e instanceof KanError ? e.message : String(e);
      if (/already a member/i.test(msg)) alreadyMember = true;
      else if (e instanceof KanError && e.status === 409) alreadyMember = true; // повторный инвайт тоже считаем «есть»
      else return { name, status: "failed", detail: `invite: ${msg}` };
    }

    // 2. пароль: генерим и сохраняем ДО sign-up, чтобы не потерять
    let password: string;
    if (existsSync(passwordPath(name))) {
      password = readFileSync(passwordPath(name), "utf8").trim();
    } else {
      password = randomBytes(24).toString("base64url");
      writeSecret(passwordPath(name), password);
    }

    // 3. sign-up, а если пользователь уже есть — sign-in сохранным паролем
    let cookie: string | undefined;
    let status: "created" | "signed-in" = "created";
    try {
      ({ cookie } = await this.auth.signUp(name, email, password));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/exist|taken|registered/i.test(msg)) {
        status = "signed-in";
        try {
          ({ cookie } = await this.auth.signIn(email, password));
        } catch (e2) {
          return { name, status: "failed", detail: `sign-up: ${msg}; sign-in: ${(e2 as Error).message}` };
        }
      } else {
        return { name, status: "failed", detail: `sign-up: ${msg}` };
      }
    }
    if (!cookie) return { name, status: "failed", detail: "нет session-cookie после auth" };

    // 4. акцепт invite-link (email-инвайт без почты акцептуется только так)
    if (!alreadyMember || status === "created") {
      try {
        await this.acceptInviteLink(cookie);
      } catch (e) {
        return { name, status: "failed", detail: `accept: ${(e as Error).message}` };
      }
      await this.dropInvitedRow(email);
    }

    // 5. api-key → токен
    let key: string | undefined;
    try {
      const { data } = await this.auth.createApiKey(cookie, "keeper-registrar");
      key = data?.key as string | undefined;
    } catch {
      /* ниже */
    }
    if (!key) return { name, status: "failed", detail: "api-key create: нет key в ответе" };
    writeSecret(identityTokenPath(name), key);
    if (name === "Keeper") await this.grantKeeperAdmin();
    this.log(`identity: ${name} → ${status} (${email})`);
    return { name, status };
  }
}

/**
 * Один проход регистратора: Agent, Keeper, затем все имена из каталога pi.
 * Быстрый путь: токены есть у всех — ни одного запроса к борде.
 */
export async function runRegistrar(
  host: HostConfig,
  ownerToken: string,
  log: (msg: string) => void,
  dir = agentsDir(),
): Promise<ProvisionResult[]> {
  const names = [...BUILTIN_NAMES, ...agentNamesFromCatalog(dir)];
  if (names.every(hasIdentityToken)) return [];

  const keeperToken = hasIdentityToken("Keeper") ? readIdentityToken("Keeper") : null;
  const registrar = new Registrar(
    host,
    new KanClient(host.url, keeperToken ?? ownerToken),
    new KanClient(host.url, ownerToken),
    log,
  );
  const out: ProvisionResult[] = [];
  for (const name of names) {
    try {
      out.push(await registrar.provision(name, (BUILTIN_NAMES as readonly string[]).includes(name)));
    } catch (e) {
      out.push({ name, status: "failed", detail: (e as Error).message });
    }
  }
  return out;
}

/** Токен для собственных записей хранителя: Keeper, если заведён, иначе legacy владелец. */
export function keeperWriteToken(host: HostConfig, ownerToken: string): string {
  return hasIdentityToken("Keeper") ? readIdentityToken("Keeper") : ownerToken;
}

/** Путь токена сессий (Agent), если заведён — wake передаёт его в KAN_TOKEN_FILE. */
export function sessionTokenFile(): string | null {
  return hasIdentityToken("Agent") ? identityTokenPath("Agent") : null;
}

