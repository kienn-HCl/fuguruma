import { Highlight, Locator } from "../api";

export interface TocItem {
  label: string;
  href: string;
  depth: number;
}

export interface Selection {
  text: string;
  /** Text around the selection, sent to the AI as context. */
  context: string;
  locator: Locator;
  /** Bounding box of the selection in viewport coordinates. */
  rect: { left: number; top: number; bottom: number; width: number };
}

export interface ReaderSettings {
  theme: "light" | "sepia" | "dark";
  fontSize: number; // percent, EPUB only
  /** EPUB body font: the book's own CSS, or a forced gothic / mincho stack. */
  font: "book" | "sans" | "serif";
}

/** Imperative API shared by the EPUB and PDF views. */
export interface ReaderHandle {
  next(): void;
  prev(): void;
  goTo(loc: Locator | string): void;
  /** Go to a fraction (0..1) of the book. */
  goToPercent(p: number): void;
  clearSelection(): void;
}

export interface ReaderViewProps {
  url: string;
  bookId: string;
  initial: Locator | null;
  highlights: Highlight[];
  settings: ReaderSettings;
  onReady(toc: TocItem[]): void;
  onRelocate(loc: Locator, percent: number | null, label: string): void;
  onSelect(sel: Selection | null): void;
  onHighlightClick(id: string): void;
  /** Tap in the middle of the page. */
  onCenterTap(): void;
  /** PDF only: zoom factor relative to fitting the page (1 = fit). */
  zoom?: number;
}

export const highlightColors: Record<string, string> = {
  yellow: "#ffe066",
  green: "#a8e6a1",
  blue: "#9fd3ff",
  pink: "#ffb3c7",
  purple: "#d4b8ff",
};

/** Extract up to `radius` characters on each side of [start, end) in text. */
export function surrounding(text: string, start: number, end: number, radius = 1500) {
  const s = Math.max(0, start - radius);
  const e = Math.min(text.length, end + radius);
  return (s > 0 ? "…" : "") + text.slice(s, e) + (e < text.length ? "…" : "");
}
