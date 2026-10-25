import { useState } from "react";
import { api, Book, Tag } from "../api";
import Modal from "./Modal";
import { toast } from "./Toast";

export default function BookEditModal({
  book, tags, onClose, onSaved, onTagsChanged,
}: {
  book: Book;
  tags: Tag[];
  onClose: () => void;
  onSaved: (b: Book) => void;
  onTagsChanged: () => void;
}) {
  const [title, setTitle] = useState(book.title);
  const [author, setAuthor] = useState(book.author);
  const [sel, setSel] = useState<Set<number>>(new Set(book.tags.map((t) => t.id)));
  const [newTag, setNewTag] = useState("");
  const [allTags, setAllTags] = useState(tags);

  const toggle = (id: number) => {
    const s = new Set(sel);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setSel(s);
  };

  const addTag = async () => {
    const name = newTag.trim();
    if (!name) return;
    try {
      const t = await api.createTag(name, randomColor());
      setAllTags([...allTags, t]);
      setSel(new Set([...sel, t.id]));
      setNewTag("");
      onTagsChanged();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const save = async () => {
    await api.updateBook(book.id, { title, author });
    const b = await api.setBookTags(book.id, [...sel]);
    onSaved(b);
    onClose();
  };

  return (
    <Modal title="本の情報" onClose={onClose}>
      <div className="field">
        <label>タイトル</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label>著者</label>
        <input className="input" value={author} onChange={(e) => setAuthor(e.target.value)} />
      </div>
      <div className="field">
        <label>タグ</label>
        <div className="tag-pick">
          {allTags.map((t) => (
            <button key={t.id} className={`chip ${sel.has(t.id) ? "active" : ""}`} onClick={() => toggle(t.id)}>
              <span className="dot" style={{ background: t.color }} />
              {t.name}
            </button>
          ))}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <input
            className="input"
            placeholder="新しいタグ"
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addTag()}
          />
          <button className="btn" onClick={addTag}>追加</button>
        </div>
      </div>
      <p className="small muted" style={{ wordBreak: "break-all" }}>{book.path}</p>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn ghost" onClick={onClose}>キャンセル</button>
        <button className="btn primary" onClick={save}>保存</button>
      </div>
    </Modal>
  );
}

export function randomColor() {
  const colors = ["#e07a5f", "#3d85c6", "#6aa84f", "#b4a7d6", "#f1c232", "#76a5af", "#c27ba0", "#8e7cc3", "#e69138"];
  return colors[Math.floor(Math.random() * colors.length)];
}
