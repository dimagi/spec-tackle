import { useState } from "react";
import { MentionTextarea } from "../../components/MentionTextarea";
import { loadPref, savePref, type PRRef } from "../../state/storage";

type Props = {
  threadId: string;
  /** Where to keep an unsent draft; omit to keep none. */
  pr?: PRRef;
  placeholder?: string;
  help?: string;
  submitLabel?: string;
  disabled?: boolean;
  /** Suggest people after an `@`; off for replies that stay private. */
  mentions?: boolean;
  onSubmit: (body: string) => Promise<unknown> | void;
  /** Keep a reply as a draft for the review; without it, replies can only be sent. */
  onDraft?: (body: string) => Promise<unknown>;
  onFocus: () => void;
};

export function ReplyBox({ threadId, pr, placeholder = "Reply…", help = "⌘↵ to send", submitLabel = "Reply", disabled, mentions = false, onSubmit, onDraft, onFocus }: Props) {
  const draftKey = `draft:${threadId}`;
  const [text, setText] = useState(() => (pr ? loadPref<string>(pr, draftKey, "") || "" : ""));
  const [open, setOpen] = useState(!!text);
  const [busy, setBusy] = useState(false);

  const change = (value: string) => {
    setText(value);
    if (pr) savePref(pr, draftKey, value || null);
  };
  const submit = async (textarea?: HTMLTextAreaElement | null, how: "send" | "draft" = "send") => {
    if (busy) return; // ⌘↵ while a reply is in flight
    const body = text.trim();
    if (!body) return textarea?.focus();
    setBusy(true);
    try {
      await (how === "draft" && onDraft ? onDraft(body) : onSubmit(body));
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
      <MentionTextarea
        rows={open ? 3 : 1}
        placeholder={placeholder}
        value={text}
        disabled={disabled}
        mentions={mentions}
        onValueChange={change}
        onFocus={() => { setOpen(true); onFocus(); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit(e.currentTarget, e.shiftKey && onDraft ? "draft" : "send");
          } else if (e.key === "Escape") {
            e.stopPropagation();
            if (!text.trim()) setOpen(false);
            e.currentTarget.blur();
          }
        }}
      />
      <div className={`actions ${onDraft ? "flex-wrap" : ""}`} hidden={!open}>
        <span className={`text-[11px] text-stone-400 ${onDraft ? "w-full" : ""}`}>{onDraft ? `${help} · ⌘⇧↵ to add to review` : help}</span>
        <span className="flex-1" />
        <button className="btn-ghost" onClick={() => { change(""); setOpen(false); }}>Cancel</button>
        {onDraft && (
          <button className="btn-secondary" disabled={busy} title="Keep it as a draft, posted when you finish your review"
            onClick={(e) => submit(e.currentTarget.closest(".thread-reply")?.querySelector("textarea"), "draft")}>Add to review</button>
        )}
        <button className="btn-primary" disabled={busy} onClick={(e) => submit(e.currentTarget.closest(".thread-reply")?.querySelector("textarea"))}>{submitLabel}</button>
      </div>
    </div>
  );
}
