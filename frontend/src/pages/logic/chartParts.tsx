/** Pieces both Visualize charts (Flow and Calls) share. */
import { Handle, Position, useReactFlow } from "@xyflow/react";
import { useEffect, useRef, useState } from "react";

export const FIT = { duration: 300, padding: 0.12 };

/** Card fill and border for how the PR touched a block or function. */
export const TONE = {
  added: "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/60",
  changed: "border-amber-500 bg-amber-50 dark:bg-amber-950/50",
  unchanged: "border-stone-300 bg-white dark:border-stone-600 dark:bg-stone-900",
};

/** Edges enter at the top and leave at the bottom; nothing can be connected by hand. */
export function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} className="!border-0 !bg-transparent" />
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="!border-0 !bg-transparent" />
    </>
  );
}

export function useDarkMode() {
  const read = () => document.documentElement.classList.contains("dark");
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const update = () => setDark(read());
    window.addEventListener("spec-tackle:theme", update);
    return () => window.removeEventListener("spec-tackle:theme", update);
  }, []);
  return dark;
}

/** Re-fit when the chart's box changes width, e.g. when a panel opens beside it. */
export function FitOnResize() {
  const { fitView } = useReactFlow();
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const box = ref.current?.closest(".logic-flow");
    if (!box) return;
    const observer = new ResizeObserver(() => fitView(FIT));
    observer.observe(box);
    return () => observer.disconnect();
  }, [fitView]);
  return <span ref={ref} hidden />;
}
