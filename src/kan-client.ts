// Минимальный клиент REST API Kan.bn (trpc-to-openapi, /api/v1).
// Проверено по исходникам kanbn/kan rev main (2026-10) и живому инстансу.
// Секрет — только Bearer-токен из файла; в лог токены не попадают.

export interface KanComment {
  publicId: string;
}

export interface KanChecklistItem {
  publicId: string;
  content?: string;
  checked?: boolean;
}

export interface KanChecklist {
  publicId: string;
  name?: string;
  items?: KanChecklistItem[];
}

export interface KanCard {
  publicId: string;
  title: string;
  description: string | null;
  index: number;
  cardNumber?: number | null;
  dueDate: string | null;
  labels: { publicId: string; name?: string }[];
  members: unknown[];
  attachments: { publicId: string }[];
  checklists: KanChecklist[];
  comments: KanComment[];
}

export interface KanList {
  publicId: string;
  name: string;
  index: number;
  cards: KanCard[];
}

export interface KanBoard {
  publicId: string;
  name: string;
  slug: string;
  isArchived: boolean;
  workspace: { publicId: string; cardPrefix: string };
  labels: unknown[];
  lists: KanList[];
}

export interface KanActivity {
  publicId: string;
  type: string; // card.created | card.moved | card.updated.* | card.updated.comment.added ...
  createdAt: string;
  comment?: { publicId: string; comment: string } | null;
  user?: { id: string; name: string | null; email: string } | null;
  fromList?: { publicId: string; name: string } | null;
  toList?: { publicId: string; name: string } | null;
}

export class KanError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class KanClient {
  private baseUrl: string;
  private token: string;
  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/api/v1${path}`;
    // Kan троттлит ключ (~60 req/мин), а ключ общий у хранителя и всех сессий.
    // 429 — не ошибка, а «подожди»: ждём по подсказке сервера, до 3 раз.
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 429 && attempt < 3) {
        const hint = /Try again in (\d+)s/.exec(await res.text());
        const waitMs = Math.min(Number(hint?.[1] ?? 10), 35) * 1000;
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      const text = await res.text();
      if (!res.ok) {
        throw new KanError(res.status, `${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
      }
      return text ? (JSON.parse(text) as T) : (undefined as T);
    }
  }

  /** Общий вызов REST (для регистратора идентичностей: invites/invites/roles). */
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    return this.req<T>(method, path, body);
  }

  // ── чтение ──
  // /workspaces отдаёт [{role, workspace: {...}}] — разворачиваем
  async listWorkspaces(): Promise<{ publicId: string; name: string }[]> {
    const raw = await this.req<{ publicId: string; name: string }[] | { role: string; workspace: { publicId: string; name: string } }[]>(
      "GET",
      "/workspaces",
    );
    if (!Array.isArray(raw)) return [];
    return raw.map((x) => ((x as { workspace?: { publicId: string; name: string } }).workspace ?? x) as { publicId: string; name: string });
  }
  listBoards(workspacePublicId: string): Promise<{ publicId: string; name: string }[]> {
    return this.req("GET", `/workspaces/${workspacePublicId}/boards`);
  }
  getBoard(boardPublicId: string): Promise<KanBoard> {
    return this.req("GET", `/boards/${boardPublicId}`);
  }
  getCard(cardPublicId: string): Promise<KanCard & { list?: { publicId: string } }> {
    return this.req("GET", `/cards/${cardPublicId}`);
  }
  getActivities(cardPublicId: string, limit = 20): Promise<{ activities: KanActivity[] }> {
    return this.req("GET", `/cards/${cardPublicId}/activities?limit=${limit}`);
  }

  // ── запись ──
  createCard(input: {
    listPublicId: string;
    title: string;
    description?: string;
    dueDate?: string | null;
    position?: "start" | "end";
  }): Promise<KanCard> {
    // description обязателен по zod, как и пустые массивы label/member/position
    // (грабли смоука 2026-10) — шлём полную форму
    return this.req("POST", "/cards", {
      description: "",
      labelPublicIds: [],
      memberPublicIds: [],
      position: "end",
      ...input,
    });
  }
  updateCard(
    cardPublicId: string,
    patch: {
      title?: string;
      description?: string;
      index?: number;
      listPublicId?: string;
      dueDate?: string | null;
    },
  ): Promise<unknown> {
    return this.req("PUT", `/cards/${cardPublicId}`, { cardPublicId, ...patch });
  }
  addComment(cardPublicId: string, comment: string): Promise<KanComment> {
    return this.req("POST", `/cards/${cardPublicId}/comments`, { cardPublicId, comment });
  }
  createList(input: { boardPublicId: string; name: string; description?: string }): Promise<KanList> {
    return this.req("POST", "/lists", input);
  }

  // Вложение файла в карточку: три шага через presigned S3 PUT (multipart не
  // поддерживается). Требует настроенного бакета на Kan (иначе 500 "bucket
  // not configured"). Лимит сервера — 50 MiB.
  async uploadAttachment(
    cardPublicId: string,
    file: { filename: string; contentType: string; data: Uint8Array },
  ): Promise<void> {
    const { url, key } = await this.req<{ url: string; key: string }>(
      "POST",
      `/cards/${cardPublicId}/attachments/upload-url`,
      { cardPublicId, filename: file.filename, contentType: file.contentType, size: file.data.length },
    );
    const put = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": file.contentType },
      body: file.data as BodyInit,
      signal: AbortSignal.timeout(120_000),
    });
    if (!put.ok) {
      throw new KanError(put.status, `S3 PUT → ${put.status}: ${(await put.text()).slice(0, 200)}`);
    }
    await this.req("POST", `/cards/${cardPublicId}/attachments/confirm`, {
      cardPublicId,
      s3Key: key,
      filename: file.filename,
      originalFilename: file.filename,
      contentType: file.contentType,
      size: file.data.length,
    });
  }
}
