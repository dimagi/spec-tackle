import { useEffect, useRef } from "react";

export type KeyHandlers = {
  step: (direction: 1 | -1) => void;
  escape: () => void;
  reply: () => void;
  /** c / a on a text selection; return true if handled. */
  comment?: (mode: "comment" | "claude") => boolean;
};

/** Page shortcuts; ignored while typing or in a dialog, and with modifier keys. */
export function useKeyboard(handlers: KeyHandlers) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as Element).closest?.("input, textarea, dialog") || e.metaKey || e.ctrlKey || e.altKey) return;
      const h = ref.current;
      if (e.key === "j") h.step(1);
      else if (e.key === "k") h.step(-1);
      else if ((e.key === "c" || e.key === "a") && h.comment?.(e.key === "c" ? "comment" : "claude")) e.preventDefault();
      else if (e.key === "r") { e.preventDefault(); h.reply(); }
      else if (e.key === "Escape") h.escape();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
