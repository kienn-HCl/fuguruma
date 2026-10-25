import { useRef, useState } from "react";
import { Tag, UploadError, uploadBook } from "../api";
import Modal from "./Modal";

type Item = {
  key: string;
  file: File;
  status: "waiting" | "uploading" | "done" | "duplicate" | "error";
  progress: number;
  message?: string;
  bookId?: string;
};

const accepted = [".epub", ".pdf"];
const isAccepted = (f: File) => accepted.some((ext) => f.name.toLowerCase().endsWith(ext));

function formatSize(bytes: number) {
  return bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

/** Upload dialog: pick or drop .epub / .pdf files, optionally tag them, upload one by one. */
export default function UploadModal({
  tags, maxMb, initialFiles = [], onClose, onUploaded, onOpenBook,
}: {
  tags: Tag[];
  maxMb: number;
  initialFiles?: File[];
  onClose: () => void;
  onUploaded: () => void;
  onOpenBook: (id: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Item[]>(() => toItems(initialFiles));
  const [tagIds, setTagIds] = useState<Set<number>>(new Set());
  const [dragging, setDragging] = useState(false);
  const [running, setRunning] = useState(false);

  function toItems(files: File[]): Item[] {
    return files.map((file, i) => {
      const item: Item = { key: `${Date.now()}-${i}-${file.name}`, file, status: "waiting", progress: 0 };
      if (!isAccepted(file)) return { ...item, status: "error", message: "対応していない形式です（.epub / .pdf のみ）" };
      if (maxMb > 0 && file.size > maxMb * (1 << 20)) return { ...item, status: "error", message: `大きすぎます（上限 ${maxMb} MB）` };
      return item;
    });
  }

  const add = (files: FileList | File[]) => {
    // Copy now: a FileList is emptied when the input is reset or the drop event ends.
    const added = toItems([...files]);
    setItems((cur) => [...cur, ...added]);
  };
  const update = (key: string, patch: Partial<Item>) => setItems((cur) => cur.map((it) => (it.key === key ? { ...it, ...patch } : it)));

  const start = async () => {
    setRunning(true);
    let uploaded = false;
    for (const it of items.filter((i) => i.status === "waiting")) {
      update(it.key, { status: "uploading", progress: 0 });
      try {
        const book = await uploadBook(it.file, [...tagIds], (p) => update(it.key, { progress: p }));
        update(it.key, { status: "done", progress: 1, bookId: book.id });
        uploaded = true;
      } catch (e) {
        const err = e as UploadError;
        update(it.key, { status: err.status === 409 ? "duplicate" : "error", message: err.message, bookId: err.bookId });
      }
    }
    setRunning(false);
    if (uploaded) onUploaded();
  };

  const waiting = items.filter((i) => i.status === "waiting").length;
  const toggleTag = (id: number) => {
    const s = new Set(tagIds);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setTagIds(s);
  };

  return (
    <Modal title="本を追加" onClose={() => !running && onClose()}>
      <div
        className={`dropzone ${dragging ? "over" : ""}`}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          add(e.dataTransfer.files);
        }}
      >
        <div style={{ fontSize: 28 }}>⤒</div>
        <div>ここにファイルをドロップ、またはクリックして選択</div>
        <div className="small muted">EPUB / PDF（1 ファイル {maxMb} MB まで）</div>
        <input
          ref={input}
          type="file"
          accept=".epub,.pdf,application/epub+zip,application/pdf"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) add(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {items.length > 0 && (
        <ul className="upload-list">
          {items.map((it) => (
            <li key={it.key}>
              <div className="row">
                <span className="name" title={it.file.name}>{it.file.name}</span>
                <span className="small muted">{formatSize(it.file.size)}</span>
                {it.status === "waiting" && !running && (
                  <button className="btn ghost small" aria-label="取り除く" onClick={() => setItems((cur) => cur.filter((x) => x.key !== it.key))}>×</button>
                )}
              </div>
              {it.status === "uploading" && <div className="pbar"><div style={{ width: `${Math.round(it.progress * 100)}%` }} /></div>}
              {it.status === "done" && <div className="small" style={{ color: "#2e7d32" }}>✓ 追加しました</div>}
              {(it.status === "error" || it.status === "duplicate") && (
                <div className="small" style={{ color: it.status === "error" ? "#c0392b" : "var(--muted)" }}>
                  {it.message}
                  {it.bookId && <button className="btn ghost small" onClick={() => onOpenBook(it.bookId!)}>開く</button>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {tags.length > 0 && (
        <div className="field">
          <label>追加する本に付けるタグ（任意）</label>
          <div className="tag-pick">
            {tags.map((t) => (
              <button key={t.id} className={`chip ${tagIds.has(t.id) ? "active" : ""}`} onClick={() => toggleTag(t.id)} disabled={running}>
                <span className="dot" style={{ background: t.color }} />
                {t.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <p className="small muted">アップロードしたファイルは本のディレクトリ内の決まったフォルダに新しく保存されます。既存のファイルが変更・上書きされることはありません。</p>

      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn ghost" onClick={onClose} disabled={running}>閉じる</button>
        <button className="btn primary" onClick={start} disabled={running || waiting === 0}>
          {running ? "アップロード中…" : `アップロード${waiting ? `（${waiting}）` : ""}`}
        </button>
      </div>
    </Modal>
  );
}
