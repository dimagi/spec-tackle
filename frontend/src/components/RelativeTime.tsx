import { useEffect, useState } from "react";
import { timeAgo } from "../lib/time";

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

/** Re-render every 20 seconds so relative times stay fresh. */
export function useTick() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    listeners.add(bump);
    timer ??= setInterval(() => listeners.forEach((l) => l()), 20_000);
    return () => {
      listeners.delete(bump);
      if (!listeners.size && timer) { clearInterval(timer); timer = null; }
    };
  }, []);
}

export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  useTick();
  if (!iso) return null;
  return (
    <time className={className} data-time={iso} title={new Date(iso).toLocaleString()}>
      {timeAgo(iso)}
    </time>
  );
}
