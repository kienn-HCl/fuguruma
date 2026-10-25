import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, Note, readerUrl } from "../api";
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
        <button className="btn primary" onClick={create}>＋ 新規</button>
      </header>
      <div className={`notes-layout ${id ? "has-note" : ""}`}>
        <aside className="notes-list">
          <div style={{ padding: 10 }}>
            <input className="input" placeholder="ノートを検索" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {notes.length === 0 && <div className="empty">ノートはまだありません</div>}
          {notes.map((n) => (
            <div key={n.id} className="list-item" style={n.id === id ? { background: "var(--surface-2)" } : undefined} onClick={() => nav(`/notes/${n.id}`)}>
              <div style={{ fontWeight: 600 }}>{n.title || "無題のノート"}</div>
              <div className="small muted" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {n.bookTitle && <>📖 {n.bookTitle} · </>}
                {n.locator && <>📍 {n.locatorLabel || "位置あり"} · </>}
                {new Date(n.updatedAt).toLocaleString()}
              </div>
            </div>
          ))}
        </aside>
        <main className="notes-main">
          {current ? (
            <NoteEditor
              note={current}
              onBack={() => nav("/notes")}
              onDelete={remove}
              onChange={(n) => setNotes((ns) => ns.map((x) => (x.id === n.id ? n : x)))}
              extra={
                current.bookId ? (
                  <span className="pin">
                    📖 {current.bookTitle}
                    {current.locator ? (
                      <>
                        {" "}・ 📍 {current.locatorLabel || "位置あり"}
                        <Link to={readerUrl(current.bookId, current.locator)}>本文のこの位置を開く</Link>
                      </>
                    ) : (
                      <Link to={readerUrl(current.bookId)}>本を開く</Link>
                    )}
                  </span>
                ) : undefined
              }
            />
          ) : (
            <div className="empty">ノートを選択してください</div>
          )}
        </main>
      </div>
    </>
  );
}
