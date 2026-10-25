// Typed client for the Go backend (see docs/SPEC.md §7).

export type EpubLocator = { type: "epub"; cfi: string };
export type PdfLocator = { type: "pdf"; page: number; rects?: number[][] };
export type Locator = EpubLocator | PdfLocator;

export interface Tag {
  id: number;
  name: string;
  color: string;
  count?: number;
}

export interface Progress {
  locator: Locator;
  percent: number;
  updatedAt: number;
}

export interface Book {
  id: string;
  path: string;
  format: "epub" | "pdf";
  title: string;
  author: string;
  description: string;
  size: number;
  hasCover: boolean;
  missing: boolean;
  addedAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  tags: Tag[];
  progress: Progress | null;
}

/**
 * A memo marks a passage of the book ("highlight": the quote, a colour and a
 * Markdown body, which may be empty) or is free text placed among the memos
 * in the book's note ("text", ordered by a locator copied from the memo it follows).
 */
export interface Memo {
  id: string;
  bookId: string;
  kind: "highlight" | "text";
  locator: Locator;
  /** Human-readable position, e.g. "第三章・42%" or "p.12". */
  label: string;
  text: string;
  color: string;
  body: string;
  /** Orders memos that share a position. */
  sort: number;
  createdAt: number;
  updatedAt: number;
}

/** The note of a book (one per book, shown above its memos) or a free-standing note. */
export interface Note {
  id: string;
  bookId: string | null;
  bookTitle?: string;
  title: string;
  body: string;
  memoCount: number;
  createdAt: number;
  updatedAt: number;
}

/** Where an exported AI conversation went. */
export interface Saved {
  memo?: Memo;
  note?: Note;
}

export interface Message {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

export interface Conversation {
  id: string;
  bookId: string;
  title: string;
  passage: string;
  locator: Locator | null;
  memoId: string | null;
  createdAt: number;
  updatedAt: number;
  messages?: Message[];
}

export interface Status {
  authRequired: boolean;
  loggedIn: boolean;
  aiEnabled: boolean;
  aiProvider: string;
  uploadEnabled: boolean;
  uploadMaxMb: number;
}

export type AIProvider = "none" | "anthropic" | "openai" | "claude-cli";

export interface Settings {
  configPath: string;
  envOverrides: string[] | null;
  server: { addr: string; dataDir: string; booksDir: string };
  library: { scanInterval: string; uploadEnabled: boolean; uploadDir: string; uploadMaxMb: number };
  auth: { passwordSet: boolean };
  ai: {
    provider: AIProvider;
    error: string;
    anthropic: { model: string; effort: string; apiKeySet: boolean; apiKeyHint: string };
    openai: { baseUrl: string; model: string; apiKeySet: boolean; apiKeyHint: string };
    claudeCli: { command: string; model: string };
  };
}

/** Partial AI settings. apiKey: omitted = keep the stored key, "" = clear it. */
export interface AIPatch {
  provider?: AIProvider;
  anthropic?: { model?: string; effort?: string; apiKey?: string };
  openai?: { baseUrl?: string; model?: string; apiKey?: string };
  claudeCli?: { model?: string };
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      /* not json */
    }
    if (res.status === 401) window.dispatchEvent(new Event("fuguruma:unauthorized"));
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

const qs = (o: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

export const api = {
  status: () => req<Status>("GET", "/api/status"),
  login: (password: string) => req("POST", "/api/login", { password }),
  logout: () => req("POST", "/api/logout"),

  settings: () => req<Settings>("GET", "/api/settings"),
  saveSettings: (p: { library?: Partial<Settings["library"]>; ai?: AIPatch }) => req<Settings>("PUT", "/api/settings", p),
  changePassword: (current: string, next: string) =>
    req<{ ok: boolean; passwordSet: boolean }>("POST", "/api/settings/password", { current, new: next }),
  testAI: (p: AIPatch) => req<{ ok: boolean; reply?: string; error?: string }>("POST", "/api/settings/ai/test", p),

  books: (o: { q?: string; tag?: number; sort?: string } = {}) => req<Book[]>("GET", `/api/books${qs(o)}`),
  book: (id: string) => req<Book>("GET", `/api/books/${id}`),
  updateBook: (id: string, p: { title?: string; author?: string }) => req<Book>("PATCH", `/api/books/${id}`, p),
  /** Removes a book whose file is missing from the library (the file itself is never touched). */
  deleteBook: (id: string) => req("DELETE", `/api/books/${id}`),
  setBookTags: (id: string, tagIds: number[]) => req<Book>("PUT", `/api/books/${id}/tags`, { tagIds }),
  fileUrl: (id: string) => `/api/books/${id}/file`,
  coverUrl: (b: Pick<Book, "id" | "updatedAt">) => `/api/books/${b.id}/cover?v=${b.updatedAt}`,
  uploadCover: async (id: string, blob: Blob) => {
    const res = await fetch(`/api/books/${id}/cover`, { method: "PUT", body: blob });
    if (!res.ok) throw new ApiError(res.status, "cover upload failed");
  },
  progress: (id: string) => req<Progress | null>("GET", `/api/books/${id}/progress`),
  saveProgress: (id: string, p: { locator: Locator; percent: number; updatedAt: number }) =>
    req<Progress>("PUT", `/api/books/${id}/progress`, p),
  scan: () => req<{ added: number; moved: number; missing: number; total: number }>("POST", "/api/library/scan"),

  tags: () => req<Tag[]>("GET", "/api/tags"),
  createTag: (name: string, color?: string) => req<Tag>("POST", "/api/tags", { name, color }),
  updateTag: (id: number, p: { name?: string; color?: string }) => req("PATCH", `/api/tags/${id}`, p),
  deleteTag: (id: number) => req("DELETE", `/api/tags/${id}`),

  memos: (bookId: string) => req<Memo[]>("GET", `/api/books/${bookId}/memos`),
  createMemo: (bookId: string, m: Pick<Memo, "locator" | "label" | "text"> & Partial<Pick<Memo, "kind" | "color" | "body" | "sort">>) =>
    req<Memo>("POST", `/api/books/${bookId}/memos`, m),
  updateMemo: (id: string, p: { color?: string; body?: string }) => req<Memo>("PATCH", `/api/memos/${id}`, p),
  deleteMemo: (id: string) => req("DELETE", `/api/memos/${id}`),

  notes: (o: { q?: string } = {}) => req<Note[]>("GET", `/api/notes${qs(o)}`),
  note: (id: string) => req<Note>("GET", `/api/notes/${id}`),
  /** The note of a book (created on first use). */
  bookNote: (bookId: string) => req<Note>("GET", `/api/books/${bookId}/note`),
  /** Creates a free-standing note. */
  createNote: (n: { title: string; body: string }) => req<Note>("POST", "/api/notes", n),
  updateNote: (id: string, p: { title?: string; body?: string }) => req<Note>("PATCH", `/api/notes/${id}`, p),
  deleteNote: (id: string) => req("DELETE", `/api/notes/${id}`),

  conversations: (bookId: string) => req<Conversation[]>("GET", `/api/books/${bookId}/conversations`),
  conversation: (id: string) => req<Conversation>("GET", `/api/conversations/${id}`),
  createConversation: (bookId: string, c: { passage: string; context: string; locator: Locator | null; memoId?: string }) =>
    req<Conversation>("POST", `/api/books/${bookId}/conversations`, c),
  renameConversation: (id: string, title: string) => req("PATCH", `/api/conversations/${id}`, { title }),
  deleteConversation: (id: string) => req("DELETE", `/api/conversations/${id}`),
  /** Appends the conversation (or some of its messages) to its memo, or to the book's note. */
  exportConversation: (id: string, o: { messageIds?: string[] } = {}) => req<Saved>("POST", `/api/conversations/${id}/export`, o),
  summarizeConversation: (id: string) => req<Saved>("POST", `/api/conversations/${id}/summarize`, {}),
};

export type ChatEvent =
  | { type: "user"; message: Message }
  | { type: "delta"; text: string }
  | { type: "done"; message: Message }
  | { type: "error"; error: string; removedMessageId?: string };

/** Sends a message and yields server-sent events as Claude streams its reply. */
export async function* sendMessage(convId: string, content: string, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
  const res = await fetch(`/api/conversations/${convId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
    signal,
  });
  if (!res.ok || !res.body) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      /* ignore */
    }
    yield { type: "error", error: msg };
    return;
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data: ")) yield JSON.parse(line.slice(6)) as ChatEvent;
      }
    }
  }
}

export class UploadError extends Error {
  constructor(public status: number, message: string, public bookId?: string) {
    super(message);
  }
}

/**
 * Uploads one book file. Uses XMLHttpRequest because fetch cannot report
 * upload progress. onProgress receives a fraction between 0 and 1.
 */
export function uploadBook(file: File, tagIds: number[], onProgress?: (p: number) => void): Promise<Book> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    // tagIds must precede the file: the server reads the parts in order.
    form.append("tagIds", tagIds.join(","));
    form.append("file", file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/library/upload");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let body: { error?: string; bookId?: string } & Partial<Book> = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not json */
      }
      if (xhr.status === 201) resolve(body as Book);
      else {
        if (xhr.status === 401) window.dispatchEvent(new Event("fuguruma:unauthorized"));
        reject(new UploadError(xhr.status, body.error ?? xhr.statusText, body.bookId));
      }
    };
    xhr.onerror = () => reject(new UploadError(0, "通信に失敗しました"));
    xhr.send(form);
  });
}

/** Link that opens a book, optionally at a position, showing a memo or an AI conversation. */
export function readerUrl(bookId: string, o: { at?: Locator | null; memo?: string; conv?: string } = {}) {
  const p = new URLSearchParams();
  if (o.at) p.set("at", JSON.stringify(o.at));
  if (o.memo) p.set("memo", o.memo);
  if (o.conv) p.set("conv", o.conv);
  const q = p.toString();
  return `/read/${bookId}${q ? `?${q}` : ""}`;
}
