import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import ePub, { Book, Contents, NavItem, Rendition } from "epubjs";
import { Locator } from "../api";
import { Anchor, highlightColors, ReaderHandle, ReaderViewProps, surrounding, TocItem } from "./types";

const themeColors = {
  light: { fg: "#222222", bg: "#ffffff", link: "#b5523b" },
  sepia: { fg: "#5b4636", bg: "#f4ecd8", link: "#8a4f3d" },
  dark: { fg: "#d6d2ca", bg: "#161616", link: "#e07a5f" },
};

function flattenToc(items: NavItem[], depth = 0, out: TocItem[] = []): TocItem[] {
  for (const it of items) {
    out.push({ label: it.label.trim(), href: it.href, depth });
    if (it.subitems?.length) flattenToc(it.subitems, depth + 1, out);
  }
  return out;
}

const EpubView = forwardRef<ReaderHandle, ReaderViewProps>(function EpubView(props, ref) {
  const el = useRef<HTMLDivElement>(null);
  const bookRef = useRef<Book>();
  const rendRef = useRef<Rendition>();
  const applied = useRef(new Map<string, { cfi: string; color: string; ul: boolean }>()); // mark id -> drawn annotation
  const [loading, setLoading] = useState(true);
  // Latest props for event handlers registered once at mount.
  const p = useRef(props);
  p.current = props;
  const rtl = useRef(false);

  useImperativeHandle(ref, () => ({
    next: () => rendRef.current?.next(),
    prev: () => rendRef.current?.prev(),
    goTo: (loc: Locator | string) => {
      const target = typeof loc === "string" ? loc : loc.type === "epub" ? loc.cfi : undefined;
      if (target) rendRef.current?.display(target);
    },
    goToPercent: (pct: number) => {
      const b = bookRef.current;
      if (b && b.locations.length() > 0) rendRef.current?.display(b.locations.cfiFromPercentage(pct));
    },
    clearSelection: () => {
      for (const c of (rendRef.current?.getContents() as unknown as Contents[]) ?? []) c.window.getSelection()?.removeAllRanges();
    },
    anchors: () => {
      const out: Record<string, Anchor> = {};
      const r = rendRef.current;
      if (!r || !el.current) return out;
      const box = el.current.getBoundingClientRect();
      for (const [id, a] of applied.current) {
        let range: Range | null = null;
        try {
          range = r.getRange(a.cfi) ?? null;
        } catch { /* section not displayed */ }
        const frame = range?.startContainer.ownerDocument?.defaultView?.frameElement;
        if (!range || !frame) continue;
        const fr = frame.getBoundingClientRect();
        const line = [...range.getClientRects()]
          .filter((c) => c.width > 1)
          .map((c) => ({ left: fr.left + c.left, top: fr.top + c.top, right: fr.left + c.right, bottom: fr.top + c.bottom }))
          .find((c) => c.right > box.left + 1 && c.left < box.right - 1 && c.bottom > box.top && c.top < box.bottom);
        if (line) out[id] = line;
      }
      return out;
    },
  }));

  useEffect(() => {
    const book = ePub(props.url, { openAs: "epub" });
    bookRef.current = book;
    const rendition = book.renderTo(el.current!, {
      width: "100%",
      height: "100%",
      flow: "paginated",
      spread: "auto",
      minSpreadWidth: 900,
      allowScriptedContent: false,
    });
    rendRef.current = rendition;
    let toc: TocItem[] = [];
    let destroyed = false;

    const chapterLabel = (href: string) => {
      const base = href.split("#")[0];
      let label = "";
      for (const t of toc) if (t.href.split("#")[0].endsWith(base) || base.endsWith(t.href.split("#")[0])) label = t.label;
      return label;
    };

    rendition.on("relocated", (loc: { start: { cfi: string; href: string; percentage: number } }) => {
      const hasLocs = book.locations.length() > 0;
      const pct = hasLocs ? book.locations.percentageFromCfi(loc.start.cfi) : null;
      p.current.onRelocate({ type: "epub", cfi: loc.start.cfi }, pct, chapterLabel(loc.start.href));
      p.current.onLayout?.();
    });
    rendition.on("rendered", () => p.current.onLayout?.());

    rendition.on("selected", (cfiRange: string, contents: Contents) => {
      const range = rendition.getRange(cfiRange);
      const text = range?.toString().trim();
      if (!range || !text) return;
      const frame = contents.window.frameElement as HTMLElement;
      const fr = frame.getBoundingClientRect();
      const r = range.getBoundingClientRect();
      // Character offsets within the section, for extracting surrounding text.
      const body = contents.document.body;
      const pre = contents.document.createRange();
      pre.setStart(body, 0);
      pre.setEnd(range.startContainer, range.startOffset);
      const start = pre.toString().length;
      p.current.onSelect({
        text,
        context: surrounding(body.textContent ?? "", start, start + range.toString().length),
        locator: { type: "epub", cfi: cfiRange },
        rect: { left: fr.left + r.left, top: fr.top + r.top, bottom: fr.top + r.bottom, width: r.width },
      });
    });

    // Tap zones: left/right third turns pages, middle toggles the toolbar.
    rendition.on("click", (e: MouseEvent) => {
      const win = (e.view ?? window) as Window;
      if (win.getSelection()?.toString()) return;
      if ((e.target as HTMLElement).closest?.("a")) return;
      p.current.onSelect(null);
      const frame = win.frameElement as HTMLElement | null;
      const x = (frame?.getBoundingClientRect().left ?? 0) + e.clientX;
      const vr = el.current!.getBoundingClientRect();
      const rel = (x - vr.left) / vr.width;
      if (rel < 0.3) (rtl.current ? rendition.next() : rendition.prev());
      else if (rel > 0.7) (rtl.current ? rendition.prev() : rendition.next());
      else p.current.onCenterTap();
    });

    rendition.hooks.content.register((contents: Contents) => {
      const doc = contents.document;
      let sx = 0, sy = 0, st = 0;
      doc.addEventListener("touchstart", (e) => {
        sx = e.changedTouches[0].screenX;
        sy = e.changedTouches[0].screenY;
        st = Date.now();
      }, { passive: true });
      doc.addEventListener("touchend", (e) => {
        const dx = e.changedTouches[0].screenX - sx;
        const dy = e.changedTouches[0].screenY - sy;
        if (Date.now() - st > 600 || Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx)) return;
        if (contents.window.getSelection()?.toString()) return;
        const forward = dx < 0 !== rtl.current;
        forward ? rendition.next() : rendition.prev();
      });
      doc.addEventListener("keydown", onKey);
      doc.addEventListener("selectionchange", () => {
        if (!contents.window.getSelection()?.toString()) p.current.onSelect(null);
      });
    });

    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest?.("input, textarea")) return;
      if (e.key === "ArrowRight") rtl.current ? rendition.prev() : rendition.next();
      if (e.key === "ArrowLeft") rtl.current ? rendition.next() : rendition.prev();
    };
    window.addEventListener("keydown", onKey);

    book.ready.then(async () => {
      if (destroyed) return;
      rtl.current = (book as unknown as { packaging?: { metadata?: { direction?: string } } }).packaging?.metadata?.direction === "rtl";
      toc = flattenToc(book.navigation.toc);
      applyTheme(rendition, p.current.settings);
      const initial = p.current.initial?.type === "epub" ? p.current.initial.cfi : undefined;
      try {
        await rendition.display(initial);
      } catch {
        await rendition.display();
      }
      setLoading(false);
      p.current.onReady(toc);

      // Locations power percentage progress; generating them is slow, so cache per book.
      const key = `fuguruma:locations:${p.current.bookId}`;
      let cached: string | null = null;
      try {
        cached = localStorage.getItem(key);
      } catch { /* storage unavailable */ }
      if (cached) {
        book.locations.load(cached);
      } else {
        await book.locations.generate(1200);
        try {
          localStorage.setItem(key, book.locations.save());
        } catch { /* quota */ }
      }
      if (!destroyed) rendition.reportLocation();
    });

    return () => {
      destroyed = true;
      window.removeEventListener("keydown", onKey);
      applied.current.clear();
      book.destroy();
    };
  }, [props.url, props.bookId]);

  // epub.js only re-lays out on window resize; also follow the container
  // (e.g. when the side panel opens or closes).
  useEffect(() => {
    if (loading) return;
    let t = 0;
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      // Called without arguments, epub.js measures the container itself (the typings require sizes).
      t = window.setTimeout(() => {
        (rendRef.current as unknown as { resize(): void } | undefined)?.resize();
        p.current.onLayout?.();
      }, 150);
    });
    ro.observe(el.current!);
    return () => {
      clearTimeout(t);
      ro.disconnect();
    };
  }, [loading]);

  // Settings changes.
  useEffect(() => {
    if (rendRef.current && !loading) applyTheme(rendRef.current, props.settings);
    p.current.onLayout?.();
  }, [props.settings, loading]);

  // Sync highlight annotations with props.
  useEffect(() => {
    const r = rendRef.current;
    if (!r || loading) return;
    const want = new Map(props.marks.filter((m) => m.locator.type === "epub").map((m) => [m.id, m]));
    for (const [id, a] of applied.current) {
      const m = want.get(id);
      if (!m || (m.locator.type === "epub" && m.locator.cfi !== a.cfi) || m.color !== a.color || m.annotated !== a.ul) {
        r.annotations.remove(a.cfi, "highlight");
        if (a.ul) r.annotations.remove(a.cfi, "underline");
        applied.current.delete(id);
      }
    }
    for (const [id, m] of want) {
      if (applied.current.has(id) || m.locator.type !== "epub") continue;
      const color = highlightColors[m.color] ?? m.color;
      r.annotations.highlight(m.locator.cfi, { id }, () => p.current.onMarkClick(id), "fuguruma-hl", {
        fill: color,
        "fill-opacity": "0.45",
        "mix-blend-mode": "multiply",
      });
      // Passages with a memo get an underline, so they stand out where the margin is not shown.
      if (m.annotated) {
        r.annotations.underline(m.locator.cfi, { id }, () => p.current.onMarkClick(id), "fuguruma-ul", {
          stroke: color,
          "stroke-opacity": "1",
          "stroke-width": "2",
          "mix-blend-mode": "multiply",
        });
      }
      applied.current.set(id, { cfi: m.locator.cfi, color: m.color, ul: m.annotated });
    }
    p.current.onLayout?.();
  }, [props.marks, loading]);

  return (
    <div className="epub-reader">
      <div ref={el} />
      {loading && <div className="loading">読み込み中…</div>}
    </div>
  );
});

const fontStacks = {
  sans: '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Noto Sans CJK JP", "Yu Gothic", YuGothic, Meiryo, sans-serif',
  serif: '"Hiragino Mincho ProN", "Noto Serif JP", "Noto Serif CJK JP", "Yu Mincho", YuMincho, serif',
};

function applyTheme(r: Rendition, s: ReaderViewProps["settings"]) {
  const c = themeColors[s.theme];
  r.themes.override("color", c.fg, true);
  r.themes.override("background", c.bg, true);
  r.themes.fontSize(`${s.fontSize}%`);
  // registerCss replaces the injected stylesheet (registerRules would keep appending).
  const font = s.font !== "book" ? `body, body * { font-family: ${fontStacks[s.font]} !important; }` : "";
  r.themes.registerCss("fuguruma", `a { color: ${c.link} !important; } ::selection { background: rgba(181, 82, 59, 0.3); } ${font}`);
  r.themes.select("fuguruma");
}

export default EpubView;
