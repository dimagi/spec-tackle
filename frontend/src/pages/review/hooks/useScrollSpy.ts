import { useEffect, useState } from "react";

/** Index of the last target whose top has scrolled above 140px. */
export function useScrollSpy(ids: string[]): number {
  const [current, setCurrent] = useState(0);
  const key = ids.join("|");
  useEffect(() => {
    const spy = () => {
      let i = 0;
      ids.forEach((id, n) => {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top < 140) i = n;
      });
      setCurrent(i);
    };
    const onScroll = () => requestAnimationFrame(spy);
    window.addEventListener("scroll", onScroll, { passive: true });
    spy();
    return () => window.removeEventListener("scroll", onScroll);
  }, [key]);
  return current;
}
