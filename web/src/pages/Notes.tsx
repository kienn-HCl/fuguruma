import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, Conversation, Memo, Note, readerUrl } from "../api";
import { useStatus } from "../App";
import BookNote from "../components/BookNote";
import { MemoActions } from "../components/MemoCard";
import NoteEditor from "../components/NoteEditor";

export default function Notes() {
  const { id } = useParams();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [notes, setNotes] = useState<Note[]>([]);
  const [current, setCurrent] = useState<Note | null>(null);

  useEffect(() => {
    const t = setTimeout(() => api.notes({ q: q || undefined }).then(setNotes), 200);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (id) api.note(id).then(setCurrent).catch(() => setCurrent(null));
    else setCurrent(null);
  }, [id]);

  const updated = (n: Note) => {
    setCurrent(n);
    setNotes((ns) => [n, ...ns.filter((x) => x.id !== n.id)]);
  };

  const create = async () => {
    const n = await api.createNote({ title: "", body: "" });
    setNotes([n, ...notes]);
    nav(`/notes/${n.id}`);
  };

  const remove = async () => {
    if (!current || !confirm("このノートを削除しますか？")) return;
    await api.deleteNote(current.id);
    setNotes(notes.filter((n) => n.id !== current.id));
    nav("/notes");
  };

  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand"><img src="/favicon.svg" alt="" />文車</Link>
        <strong>ノート</strong>
        <div className="spacer" />
        <button className="btn primary" onClick={create} title="本に紐づかないノートを作ります">＋ 新規</button>
      </header>
      <div className={`notes-layout ${id ? "has-note" : ""}`}>
        <aside className="notes-list">
          <div style={{ padding: 10 }}>
            <input className="input" placeholder="ノートとメモを検索" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {notes.length === 0 && <div className="empty">ノートはまだありません。<br />本を読みながらメモを残すと、本ごとのノートができます。</div>}
          {notes.map((n) => (
            <div key={n.id} className="list-item" style={n.id === id ? { background: "var(--surface-2)" } : undefined} onClick={() => nav(`/notes/${n.id}`)}>
              <div style={{ fontWeight: 600 }}>{n.bookId ? `📖 ${n.title || n.bookTitle}` : n.title || "無題のノート"}</div>
              <div className="small muted" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {n.bookId && <>メモ {n.memoCount} 件 · </>}
                {new Date(n.updatedAt).toLocaleString()}
              </div>
            </div>
          ))}
        </aside>
        <main className="notes-main">
          {current?.bookId ? (
            <BookNotePage key={current.id} note={current} onChange={updated} onBack={() => nav("/notes")} />
          ) : current ? (
            <NoteEditor note={current} onBack={() => nav("/notes")} onDelete={remove} onChange={updated} />
          ) : (
            <div className="empty">ノートを選択してください</div>
          )}
        </main>
      </div>
    </>
  );
}

/** A book's note outside the reader: memos link back into the book. */
function BookNotePage({ note, onChange, onBack }: { note: Note; onChange: (n: Note) => void; onBack: () => void }) {
  const nav = useNavigate();
  const status = useStatus();
  const bookId = note.bookId!;
  const [memos, setMemos] = useState<Memo[] | null>(null);
  const [convs, setConvs] = useState<Conversation[]>([]);

  useEffect(() => {
    api.memos(bookId).then(setMemos);
    api.conversations(bookId).then(setConvs);
  }, [bookId]);

  const actions: MemoActions = {
    onChange: async (m, p) => {
      setMemos((ms) => ms!.map((x) => (x.id === m.id ? { ...x, ...p } : x)));
      const u = await api.updateMemo(m.id, p);
      setMemos((ms) => ms!.map((x) => (x.id === u.id ? u : x)));
    },
    onDelete: async (m) => {
      if (m.kind === "highlight" && !confirm("このメモを削除しますか？")) return;
      await api.deleteMemo(m.id);
      setMemos((ms) => ms!.filter((x) => x.id !== m.id));
    },
    onJump: (m) => nav(readerUrl(bookId, { at: m.locator, memo: m.kind === "highlight" ? m.id : undefined })),
    onAsk: async (m) => {
      const c = await api.createConversation(bookId, { passage: m.text, context: "", locator: m.locator, memoId: m.id });
      nav(readerUrl(bookId, { at: m.locator, memo: m.id, conv: c.id }));
    },
    onOpenConv: (cid) => {
      const m = memos?.find((x) => x.id === convs.find((c) => c.id === cid)?.memoId);
      nav(readerUrl(bookId, { at: m?.locator, memo: m?.id, conv: cid }));
    },
  };

  return (
    <div className="editor">
      <div className="editor-head">
        <button className="icon-btn" onClick={onBack} aria-label="戻る">‹</button>
        <span className="small muted" style={{ flex: 1 }}>📖 {note.bookTitle}</span>
        <Link className="btn small" to={readerUrl(bookId)}>本を開く</Link>
      </div>
      <div className="editor-scroll">
        {memos ? (
          <BookNote
            note={note}
            bookTitle={note.bookTitle ?? ""}
            memos={memos}
            convs={convs}
            aiEnabled={status.aiEnabled}
            onNoteChange={onChange}
            onMemoCreated={(m) => setMemos((ms) => [...ms!, m])}
            {...actions}
          />
        ) : (
          <div className="empty">読み込み中…</div>
        )}
      </div>
    </div>
  );
}
