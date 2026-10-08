import { useState } from "react";
import { loadPref, savePref, type PRRef } from "../../state/storage";

type Props = {
  threadId: string;
  /** Where to keep an unsent draft; omit to keep none. */
  pr?: PRRef;
  placeholder?: string;
  help?: string;
  submitLabel?: string;
  disabled?: boolean;
  onSubmit: (body: string) => Promise<unknown> | void;
  onFocus: () => void;
};

export function ReplyBox({ threadId, pr, placeholder = "Reply…", help = "⌘↵ to send", submitLabel = "Reply", disabled, onSubmit, onFocus }: Props) {
  const draftKey = `draft:${threadId}`;
  const [text, setText] = useState(() => (pr ? loadPref<string>(pr, draftKey, "") || "" : ""));
  const [open, setOpen] = useState(!!text);
  const [busy, setBusy] = useState(false);

  const change = (value: string) => {
    setText(value);
    if (pr) savePref(pr, draftKey, value || null);
  };
  const submit = async (textarea?: HTMLTextAreaElement | null) => {
    if (busy) return; // ⌘↵ while a reply is in flight
    const body = text.trim();
    if (!body) return textarea?.focus();
    setBusy(true);
    try {
      await onSubmit(body);
      change("");
      setOpen(false);
      textarea?.blur();
    } catch {
      /* the caller reports the error; keep the text */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="thread-reply">
      <textarea
        rows={open ? 3 : 1}
        placeholder={placeholder}
        value={text}
        disabled={disabled}
        onChange={(e) => change(e.target.value)}
        onFocus={() => { setOpen(true); onFocus(); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit(e.currentTarget);
          } else if (e.key === "Escape") {
            e.stopPropagation();
            if (!text.trim()) setOpen(false);
            e.currentTarget.blur();
          }
        }}
      />
      <div className="actions" hidden={!open}>
        <span className="text-[11px] text-stone-400">{help}</span>
        <span className="flex-1" />
        <button className="btn-ghost" onClick={() => { change(""); setOpen(false); }}>Cancel</button>
        <button className="btn-primary" disabled={busy} onClick={(e) => submit(e.currentTarget.closest(".thread-reply")?.querySelector("textarea"))}>{submitLabel}</button>
      </div>
    </div>
  );
}
