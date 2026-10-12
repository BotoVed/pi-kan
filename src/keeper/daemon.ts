// Keeper: цикл опрос → diff → очередь побудок → спавн сессий.
// Без LLM. Одна карточка — одна активная сессия; события при занятой сессии
// копятся в pending и сливаются в одно пробуждение.

import { hostname } from "node:os";
import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { KanClient, KanError, type KanActivity, type KanCard } from "../kan-client.ts";
import { loadHostConfig, readToken, parseBoardConfig, type BoardConfig } from "../config.ts";
import { runRegistrar, keeperWriteToken, AGENTS_DOMAIN } from "../identity.ts";
import { loadState, saveState, boardState, type State } from "../state.ts";
import { diffBoard, listName, type WakeEvent } from "./diff.ts";
import { wakeSession, activeLocks, readLock, killSession, clearLock, describeEvent, type WakeHandle } from "./wake.ts";
import { attachNewArtifacts } from "./artifacts.ts";

const TICK_MS = 15_000;

interface PendingEvent {
  type: string;
  listId: string;
  fromListId?: string;
  commentIds?: string[];
  at: string;
}

interface BoardRuntime {
  cfg: BoardConfig;
  nextPollAt: number;
  pending: Record<string, PendingEvent[]>; // cardPublicId → события, ждут слота
}

const runtimes = new Map<string, BoardRuntime>();
const handles = new Map<string, WakeHandle>(); // cardPublicId → живой ребёнок
let logFile = "";

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  process.stdout.write(line + "\n");
  if (logFile) {
    try {
      appendFileSync(logFile, line + "\n");
    } catch {
      /* лог не критичен */
    }
  }
}

/** Классифицирует новые комменты по activities: человек / job / агент. */
async function classifyComments(
  kan: KanClient,
  cardPublicId: string,
  newIds: string[],
): Promise<{ human: KanActivity[]; job: KanActivity[] }> {
  const human: KanActivity[] = [];
  const job: KanActivity[] = [];
  try {
    const { activities } = await kan.getActivities(cardPublicId, 30);
    const ids = new Set(newIds);
    for (const a of activities) {
      if (!a.type.includes("comment.added") || !a.comment || !ids.has(a.comment.publicId)) continue;
      const text = a.comment.comment;
      // Надёжный антицикл: автор из agents.local ⇒ машина (тег — legacy-страховка).
      if ((a.user?.email ?? "").toLowerCase().endsWith(`@${AGENTS_DOMAIN}`)) {
        if (text.includes("<!--kan:job")) job.push(a);
        continue;
      }
      if (text.includes("<!--kan:job")) job.push(a);
      else if (text.includes("<!--kan:agent")) continue; // агент — не будит
      else human.push(a);
    }
  } catch (e) {
    log(`activities failed for ${cardPublicId}: ${(e as Error).message}`);
  }
  return { human, job };
}

function eventPayload(
  kan: KanClient,
  boardName: string,
  card: KanCard,
  ev: PendingEvent,
  activities: KanActivity[],
  boardLists: (id: string) => string,
): Promise<string> {
  void kan;
  const base = describeEvent(
    { type: ev.type, card, listId: ev.listId, fromListId: ev.fromListId, commentIds: ev.commentIds },
    boardLists,
    activities,
  );
  return Promise.resolve(base);
}

async function tick(): Promise<void> {
  const host = loadHostConfig();
  const ownerToken = readToken(host);
  // Регистратор личностей: быстрый путь — только fs-stat (токены на месте → ноль запросов).
  try {
    for (const r of await runRegistrar(host, ownerToken, log)) {
      log(`identity ${r.name}: ${r.status}${r.detail ? ` — ${r.detail}` : ""}`);
    }
  } catch (e) {
    log(`identity registrar: ${(e as Error).message}`);
  }
  const kan = new KanClient(host.url, keeperWriteToken(host, ownerToken));
  const state: State = loadState(host.kanRoot);
  const me = hostname();
  const now = Date.now();

  // почистить завершённые хендлы
  for (const [cardId, h] of handles) {
    if (h.child.exitCode !== null) handles.delete(cardId);
  }

  const workspaces = await kan.listWorkspaces();
  for (const ws of workspaces) {
    const boards = await kan.listBoards(ws.publicId);
    for (const b of boards) {
      let board;
      try {
        board = await kan.getBoard(b.publicId);
      } catch (e) {
        if (e instanceof KanError && e.status === 404) {
          // борду удалили из Kan — вычёркиваем из состояния без шума
          delete state.boards[b.publicId];
          continue;
        }
        log(`board ${b.name}: ${(e as Error).message}`);
        continue;
      }

      const bs = boardState(state, b.publicId);

      // ── конфиг-карточка: подписка и политика ──
      let cfgDesc: string | null = null;
      for (const list of board.lists) {
        for (const card of list.cards) {
          if (card.publicId === bs.configCardPublicId || card.title.trim() === ".pi-kan") {
            cfgDesc = card.description;
            bs.configCardPublicId = card.publicId;
          }
        }
      }
      if (!bs.configCardPublicId) continue; // борда не подписана

      let cfg: BoardConfig;
      try {
        const parsed = parseBoardConfig(cfgDesc);
        cfg = parsed.config;
        bs.lastKnownGood = cfg;
        bs.configErrorHash = undefined;
        for (const w of parsed.warnings) log(`config warn ${b.name}: ${w}`);
      } catch (e) {
        const msg = (e as Error).message;
        const errHash = Buffer.from(msg).toString("base64url").slice(0, 16);
        if (!bs.lastKnownGood) {
          log(`board ${b.name}: конфиг нечитаем и last-known-good нет — пропуск`);
        }
        if (bs.configErrorHash !== errHash && bs.lastKnownGood) {
          try {
            await kan.addComment(
              bs.configCardPublicId!,
              `<!--kan:agent mode=keeper-->\n⚠️ Конфиг-карточка невалидна, применяю последний валидный.\nОшибка: ${msg}`,
            );
          } catch {
            /* борда не дала — хотя бы в лог */
          }
        }
        bs.configErrorHash = errHash;
        if (!bs.lastKnownGood) continue;
        cfg = bs.lastKnownGood;
        log(`board ${b.name}: конфиг невалиден (${msg}) — last-known-good`);
      }

      if (!cfg.enabled) continue;
      if (cfg.host && cfg.host !== me) continue;

      const rt: BoardRuntime = runtimes.get(b.publicId) ?? { cfg, nextPollAt: 0, pending: {} };
      rt.cfg = cfg;
      // pending переживает рестарт хранителя: перекладываем в состояние и обратно
      if (bs.pending) rt.pending = bs.pending;
      else bs.pending = rt.pending;
      runtimes.set(b.publicId, rt);

      if (now < rt.nextPollAt) continue;
      rt.nextPollAt = now + cfg.pollIntervalSec * 1000;

      // ── diff ──
      const diff = diffBoard(board, bs, cfg);

      for (const publicId of diff.archived) {
        if (killSession(host.kanRoot, publicId)) log(`archived → killed session ${publicId}`);
        clearLock(host.kanRoot, publicId);
        handles.delete(publicId);
        delete rt.pending[publicId];
      }
      for (const publicId of diff.doneClosed) {
        if (killSession(host.kanRoot, publicId)) log(`done → killed session ${publicId}`);
        handles.delete(publicId);
        delete rt.pending[publicId];
      }

      // ── события → pending (с фильтрацией агентских комментов) ──
      for (const ev of diff.events as WakeEvent[]) {
        const card = ev.card;
        if (ev.type === "comment") {
          const { human, job } = await classifyComments(kan, card.publicId, ev.commentIds ?? []);
          if (!human.length && !job.length) continue; // только агентские — не событие
          const acts = [...human, ...job];
          const type = job.length && !human.length ? "job" : "comment";
          push(rt.pending, card.publicId, {
            type,
            listId: ev.listId,
            commentIds: acts.map((a) => a.comment!.publicId),
            at: new Date().toISOString(),
          });
          pendingActivities.set(`${b.publicId}/${card.publicId}`, acts);
        } else {
          push(rt.pending, card.publicId, {
            type: ev.type,
            listId: ev.listId,
            fromListId: (ev as { fromListId?: string }).fromListId,
            at: new Date().toISOString(),
          });
        }
      }

      // ── слоты и побудки ──
      const live = activeLocks(host.kanRoot);
      let free = cfg.maxConcurrent - live.length;

      // уведомление о заторе — один раз на состав очереди
      const queued = Object.keys(rt.pending);
      if (queued.length && free <= 0) {
        const noticeHash = queued.sort().join(",").length.toString(36) + ":" + live.length;
        if (bs.queueNoticeHash !== noticeHash) {
          bs.queueNoticeHash = noticeHash;
          const first = board.lists
            .flatMap((l) => l.cards.map((c) => ({ l, c })))
            .find((x) => x.c.publicId === queued[0]);
          if (first) {
            try {
              await kan.addComment(
                first.c.publicId,
                `<!--kan:agent mode=keeper-->\n⏳ В очереди ждут слота: ${queued.length}. Занято: ${live
                  .map((l) => l.cardPublicId)
                  .join(", ")}.`,
              );
            } catch {
              /* не критично */
            }
          }
        }
      } else if (!queued.length) {
        bs.queueNoticeHash = undefined;
      }

      for (const cardId of Object.keys(rt.pending)) {
        if (free <= 0) break;
        if (readLock(host.kanRoot, cardId)) continue; // сессия жива (наша или осиротевшая)
        const card = findCard(board, cardId);
        if (!card) {
          delete rt.pending[cardId];
          continue;
        }
        const events = rt.pending[cardId];
        const acts = pendingActivities.get(`${b.publicId}/${cardId}`) ?? [];
        const payloads: string[] = [];
        for (const ev of events) {
          payloads.push(await eventPayload(kan, board.name, card, ev, acts, (id) => listName(board, id)));
        }
        const payload = payloads.join("\n\n---\n\n");
        try {
          const handle = await wakeSession(kan, { kanRoot: host.kanRoot, boardName: board.name, card, payload, cfg }, cfg.lists.inProgress);
          handles.set(cardId, handle);
          // наш собственный замок (move→inProgress) — не пользовательское событие:
          // отражаем его в состоянии, чтобы следующий diff не родил паразитный moved
          const cs = bs.cards[cardId];
          if (cs) cs.listId = cfg.lists.inProgress;
          delete rt.pending[cardId];
          pendingActivities.delete(`${b.publicId}/${cardId}`);
          free--;
          log(`woke ${board.name}/${card.title} (${cardId}) run=${handle.lock.runId} pid=${handle.lock.pid}`);
          handle.child.on("exit", (code) => {
            log(`session exited ${cardId} code=${code}`);
            // ЗАМОК НА СЕССИЮ: её итоговые записи (комменты, чек-лист, перемещение
            // на согласование) — не человеческие события. Забываем карточку из
            // кэша: следующий тик молча запомнит свежий снимок (событие — только
            // если карточка снова в ready). Без этого — автоцикл (аудит ME-6).
            delete bs.cards[cardId];
            // события, накопившиеся за время хода (почти всегда — собственные
            // записи сессии), не имеют права будить её же: сбрасываем очередь.
            delete rt.pending[cardId];
            handles.delete(cardId);
            clearLock(host.kanRoot, cardId);
            // свежие артефакты хода — на карточку вложениями (если Kan с бакетом)
            void attachNewArtifacts(kan, host.kanRoot, cardId, log).catch((e) =>
              log(`артефакты ${cardId}: ${(e as Error).message}`),
            );
          });
        } catch (e) {
          log(`wake FAILED ${board.name}/${card.title}: ${(e as Error).message}`);
          break; // борда больна — в следующий тик
        }
      }
    }
  }

  saveState(host.kanRoot, state);
}

// активности человеческих/job-комментов для payload (до следующего полла)
const pendingActivities = new Map<string, KanActivity[]>();

function push(pending: Record<string, PendingEvent[]>, cardId: string, ev: PendingEvent): void {
  (pending[cardId] ??= []).push(ev);
  if (pending[cardId].length > 20) pending[cardId].shift();
}

function findCard(board: { lists: { cards: KanCard[] }[] }, cardId: string): KanCard | null {
  for (const l of board.lists) for (const c of l.cards) if (c.publicId === cardId) return c;
  return null;
}

export async function runDaemon(): Promise<never> {
  const host = loadHostConfig();
  mkdirSync(join(host.kanRoot, "tasks"), { recursive: true });
  mkdirSync(join(host.kanRoot, "inbox"), { recursive: true });
  logFile = join(host.kanRoot, "keeper.log");
  log(`хранитель стартовал (host=${hostname()} url=${host.url})`);

  // осиротевшие замки (после рестарта хранителя) чистит readLock по pid

  const onSignal = (sig: string) => {
    log(`получен ${sig} — гасим детей и выходим`);
    for (const [, h] of handles) {
      try {
        process.kill(h.lock.pid, "SIGTERM");
      } catch {
        /* мёртв */
      }
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  for (;;) {
    try {
      await tick();
    } catch (e) {
      log(`tick error: ${(e as Error).stack ?? e}`);
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}
