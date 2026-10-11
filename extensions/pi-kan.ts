// Расширение pi: /kan init|status + мандат-гард.
// Самая опасная часть системы — право молчать. Гард блокирует агентские
// записи, выходящие за мандат: трогать .pi-kan, двигать в «завершены»/архив.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { KanClient } from "../src/kan-client.ts";
import {
  loadHostConfig,
  readToken,
  configSkeleton,
  CONFIG_CARD_TITLE,
  hostConfigPath,
} from "../src/config.ts";
import { loadState } from "../src/state.ts";

const KAN_TOOL_RE = /^mcp__kan__|update_card|delete_card|create_card|add_card_comment|archive/i;

export default function (pi: ExtensionAPI) {
  // ── мандат-гард ──
  // Публичные id защищённых карточек читаются из ~/.kan/state.json на каждый
  // вызов (дёшево, всегда свежо после полла хранителя).
  pi.on("tool_call", async (event) => {
    const name = String(event.toolName ?? "");
    if (!KAN_TOOL_RE.test(name)) return;
    const input = (event as { input?: Record<string, unknown> }).input ?? {};

    let protectedIds: string[] = [];
    let doneIds: string[] = [];
    try {
      const host = loadHostConfig();
      const state = loadState(host.kanRoot);
      for (const bs of Object.values(state.boards)) {
        if (bs.configCardPublicId) protectedIds.push(bs.configCardPublicId);
        if (bs.lastKnownGood?.lists.done) doneIds.push(bs.lastKnownGood.lists.done);
      }
    } catch {
      return; // нет конфига — гард молчит (хранитель всё равно не подписан)
    }

    const cardId = String(input.cardPublicId ?? "");
    if (cardId && protectedIds.includes(cardId)) {
      return { block: true, reason: `Мандат: карточка-конфиг ${CONFIG_CARD_TITLE} неприкосновенна для агентов (move/edit/delete запрещены).` };
    }

    // движение в «завершены» — только человек (кроме случаев, когда id списка
    // не резолвится локально — тогда решает борда/человек)
    const targetList = String(input.listPublicId ?? "");
    if (targetList && doneIds.includes(targetList)) {
      return { block: true, reason: "Мандат: в «завершены» карточку перемещает только человек. Максимум для агента — «на согласовании»." };
    }
  });

  // ── /kan ──
  pi.registerCommand("kan", {
    description: "pi-kan: init | status — подписка борды Kan.bn на хранителя",
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/);
      try {
        if (sub === "init") await kanInit(rest.join(" "), ctx.ui.notify);
        else if (sub === "status") kanStatus(ctx.ui.notify);
        else ctx.ui.notify("использование: /kan init <имя борды> | /kan status", "info");
      } catch (e) {
        ctx.ui.notify(`/kan: ${(e as Error).message}`, "error");
      }
    },
  });
}

// экспортировано для неинтерактивного прогона (тесты, скрипты установки)
export async function kanInit(
  boardName: string,
  say: (m: string, t?: "info" | "warning" | "error") => void,
): Promise<void> {  if (!boardName) return say("укажи борду: /kan init <имя борды>", "warning");
  const host = loadHostConfig();
  const kan = new KanClient(host.url, readToken(host));

  // 1. ключ жив?
  const workspaces = await kan.listWorkspaces();
  say(`ключ принят, воркспейсов: ${workspaces.length}`, "info");

  // 2. найти борду
  let found: { publicId: string; name: string; ws: string } | null = null;
  for (const ws of workspaces) {
    for (const b of await kan.listBoards(ws.publicId)) {
      if (b.name.toLowerCase() === boardName.toLowerCase()) found = { ...b, ws: ws.publicId };
    }
  }
  if (!found) return say(`борда «${boardName}» не найдена`, "error");

  const board = await kan.getBoard(found.publicId);

  // 3. уже подписана?
  const statePath = join(host.kanRoot, "state.json");
  const existingConfigCard = board.lists
    .flatMap((l) => l.cards)
    .find((c) => c.title.trim() === CONFIG_CARD_TITLE);

  // 4. резолвим списки по именам (рус. конвенция борды)
  const byName = (re: RegExp) => board.lists.find((l) => re.test(l.name.trim()))?.publicId;
  const lists = {
    backlog: byName(/б[эе]клог|backlog/i),
    ready: byName(/к исполнению|ready|todo/i),
    inProgress: byName(/в работе|progress/i),
    review: byName(/согласован|review/i),
    done: byName(/заверш|done/i),
  };
  const missing = Object.entries(lists).filter(([, v]) => !v);
  // недостающие списки создаём (кроме бэклога — без него некуда класть конфиг-карточку)
  for (const [key, _] of missing) {
    const name = { backlog: "бэклог", ready: "к исполнению", inProgress: "в работе", review: "на согласовании", done: "завершены" }[key]!;
    try {
      const l = await kan.createList({ boardPublicId: found.publicId, name });
      (lists as Record<string, string>)[key] = l.publicId;
      say(`создал список «${name}» (${l.publicId})`, "info");
    } catch (e) {
      return say(`не смог создать список «${name}»: ${(e as Error).message}`, "error");
    }
  }

  const skeletonDesc =
    "```json\n" +
    configSkeleton(lists as never) +
    "\n```\nСлужебная карточка pi-kan: политика хранителя этой борды. Агенту трогать нельзя. Удалишь — борда отпишется от хранителя.";

  if (existingConfigCard) {
    if (!existingConfigCard.description?.includes("{")) {
      // карточка-заготовка без конфига — дозаполняем скелетом
      await kan.updateCard(existingConfigCard.publicId, { description: skeletonDesc });
      say(`заполнил пустую ${CONFIG_CARD_TITLE} (${existingConfigCard.publicId}) скелетом политики — проверь lists`, "info");
    } else {
      say(`борда уже подписана: ${CONFIG_CARD_TITLE} = ${existingConfigCard.publicId} (правь описание — хранитель подхватит)`, "info");
    }
  } else {
    // 5. создаём конфиг-карточку со скелетом политики
    const card = await kan.createCard({
      listPublicId: lists.backlog!,
      title: CONFIG_CARD_TITLE,
      description: skeletonDesc,
    });
    say(`подписал: ${CONFIG_CARD_TITLE} (${card.publicId}) на борде «${board.name}» — проверь lists в описании и запускай kan-keeper`, "info");
  }

  // 6. каталоги задач
  for (const d of [join(host.kanRoot, "tasks"), join(host.kanRoot, "inbox")]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
  void statePath;
}

export function kanStatus(say: (m: string, t?: "info" | "warning" | "error") => void): void {
  try {
    const host = loadHostConfig();
    const state = loadState(host.kanRoot);
    const boards = Object.entries(state.boards);
    say(`конфиг: ${hostConfigPath()} · kanRoot: ${host.kanRoot}`, "info");
    if (!boards.length) return say("хранитель ещё не опрашивал ни одной подписанной борды", "warning");
    for (const [id, bs] of boards) {
      const pending = Object.keys(bs.pending ?? {}).length;
      say(`борда ${id}: карточек ${Object.keys(bs.cards).length}, в очереди ${pending}, конфиг-карточка ${bs.configCardPublicId ?? "?"}`, "info");
    }
  } catch (e) {
    say((e as Error).message, "error");
  }
}
