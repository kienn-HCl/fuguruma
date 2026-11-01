// Service worker: lets Fuguruma start and read saved books without a connection.
// scripts/build-sw.mjs prepends VERSION and PRECACHE (every file of the build) and
// writes the result to dist/sw.js.
//
// - App files: precached on install, served from the cache (new builds replace them).
// - Pages: network first, falling back to the cached app page (/).
// - API reads (books, memos, notes, conversations, progress…): network first; the
//   last good response is kept and served when offline.
// - Book files and covers of books saved for offline reading live in the "books"
//   cache, written by the page (src/offline.ts); covers are served from it first.

/* global VERSION, PRECACHE */
const SHELL = `shell-${VERSION}`;
const API = "api";
const BOOKS = "books";
const NETWORK_TIMEOUT = 6000;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("shell-") && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first; on failure (or after a timeout, when a cached copy exists) use the cache.
async function networkFirst(req, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  const network = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  const cached = () => cache.match(req).then((r) => r || (fallbackUrl ? caches.match(fallbackUrl) : undefined));
  try {
    return await Promise.race([
      network,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), NETWORK_TIMEOUT)),
    ]);
  } catch {
    const hit = await cached();
    if (hit) return hit;
    return network; // nothing cached: wait for the network (or its error)
  }
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;

  if (url.pathname.startsWith("/api/")) {
    const p = url.pathname;
    // Book files (range requests, read by the page from the books cache), settings and scans pass through.
    if (/\/file$/.test(p) || p.startsWith("/api/settings") || p.startsWith("/api/library")) return;
    if (/^\/api\/books\/[^/]+\/cover$/.test(p)) {
      e.respondWith(caches.open(BOOKS).then((c) => c.match(p)).then((hit) => hit || fetch(req)));
      return;
    }
    e.respondWith(networkFirst(req, API));
    return;
  }

  if (req.mode === "navigate") {
    e.respondWith(networkFirst(req, SHELL, "/"));
    return;
  }

  e.respondWith(caches.match(req, { cacheName: SHELL }).then((hit) => hit || fetch(req)));
});
