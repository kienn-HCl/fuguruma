import { ReactNode, useEffect, useRef, useState } from "react";
import { api, Conversation, Memo, Note } from "../api";
import { compareLocators, sortMemos } from "../memos";
import InlineMarkdown from "./InlineMarkdown";
import MemoCard, { MemoActions } from "./MemoCard";

/**
 * The note of a book: a Markdown introduction, then every memo in reading
 * order with free text that can be written between them.
 */
export default function BookNote({
  note, bookTitle, memos, convs, aiEnabled, focus, extra, onNoteChange, onMemoCreated, ...actions
}: MemoActions & {
  note: Note;
  bookTitle: string;
  memos: Memo[];
  convs: Conversation[];
  aiEnabled: boolean;
  /** Memo to scroll to. */
  focus?: string | null;
  /** Shown next to the title (e.g. a link to the book). */
  extra?: ReactNode;
  onNoteChange: (n: Note) => void;
  onMemoCreated: (m: Memo) => void;
}) {
  const [title, setTitle] = useState(note.title);
  const [fresh, setFresh] = useState<string | null>(null); // text memo just added: open in the editor
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => setTitle(note.title), [note.id, note.title]);

  useEffect(() => {
    if (!focus) return;
    const el = root.current?.querySelector(`[data-memo="${focus}"]`);
    el?.scrollIntoView({ block: "center" });
  }, [focus]);

  const sorted = sortMemos(memos);
  const convsOf = (id: string) => convs.filter((c) => c.memoId === id);

  // Free text goes right after `after`, before the next item at the same position.
  const addText = async (after: Memo, i: number) => {
    const next = sorted[i + 1];
    const sameSpot = next && next.kind === "text" && compareLocators(next.locator, after.locator) === 0;
    const sort =
      after.kind === "text" ? (sameSpot ? (after.sort + next.sort) / 2 : after.sort + 1) : sameSpot ? next.sort - 1 : Date.now();
    const m = await api.createMemo(after.bookId, { kind: "text", locator: after.locator, label: after.label, text: "", body: "", sort });
    setFresh(m.id);
    onMemoCreated(m);
  };

  const saveNote = async (p: { title?: string; body?: string }) => onNoteChange(await api.updateNote(note.id, p));

  return (
    <div className="book-note" ref={root}>
      <div className="book-note-head">
        <input
          className="editor-title"
          value={title}
          placeholder={`${bookTitle} 読書メモ`}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title !== note.title && saveNote({ title })}
        />
        {extra}
      </div>
      <InlineMarkdown
        className="book-note-intro"
        value={note.body}
        placeholder="この本についてのメモ…（全体の感想や、下のメモのまとめなど。Markdown で書けます）"
        onSave={(body) => saveNote({ body })}
      />
      {sorted.length === 0 && (
        <div className="empty small">本文を選択して「メモ」や「AIに聞く」を使うと、ここに本文の順で並びます。</div>
      )}
      {sorted.map((m, i) => (
        <div key={m.id} className="book-note-item">
          {m.kind === "highlight" ? (
            <MemoCard memo={m} convs={convsOf(m.id)} variant="note" aiEnabled={aiEnabled} {...actions} />
          ) : (
            <div className="note-text" data-memo={m.id}>
              <InlineMarkdown
                value={m.body}
                placeholder="文章を書く…"
                editing={fresh === m.id ? true : undefined}
                onEditingChange={(v) => !v && setFresh(null)}
                onDone={(v) => !v.trim() && actions.onDelete(m)}
                onSave={(body) => actions.onChange(m, { body })}
              />
              <button className="icon-btn note-text-del" onClick={() => actions.onDelete(m)} aria-label="この文章を削除" title="この文章を削除">×</button>
            </div>
          )}
          <button className="note-insert" onClick={() => addText(m, i)} title="ここに文章を追加">＋ 文章</button>
        </div>
      ))}
    </div>
  );
}
