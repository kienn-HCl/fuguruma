import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Conversation, Memo } from "../api";
import MemoCard, { MemoActions } from "../components/MemoCard";
import { Anchor, highlightColors } from "./types";

const GAP = 8;

/**
 * Memo cards in a margin beside the text, each next to its passage and joined
 * to it by a line. Cards that would overlap are pushed down (and back up if
 * they run past the bottom).
 */
export default function MemoMargin({
  memos, convs, active, editing, layoutTick, getAnchors, onActivate, onEditingChange, aiEnabled, ...actions
}: MemoActions & {
  /** Memos to show when their passage is on screen. */
  memos: Memo[];
  convs: Conversation[];
  active: string | null;
  editing: boolean;
  /** Changes whenever the text moves (page turn, resize, …). */
  layoutTick: number;
  getAnchors: () => Record<string, Anchor>;
  onActivate: (id: string | null) => void;
  onEditingChange: (v: boolean) => void;
  aiEnabled: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [anchors, setAnchors] = useState<Record<string, Anchor>>({});
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [box, setBox] = useState<DOMRect | null>(null);
  const cards = useRef(new Map<string, HTMLDivElement>());
  const editingNow = useRef(editing);
  editingNow.current = editing;

  const measure = useCallback(() => {
    const parent = root.current?.parentElement;
    if (!parent) return;
    setBox(parent.getBoundingClientRect());
    const next = getAnchors();
    // While the text is re-laid out (e.g. the margin just appeared) a passage can be
    // briefly unfindable; keep the card being edited where it was instead of removing it.
    setAnchors((prev) => (editingNow.current && active && !next[active] && prev[active] ? { ...next, [active]: prev[active] } : next));
  }, [getAnchors, active]);

  // The views draw asynchronously, so measure again shortly after a change.
  useEffect(() => {
    let raf = requestAnimationFrame(measure);
    const t1 = setTimeout(measure, 120);
    const t2 = setTimeout(measure, 500);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [layoutTick, memos, measure]);

  const shown = memos.filter((m) => anchors[m.id]).sort((a, b) => anchors[a.id].top - anchors[b.id].top || anchors[a.id].left - anchors[b.id].left);

  useLayoutEffect(() => {
    const next: Record<string, number> = {};
    let changed = false;
    for (const m of shown) {
      const h = cards.current.get(m.id)?.offsetHeight ?? 0;
      next[m.id] = h;
      if (heights[m.id] !== h) changed = true;
    }
    if (changed) setHeights(next);
  });

  // Re-measure card heights while one is being edited (it grows as you type).
  useEffect(() => {
    if (!active) return;
    const el = cards.current.get(active);
    if (!el) return;
    const ro = new ResizeObserver(() => setHeights((h) => (h[active] === el.offsetHeight ? h : { ...h, [active]: el.offsetHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, [active, shown.length]);

  if (!box) return <div className="memo-margin" ref={root} />;

  const marginLeft = root.current ? root.current.getBoundingClientRect().left - box.left : box.width - 320;
  // Desired tops (relative to the viewer), then resolve overlaps.
  const tops = shown.map((m) => Math.max(GAP, anchors[m.id].top - box.top - 6));
  for (let i = 1; i < tops.length; i++) {
    const prev = tops[i - 1] + (heights[shown[i - 1].id] ?? 60) + GAP;
    if (tops[i] < prev) tops[i] = prev;
  }
  const bottom = box.height - GAP;
  for (let i = tops.length - 1; i >= 0; i--) {
    const limit = (i === tops.length - 1 ? bottom : tops[i + 1] - GAP) - (heights[shown[i].id] ?? 60);
    if (tops[i] > limit) tops[i] = Math.max(GAP, limit);
  }

  return (
    <>
      <svg className="memo-lines" width={box.width} height={box.height} aria-hidden>
        {shown.map((m, i) => {
          const a = anchors[m.id];
          const x0 = a.right - box.left;
          const y0 = a.bottom - box.top;
          const gx = marginLeft - 10;
          const y1 = tops[i] + 16;
          return (
            <path
              key={m.id}
              className={m.id === active ? "on" : ""}
              d={`M ${x0} ${y0} H ${Math.max(x0, gx)} L ${marginLeft + 2} ${y1}`}
              style={{ ["--mc" as string]: highlightColors[m.color] ?? m.color }}
            />
          );
        })}
      </svg>
      <div className="memo-margin" ref={root}>
        {shown.map((m, i) => (
          <div
            key={m.id}
            className="memo-slot"
            style={{ top: tops[i] }}
            ref={(el) => {
              if (el) cards.current.set(m.id, el);
              else cards.current.delete(m.id);
            }}
            onClick={() => m.id !== active && onActivate(m.id)}
          >
            <MemoCard
              memo={m}
              convs={convs.filter((c) => c.memoId === m.id)}
              variant="margin"
              active={m.id === active}
              editing={m.id === active ? editing : false}
              onEditingChange={onEditingChange}
              aiEnabled={aiEnabled}
              {...actions}
            />
          </div>
        ))}
      </div>
    </>
  );
}
