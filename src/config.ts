// Конфигурация двухуровневая (ARCHITECTURE.md §10):
// — хост: ~/.kan/config.json — только креды и пути;
// — борда: карточка «.pi-kan», JSON в описании — только политика.
// Секретов на борде нет: валидатор политики отвергает url/token*.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── хост ──

export interface HostConfig {
  url: string; // http://192.168.10.132:3000
  tokenFile: string; // путь к файлу API-токена (chmod 600)
  kanRoot: string; // ~/.kan
}

export function hostConfigPath(): string {
  return process.env.KAN_CONFIG ?? join(homedir(), ".kan", "config.json");
}

export function loadHostConfig(): HostConfig {
  const path = hostConfigPath();
  if (!existsSync(path)) {
    throw new Error(
      `нет конфига ${path} — выполни /kan init в pi (или создай вручную: { url, tokenFile, kanRoot })`,
    );
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<HostConfig>;
  if (!raw.url || !raw.tokenFile) {
    throw new Error(`${path}: обязательны url и tokenFile (секреты — только здесь)`);
  }
  return {
    url: process.env.KAN_URL ?? raw.url,
    tokenFile: process.env.KAN_TOKEN_FILE ?? raw.tokenFile,
    kanRoot: process.env.KAN_ROOT ?? raw.kanRoot ?? join(homedir(), ".kan"),
  };
}

export function readToken(host: HostConfig): string {
  const tok = readFileSync(host.tokenFile, "utf8").trim();
  if (!tok) throw new Error(`пустой токен в ${host.tokenFile}`);
  return tok;
}

// ── борда (политика из описания карточки .pi-kan) ──

export const CONFIG_CARD_TITLE = ".pi-kan";

export interface BoardConfig {
  lists: {
    backlog: string;
    ready: string;
    inProgress: string;
    review: string;
    done: string;
  };
  pollIntervalSec: number;
  maxConcurrent: number;
  wake: { model?: string | null; thinkingLevel?: string | null };
  events: {
    comments: boolean;
    descriptionEdits: boolean;
    checklistEdits: boolean;
    dueDate: boolean;
  };
  enabled: boolean;
  host: string | null; // кем мониториться (null = кто первый встал)
}

export interface ParsedBoardConfig {
  config: BoardConfig;
  warnings: string[];
}

const DEFAULTS = {
  pollIntervalSec: 60,
  maxConcurrent: 2,
  enabled: true,
  host: null as string | null,
};

// Секретные ключи недопустимы в политике борды
const SECRET_KEY_RE = /^(url|token|tokenfile|apikey)$/i;

function deepKeys(obj: unknown, prefix = ""): string[] {
  if (obj === null || typeof obj !== "object") return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out.push(prefix ? `${prefix}.${k}` : k);
    out.push(...deepKeys(v, prefix ? `${prefix}.${k}` : k));
  }
  return out;
}

/** Достаёт JSON из описания карточки: ```json-блок или голый объект. */
export function extractConfigJson(description: string | null): string | null {
  if (!description) return null;
  const fence = description.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  // WYSIWYG-редактор Kan пересохраняет ```json-блок как HTML
  // (<pre><code class="language-json">…</code></pre>) — учимся читать и так
  const html = extractFromHtml(description);
  if (html) return html;
  const trimmed = description.trim();
  return trimmed.startsWith("{") ? trimmed : null;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

function extractFromHtml(description: string): string | null {
  if (!description.includes("<")) return null;
  const blocks = [...description.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/g)].map((m) => m[1]);
  if (!blocks.length) blocks.push(description); // голый JSON в <p> и т.п.
  for (const block of blocks) {
    const text = block
      .replace(/<[^>]*>/g, "")
      .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code: string) => {
        if (code.startsWith("#x")) return String.fromCodePoint(parseInt(code.slice(1), 16));
        if (code.startsWith("#")) return String.fromCodePoint(parseInt(code.slice(1), 10));
        return ENTITIES[code.toLowerCase()] ?? m;
      })
      .trim();
    const start = text.indexOf("{");
    if (start < 0) continue;
    const candidate = text.slice(start);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      /* не наш блок */
    }
  }
  return null;
}

/**
 * Парсит и валидирует политику борды. Бросает Error с человекочитаемым
 * текстом (он пойдёт комментом-ошибкой в .pi-kan). Неизвестные ключи —
 * warning, не ошибка (обратная совместимость при расширении схемы).
 */
export function parseBoardConfig(description: string | null): ParsedBoardConfig {
  const jsonStr = extractConfigJson(description);
  if (!jsonStr) {
    throw new Error("в описании .pi-kan нет JSON-конфига (```json-блок или голый объект)");
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(jsonStr) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`JSON невалиден (недописан с телефона?): ${(e as Error).message}`);
  }

  const warnings: string[] = [];

  for (const key of deepKeys(raw)) {
    const leaf = key.split(".").pop() ?? key;
    if (SECRET_KEY_RE.test(leaf)) {
      throw new Error(`ключ «${key}» запрещён на борде — секреты и url живут в ~/.kan/config.json`);
    }
  }

  const lists = raw.lists as Record<string, string> | undefined;
  const need = ["backlog", "ready", "inProgress", "review", "done"] as const;
  if (!lists || need.some((k) => typeof lists[k] !== "string")) {
    throw new Error(`lists обязан содержать publicId'ы: ${need.join(", ")}`);
  }

  const knownTop = new Set(["lists", "pollIntervalSec", "maxConcurrent", "wake", "events", "enabled", "host"]);
  for (const k of Object.keys(raw)) {
    if (!knownTop.has(k)) warnings.push(`неизвестный ключ «${k}» — игнорируется (возможно, новая схема)`);
  }

  const wake = (raw.wake ?? {}) as Record<string, unknown>;
  const events = (raw.events ?? {}) as Record<string, unknown>;

  const poll = raw.pollIntervalSec ?? DEFAULTS.pollIntervalSec;
  const conc = raw.maxConcurrent ?? DEFAULTS.maxConcurrent;
  if (typeof poll !== "number" || poll < 10) throw new Error("pollIntervalSec — число ≥ 10");
  if (typeof conc !== "number" || conc < 1) throw new Error("maxConcurrent — число ≥ 1");

  const config: BoardConfig = {
    lists: Object.fromEntries(need.map((k) => [k, lists[k]])) as BoardConfig["lists"],
    pollIntervalSec: poll,
    maxConcurrent: conc,
    wake: {
      model: typeof wake.model === "string" ? wake.model : null,
      thinkingLevel: typeof wake.thinkingLevel === "string" ? wake.thinkingLevel : null,
    },
    events: {
      comments: events.comments !== false,
      descriptionEdits: events.descriptionEdits !== false,
      checklistEdits: events.checklistEdits !== false,
      dueDate: events.dueDate !== false,
    },
    enabled: raw.enabled !== false,
    host: typeof raw.host === "string" ? raw.host : DEFAULTS.host,
  };
  return { config, warnings };
}

/** Скелет политики для /kan init — руки JSON не пишут. */
export function configSkeleton(lists: BoardConfig["lists"]): string {
  return JSON.stringify(
    {
      lists,
      pollIntervalSec: DEFAULTS.pollIntervalSec,
      maxConcurrent: DEFAULTS.maxConcurrent,
      wake: { model: null, thinkingLevel: null },
      events: { comments: true, descriptionEdits: true, checklistEdits: true, dueDate: true },
      enabled: true,
      host: null,
    },
    null,
    2,
  );
}
