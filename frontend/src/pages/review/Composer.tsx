import { useEffect, useRef, useState } from "react";
import { request } from "../../api/request";
import type { PageFile } from "../../api/types";
import { commentableRange, quoteFor, rangeLabel } from "../../lib/threads";
import type { ComposerMode, ComposerTarget } from "../../state/review";

const MODES = {
  comment: { title: "New comment", help: "Markdown · ⌘↵ to post", submit: "Comment", busy: "Posting…", placeholder: "What should change, or what's unclear?" },
  claude: { title: "Ask Claude", help: "Private, never posted · ⌘↵ to ask", submit: "Ask Claude", busy: "Asking…", placeholder: "Ask Claude about this passage…" },
};

export type ComposerProps = {
  target: ComposerTarget;
  file: PageFile;
  claude: boolean;
  api: string;
  onModeChange: (mode: ComposerMode) => void;
  onCancel: () => void;
  onSubmit: (body: string, mode: ComposerMode) => Promise<unknown>;
  /** Whether there's unsent text worth confirming before discarding. */
  onDirtyChange: (dirty: boolean) => void;
};

export function Composer({ target, file, claude, api, onModeChange, onCancel, onSubmit, onDirtyChange }: ComposerProps) {
  const quoteText = quoteFor(target.quote);
  const mode: ComposerMode = claude ? target.mode : "comment";
  const m = MODES[mode];
  const [text, setText] = useState(mode === "claude" ? "" : quoteText);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);

  // Claude mode never quotes (the card shows the lines) and never previews (that calls GitHub).
  const lastMode = useRef(mode);
  useEffect(() => {
    if (lastMode.current === mode) return;
    lastMode.current = mode;
    if (mode === "claude") {
      setPreview(null);
      setText((t) => (t === quoteText ? "" : t));
    } else {
      setText((t) => t || quoteText);
    }
  }, [mode, quoteText]);

  // A new selection in the same block: quote it, unless the reviewer has written something.
  const lastQuote = useRef(quoteText);
  useEffect(() => {
    if (lastQuote.current === quoteText) return;
    const previous = lastQuote.current;
    lastQuote.current = quoteText;
    if (mode === "comment") setText((t) => (!t.trim() || t === previous ? quoteText : t));
    textarea.current?.focus({ preventScroll: true });
  }, [quoteText, mode]);

  useEffect(() => {
    onDirtyChange(!!text.trim() && text.trim() !== quoteText.trim());
  }, [text, quoteText, onDirtyChange]);

  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, [mode]);

  const ok = commentableRange(file, target.start, target.end);
  let hint: string | null = null;
  let warn = false;
  if (!ok) {
    warn = true;
    hint = `This text wasn't changed in the PR, so GitHub can't attach a line comment here. It will be posted as a file comment that references ${rangeLabel(target.start, target.end)}.`;
  } else if (ok.start !== target.start || ok.end !== target.end) {
    hint = `Only ${rangeLabel(ok.start, ok.end)} of this passage changed in the PR, so the comment will be attached there.`;
  }

  const submit = async () => {
    if (busy) return; // ⌘↵ while a post is in flight
    const body = text.trim();
    if (!body) return textarea.current?.focus();
    setBusy(true);
    try {
      await onSubmit(body, mode);
    } finally {
      setBusy(false);
    }
  };

  const showPreview = async () => {
    setPreview("");
    setPreviewError(null);
    try {
      const { html } = await request<{ html: string }>("POST", `${api}/preview`, { body: text || "_Nothing to preview_" });
      setPreview(html);
    } catch (err) {
      setPreviewError((err as Error).message);
    }
  };

  return (
    <>
      <div className="thread-head">
        <span className="chip">{rangeLabel(target.start, target.end)}</span>
        <span className="composer-title">{m.title}</span>
        {claude && (
          <>
            <span className="flex-1" />
            <div className="mode-switch">
              <button className={mode === "comment" ? "on" : ""} onClick={() => onModeChange("comment")}>Comment</button>
              <button className={mode === "claude" ? "on" : ""} onClick={() => onModeChange("claude")}>Ask Claude</button>
            </div>
          </>
        )}
      </div>
      {mode === "comment" && hint && <div className="comment-only"><div className={`hint ${warn ? "warn" : ""}`}>{hint}</div></div>}
      <div className="p-3">
        {mode === "comment" && (
          <div className="tabs comment-only">
            <button className={preview === null ? "on" : ""} onClick={() => setPreview(null)}>Write</button>
            <button className={preview !== null ? "on" : ""} onClick={showPreview}>Preview</button>
          </div>
        )}
        <textarea
          ref={textarea} rows={4} className="field" value={text} placeholder={m.placeholder} hidden={preview !== null}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              e.stopPropagation();
              if (!text.trim()) onCancel();
              e.currentTarget.blur();
            }
          }}
        />
        {preview !== null && (previewError !== null ? (
          <div className="preview comment-body prose prose-stone prose-sm max-w-none dark:prose-invert">{previewError}</div>
        ) : (
          <div className="preview comment-body prose prose-stone prose-sm max-w-none dark:prose-invert"
            dangerouslySetInnerHTML={{ __html: preview || '<span class="text-stone-400">Rendering…</span>' }} />
        ))}
        <div className="mt-2 flex items-center gap-2">
          <span className="composer-help text-[11px] text-stone-400">{m.help}</span>
          <span className="flex-1" />
          <button className="btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn-primary" disabled={busy} onClick={submit}>{busy ? m.busy : m.submit}</button>
        </div>
      </div>
    </>
  );
}
