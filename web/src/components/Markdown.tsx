import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true });

export function renderMarkdown(src: string): string {
  return DOMPurify.sanitize(marked.parse(src, { async: false }) as string);
}

export default function Markdown({ text, className = "" }: { text: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className={`md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
