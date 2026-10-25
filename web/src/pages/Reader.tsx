import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, Book, Conversation, Locator, Memo, Note, Saved } from "../api";
import { useStatus } from "../App";
import AiPanel from "../components/AiPanel";
import BookNote from "../components/BookNote";
import MemoCard, { MemoActions } from "../components/MemoCard";
import { toast } from "../components/Toast";
import { hasContent } from "../memos";
import EpubView from "../reader/EpubView";
import MemoMargin from "../reader/MemoMargin";
import PdfView from "../reader/PdfView";
import { highlightColors, Mark, ReaderHandle, ReaderSettings, Selection, TocItem } from "../reader/types";

type PanelTab = "toc" | "note" | "ai" | "settings";

const defaultSettings: ReaderSettings = { theme: "light", fontSize: 100, font: "book", margin: true };
function loadSettings(): ReaderSettings {
  try {
    return { ...defaultSettings, ...JSON.parse(localStorage.getItem("fuguruma:reader") || "{}") };
  } catch {
    return defaultSettings;
  }
}

/** The margin with memo cards needs room beside the text. */
const MARGIN_MIN_WIDTH = 840;

export default function Reader() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = useStatus();
  const view = useRef<ReaderHandle>(null);
  const viewer = useRef<HTMLDivElement>(null);
  const [book, setBook] = useState<Book | null>(null);
  const [initial, setInitial] = useState<Locator | null | undefined>(undefined);
  const [memos, setMemos] = useState<Memo[]>([]);
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [note, setNote] = useState<Note | null>(null);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [settings, setSettings] = useState(loadSettings);
  const [panel, setPanel] = useState<PanelTab | null>(null);
  const [immersive, setImmersive] = useState(false);
  const [sel, setSel] = useState<Selection | null>(null);
  const [pos, setPos] = useState<{ loc: Locator | null; pct: number; label: string }>({ loc: null, pct: 0, label: "" });
  const [openConv, setOpenConv] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null); // memo shown in the margin or the sheet
  const [editing, setEditing] = useState(false);
  const [zoom, setZoom] = useState(1); // PDF only
  const [viewerWidth, setViewerWidth] = useState(0);
  const [layoutTick, setLayoutTick] = useState(0);
  const lastSaved = useRef(0);

  useEffect(() => {
    // ?at=<locator JSON> opens the book at a specific place, ?memo=<id> shows a memo, ?conv=<id> opens an AI conversation.
    let at: Locator | null = null;
    try {
      at = params.get("at") ? (JSON.parse(params.get("at")!) as Locator) : null;
    } catch { /* ignore a malformed link */ }
    const memo = params.get("memo");
    const conv = params.get("conv");
    if (params.toString()) setParams({}, { replace: true });
    api.book(id).then((b) => {
      setBook(b);
      setInitial(at ?? b.progress?.locator ?? null);
      if (b.progress && !at) setPos({ loc: b.progress.locator, pct: b.progress.percent, label: "" });
    });
    api.memos(id).then(setMemos);
    api.conversations(id).then(setConvs);
    if (memo) setActive(memo);
    if (conv) {
      setOpenConv(conv);
      setPanel("ai");
    }
  }, [id]);

  const reloadConvs = useCallback(() => api.conversations(id).then(setConvs), [id]);

  useEffect(() => {
    if (panel === "note" && !note) api.bookNote(id).then(setNote);
  }, [panel, note, id]);

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
      if (e.key !== "Escape") return;
      if (sel) clearSel();
      else if (active) setActive(null);
      else setPanel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (!viewer.current) return;
    const ro = new ResizeObserver(([e]) => setViewerWidth(e.contentRect.width));
    ro.observe(viewer.current);
    return () => ro.disconnect();
  }, [book]);

  const onRelocate = useCallback((loc: Locator, pct: number | null, label: string) => {
    setPos((p) => ({ loc, pct: pct ?? p.pct, label: label || p.label }));
  }, []);
  const onSelect = useCallback((s: Selection | null) => setSel(s), []);
  const marginShown = useRef(false);
  const onMarkClick = useCallback((mid: string) => {
    setActive(mid);
    setEditing(false);
    // Without the margin the memo shows in a sheet, or in the note when a panel is open beside the text.
    if (!marginShown.current) setPanel((p) => (p && window.innerWidth >= 900 ? "note" : null));
  }, []);
  const onCenterTap = useCallback(() => setImmersive((v) => !v), []);
  const onReady = useCallback((t: TocItem[]) => setToc(t), []);
  const layoutPending = useRef(false);
  const onLayout = useCallback(() => {
    if (layoutPending.current) return;
    layoutPending.current = true;
    requestAnimationFrame(() => {
      layoutPending.current = false;
      setLayoutTick((t) => t + 1);
    });
  }, []);
  const getAnchors = useCallback(() => view.current?.anchors() ?? {}, []);

  const clearSel = () => {
    view.current?.clearSelection();
    setSel(null);
  };

  const togglePanel = (t: PanelTab) => setPanel((p) => (p === t ? null : t));
  const narrow = () => window.innerWidth < 900;
  const jump = (loc: Locator | string) => {
    view.current?.goTo(loc);
    if (narrow()) setPanel(null);
  };

  const convCount = useMemo(() => {
    const c: Record<string, number> = {};
    for (const x of convs) if (x.memoId) c[x.memoId] = (c[x.memoId] ?? 0) + 1;
    return c;
  }, [convs]);
  const marks: Mark[] = useMemo(
    () =>
      memos
        .filter((m) => m.kind === "highlight")
        .map((m) => ({ id: m.id, locator: m.locator, color: m.color, annotated: hasContent(m, convCount[m.id]) })),
    [memos, convCount],
  );
  const marginMemos = memos.filter((m) => m.kind === "highlight" && (m.id === active || hasContent(m, convCount[m.id])));
  const marginOn = settings.margin && viewerWidth >= MARGIN_MIN_WIDTH && marginMemos.length > 0;
  marginShown.current = marginOn;
  const activeMemo = memos.find((m) => m.id === active) ?? null;

  // ---- memos ----
  const placeLabel = (loc: Locator) =>
    loc.type === "pdf" ? `p.${loc.page}` : `${pos.label ? `${pos.label}・` : ""}${Math.round(pos.pct * 100)}%`;

  /** Creates a memo from the selection: a plain highlight, a memo to write, or a question to the AI. */
  const createFromSelection = async (color: string, then: "highlight" | "write" | "ask") => {
    if (!sel) return;
    const s = sel;
    clearSel();
    const m = await api.createMemo(id, { locator: s.locator, label: placeLabel(s.locator), text: s.text, color });
    setMemos((ms) => [...ms, m]);
    if (then === "write") {
      setActive(m.id);
      setEditing(true);
    } else if (then === "ask") {
      setActive(m.id);
      setEditing(false);
      await ask(m, s.context);
    }
  };

  const ask = async (m: Memo, context = "") => {
    const c = await api.createConversation(id, { passage: m.text, context, locator: m.locator, memoId: m.id });
    setConvs((cs) => [c, ...cs]);
    setOpenConv(c.id);
    setPanel("ai");
  };

  const showMemo = (m: Memo) => {
    if (m.kind === "highlight") {
      view.current?.goTo(m.locator);
      setActive(m.id);
      setEditing(false);
    }
    if (narrow()) setPanel(null);
  };

  const onSaved = (r: Saved) => {
    if (r.memo) setMemos((ms) => ms.map((x) => (x.id === r.memo!.id ? r.memo! : x)));
    if (r.note) setNote(r.note);
  };

  const actions: MemoActions = {
    onChange: async (m, p) => {
      setMemos((ms) => ms.map((x) => (x.id === m.id ? { ...x, ...p } : x)));
      const u = await api.updateMemo(m.id, p);
      setMemos((ms) => ms.map((x) => (x.id === u.id ? u : x)));
    },
    onDelete: async (m) => {
      const n = convCount[m.id] ?? 0;
      if (m.kind === "highlight" && (m.body.trim() || n) && !confirm(`このメモを削除しますか？${n ? "\n（AI との会話は残ります）" : ""}`)) return;
      await api.deleteMemo(m.id);
      setMemos((ms) => ms.filter((x) => x.id !== m.id));
      setConvs((cs) => cs.map((c) => (c.memoId === m.id ? { ...c, memoId: null } : c)));
      if (active === m.id) setActive(null);
    },
    onJump: showMemo,
    onAsk: (m) => ask(m),
    onOpenConv: (cid) => {
      setOpenConv(cid);
      setPanel("ai");
    },
  };

  if (!book || initial === undefined) return <div className="loading">読み込み中…</div>;

  const View = book.format === "pdf" ? PdfView : EpubView;

  return (
    <div className={`reader ${immersive && !panel ? "immersive" : ""}`} data-theme={settings.theme}>
      <div className="reader-body">
        <div className={`viewer ${marginOn ? "has-margin" : ""}`} ref={viewer}>
          <View
            ref={view}
            url={api.fileUrl(book.id)}
            bookId={book.id}
            initial={initial}
            marks={marks}
            settings={settings}
            onReady={onReady}
            onRelocate={onRelocate}
            onSelect={onSelect}
            onMarkClick={onMarkClick}
            onCenterTap={onCenterTap}
            onLayout={onLayout}
            zoom={zoom}
          />
          {marginOn && (
            <MemoMargin
              memos={marginMemos}
              convs={convs}
              active={active}
              editing={editing}
              layoutTick={layoutTick}
              getAnchors={getAnchors}
              onActivate={(mid) => {
                setActive(mid);
                setEditing(false);
              }}
              onEditingChange={setEditing}
              aiEnabled={status.aiEnabled}
              {...actions}
              onJump={undefined}
            />
          )}
        </div>

        {panel && (
          <aside className="panel">
            <div className="panel-tabs">
              {(["toc", "note", "ai", "settings"] as PanelTab[]).map((t) => (
                <button key={t} className={panel === t ? "active" : ""} onClick={() => setPanel(t)}>
                  {{ toc: "目次", note: "ノート", ai: "AI", settings: "表示" }[t]}
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
              {panel === "note" &&
                (note ? (
                  <BookNote
                    note={note}
                    bookTitle={book.title}
                    memos={memos}
                    convs={convs}
                    focus={active}
                    aiEnabled={status.aiEnabled}
                    onNoteChange={setNote}
                    onMemoCreated={(m) => setMemos((ms) => [...ms, m])}
                    {...actions}
                  />
                ) : (
                  <div className="empty">読み込み中…</div>
                ))}
              {panel === "ai" && (
                <AiPanel
                  list={convs}
                  memos={memos}
                  openId={openConv}
                  onOpen={setOpenConv}
                  onReload={reloadConvs}
                  onJump={jump}
                  onShowMemo={showMemo}
                  onSaved={onSaved}
                  enabled={status.aiEnabled}
                />
              )}
              {panel === "settings" && <SettingsPanel settings={settings} onChange={setSettings} isPdf={book.format === "pdf"} />}
            </div>
          </aside>
        )}
      </div>

      {activeMemo && !marginOn && !panel && (
        <div className="memo-sheet" role="dialog" aria-label="メモ">
          <button className="icon-btn memo-sheet-close" onClick={() => setActive(null)} aria-label="閉じる">×</button>
          <MemoCard
            memo={activeMemo}
            convs={convs.filter((c) => c.memoId === activeMemo.id)}
            variant="sheet"
            editing={editing}
            onEditingChange={setEditing}
            aiEnabled={status.aiEnabled}
            {...actions}
            onJump={undefined}
          />
        </div>
      )}

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
            ["note", "✎", "ノート"],
            ["ai", "✦", "AI"],
          ] as [PanelTab, string, string][]).map(([t, icon, label]) => (
            <button key={t} className={`icon-btn ${panel === t ? "active" : ""}`} onClick={() => togglePanel(t)} title={label} aria-label={label}>
              {icon}
            </button>
          ))}
        </div>
      </footer>

      {sel && (
        <SelectionPopup
          sel={sel}
          aiEnabled={status.aiEnabled}
          onHighlight={(c) => createFromSelection(c, "highlight")}
          onMemo={() => createFromSelection("yellow", "write")}
          onAsk={() => createFromSelection("yellow", "ask")}
          onCopy={() => { navigator.clipboard.writeText(sel.text); clearSel(); toast("コピーしました"); }}
        />
      )}
    </div>
  );
}

function SelectionPopup({
  sel, aiEnabled, onHighlight, onMemo, onAsk, onCopy,
}: {
  sel: Selection;
  aiEnabled: boolean;
  onHighlight: (color: string) => void;
  onMemo: () => void;
  onAsk: () => void;
  onCopy: () => void;
}) {
  // Place below the selection (above if near the bottom) so native mobile menus don't overlap.
  const below = sel.rect.bottom + 70 < window.innerHeight - 96; // keep clear of the bottom dock
  const top = below ? sel.rect.bottom + 12 : Math.max(8, sel.rect.top - 56);
  const half = Math.min(190, window.innerWidth / 2); // the popup wraps to fit narrow screens
  const left = Math.min(Math.max(sel.rect.left + sel.rect.width / 2, half), window.innerWidth - half);
  return (
    <div className="sel-pop" style={{ top, left }} onMouseDown={(e) => e.preventDefault()}>
      {Object.entries(highlightColors).slice(0, 4).map(([name, c]) => (
        <button key={name} className="swatch" style={{ background: c }} title={`ハイライト（${name}）`} onClick={() => onHighlight(name)} />
      ))}
      <span className="sep" />
      <button onClick={onMemo} title="この箇所にメモを書く">メモ</button>
      {aiEnabled && <button onClick={onAsk} title="この箇所について AI に聞く（会話はメモに紐づきます）">✦ AIに聞く</button>}
      <button onClick={onCopy}>コピー</button>
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
      <div className="field">
        <label className="row" style={{ gap: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={settings.margin} onChange={(e) => onChange({ ...settings, margin: e.target.checked })} />
          メモを本文の横の余白に表示する（画面の広いとき）
        </label>
      </div>
      <p className="small muted">表示設定はこの端末にのみ保存されます。読書位置・メモ・ノートは全端末で同期されます。</p>
    </div>
  );
}
