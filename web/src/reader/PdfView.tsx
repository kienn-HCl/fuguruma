import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { Locator } from "../api";
import { openPdf, pdfjs } from "./pdfjs";
import { Anchor, highlightColors, ReaderHandle, ReaderViewProps, surrounding, TocItem } from "./types";
import "./textlayer.css";

type OutlineNode = { title: string; dest: string | unknown[] | null; items: OutlineNode[] };

async function resolveOutline(doc: PDFDocumentProxy): Promise<TocItem[]> {
  const outline = (await doc.getOutline()) as OutlineNode[] | null;
  if (!outline) return [];
  const out: TocItem[] = [];
  const walk = async (nodes: OutlineNode[], depth: number) => {
    for (const n of nodes) {
      let page = 0;
      try {
        const dest = typeof n.dest === "string" ? await doc.getDestination(n.dest) : n.dest;
        if (dest?.[0]) page = (await doc.getPageIndex(dest[0] as never)) + 1;
      } catch { /* unresolved destination */ }
      if (page) out.push({ label: n.title, href: `page:${page}`, depth });
      if (n.items?.length) await walk(n.items, depth + 1);
    }
  };
  await walk(outline, 0);
  return out;
}

const PdfView = forwardRef<ReaderHandle, ReaderViewProps>(function PdfView(props, ref) {
  const scroller = useRef<HTMLDivElement>(null);
  const pageEl = useRef<HTMLDivElement>(null);
  const canvasEl = useRef<HTMLCanvasElement>(null);
  const textEl = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(props.initial?.type === "pdf" ? props.initial.page : 1);
  const zoom = props.zoom ?? 1;
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [error, setError] = useState("");
  const pageText = useRef("");
  const p = useRef(props);
  p.current = props;

  const num = doc?.numPages ?? 1;
  const go = useCallback((n: number) => setPage((cur) => Math.min(Math.max(1, n), doc?.numPages ?? cur)), [doc]);
  const next = useCallback(() => setPage((c) => Math.min(c + 1, doc?.numPages ?? c)), [doc]);
  const prev = useCallback(() => setPage((c) => Math.max(c - 1, 1)), []);

  useImperativeHandle(ref, () => ({
    next,
    prev,
    goTo: (loc: Locator | string) => {
      if (typeof loc === "string") {
        const m = /^page:(\d+)$/.exec(loc);
        if (m) go(Number(m[1]));
      } else if (loc.type === "pdf") go(loc.page);
    },
    goToPercent: (pct: number) => go(Math.round(pct * num) || 1),
    clearSelection: () => window.getSelection()?.removeAllRanges(),
    anchors: () => {
      const out: Record<string, Anchor> = {};
      const pe = pageEl.current;
      const sc = scroller.current;
      if (!pe || !sc || !doc) return out;
      const pr = pe.getBoundingClientRect();
      const box = sc.getBoundingClientRect();
      for (const m of p.current.marks) {
        if (m.locator.type !== "pdf" || m.locator.page !== page || !m.locator.rects?.length) continue;
        const line = m.locator.rects
          .map(([x, y, w, h]) => ({ left: pr.left + x * pr.width, top: pr.top + y * pr.height, right: pr.left + (x + w) * pr.width, bottom: pr.top + (y + h) * pr.height }))
          .find((c) => c.bottom > box.top && c.top < box.bottom && c.right > box.left && c.left < box.right);
        if (line) out[m.id] = line;
      }
      return out;
    },
  }), [next, prev, go, num, doc, page]);

  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    openPdf(props.url)
      .then(async (d) => {
        if (cancelled) return d.loadingTask.destroy();
        loaded = d;
        setDoc(d);
        p.current.onReady(await resolveOutline(d).catch(() => []));
      })
      .catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
      loaded?.loadingTask.destroy();
    };
  }, [props.url]);

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(scroller.current!);
    return () => ro.disconnect();
  }, []);

  // Render current page (canvas + selectable text layer).
  useEffect(() => {
    if (!doc || !size.w) return;
    let cancelled = false;
    let task: { cancel(): void } | null = null;
    (async () => {
      const pg = await doc.getPage(page);
      if (cancelled) return;
      const base = pg.getViewport({ scale: 1 });
      const pad = 24;
      const fit = Math.min((size.w - pad) / base.width, (size.h - pad) / base.height);
      const viewport = pg.getViewport({ scale: fit * zoom });
      const dpr = window.devicePixelRatio || 1;
      const canvas = canvasEl.current!;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const pe = pageEl.current!;
      pe.style.width = `${Math.floor(viewport.width)}px`;
      pe.style.height = `${Math.floor(viewport.height)}px`;
      pe.style.setProperty("--scale-factor", String(viewport.scale));
      const rt = pg.render({
        canvas,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      });
      task = rt;
      await rt.promise.catch(() => {});
      if (cancelled) return;

      const tc = await pg.getTextContent();
      if (cancelled) return;
      pageText.current = tc.items.map((i) => ("str" in i ? i.str + (i.hasEOL ? "\n" : "") : "")).join("");
      const tl = textEl.current!;
      tl.replaceChildren();
      p.current.onLayout?.();
      await new pdfjs.TextLayer({ textContentSource: tc, container: tl, viewport }).render();
    })();
    p.current.onRelocate({ type: "pdf", page }, page / (doc.numPages || 1), `${page} / ${doc.numPages}`);
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page, zoom, size]);

  // Report text selections inside the text layer.
  useEffect(() => {
    let t = 0;
    const check = () => {
      const sel = window.getSelection();
      const text = sel?.toString().trim();
      if (!sel || !text || sel.rangeCount === 0) {
        p.current.onSelect(null);
        return;
      }
      const range = sel.getRangeAt(0);
      if (!textEl.current?.contains(range.commonAncestorContainer)) return;
      const pr = pageEl.current!.getBoundingClientRect();
      const rects = [...range.getClientRects()]
        .filter((r) => r.width > 1 && r.height > 1)
        .map((r) => [(r.left - pr.left) / pr.width, (r.top - pr.top) / pr.height, r.width / pr.width, r.height / pr.height].map((v) => Math.round(v * 10000) / 10000));
      const br = range.getBoundingClientRect();
      const all = pageText.current;
      const idx = all.indexOf(text.slice(0, 30));
      p.current.onSelect({
        text,
        context: idx >= 0 ? surrounding(all, idx, idx + text.length) : all.slice(0, 3000),
        locator: { type: "pdf", page, rects },
        rect: { left: br.left, top: br.top, bottom: br.bottom, width: br.width },
      });
    };
    const onChange = () => {
      clearTimeout(t);
      t = window.setTimeout(check, 300);
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      clearTimeout(t);
      document.removeEventListener("selectionchange", onChange);
    };
  }, [page]);

  // Keyboard, tap zones and swipe.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest?.("input, textarea")) return;
      if (e.key === "ArrowRight" || e.key === "PageDown") next();
      if (e.key === "ArrowLeft" || e.key === "PageUp") prev();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev]);

  const touch = useRef({ x: 0, y: 0, t: 0 });
  const onClick = (e: React.MouseEvent) => {
    if (window.getSelection()?.toString()) return;
    if ((e.target as HTMLElement).closest(".pdf-hl div")) return;
    const r = scroller.current!.getBoundingClientRect();
    const rel = (e.clientX - r.left) / r.width;
    if (zoom > 1 && rel > 0.15 && rel < 0.85) return p.current.onCenterTap();
    if (rel < 0.3) prev();
    else if (rel > 0.7) next();
    else p.current.onCenterTap();
  };

  const hls = props.marks.filter((m) => m.locator.type === "pdf" && m.locator.page === page);
  useEffect(() => p.current.onLayout?.(), [props.marks]);

  return (
    <div
      className="pdf-view"
      ref={scroller}
      onClick={onClick}
      onScroll={() => p.current.onLayout?.()}
      onTouchStart={(e) => (touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() })}
      onTouchEnd={(e) => {
        if (zoom > 1 || window.getSelection()?.toString()) return;
        const dx = e.changedTouches[0].clientX - touch.current.x;
        const dy = e.changedTouches[0].clientY - touch.current.y;
        if (Date.now() - touch.current.t < 600 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) (dx < 0 ? next() : prev());
      }}
    >
      {error && <div className="loading">PDF を開けませんでした: {error}</div>}
      {!doc && !error && <div className="loading">読み込み中…</div>}
      <div className="pdf-page" ref={pageEl} style={{ visibility: doc ? "visible" : "hidden" }}>
        <canvas ref={canvasEl} />
        <div className="pdf-hl">
          {hls.flatMap((m) =>
            (m.locator.type === "pdf" ? m.locator.rects ?? [] : []).map((r, i) => (
              <div
                key={`${m.id}-${i}`}
                className={m.annotated ? "annotated" : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  p.current.onMarkClick(m.id);
                }}
                style={{
                  left: `${r[0] * 100}%`, top: `${r[1] * 100}%`, width: `${r[2] * 100}%`, height: `${r[3] * 100}%`,
                  ["--hl" as string]: highlightColors[m.color] ?? m.color,
                }}
              />
            )),
          )}
        </div>
        <div className="textLayer" ref={textEl} />
      </div>
    </div>
  );
});

export default PdfView;
