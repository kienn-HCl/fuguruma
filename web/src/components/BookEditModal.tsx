import { useState } from "react";
import { api, Book, Tag } from "../api";
import Modal from "./Modal";
import { offlineSupported, removeBook, saveBook, useOfflineEntries, useOnline } from "../offline";
import { toast } from "./Toast";

export default function BookEditModal({
  book, tags, onClose, onSaved, onTagsChanged, onDeleted,
}: {
  book: Book;
  tags: Tag[];
  onClose: () => void;
  onSaved: (b: Book) => void;
  onTagsChanged: () => void;
  onDeleted: () => void;
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

  const remove = async () => {
    const ok = confirm(
      `「${book.title}」を本棚から削除しますか？\n\n` +
        "メモ・AI との会話・読書位置・タグ付けは削除されます。\nこの本のノートは、メモを書き写したうえで本に紐づかないノートとして残ります。\n\n" +
        "あとで同じファイルを置いても、新しい本として登録されます。",
    );
    if (!ok) return;
    try {
      await api.deleteBook(book.id);
      toast(`「${book.title}」を本棚から削除しました`);
      onDeleted();
      onClose();
    } catch (e) {
      toast((e as Error).message);
    }
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
      {offlineSupported && !book.missing && <OfflineField book={book} />}
      <p className="small muted" style={{ wordBreak: "break-all" }}>{book.path}</p>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn ghost" onClick={onClose}>キャンセル</button>
        <button className="btn primary" onClick={save}>保存</button>
      </div>
      {book.missing && (
        <div className="danger-zone">
          <p className="small muted" style={{ marginTop: 0 }}>
            この本のファイルは見つかりません。ファイルを本のディレクトリに戻すと元に戻ります。不要なら本棚から削除できます（ファイルの削除は行いません）。
          </p>
          <button className="btn danger" onClick={remove}>本棚から削除</button>
        </div>
      )}
    </Modal>
  );
}

/** Save the book on this device for reading offline, or forget it. */
function OfflineField({ book }: { book: Book }) {
  const entry = useOfflineEntries()[book.id];
  const online = useOnline();
  const [progress, setProgress] = useState<number | null>(null);

  const save = async () => {
    setProgress(0);
    try {
      await saveBook(book, "manual", setProgress);
      toast(`「${book.title}」をこの端末に保存しました`);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="field">
      <label>オフライン</label>
      <div className="row" style={{ flexWrap: "wrap" }}>
        {progress !== null ? (
          <span className="small">保存中… {Math.round(progress * 100)}%</span>
        ) : entry?.mode === "manual" ? (
          <>
            <span className="small">⤓ この端末に保存済み（{formatSize(entry.size)}）</span>
            <button className="btn small" onClick={() => removeBook(book.id)}>保存を解除</button>
          </>
        ) : (
          <>
            <span className="small muted">
              {entry ? `最近開いた本として自動で保存済み（${formatSize(entry.size)}）` : "この端末には保存されていません"}
            </span>
            <button className="btn small" onClick={save} disabled={!online} title="オフラインでも読めるように、本とメモをこの端末に保存します">
              ⤓ この端末に保存
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function randomColor() {
  const colors = ["#e07a5f", "#3d85c6", "#6aa84f", "#b4a7d6", "#f1c232", "#76a5af", "#c27ba0", "#8e7cc3", "#e69138"];
  return colors[Math.floor(Math.random() * colors.length)];
}
