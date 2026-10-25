import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, Book, Highlight, Locator, Note } from "../api";
import { useStatus } from "../App";
import AiPanel from "../components/AiPanel";
import NoteEditor from "../components/NoteEditor";
import { toast } from "../components/Toast";
import EpubView from "../reader/EpubView";
import PdfView from "../reader/PdfView";
import { highlightColors, ReaderHandle, ReaderSettings, Selection, TocItem } from "../reader/types";

type PanelTab = "toc" | "highlights" | "notes" | "ai" | "settings";

const defaultSettings: ReaderSettings = { theme: "light", fontSize: 100, font: "book" };
function loadSettings(): ReaderSettings {
  try {
    return { ...defaultSettings, ...JSON.parse(localStorage.getItem("fuguruma:reader") || "{}") };
  } catch {
    return defaultSettings;
  }
}

export default function Reader() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = useStatus();
  const view = useRef<ReaderHandle>(null);
  const [book, setBook] = useState<Book | null>(null);
  const [initial, setInitial] = useState<Locator | null | undefined>(undefined);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [settings, setSettings] = useState(loadSettings);
  const [panel, setPanel] = useState<PanelTab | null>(null);
  const [immersive, setImmersive] = useState(false);
  const [sel, setSel] = useState<Selection | null>(null);
  const [pos, setPos] = useState<{ loc: Locator | null; pct: number; label: string }>({ loc: null, pct: 0, label: "" });
  const [openConv, setOpenConv] = useState<string | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [activeNote, setActiveNote] = useState<Note | null>(null);
  const [focusHl, setFocusHl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1); // PDF only
  const lastSaved = useRef(0);

  useEffect(() => {
    // ?at=<locator JSON> opens the book at a specific place (e.g. a link from a note).
    let at: Locator | null = null;
    try {
      at = params.get("at") ? (JSON.parse(params.get("at")!) as Locator) : null;
    } catch { /* ignore a malformed link */ }
    if (params.has("at")) setParams({}, { replace: true });
    api.book(id).then((b) => {
      setBook(b);
      setInitial(at ?? b.progress?.locator ?? null);
      if (b.progress && !at) setPos({ loc: b.progress.locator, pct: b.progress.percent, label: "" });
    });
    api.highlights(id).then(setHighlights);
    api.notes({ bookId: id }).then(setNotes);
  }, [id]);

  useEffect(() => {
    try {
      localStorage.setItem("fuguruma:reader", JSON.stringify(settings));
    } catch { /* ignore */ }
  }, [settings]);

  // Save reading position (debounced). keepalive lets it finish if the tab closes.
  useEffect(() => {
    if (!pos.loc) return;
    const t = setTimeout(() => {
      const updatedAt = Date.now();
      lastSaved.current = updatedAt;
      fetch(`/api/books/${id}/progress`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locator: pos.loc, percent: pos.pct, updatedAt }),
        keepalive: true,
      }).catch(() => {});
    }, 1200);
    return () => clearTimeout(t);
  }, [pos.loc, pos.pct, id]);

  // When returning to this tab, offer to jump if another device read further.
  useEffect(() => {
    const onVis = async () => {
      if (document.visibilityState !== "visible") return;
      const remote = await api.progress(id).catch(() => null);
      if (remote && remote.updatedAt > lastSaved.current + 2000 && JSON.stringify(remote.locator) !== JSON.stringify(pos.loc)) {
        toast(`別の端末で ${Math.round(remote.percent * 100)}% まで読んでいます`, { label: "移動", run: () => view.current?.goTo(remote.locator) });
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [id, pos.loc]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (sel) clearSel();
        else setPanel(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const onRelocate = useCallback((loc: Locator, pct: number | null, label: string) => {
    setPos((p) => ({ loc, pct: pct ?? p.pct, label: label || p.label }));
  }, []);
  const onSelect = useCallback((s: Selection | null) => setSel(s), []);
  const onHighlightClick = useCallback((hid: string) => {
    setFocusHl(hid);
    setPanel("highlights");
  }, []);
  const onCenterTap = useCallback(() => {
    setImmersive((v) => !v);
  }, []);
  const onReady = useCallback((t: TocItem[]) => setToc(t), []);

  const clearSel = () => {
    view.current?.clearSelection();
    setSel(null);
  };

  const togglePanel = (t: PanelTab) => setPanel((p) => (p === t ? null : t));
  const jump = (loc: Locator | string) => {
    view.current?.goTo(loc);
    if (window.innerWidth < 900) setPanel(null);
  };

  // ---- selection actions ----
  const addHighlight = async (color: string, openComment = false) => {
    if (!sel) return;
    const h = await api.createHighlight(id, { locator: sel.locator, text: sel.text, color });
    setHighlights((hs) => [...hs, h]);
    clearSel();
    if (openComment) {
      setFocusHl(h.id);
      setPanel("highlights");
    }
  };

  const askAI = async (passage: string, context: string, locator: Locator | null) => {
    const c = await api.createConversation(id, { passage, context, locator });
    clearSel();
    setOpenConv(c.id);
    setPanel("ai");
  };

  const quoteToNote = async (text: string, comment = "") => {
    const md = `> ${text.trim().replace(/\n/g, "\n> ")}${comment ? `\n\n${comment}` : ""}`;
    let n: Note;
    if (activeNote) {
      const body = activeNote.body.trim() ? `${activeNote.body}\n\n${md}` : md;
      n = await api.updateNote(activeNote.id, { body });
    } else {
      n = await api.createNote({ bookId: id, title: `${book?.title ?? ""} 読書メモ`, body: md });
    }
    noteSaved(n);
    toast(activeNote ? "ノートに引用しました" : "ノートを作成して引用しました", { label: "ノートを見る", run: () => setPanel("notes") });
  };

  const noteSaved = (n: Note) => {
    setActiveNote(n);
    setNotes((ns) => [n, ...ns.filter((x) => x.id !== n.id)]);
  };

  if (!book || initial === undefined) return <div className="loading">読み込み中…</div>;

  const View = book.format === "pdf" ? PdfView : EpubView;

  return (
    <div className={`reader ${immersive && !panel ? "immersive" : ""}`} data-theme={settings.theme}>
      <div className="reader-body">
        <div className="viewer">
          <View
            ref={view}
            url={api.fileUrl(book.id)}
            bookId={book.id}
            initial={initial}
            highlights={highlights}
            settings={settings}
            onReady={onReady}
            onRelocate={onRelocate}
            onSelect={onSelect}
            onHighlightClick={onHighlightClick}
            onCenterTap={onCenterTap}
            zoom={zoom}
          />
        </div>

        {panel && (
          <aside className="panel">
            <div className="panel-tabs">
              {(["toc", "highlights", "notes", "ai", "settings"] as PanelTab[]).map((t) => (
                <button key={t} className={panel === t ? "active" : ""} onClick={() => setPanel(t)}>
                  {{ toc: "目次", highlights: "ハイライト", notes: "ノート", ai: "AI", settings: "表示" }[t]}
                </button>
              ))}
              <div className="spacer" />
              <button className="icon-btn" onClick={() => setPanel(null)} aria-label="閉じる">×</button>
            </div>
            <div className="panel-body">
              {panel === "toc" && (
                <nav className="toc">
                  {toc.length === 0 && <div className="empty">目次がありません</div>}
                  {toc.map((t, i) => (
                    <a key={i} href="#" style={{ paddingLeft: 16 + t.depth * 16 }} onClick={(e) => { e.preventDefault(); jump(t.href); }}>
                      {t.label}
                    </a>
                  ))}
                </nav>
              )}
              {panel === "highlights" && (
                <HighlightList
                  highlights={highlights}
                  focus={focusHl}
                  onJump={(h) => jump(h.locator)}
                  onChange={(h) => setHighlights((hs) => hs.map((x) => (x.id === h.id ? h : x)))}
                  onDelete={(h) => api.deleteHighlight(h.id).then(() => setHighlights((hs) => hs.filter((x) => x.id !== h.id)))}
                  onQuote={(h) => quoteToNote(h.text, h.comment)}
                  onAsk={(h) => askAI(h.text, "", h.locator)}
                  aiEnabled={status.aiEnabled}
                />
              )}
              {panel === "notes" &&
                (activeNote ? (
                  <NoteEditor
                    compact
                    note={activeNote}
                    onBack={() => setActiveNote(null)}
                    onChange={noteSaved}
                    onDelete={async () => {
                      if (!confirm("このノートを削除しますか？")) return;
                      await api.deleteNote(activeNote.id);
                      setNotes((ns) => ns.filter((n) => n.id !== activeNote.id));
                      setActiveNote(null);
                    }}
                  />
                ) : (
                  <div>
                    <div style={{ padding: 10 }}>
                      <button
                        className="btn primary"
                        onClick={async () => noteSaved(await api.createNote({ bookId: id, title: `${book.title} 読書メモ`, body: "" }))}
                      >
                        ＋ 新しいノート
                      </button>
                    </div>
                    {notes.length === 0 && <div className="empty small">この本のノートはまだありません。<br />開いているノートが、引用や AI 会話の書き出し先になります。</div>}
                    {notes.map((n) => (
                      <div key={n.id} className="list-item" onClick={() => setActiveNote(n)}>
                        <div style={{ fontWeight: 600 }}>{n.title || "無題のノート"}</div>
                        <div className="small muted">{new Date(n.updatedAt).toLocaleString()}</div>
                      </div>
                    ))}
                  </div>
                ))}
              {panel === "ai" && (
                <AiPanel
                  bookId={id}
                  openId={openConv}
                  onOpen={setOpenConv}
                  onJump={jump}
                  activeNote={activeNote}
                  onNoteSaved={noteSaved}
                  enabled={status.aiEnabled}
                />
              )}
              {panel === "settings" && <SettingsPanel settings={settings} onChange={setSettings} isPdf={book.format === "pdf"} />}
            </div>
          </aside>
        )}
      </div>

      {/* Controls live at the bottom, within thumb reach on phones (same layout on PC). */}
      <footer className="reader-dock">
        <div className="reader-progress">
          <span className="label">{pos.label}</span>
          <input
            type="range"
            min={0}
            max={1000}
            aria-label="読書位置"
            value={Math.round(pos.pct * 1000)}
            onChange={(e) => setPos((p) => ({ ...p, pct: Number(e.target.value) / 1000 }))}
            onPointerUp={(e) => view.current?.goToPercent(Number((e.target as HTMLInputElement).value) / 1000)}
            onKeyUp={(e) => view.current?.goToPercent(Number((e.target as HTMLInputElement).value) / 1000)}
          />
          <span>{Math.round(pos.pct * 100)}%</span>
        </div>
        <div className="reader-toolbar">
          <button className="icon-btn" onClick={() => nav("/")} aria-label="本棚へ" title="本棚へ">‹</button>
          <div className="title" title={book.title}>{book.title}</div>
          {book.format === "pdf" && (
            <div className="zoom" role="group" aria-label="拡大縮小">
              <button className="icon-btn" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))} aria-label="縮小">－</button>
              <button className="zoom-level" onClick={() => setZoom(1)} title="ページ全体を表示">{Math.round(zoom * 100)}%</button>
              <button className="icon-btn" onClick={() => setZoom((z) => Math.min(4, z + 0.25))} aria-label="拡大">＋</button>
            </div>
          )}
          {([
            ["toc", "☰", "目次"],
            ["settings", "Aa", "表示設定"],
            ["highlights", "🖍", "ハイライト"],
            ["notes", "✎", "ノート"],
            ["ai", "✦", "AI"],
          ] as [PanelTab, string, string][]).map(([t, icon, label]) => (
            <button key={t} className={`icon-btn ${panel === t ? "active" : ""}`} onClick={() => togglePanel(t)} title={label} aria-label={label}>
              {icon}
            </button>
          ))}
        </div>
      </footer>

      {sel && <SelectionPopup sel={sel} aiEnabled={status.aiEnabled} onHighlight={addHighlight} onAsk={() => askAI(sel.text, sel.context, sel.locator)} onQuote={() => { quoteToNote(sel.text); clearSel(); }} onCopy={() => { navigator.clipboard.writeText(sel.text); clearSel(); toast("コピーしました"); }} />}
    </div>
  );
}

function SelectionPopup({
  sel, aiEnabled, onHighlight, onAsk, onQuote, onCopy,
}: {
  sel: Selection;
  aiEnabled: boolean;
  onHighlight: (color: string, openComment?: boolean) => void;
  onAsk: () => void;
  onQuote: () => void;
  onCopy: () => void;
}) {
  // Place below the selection (above if near the bottom) so native mobile menus don't overlap.
  const below = sel.rect.bottom + 70 < window.innerHeight - 96; // keep clear of the bottom dock
  const top = below ? sel.rect.bottom + 12 : Math.max(8, sel.rect.top - 56);
  const half = Math.min(210, window.innerWidth / 2); // the popup wraps to fit narrow screens
  const left = Math.min(Math.max(sel.rect.left + sel.rect.width / 2, half), window.innerWidth - half);
  return (
    <div className="sel-pop" style={{ top, left }} onMouseDown={(e) => e.preventDefault()}>
      {Object.entries(highlightColors).slice(0, 4).map(([name, c]) => (
        <button key={name} className="swatch" style={{ background: c }} title={`ハイライト（${name}）`} onClick={() => onHighlight(name)} />
      ))}
      <span className="sep" />
      <button onClick={() => onHighlight("yellow", true)}>メモ</button>
      <button onClick={onQuote} title="開いているノートに引用を追記">引用</button>
      {aiEnabled && <button onClick={onAsk}>✦ AIに聞く</button>}
      <button onClick={onCopy}>コピー</button>
    </div>
  );
}

function HighlightList({
  highlights, focus, onJump, onChange, onDelete, onQuote, onAsk, aiEnabled,
}: {
  highlights: Highlight[];
  focus: string | null;
  onJump: (h: Highlight) => void;
  onChange: (h: Highlight) => void;
  onDelete: (h: Highlight) => void;
  onQuote: (h: Highlight) => void;
  onAsk: (h: Highlight) => void;
  aiEnabled: boolean;
}) {
  const focusRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    focusRef.current?.scrollIntoView({ block: "center" });
    focusRef.current?.focus();
  }, [focus]);
  if (highlights.length === 0) return <div className="empty">本文を選択してハイライトできます</div>;
  const sorted = [...highlights].sort((a, b) => a.createdAt - b.createdAt);
  return (
    <div>
      {sorted.map((h) => (
        <div key={h.id} className="list-item" style={{ cursor: "default", background: h.id === focus ? "var(--surface-2)" : undefined }}>
          <blockquote className="quote full" style={{ ["--qc" as string]: highlightColors[h.color] ?? h.color, cursor: "pointer" }} onClick={() => onJump(h)}>
            {h.text}
          </blockquote>
          <textarea
            ref={h.id === focus ? focusRef : undefined}
            className="input small"
            rows={h.comment ? 3 : 1}
            style={{ marginTop: 8, resize: "vertical" }}
            placeholder="メモを追加…"
            defaultValue={h.comment}
            onBlur={async (e) => {
              if (e.target.value !== h.comment) onChange(await api.updateHighlight(h.id, { comment: e.target.value }));
            }}
          />
          <div className="row" style={{ marginTop: 6, flexWrap: "wrap", gap: 4 }}>
            {Object.entries(highlightColors).map(([name, c]) => (
              <button
                key={name}
                aria-label={name}
                onClick={async () => onChange(await api.updateHighlight(h.id, { color: name }))}
                style={{ width: 18, height: 18, borderRadius: "50%", background: c, border: h.color === name ? "2px solid var(--text)" : "1px solid var(--border)", cursor: "pointer", padding: 0 }}
              />
            ))}
            <div className="spacer" />
            <button className="btn ghost small" onClick={() => onQuote(h)}>ノートへ</button>
            {aiEnabled && <button className="btn ghost small" onClick={() => onAsk(h)}>AI</button>}
            <button className="btn ghost small danger" onClick={() => onDelete(h)}>削除</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function SettingsPanel({ settings, onChange, isPdf }: { settings: ReaderSettings; onChange: (s: ReaderSettings) => void; isPdf: boolean }) {
  return (
    <div style={{ padding: 16 }}>
      <div className="field">
        <label>テーマ</label>
        <div className="row">
          {(["light", "sepia", "dark"] as const).map((t) => (
            <button key={t} className={`btn ${settings.theme === t ? "primary" : ""}`} onClick={() => onChange({ ...settings, theme: t })}>
              {{ light: "ライト", sepia: "セピア", dark: "ダーク" }[t]}
            </button>
          ))}
        </div>
      </div>
      {!isPdf && (
        <div className="field">
          <label>文字サイズ（{settings.fontSize}%）</label>
          <input type="range" min={70} max={200} step={5} value={settings.fontSize} style={{ width: "100%" }} onChange={(e) => onChange({ ...settings, fontSize: Number(e.target.value) })} />
        </div>
      )}
      {!isPdf && (
        <div className="field">
          <label>本文フォント</label>
          <div className="row">
            {(["book", "serif", "sans"] as const).map((f) => (
              <button key={f} className={`btn ${settings.font === f ? "primary" : ""}`} onClick={() => onChange({ ...settings, font: f })}>
                {{ book: "本の指定", serif: "明朝", sans: "ゴシック" }[f]}
              </button>
            ))}
          </div>
        </div>
      )}
      <p className="small muted">表示設定はこの端末にのみ保存されます。読書位置・ハイライト・ノートは全端末で同期されます。</p>
    </div>
  );
}
