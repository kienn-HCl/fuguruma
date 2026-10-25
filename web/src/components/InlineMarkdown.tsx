import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "./Markdown";

/**
 * Markdown shown as rendered text; clicking it switches to a textarea that
 * grows with its content. Changes are saved after a pause and on blur.
 */
export default function InlineMarkdown({
  value, onSave, onDone, placeholder, editing, onEditingChange, className = "",
}: {
  value: string;
  onSave: (v: string) => Promise<unknown> | void;
  /** Called with the final text when editing ends. */
  onDone?: (v: string) => void;
  placeholder: string;
  /** Controlled edit state (optional). */
  editing?: boolean;
  onEditingChange?: (v: boolean) => void;
  className?: string;
}) {
  const [own, setOwn] = useState(false);
  const isEditing = editing ?? own;
  const setEditing = (v: boolean) => {
    setOwn(v);
    onEditingChange?.(v);
  };
  const [text, setText] = useState(value);
  const saved = useRef(value);
  const ta = useRef<HTMLTextAreaElement>(null);

  // Follow changes made elsewhere (e.g. an AI summary appended) unless they would clobber typing.
  useEffect(() => {
    if (!isEditing || text === saved.current) setText(value);
    saved.current = value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const flush = (v = text) => {
    if (v === saved.current) return;
    saved.current = v;
    onSave(v);
  };

  useEffect(() => {
    if (!isEditing) return;
    const t = setTimeout(() => flush(), 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, isEditing]);

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [text, isEditing]);

  useEffect(() => {
    if (!isEditing || !ta.current) return;
    const el = ta.current;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, [isEditing]);

  if (isEditing) {
    return (
      <textarea
        ref={ta}
        className={`inline-md-input ${className}`}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          flush();
          setEditing(false);
          onDone?.(text);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            (e.target as HTMLTextAreaElement).blur();
          }
        }}
      />
    );
  }
  return (
    <div
      className={`inline-md ${className}`}
      role="button"
      tabIndex={0}
      title="クリックして編集"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a")) return;
        setEditing(true);
      }}
      onKeyDown={(e) => e.key === "Enter" && setEditing(true)}
    >
      {text.trim() ? <Markdown text={text} /> : <span className="placeholder">{placeholder}</span>}
    </div>
  );
}
