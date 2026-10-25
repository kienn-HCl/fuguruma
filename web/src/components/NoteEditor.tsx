import { ReactNode, useEffect, useRef, useState } from "react";
import { api, Note } from "../api";
import Markdown from "./Markdown";

type Mode = "edit" | "preview" | "split";

/** Markdown note editor with debounced autosave. */
export default function NoteEditor({
  note, onChange, onDelete, onBack, compact = false, extra, autoFocus = false,
}: {
  note: Note;
  onChange?: (n: Note) => void;
  onDelete?: () => void;
  onBack?: () => void;
  compact?: boolean;
  /** Shown under the title, e.g. where in the book the note is pinned. */
  extra?: ReactNode;
  /** Focus the body (cursor at the end) when the editor opens. */
  autoFocus?: boolean;
}) {
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [mode, setMode] = useState<Mode>(() => (compact || window.innerWidth < 900 ? "edit" : "split"));
  const [saved, setSaved] = useState(true);
  const last = useRef({ title: note.title, body: note.body });
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!autoFocus || !ta.current) return;
    const el = ta.current;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    // Only when a note is opened, not on every save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id]);

  // Reload when a different note is opened or the note is updated elsewhere (e.g. AI export appended).
  useEffect(() => {
    setTitle(note.title);
    setBody(note.body);
    last.current = { title: note.title, body: note.body };
  }, [note.id, note.updatedAt]);

  useEffect(() => {
    if (title === last.current.title && body === last.current.body) return;
    setSaved(false);
    const t = setTimeout(async () => {
      const n = await api.updateNote(note.id, { title, body });
      last.current = { title, body };
      setSaved(true);
      onChange?.(n);
    }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, body]);

  // Wrap selected text (or insert at line start) for simple formatting shortcuts.
  const wrap = (before: string, after = "", linePrefix = false) => {
    const el = ta.current;
    if (!el) return;
    const { selectionStart: s, selectionEnd: e } = el;
    let next: string;
    if (linePrefix) {
      const ls = body.lastIndexOf("\n", s - 1) + 1;
      next = body.slice(0, ls) + before + body.slice(ls);
    } else {
      next = body.slice(0, s) + before + body.slice(s, e) + after + body.slice(e);
    }
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + before.length, e + before.length);
    });
  };

  return (
    <div className="editor">
      <div className="editor-head">
        {onBack && <button className="icon-btn" onClick={onBack} aria-label="戻る">‹</button>}
        <input className="editor-title" value={title} placeholder="無題のノート" onChange={(e) => setTitle(e.target.value)} />
        <span className="small muted">{saved ? "保存済み" : "保存中…"}</span>
      </div>
      {extra && <div className="editor-extra">{extra}</div>}
      <div className="row" style={{ padding: "6px 10px", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
        <button className="btn ghost small" onClick={() => wrap("## ", "", true)} title="見出し">H</button>
        <button className="btn ghost small" onClick={() => wrap("**", "**")} title="太字"><b>B</b></button>
        <button className="btn ghost small" onClick={() => wrap("> ", "", true)} title="引用">❝</button>
        <button className="btn ghost small" onClick={() => wrap("- ", "", true)} title="リスト">•</button>
        <div className="spacer" />
        {(["edit", "split", "preview"] as Mode[])
          .filter((m) => !(compact && m === "split"))
          .map((m) => (
            <button key={m} className={`btn small ${mode === m ? "" : "ghost"} ${m === "split" ? "only-wide" : ""}`} onClick={() => setMode(m)}>
              {{ edit: "編集", split: "並べる", preview: "プレビュー" }[m]}
            </button>
          ))}
        {onDelete && <button className="btn ghost small danger" onClick={onDelete}>削除</button>}
      </div>
      <div className={`editor-body ${mode === "split" ? "split" : ""}`}>
        {mode !== "preview" && (
          <textarea ref={ta} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Markdown で書けます" />
        )}
        {mode !== "edit" && <Markdown text={body || "*（空のノート）*"} />}
      </div>
    </div>
  );
}
