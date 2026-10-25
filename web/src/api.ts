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

export interface Highlight {
  id: string;
  bookId: string;
  locator: Locator;
  text: string;
  color: string;
  comment: string;
  createdAt: number;
  updatedAt: number;
}

export interface Note {
  id: string;
  bookId: string | null;
  bookTitle?: string;
  title: string;
  body: string;
  createdAt: number;
  updatedAt: number;
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
  createdAt: number;
  updatedAt: number;
  messages?: Message[];
}

export interface Status {
  authRequired: boolean;
  loggedIn: boolean;
  aiEnabled: boolean;
  aiProvider: string;
}

export type AIProvider = "none" | "anthropic" | "openai" | "claude-cli";

export interface Settings {
  configPath: string;
  envOverrides: string[] | null;
  server: { addr: string; dataDir: string; booksDir: string };
  library: { scanInterval: string };
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
  saveSettings: (p: { library?: { scanInterval: string }; ai?: AIPatch }) => req<Settings>("PUT", "/api/settings", p),
  changePassword: (current: string, next: string) =>
    req<{ ok: boolean; passwordSet: boolean }>("POST", "/api/settings/password", { current, new: next }),
  testAI: (p: AIPatch) => req<{ ok: boolean; reply?: string; error?: string }>("POST", "/api/settings/ai/test", p),

  books: (o: { q?: string; tag?: number; sort?: string } = {}) => req<Book[]>("GET", `/api/books${qs(o)}`),
  book: (id: string) => req<Book>("GET", `/api/books/${id}`),
  updateBook: (id: string, p: { title?: string; author?: string }) => req<Book>("PATCH", `/api/books/${id}`, p),
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

  highlights: (bookId: string) => req<Highlight[]>("GET", `/api/books/${bookId}/highlights`),
  createHighlight: (bookId: string, h: { locator: Locator; text: string; color: string; comment?: string }) =>
    req<Highlight>("POST", `/api/books/${bookId}/highlights`, h),
  updateHighlight: (id: string, p: { color?: string; comment?: string }) => req<Highlight>("PATCH", `/api/highlights/${id}`, p),
  deleteHighlight: (id: string) => req("DELETE", `/api/highlights/${id}`),

  notes: (o: { bookId?: string; q?: string } = {}) => req<Note[]>("GET", `/api/notes${qs(o)}`),
  note: (id: string) => req<Note>("GET", `/api/notes/${id}`),
  createNote: (n: { bookId?: string | null; title: string; body: string }) => req<Note>("POST", "/api/notes", n),
  updateNote: (id: string, p: { title?: string; body?: string }) => req<Note>("PATCH", `/api/notes/${id}`, p),
  deleteNote: (id: string) => req("DELETE", `/api/notes/${id}`),

  conversations: (bookId: string) => req<Conversation[]>("GET", `/api/books/${bookId}/conversations`),
  conversation: (id: string) => req<Conversation>("GET", `/api/conversations/${id}`),
  createConversation: (bookId: string, c: { passage: string; context: string; locator: Locator | null }) =>
    req<Conversation>("POST", `/api/books/${bookId}/conversations`, c),
  renameConversation: (id: string, title: string) => req("PATCH", `/api/conversations/${id}`, { title }),
  deleteConversation: (id: string) => req("DELETE", `/api/conversations/${id}`),
  exportConversation: (id: string, o: { noteId?: string; messageIds?: string[] } = {}) =>
    req<Note>("POST", `/api/conversations/${id}/export`, o),
  summarizeConversation: (id: string, o: { noteId?: string } = {}) => req<Note>("POST", `/api/conversations/${id}/summarize`, o),
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
