import { useEffect, useRef, useState } from "react";
import { selectionToRange, type SelectedRange } from "../../lib/anchors";

/** Tracks a text selection in the document; null when there's nothing to comment on. */
export function useSelection() {
  const [selection, setSelection] = useState<SelectedRange | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const update = () => setSelection(selectionToRange(getSelection()));
    const onChange = () => { clearTimeout(timer); timer = setTimeout(update, 150); };
    const onScroll = () => setSelection((s) => (s ? selectionToRange(getSelection()) : s));
    document.addEventListener("selectionchange", onChange);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearTimeout(timer);
      document.removeEventListener("selectionchange", onChange);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);
  const clear = () => { getSelection()?.removeAllRanges(); setSelection(null); };
  return { selection, clear };
}

/** The floating "Comment c · Ask Claude a" button above a selection. */
export function SelectionButton({ selection, claude, onComment }: { selection: SelectedRange | null; claude: boolean; onComment: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [left, setLeft] = useState(0);
  const rect = selection?.rect;
  useEffect(() => {
    if (!rect || !ref.current) return;
    setLeft(Math.max(8, rect.left + rect.width / 2 - ref.current.offsetWidth / 2));
  }, [rect]);
  return (
    <button
      ref={ref} hidden={!selection}
      style={rect ? { top: rect.top > 90 ? rect.top - 40 : rect.bottom + 8, left } : undefined}
      className="fixed z-50 flex items-center gap-1.5 rounded-full bg-stone-900 px-3 py-1.5 text-xs font-semibold text-white shadow-lg hover:bg-stone-700 dark:bg-amber-400 dark:text-stone-950"
      onMouseDown={(e) => e.preventDefault() /* keep the selection */}
      onClick={onComment}
    >
      <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5"><path d="M3 4.5A2.5 2.5 0 0 1 5.5 2h9A2.5 2.5 0 0 1 17 4.5v7a2.5 2.5 0 0 1-2.5 2.5H9l-4 3.5V14h.5A2.5 2.5 0 0 1 3 11.5v-7Z" /></svg>
      Comment <kbd className="ml-1 rounded bg-white/15 px-1 font-mono text-[10px]">c</kbd>
      {claude && <><span className="ml-1 opacity-70">· Ask Claude</span> <kbd className="ml-1 rounded bg-white/15 px-1 font-mono text-[10px]">a</kbd></>}
    </button>
  );
}
