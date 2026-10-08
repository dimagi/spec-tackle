import { useEffect, useRef, useState, type RefObject } from "react";

/** The "+" that appears beside the document block under the cursor. */
export function GutterButton({ docRef, onAdd }: { docRef: RefObject<HTMLElement | null>; onAdd: (block: HTMLElement) => void }) {
  const button = useRef<HTMLButtonElement>(null);
  const hoverEl = useRef<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    const doc = docRef.current;
    if (!doc) return;
    const inGutterOf = (el: Element, e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      return e.clientY >= r.top && e.clientY <= r.bottom && e.clientX < r.left;
    };
    const onMove = (e: MouseEvent) => {
      if (e.target === button.current) return;
      const el = (e.target as Element).closest<HTMLElement>(".view [data-ls]");
      if (el === hoverEl.current) return;
      // Keep the "+" while the cursor crosses the padding between the block and the button.
      if (!el && hoverEl.current && inGutterOf(hoverEl.current, e)) return;
      hoverEl.current?.classList.remove("is-hover-target");
      hoverEl.current = el;
      if (!el) return setPos(null);
      el.classList.add("is-hover-target");
      const elRect = el.getBoundingClientRect();
      const docRect = doc.getBoundingClientRect();
      const lineBox = Math.min(el.offsetHeight, 28);
      setPos({
        top: elRect.top - docRect.top + (lineBox - 24) / 2 + (el.matches("tr, .code-line") ? 0 : 3),
        left: Math.max(6, elRect.left - docRect.left - 30),
      });
    };
    const onLeave = () => {
      hoverEl.current?.classList.remove("is-hover-target");
      hoverEl.current = null;
      setPos(null);
    };
    doc.addEventListener("mousemove", onMove);
    doc.addEventListener("mouseleave", onLeave);
    return () => {
      doc.removeEventListener("mousemove", onMove);
      doc.removeEventListener("mouseleave", onLeave);
    };
  }, [docRef]);

  return (
    <button
      ref={button} className="gutter-add" title="Comment on this block" hidden={!pos}
      style={pos ? { top: pos.top, left: pos.left } : undefined}
      onClick={() => hoverEl.current && onAdd(hoverEl.current)}
    >
      +
    </button>
  );
}
