// Books saved on this device for reading without a connection.
//
// The book file and cover go into the "books" cache; the service worker
// (sw/sw.js) keeps the last response of every API read, so loading the book's
// data once while saving is enough for the reader to open it offline. Which
// books are saved is kept in localStorage.
import { useEffect, useState } from "react";
import { api, Book } from "./api";

export type OfflineMode = "manual" | "auto";

export interface OfflineEntry {
  book: Book;
  /** manual: saved by the user; auto: one of the recently opened books. */
  mode: OfflineMode;
  size: number;
  savedAt: number;
  openedAt: number;
}

const INDEX_KEY = "fuguruma:offline";
const RECENT_KEY = "fuguruma:offline-recent";
const BOOKS = "books";
const CHANGED = "fuguruma:offline-changed";
export const DEFAULT_RECENT = 3;

/** Offline reading needs the Cache API and a service worker (HTTPS or localhost). */
export const offlineSupported = typeof window !== "undefined" && window.isSecureContext && "caches" in window && "serviceWorker" in navigator;

function readIndex(): Record<string, OfflineEntry> {
  try {
    return JSON.parse(localStorage.getItem(INDEX_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeIndex(idx: Record<string, OfflineEntry>) {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(idx));
  } catch { /* quota: the index is small, the files are in the cache */ }
  window.dispatchEvent(new Event(CHANGED));
}

export const offlineEntries = () => readIndex();
export const offlineEntry = (id: string): OfflineEntry | undefined => readIndex()[id];

/** How many recently opened books are kept automatically (0 = none). */
export function recentCount(): number {
  const n = Number(localStorage.getItem(RECENT_KEY) ?? DEFAULT_RECENT);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RECENT;
}

export function setRecentCount(n: number) {
  localStorage.setItem(RECENT_KEY, String(n));
  evictRecent();
}

const fileKey = (id: string) => `/api/books/${id}/file`;
const coverKey = (id: string) => `/api/books/${id}/cover`;

const saving = new Map<string, Promise<void>>();

/**
 * Saves a book: its file, cover, and the data the reader loads (memos, note,
 * AI conversations, progress). Saving an automatically kept book manually makes it manual.
 */
export function saveBook(book: Book, mode: OfflineMode, onProgress?: (p: number) => void): Promise<void> {
  const cur = readIndex()[book.id];
  if (cur && (cur.mode === "manual" || mode === "auto") && cur.size === book.size) {
    if (cur.mode !== mode && mode === "manual") writeIndex({ ...readIndex(), [book.id]: { ...cur, mode } });
    return Promise.resolve();
  }
  const running = saving.get(book.id);
  if (running) return running.then(() => saveBook(book, mode, onProgress));
  const p = (async () => {
    const cache = await caches.open(BOOKS);
    const res = await fetch(api.fileUrl(book.id));
    if (!res.ok || !res.body) throw new Error(`本のファイルを取得できませんでした（${res.status}）`);
    const total = Number(res.headers.get("Content-Length")) || book.size;
    const chunks: Uint8Array[] = [];
    let got = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress?.(total ? Math.min(1, got / total) : 0);
    }
    const blob = new Blob(chunks as BlobPart[], { type: res.headers.get("Content-Type") || "application/octet-stream" });
    await cache.put(fileKey(book.id), new Response(blob, { headers: { "Content-Type": blob.type, "Content-Length": String(blob.size) } }));
    if (book.hasCover) {
      const cover = await fetch(api.coverUrl(book)).catch(() => null);
      if (cover?.ok) await cache.put(coverKey(book.id), cover);
    }
    // Load what the reader needs once, so the service worker keeps a copy.
    await Promise.allSettled([
      api.book(book.id),
      api.memos(book.id),
      api.bookNote(book.id),
      api.progress(book.id),
      api.status(),
      api.conversations(book.id).then((cs) => Promise.allSettled(cs.map((c) => api.conversation(c.id)))),
    ]);
    const now = Date.now();
    const prev = readIndex()[book.id];
    writeIndex({
      ...readIndex(),
      [book.id]: { book, mode: prev?.mode === "manual" ? "manual" : mode, size: blob.size, savedAt: now, openedAt: prev?.openedAt ?? now },
    });
  })().finally(() => saving.delete(book.id));
  saving.set(book.id, p);
  return p;
}

export async function removeBook(id: string) {
  const cache = await caches.open(BOOKS);
  await Promise.all([cache.delete(fileKey(id)), cache.delete(coverKey(id))]);
  const idx = readIndex();
  delete idx[id];
  writeIndex(idx);
}

/** The saved file of a book, or null if it is not saved on this device. */
export async function savedFile(id: string): Promise<ArrayBuffer | null> {
  if (!offlineSupported || !readIndex()[id]) return null;
  const res = await (await caches.open(BOOKS)).match(fileKey(id));
  return res ? res.arrayBuffer() : null;
}

/**
 * Called when a book is opened: keeps it among the recently opened books (saved
 * in the background while online) and drops the oldest automatic ones.
 */
export function bookOpened(book: Book) {
  if (!offlineSupported) return;
  const idx = readIndex();
  const cur = idx[book.id];
  if (cur) {
    writeIndex({ ...idx, [book.id]: { ...cur, book, openedAt: Date.now() } });
    // The file changed on the server (e.g. replaced by a new edition): save it again.
    if (cur.size !== book.size && navigator.onLine) saveBook(book, cur.mode).catch(() => {});
  } else if (recentCount() > 0 && navigator.onLine && !book.missing) {
    // Wait a little so the download does not compete with opening the book.
    setTimeout(() => saveBook(book, "auto").then(evictRecent).catch(() => {}), 3000);
    return;
  }
  evictRecent();
}

function evictRecent() {
  const autos = Object.values(readIndex())
    .filter((e) => e.mode === "auto")
    .sort((a, b) => b.openedAt - a.openedAt);
  for (const e of autos.slice(recentCount())) removeBook(e.book.id);
}

/** Refreshes the stored book details (title, tags, progress) from a fresh library listing. */
export function updateSavedBooks(books: Book[]) {
  const idx = readIndex();
  let changed = false;
  for (const b of books) {
    if (idx[b.id] && JSON.stringify(idx[b.id].book) !== JSON.stringify(b)) {
      idx[b.id] = { ...idx[b.id], book: b };
      changed = true;
    }
  }
  if (changed) writeIndex(idx);
}

/** Forgets every saved book and cached response (on logout). */
export async function clearOffline() {
  localStorage.removeItem(INDEX_KEY);
  if (!offlineSupported) return;
  await Promise.all([caches.delete(BOOKS), caches.delete("api")]);
  window.dispatchEvent(new Event(CHANGED));
}

/** Saved books, updated when they change (also in other tabs). */
export function useOfflineEntries() {
  const [entries, setEntries] = useState(readIndex);
  useEffect(() => {
    const update = () => setEntries(readIndex());
    const onStorage = (e: StorageEvent) => e.key === INDEX_KEY && update();
    window.addEventListener(CHANGED, update);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CHANGED, update);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return entries;
}

/** Whether the browser is online. */
export function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

// ---- reading position while offline ----

const PENDING_KEY = "fuguruma:pending-progress";
type Pending = Record<string, { locator: unknown; percent: number; updatedAt: number }>;

function readPending(): Pending {
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY) || "{}");
  } catch {
    return {};
  }
}

/** Keeps a reading position that could not be sent; sent by flushProgress() later. */
export function keepProgress(bookId: string, p: { locator: unknown; percent: number; updatedAt: number }) {
  localStorage.setItem(PENDING_KEY, JSON.stringify({ ...readPending(), [bookId]: p }));
}

/** A position read offline that is newer than the server's, if any. */
export const pendingProgress = (bookId: string) => readPending()[bookId];

/** Sends the positions kept while offline (the server keeps the newer one). */
export async function flushProgress() {
  for (const [id, p] of Object.entries(readPending())) {
    try {
      const res = await fetch(`/api/books/${id}/progress`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p),
      });
      if (res.ok || res.status === 404) {
        const rest = readPending();
        if (rest[id]?.updatedAt === p.updatedAt) delete rest[id];
        localStorage.setItem(PENDING_KEY, JSON.stringify(rest));
      }
    } catch {
      return; // still offline
    }
  }
}
