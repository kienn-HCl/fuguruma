import { EpubCFI } from "epubjs";
import { Locator, Memo } from "./api";

const cfi = new EpubCFI();

/** Compares two positions in a book (EPUB CFIs, or PDF page then top/left of the first rect). */
export function compareLocators(a: Locator, b: Locator): number {
  if (a.type === "epub" && b.type === "epub") {
    if (!a.cfi || !b.cfi) return a.cfi ? 1 : b.cfi ? -1 : 0;
    try {
      return cfi.compare(a.cfi, b.cfi);
    } catch {
      return 0;
    }
  }
  if (a.type === "pdf" && b.type === "pdf") {
    if (a.page !== b.page) return a.page - b.page;
    const ra = a.rects?.[0] ?? [0, 0];
    const rb = b.rects?.[0] ?? [0, 0];
    return Math.abs(ra[1] - rb[1]) > 0.005 ? ra[1] - rb[1] : ra[0] - rb[0];
  }
  return 0;
}

/**
 * Reading order: by position; at the same position a highlight comes before
 * the text memos that follow it, which keep their own order (sort).
 */
export function compareMemos(a: Memo, b: Memo): number {
  return (
    compareLocators(a.locator, b.locator) ||
    (a.kind === b.kind ? 0 : a.kind === "highlight" ? -1 : 1) ||
    a.sort - b.sort
  );
}

export const sortMemos = (memos: Memo[]) => [...memos].sort(compareMemos);

/** A memo has something to show besides the highlight itself. */
export const hasContent = (m: Memo, convCount = 0) => m.body.trim() !== "" || convCount > 0;
