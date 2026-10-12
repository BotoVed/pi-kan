// Автоприкрепление артефактов: после выхода сессии всё свежее из
// ~/.kan/tasks/<id>/artifacts/ ложится на карточку вложениями — человеку
// видно с телефона без доступа к диску. Дедупликация по манифесту
// (.attached.json: rel → mtimeMs). Молча выключается, если на Kan нет
// S3-бакета (иначе каждый тик шумел бы ошибкой).

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";
import type { KanClient } from "../kan-client.ts";
import { taskDir } from "./wake.ts";

const MAX_SIZE = 50 * 1024 * 1024; // лимит Kan
const MAX_DEPTH = 3;

let bucketMissing = false;

const TYPES: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".html": "text/html",
  ".py": "text/x-python",
  ".sh": "text/x-shellscript",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
};

function walk(dir: string, rel = "", depth = 0): string[] {
  if (depth > MAX_DEPTH) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.name.startsWith(".")) continue;
    const r = rel ? `${rel}/${name.name}` : name.name;
    if (name.isDirectory()) out.push(...walk(join(dir, name.name), r, depth + 1));
    else if (name.isFile()) out.push(r);
  }
  return out;
}

export async function attachNewArtifacts(
  kan: KanClient,
  kanRoot: string,
  cardPublicId: string,
  log: (msg: string) => void,
): Promise<void> {
  if (bucketMissing) return;
  const dir = join(taskDir(kanRoot, cardPublicId), "artifacts");
  if (!existsSync(dir)) return;

  const mPath = join(taskDir(kanRoot, cardPublicId), ".attached.json");
  let manifest: Record<string, number> = {};
  try {
    manifest = JSON.parse(readFileSync(mPath, "utf8"));
  } catch {
    /* первый раз */
  }

  let changed = false;
  for (const rel of walk(dir)) {
    const p = join(dir, rel);
    const st = statSync(p);
    if (manifest[rel] === st.mtimeMs) continue;
    if (st.size > MAX_SIZE) {
      log(`вложение пропущено ${cardPublicId}/${rel}: >50MB`);
      continue;
    }
    // Kan санитизирует filename ([^a-zA-Z0-9._-] → _); слашем слеши, чтобы
    // подкаталоги не превращались в кашу
    const filename = rel.replaceAll("/", ".");
    const contentType = TYPES[extname(rel).toLowerCase()] ?? "application/octet-stream";
    try {
      await kan.uploadAttachment(cardPublicId, { filename, contentType, data: readFileSync(p) });
      manifest[rel] = st.mtimeMs;
      changed = true;
      log(`вложение ${cardPublicId}/${rel} (${st.size} Б)`);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("bucket not configured")) {
        bucketMissing = true;
        log("вложения выключены: на Kan не настроен S3-бакет (артефакты — только на диске)");
        return;
      }
      log(`вложение не удалось ${rel}: ${msg}`); // попробуем на следующем выходе
    }
  }
  if (changed) writeFileSync(mPath, JSON.stringify(manifest));
}
