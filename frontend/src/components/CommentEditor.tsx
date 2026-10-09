import { useEffect, useRef, useState } from "react";
import { MentionTextarea } from "./MentionTextarea";

type Props = {
  initial: string;
  onSave: (body: string) => Promise<unknown>;
  onCancel: () => void;
};

/** Edit a posted comment in place. */
export function CommentEditor({ initial, onSave, onCancel }: Props) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const save = async () => {
    if (busy) return;
    const body = text.trim();
    if (!body) return textarea.current?.focus();
    if (body === initial.trim()) return onCancel();
    setBusy(true);
    try {
      await onSave(body);
    } catch {
      /* the caller reports the error; keep the text */
      setBusy(false);
    }
  };

  return (
    <div className="comment-editor" onKeyDown={(e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onCancel();
    }}>
      <MentionTextarea
        ref={textarea} rows={4} className="field" value={text} onValueChange={setText} aria-label="Edit comment"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          }
        }}
      />
      <div className="mt-2 flex items-center gap-2">
        <span className="text-[11px] text-stone-400">⌘↵ to save</span>
        <span className="flex-1" />
        <button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn-primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
      </div>
    </div>
  );
}
