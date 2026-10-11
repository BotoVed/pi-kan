// Состояние хранителя: ~/.kan/state.json — снапшот-дельты + last-known-good
// конфиги + кэш publicId конфиг-карточек. Писается атомарно.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import type { BoardConfig } from "./config.ts";

export interface CardState {
  listId: string;
  index: number;
  descHash: string;
  commentIds: string[];
  checklistHash: string;
  dueDate: string | null;
  lastDueWake?: string; // ISO-дата, чтобы не будить дважды в день
  title?: string;
}

export interface BoardState {
  configCardPublicId?: string; // кэш: заголовок — лишь конвенция первого поиска
  lastKnownGood?: BoardConfig;
  configErrorHash?: string; // коммент-ошибка дедуплицируется по хэшу ошибки
  queueNoticeHash?: string; // «ждут слота» — не повторять, пока очередь не изменилась
  cards: Record<string, CardState>;
  pending?: Record<string, { type: string; listId: string; fromListId?: string; commentIds?: string[]; at: string }[]>;
}

export interface State {
  boards: Record<string, BoardState>;
}

export function statePath(kanRoot: string): string {
  return join(kanRoot, "state.json");
}

export function loadState(kanRoot: string): State {
  try {
    return JSON.parse(readFileSync(statePath(kanRoot), "utf8")) as State;
  } catch {
    return { boards: {} };
  }
}

export function saveState(kanRoot: string, state: State): void {
  const path = statePath(kanRoot);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

export function boardState(state: State, boardPublicId: string): BoardState {
  state.boards[boardPublicId] ??= { cards: {} };
  return state.boards[boardPublicId];
}

export function hash(text: string): string {
  // быстрый некриптографический djb2 — достаточно для diff'а
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return h.toString(36);
}

export function checklistHash(card: { checklists: { publicId: string; name?: string; items?: { publicId: string; content?: string; checked?: boolean }[] }[] }): string {
  const flat = (card.checklists ?? [])
    .map((cl) => `${cl.publicId}:${cl.name ?? ""}|${(cl.items ?? []).map((it) => `${it.publicId}:${it.checked ? 1 : 0}:${it.content ?? ""}`).join(",")}`)
    .join(";");
  return hash(flat);
}
