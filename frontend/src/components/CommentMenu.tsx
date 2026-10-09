import { useEffect, useRef, useState } from "react";
import { toast } from "../state/toasts";

/** The "⋯" menu on a comment, like GitHub's: edit it (when `onEdit` is given), copy its link or open it on GitHub. */
export function CommentMenu({ url, onEdit, className = "" }: { url: string; onEdit?: () => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const copy = async () => {
    setOpen(false);
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied");
    } catch {
      toast("Couldn't copy the link", { kind: "error" });
    }
  };

  return (
    <div ref={root} className={`relative ${className}`}>
      <button type="button" className="icon-btn comment-menu-btn" aria-label="Comment options" aria-haspopup="menu"
        aria-expanded={open} onClick={() => setOpen(!open)}>⋯</button>
      {open && (
        <div role="menu" className="comment-menu">
          {onEdit && <button type="button" role="menuitem" onClick={() => { setOpen(false); onEdit(); }}>Edit</button>}
          <button type="button" role="menuitem" onClick={copy}>Copy link</button>
          <a role="menuitem" href={url} target="_blank" rel="noopener" onClick={() => setOpen(false)}>Open on GitHub ↗</a>
        </div>
      )}
    </div>
  );
}
