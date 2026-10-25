import { Conversation, Memo } from "../api";
import { highlightColors } from "../reader/types";
import InlineMarkdown from "./InlineMarkdown";

export interface MemoActions {
  onChange: (m: Memo, p: { color?: string; body?: string }) => Promise<unknown> | void;
  onDelete: (m: Memo) => void;
  /** Go to the memo's place in the book. */
  onJump?: (m: Memo) => void;
  /** Start a new AI conversation about the memo's passage. */
  onAsk?: (m: Memo) => void;
  onOpenConv?: (id: string) => void;
}

/**
 * A memo: where it is, the quoted passage, its Markdown body and the AI
 * conversations about it.
 * - "note": in the book's note (all details)
 * - "margin": next to the passage in the reader; details only while active
 * - "sheet": the bottom sheet on narrow screens
 */
export default function MemoCard({
  memo, convs, variant, active = true, editing, onEditingChange, aiEnabled, ...a
}: MemoActions & {
  memo: Memo;
  convs: Conversation[];
  variant: "note" | "margin" | "sheet";
  active?: boolean;
  editing?: boolean;
  onEditingChange?: (v: boolean) => void;
  aiEnabled: boolean;
}) {
  const color = highlightColors[memo.color] ?? memo.color;
  const details = variant !== "margin" || active;
  return (
    <div className={`memo-card ${variant} ${active ? "active" : ""}`} style={{ ["--mc" as string]: color }} data-memo={memo.id}>
      <div className="memo-head">
        {a.onJump ? (
          <button className="memo-place" onClick={() => a.onJump!(memo)} title="本文のこの位置へ">
            場所: {memo.label || "—"}
          </button>
        ) : (
          <span className="memo-place">場所: {memo.label || "—"}</span>
        )}
        <div className="spacer" />
        {convs.length > 0 && !details && <span className="memo-badge" title="AI との会話">✦ {convs.length}</span>}
      </div>
      {variant !== "margin" && memo.text && (
        <blockquote className={`quote ${variant === "note" ? "full" : ""}`} style={{ ["--qc" as string]: color }}>
          {memo.text}
        </blockquote>
      )}
      <InlineMarkdown
        className="memo-body"
        value={memo.body}
        placeholder={variant === "note" ? "メモを書く…" : "メモを書く…（Markdown）"}
        editing={editing}
        onEditingChange={onEditingChange}
        onSave={(body) => a.onChange(memo, { body })}
      />
      {details && convs.length > 0 && (
        <div className="memo-convs">
          {convs.map((c) => (
            <button key={c.id} className="chip" onClick={() => a.onOpenConv?.(c.id)} disabled={!a.onOpenConv} title="AI との会話を開く">
              ✦ {c.title || "（無題の会話）"}
            </button>
          ))}
        </div>
      )}
      {details && (
        <div className="memo-actions">
          {Object.entries(highlightColors).map(([name, c]) => (
            <button
              key={name}
              className={`dot ${memo.color === name ? "on" : ""}`}
              style={{ background: c }}
              aria-label={`色: ${name}`}
              onClick={() => a.onChange(memo, { color: name })}
            />
          ))}
          <div className="spacer" />
          {aiEnabled && a.onAsk && <button className="btn ghost small" onClick={() => a.onAsk!(memo)}>✦ AIに聞く</button>}
          <button className="btn ghost small danger" onClick={() => a.onDelete(memo)}>削除</button>
        </div>
      )}
    </div>
  );
}
