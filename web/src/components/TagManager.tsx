import { useState } from "react";
import { api, Tag } from "../api";
import Modal from "./Modal";
import { randomColor } from "./BookEditModal";

export default function TagManager({ tags, onClose, onChanged }: { tags: Tag[]; onClose: () => void; onChanged: () => void }) {
  const [name, setName] = useState("");
  const update = async (t: Tag, p: { name?: string; color?: string }) => {
    await api.updateTag(t.id, p);
    onChanged();
  };
  const remove = async (t: Tag) => {
    if (!confirm(`タグ「${t.name}」を削除しますか？（本は削除されません）`)) return;
    await api.deleteTag(t.id);
    onChanged();
  };
  const add = async () => {
    if (!name.trim()) return;
    await api.createTag(name.trim(), randomColor());
    setName("");
    onChanged();
  };
  return (
    <Modal title="タグの管理" onClose={onClose}>
      {tags.length === 0 && <p className="muted small">タグはまだありません</p>}
      {tags.map((t) => (
        <div className="row" key={t.id} style={{ marginBottom: 8 }}>
          <input type="color" value={t.color} onChange={(e) => update(t, { color: e.target.value })} style={{ width: 32, height: 32, border: "none", background: "none" }} />
          <input className="input" defaultValue={t.name} onBlur={(e) => e.target.value !== t.name && update(t, { name: e.target.value })} />
          <span className="small muted" style={{ minWidth: 32 }}>{t.count}冊</span>
          <button className="btn ghost danger small" onClick={() => remove(t)}>削除</button>
        </div>
      ))}
      <div className="row" style={{ marginTop: 12 }}>
        <input className="input" placeholder="新しいタグ" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <button className="btn" onClick={add}>追加</button>
      </div>
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
        <button className="btn primary" onClick={onClose}>閉じる</button>
      </div>
    </Modal>
  );
}
