// Дифф снапшота борды против сохранённого состояния → события побудки.
// Матрица событий — ARCHITECTURE.md §4. Спящие списки (бэклог) не будят,
// но состояние для них ведём (иначе выход из бэклога = «перемещение из ниоткуда»).

import { createHash } from "node:crypto";
import type { KanBoard, KanCard } from "../kan-client.ts";
import type { BoardConfig } from "../config.ts";
import { CONFIG_CARD_TITLE } from "../config.ts";
import type { BoardState, CardState } from "../state.ts";
import { hash, checklistHash } from "../state.ts";

export type WakeEvent =
  | { type: "ready"; card: KanCard; listId: string }
  | { type: "comment"; card: KanCard; listId: string; commentIds: string[] }
  | { type: "description"; card: KanCard; listId: string }
  | { type: "checklist"; card: KanCard; listId: string }
  | { type: "moved"; card: KanCard; listId: string; fromListId: string }
  | { type: "due"; card: KanCard; listId: string };

export interface DiffResult {
  events: WakeEvent[];
  configCard: KanCard | null;
  configCardListId: string | null;
  archived: string[]; // publicId'ы исчезнувших карточек (стоп-сигнал)
  doneClosed: string[]; // карточки в done (закрыть сессию)
}

export function findConfigCard(board: KanBoard, cachedPublicId?: string): { card: KanCard; listId: string } | null {
  for (const list of board.lists) {
    for (const card of list.cards) {
      if (card.publicId === cachedPublicId || card.title.trim() === CONFIG_CARD_TITLE) {
        return { card, listId: list.publicId };
      }
    }
  }
  return null;
}

function cardState(card: KanCard, listId: string): CardState {
  return {
    listId,
    index: card.index,
    descHash: hash(card.description ?? ""),
    commentIds: (card.comments ?? []).map((c) => c.publicId),
    checklistHash: checklistHash(card),
    dueDate: card.dueDate,
    title: card.title,
  };
}

/**
 * Сравнивает снапшот с bs.cards, ОБНОВЛЯЕТ bs.cards под снапшот и возвращает
 * события. knownAgentCommentIds — комменты, которые написал сам хранитель
 * (свои замки/уведомления): они не будят.
 */
export function diffBoard(
  board: KanBoard,
  bs: BoardState,
  cfg: BoardConfig,
  knownOwnCommentIds: Set<string> = new Set(),
): DiffResult {
  const events: WakeEvent[] = [];
  const seen = new Set<string>();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  const cfgCard = findConfigCard(board, bs.configCardPublicId);
  if (cfgCard) bs.configCardPublicId = cfgCard.card.publicId;

  const listById = new Map(board.lists.map((l) => [l.publicId, l.name]));
  const isBacklog = (id: string) => id === cfg.lists.backlog;
  const isDone = (id: string) => id === cfg.lists.done;

  // Хранитель следит ТОЛЬКО за пятью списками из cfg.lists. Всё остальное
  // (архивы, «входящие», любые папки вне конфига) — не существует: ни событий,
  // ни состояния. Уход отслеживаемой карточки в такой список = исчезновение из
  // снапшота = стоп-сигнал (archived): сессия убивается, но не будится.
  const watched = new Set<string>(Object.values(cfg.lists));

  for (const list of board.lists) {
    if (!watched.has(list.publicId)) continue;
    for (const card of list.cards) {
      seen.add(card.publicId);
  const isConfigCard = cfgCard?.card.publicId === card.publicId;
      const prev = bs.cards[card.publicId];
      const next = cardState(card, list.publicId);

      if (!prev) {
        // Первая встреча карточки: будим только если она сразу в ready
        // (создана/брошена в очередь между поллами). Иначе — молча запоминаем.
        if (!isConfigCard && list.publicId === cfg.lists.ready) {
          events.push({ type: "ready", card, listId: list.publicId });
        }
        bs.cards[card.publicId] = next;
        continue;
      }

      const moved = prev.listId !== next.listId;
      const newComments = next.commentIds.filter(
        (id) => !prev.commentIds.includes(id) && !knownOwnCommentIds.has(id),
      );

      // Спящие списки: событие только если КАРТОЧКА СЕЙЧАС спит (выход
      // из бэклога в ready — как раз событие, а не дремота). Перемещения в
      // НЕотслеживаемые списки (архив) сюда не доходят: они не в снапшоте,
      // и видны как исчезновение → стоп-сигнал.
      const dormant = isConfigCard || isBacklog(next.listId) || isDone(next.listId);

      if (!dormant) {
        if (moved && next.listId === cfg.lists.ready) {
          events.push({ type: "ready", card, listId: list.publicId });
        } else if (moved && next.listId === cfg.lists.review) {
          // «на согласовании» — зона человека: вход туда НЕ событие (иначе
          // собственный итог-ход сессии будит её же — автоцикл, аудит ME-6)
        } else if (moved) {
          // перемещение юзера между рабочими списками (не в ready/review) —
          // событие moved; выход из бэклога в рабочий список — «оживление»
          events.push({ type: "moved", card, listId: list.publicId, fromListId: prev.listId });
        } else if (newComments.length && cfg.events.comments) {
          events.push({ type: "comment", card, listId: list.publicId, commentIds: newComments });
        } else if (
          prev.descHash !== next.descHash &&
          cfg.events.descriptionEdits &&
          !isBacklog(prev.listId)
        ) {
          events.push({ type: "description", card, listId: list.publicId });
        } else if (prev.checklistHash !== next.checklistHash && cfg.events.checklistEdits) {
          events.push({ type: "checklist", card, listId: list.publicId });
        }
      }

      // dueDate: сегодня/просрочено, не чаще раза в день, не в спящих списках
      if (
        cfg.events.dueDate &&
        !dormant &&
        next.dueDate &&
        new Date(next.dueDate) <= now &&
        prev.lastDueWake !== today &&
        prev.dueDate === next.dueDate
      ) {
        next.lastDueWake = today;
        events.push({ type: "due", card, listId: list.publicId });
      }
      if (prev.lastDueWake === today) next.lastDueWake = today;

      bs.cards[card.publicId] = next;
      void listById;
    }
  }

  // Исчезли из снапшота = архивация/удаление → стоп-сигнал
  const archived: string[] = [];
  const doneClosed: string[] = [];
  for (const publicId of Object.keys(bs.cards)) {
    if (seen.has(publicId)) continue;
    const st = bs.cards[publicId];
    if (st.listId === cfg.lists.done) doneClosed.push(publicId);
    else archived.push(publicId);
    delete bs.cards[publicId];
  }

  return {
    events,
    configCard: cfgCard?.card ?? null,
    configCardListId: cfgCard?.listId ?? null,
    archived,
    doneClosed,
  };
}

export function listName(board: KanBoard, listId: string): string {
  return board.lists.find((l) => l.publicId === listId)?.name ?? listId;
}

export function runId(): string {
  return createHash("sha1").update(`${Date.now()}-${Math.random()}`).digest("hex").slice(0, 12);
}
