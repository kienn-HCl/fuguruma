import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, Book, Tag } from "../api";
import { useStatus } from "../App";
import BookCover from "../components/BookCover";
import BookEditModal from "../components/BookEditModal";
import TagManager from "../components/TagManager";
import UploadModal from "../components/UploadModal";
import { toast } from "../components/Toast";
import { renderPdfCover } from "../reader/pdfjs";

export default function Library() {
  const status = useStatus();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const tag = Number(params.get("tag") || 0);
  const sort = params.get("sort") || "recent";
  const [q, setQ] = useState(params.get("q") || "");
  const [books, setBooks] = useState<Book[] | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [editing, setEditing] = useState<Book | null>(null);
  const [managingTags, setManagingTags] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [uploading, setUploading] = useState<File[] | null>(null); // open upload dialog with these files
  const dragging = usePageFileDrop(status.uploadEnabled && !uploading, (files) => setUploading(files));

  const setParam = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  };

  const load = useCallback(() => {
    api.books({ q: params.get("q") || undefined, tag: tag || undefined, sort }).then(setBooks);
  }, [params, tag, sort]);
  const loadTags = useCallback(() => api.tags().then(setTags), []);

  useEffect(load, [load]);
  useEffect(() => {
    loadTags();
  }, [loadTags]);

  // Debounced search box -> URL param.
  useEffect(() => {
    const t = setTimeout(() => q !== (params.get("q") || "") && setParam("q", q), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  usePdfCovers(books, (id) => setBooks((bs) => bs && bs.map((b) => (b.id === id ? { ...b, hasCover: true, updatedAt: Date.now() } : b))));

  const scan = async () => {
    setScanning(true);
    try {
      const r = await api.scan();
      toast(`スキャン完了：${r.total} 冊（新規 ${r.added}・移動 ${r.moved}・見つからない ${r.missing}）`);
      load();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setScanning(false);
    }
  };

  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand"><img src="/favicon.svg" alt="" />文車</Link>
        <input className="input search" placeholder="タイトル・著者で検索" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="spacer" />
        <select className="input" style={{ width: "auto" }} value={sort} onChange={(e) => setParam("sort", e.target.value === "recent" ? "" : e.target.value)}>
          <option value="recent">最近読んだ順</option>
          <option value="added">追加順</option>
          <option value="title">タイトル順</option>
        </select>
        <button className="icon-btn" title="再スキャン" onClick={scan} disabled={scanning}>{scanning ? "…" : "⟳"}</button>
        <Link className="icon-btn" title="ノート" to="/notes" style={{ textDecoration: "none", color: "inherit" }}>✎</Link>
        <Link className="icon-btn" title="設定" to="/settings" style={{ textDecoration: "none", color: "inherit" }}>⚙</Link>
        {status.authRequired && (
          <button className="icon-btn" title="ログアウト" onClick={() => api.logout().then(() => location.reload())}>⎋</button>
        )}
      </header>

      <nav className="tagbar">
        <button className={`chip ${!tag ? "active" : ""}`} onClick={() => setParam("tag", "")}>すべて</button>
        {tags.map((t) => (
          <button key={t.id} className={`chip ${tag === t.id ? "active" : ""}`} onClick={() => setParam("tag", tag === t.id ? "" : String(t.id))}>
            <span className="dot" style={{ background: t.color }} />
            {t.name}
            <span className="muted">{t.count}</span>
          </button>
        ))}
        <button className="chip" onClick={() => setManagingTags(true)}>＋ タグ管理</button>
      </nav>

      {books === null ? null : books.length === 0 ? (
        <div className="empty">
          本が見つかりません。<br />
          <span className="small">本のディレクトリに .epub / .pdf を置いて「⟳」で再スキャンしてください。</span>
          {status.uploadEnabled && (
            <div style={{ marginTop: 16 }}>
              <button className="btn primary" onClick={() => setUploading([])}>＋ 本をアップロード</button>
            </div>
          )}
        </div>
      ) : (
        <main className="grid">
          {books.map((b) => (
            <div key={b.id} className={`book ${b.missing ? "missing" : ""}`} onClick={() => !b.missing && nav(`/read/${b.id}`)} title={b.missing ? "ファイルが見つかりません" : b.title}>
              <BookCover book={b} />
              <button className="more" aria-label="編集" onClick={(e) => { e.stopPropagation(); setEditing(b); }}>⋯</button>
              <div className="meta">
                <div className="t">{b.title}</div>
                <div className="au">{b.author || " "}</div>
                {b.progress && b.progress.percent > 0 && (
                  <div className="pbar"><div style={{ width: `${Math.round(b.progress.percent * 100)}%` }} /></div>
                )}
              </div>
            </div>
          ))}
        </main>
      )}

      {editing && (
        <BookEditModal
          book={editing}
          tags={tags}
          onClose={() => setEditing(null)}
          onSaved={() => { load(); loadTags(); }}
          onTagsChanged={loadTags}
        />
      )}
      {managingTags && <TagManager tags={tags} onClose={() => setManagingTags(false)} onChanged={() => { loadTags(); load(); }} />}

      {status.uploadEnabled && (
        <button className="fab" onClick={() => setUploading([])} aria-label="本を追加" title="本を追加（ファイルをドロップしても追加できます）">
          ＋<span className="fab-label">本を追加</span>
        </button>
      )}
      {dragging && <div className="drop-overlay">ドロップして本を追加</div>}
      {uploading && (
        <UploadModal
          tags={tags}
          maxMb={status.uploadMaxMb}
          initialFiles={uploading}
          onClose={() => setUploading(null)}
          onUploaded={() => { load(); loadTags(); }}
          onOpenBook={(id) => nav(`/read/${id}`)}
        />
      )}
    </>
  );
}

/** Generates covers for PDFs in the background, one at a time. */
function usePdfCovers(books: Book[] | null, onDone: (id: string) => void) {
  const tried = useRef(new Set<string>());
  const busy = useRef(false);
  const [tick, setTick] = useState(0);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (!books || busy.current) return;
    const next = books.find((b) => b.format === "pdf" && !b.hasCover && !b.missing && !tried.current.has(b.id));
    if (!next) return;
    busy.current = true;
    tried.current.add(next.id);
    renderPdfCover(api.fileUrl(next.id))
      .then((blob) => api.uploadCover(next.id, blob))
      .then(() => done.current(next.id))
      .catch((e) => console.warn("cover", next.title, e))
      .finally(() => {
        busy.current = false;
        setTick((t) => t + 1);
      });
  }, [books, tick]);
}

/** Lets the user drop files anywhere on the page; returns whether files are being dragged over it. */
function usePageFileDrop(enabled: boolean, onDrop: (files: File[]) => void) {
  const [dragging, setDragging] = useState(false);
  const cb = useRef(onDrop);
  cb.current = onDrop;
  useEffect(() => {
    if (!enabled) return;
    let depth = 0; // dragenter/dragleave fire for every child element
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      cb.current([...(e.dataTransfer?.files ?? [])]);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
      setDragging(false);
    };
  }, [enabled]);
  return dragging;
}
