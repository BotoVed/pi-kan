// Спавн сессий-задач: замок на борде, контракт пробуждения, lockfile, лимит
// одновременности. Одна карточка — одна активная сессия (lockfile по publicId).

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, openSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { KanClient, KanCard, KanActivity } from "../kan-client.ts";
import type { BoardConfig } from "../config.ts";
import { sessionTokenFile } from "../identity.ts";
import { runId } from "./diff.ts";

export interface LockInfo {
  runId: string;
  pid: number;
  cardPublicId: string;
  startedAt: string;
}

export function taskDir(kanRoot: string, cardPublicId: string): string {
  return join(kanRoot, "tasks", cardPublicId);
}

function lockPath(kanRoot: string, cardPublicId: string): string {
  return join(taskDir(kanRoot, cardPublicId), "lock.json");
}

export function readLock(kanRoot: string, cardPublicId: string): LockInfo | null {
  try {
    const lock = JSON.parse(readFileSync(lockPath(kanRoot, cardPublicId), "utf8")) as LockInfo;
    process.kill(lock.pid, 0); // мёртвый pid — протухший замок
    return lock;
  } catch {
    return null;
  }
}

export function clearLock(kanRoot: string, cardPublicId: string): void {
  rmSync(lockPath(kanRoot, cardPublicId), { force: true });
}

export function activeLocks(kanRoot: string): LockInfo[] {
  const dir = join(kanRoot, "tasks");
  if (!existsSync(dir)) return [];
  const out: LockInfo[] = [];
  for (const name of readdirSync(dir)) {
    const lock = readLock(kanRoot, name);
    if (lock) out.push(lock);
  }
  return out;
}

export function killSession(kanRoot: string, cardPublicId: string): boolean {
  const lock = readLock(kanRoot, cardPublicId);
  if (!lock) return false;
  try {
    process.kill(lock.pid, "SIGTERM");
  } catch {
    /* уже мёртв */
  }
  clearLock(kanRoot, cardPublicId);
  return true;
}

// ── контракт пробуждения ──

let contractCache: string | null = null;

export function wakeContract(): string {
  if (contractCache) return contractCache;
  // docs/WAKE-CONTRACT.md рядом с пакетом (src/keeper/ → ../../docs)
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "docs", "WAKE-CONTRACT.md"),
    join(here, "..", "..", "..", "docs", "WAKE-CONTRACT.md"), // dev: из установленного пакета
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      const md = readFileSync(path, "utf8");
      const fence = md.match(/## Шаблон\s*\n+```\n([\s\S]*?)\n```/);
      if (fence) {
        contractCache = fence[1];
        return contractCache;
      }
    }
  }
  throw new Error("docs/WAKE-CONTRACT.md не найден или не содержит блок «## Шаблон»");
}

// ── payload события ──

export function describeEvent(
  ev: { type: string; card: KanCard; listId: string; fromListId?: string; commentIds?: string[] },
  listName: (id: string) => string,
  activities: KanActivity[] = [],
): string {
  const card = `${ev.card.publicId} (ME-${ev.card.cardNumber ?? "?"})`;
  const where = listName(ev.listId);
  switch (ev.type) {
    case "ready":
      return `Событие: карточка ${card} вошла в список «${where}» — пора брать в работу.\n` +
        `Заголовок: ${ev.card.title}\nОписание:\n${ev.card.description?.trim() || "(пусто)"}`;
    case "comment": {
      const ids = new Set(ev.commentIds ?? []);
      const lines = activities
        .filter((a) => a.type.includes("comment.added") && a.comment && ids.has(a.comment.publicId))
        .map((a) => `  [${a.comment!.publicId}] ${a.user?.name ?? a.user?.email ?? "?"}: ${a.comment!.comment}`);
      return `Событие: новые комментарии человека к карточке ${card} («${ev.card.title}», список «${where}»):\n${lines.join("\n") || "  (текст не извлечён — перечитай карточку)"}`;
    }
    case "description":
      return `Событие: человек отредактировал описание карточки ${card} («${ev.card.title}», список «${where}»). Перечитай его и реагируй.`;
    case "checklist":
      return `Событие: изменён чек-лист карточки ${card} («${ev.card.title}», список «${where}»). Человек мог отметить пункт или задать новый — перечитай и продолжай.`;
    case "moved":
      return `Событие: карточка ${card} («${ev.card.title}») перемещена: «${listName(ev.fromListId!)}» → «${where}» (автор — человек; агентские перемещения хранитель фильтрует). Это директива — переосмысли статус и продолжай.`;
    case "due":
      return `Событие: у карточки ${card} («${ev.card.title}», список «${where}») наступил/просрочен срок (${ev.card.dueDate}). Если задача не готова — статус-коммент или вопрос человеку.`;
    default:
      return `Событие: ${ev.type} для карточки ${card}.`;
  }
}

// ── запуск ──

export interface WakeRequest {
  kanRoot: string;
  boardName: string;
  card: KanCard;
  payload: string; // уже описанное событие
  cfg: BoardConfig;
}

export interface WakeHandle {
  child: ChildProcess;
  lock: LockInfo;
  logPath: string;
}

/**
 * Замок (move→inProgress + коммент с тегом) — ДО спавна; коммент хранителя
 * содержит <!--kan:agent ...--> и потому сам себя не будит.
 */
export async function wakeSession(
  kan: KanClient,
  req: WakeRequest,
  inProgressListId: string,
): Promise<WakeHandle> {
  const { card, kanRoot } = req;
  const id = runId();
  const dir = taskDir(kanRoot, card.publicId);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(kanRoot, "inbox"), { recursive: true });

  // 1. Замок: в «в работе» + коммент-метка. Move ОБЯЗАТЕЛЕН: без него
  // состояние борды и кэш хранителя расходятся, а diff порождает фантомные
  // события (разбор цикла ME-6: move съел 429 и молча провалился).
  try {
    await kan.updateCard(card.publicId, { listPublicId: inProgressListId });
  } catch (e) {
    throw new Error(`wake aborted: move ${card.publicId}→inProgress failed: ${(e as Error).message}`);
  }
  await kan.addComment(
    card.publicId,
    `<!--kan:agent run=${id} mode=keeper-->\nВзял в работу. Пробуждение ${id}: ${req.payload.split("\n")[0]}`,
  );

  // 2. Промпт = контракт + payload + подстановки
  const prompt = wakeContract()
    .replaceAll("{CARD_ID}", card.publicId)
    .replaceAll("{CARD_TITLE}", card.title)
    .replaceAll("{BOARD}", req.boardName)
    .replaceAll("{LIST}", "в работе")
    .replaceAll("{SESSION_ID}", `kan-${card.publicId}`)
    .replaceAll("{RUN_ID}", id)
    .replace("{EVENT_PAYLOAD}", req.payload);

  // 3. Спавн сессии. Флаги модели — только если заданы (null → дефолт pi).
  const args = ["-p", "--session-id", `kan-${card.publicId}`, "--name", card.title];
  if (req.cfg.wake.model) {
    const model = req.cfg.wake.thinkingLevel
      ? `${req.cfg.wake.model}:${req.cfg.wake.thinkingLevel}`
      : req.cfg.wake.model;
    args.push("--model", model);
  } else if (req.cfg.wake.thinkingLevel) {
    args.push("--model", `:${req.cfg.wake.thinkingLevel}`);
  }
  args.push(prompt);

  const logPath = join(dir, `wake-${id}.log`);
  writeFileSync(logPath, `=== wake ${id} ${new Date().toISOString()}\n${prompt}\n\n`);
  const logFd = openSync(logPath, "a"); // stdout+stderr сессии — в лог пробуждения
  // Идентичность сессии: MCP kan берёт Authorization из KAN_TOKEN_FILE
  // (shell-подстановка в mcp.json). Agent заведён — пишем от Agent,
  // нет — legacy ключ владельца (обратная совместимость).
  const agentToken = sessionTokenFile();
  const child = spawn("pi", args, {
    cwd: dir,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, KAN_TASK_DIR: dir, ...(agentToken ? { KAN_TOKEN_FILE: agentToken } : {}) },
  });
  // ENOENT (pi не в PATH хранителя) иначе глотается молча: pid=-1 и тишина
  child.on("error", (e) => {
    appendFileSync(logPath, `\n=== spawn error: ${e.message}\n`);
  });

  const lock: LockInfo = { runId: id, pid: child.pid ?? -1, cardPublicId: card.publicId, startedAt: new Date().toISOString() };
  writeFileSync(lockPath(kanRoot, card.publicId), JSON.stringify(lock, null, 2));

  return { child, lock, logPath };
}
