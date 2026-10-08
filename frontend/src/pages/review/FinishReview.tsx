import { useEffect, useRef, useState } from "react";
import { toast } from "../../state/toasts";

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

type Props = { open: boolean; onClose: () => void; onSubmit: (event: ReviewEvent, body: string) => Promise<unknown> };

const CHOICES: { value: ReviewEvent; label: string; help: string }[] = [
  { value: "COMMENT", label: "Comment", help: "General feedback, no verdict." },
  { value: "APPROVE", label: "Approve", help: "The spec is good to go." },
  { value: "REQUEST_CHANGES", label: "Request changes", help: "Must be addressed before merging." },
];

export function FinishReview({ open, onClose, onSubmit }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const summary = useRef<HTMLTextAreaElement>(null);
  const [event, setEvent] = useState<ReviewEvent>("COMMENT");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const submit = async () => {
    const text = body.trim();
    if (event !== "APPROVE" && !text) {
      summary.current?.focus();
      toast("Add a summary for this kind of review", { kind: "error" });
      return;
    }
    setBusy(true);
    try {
      await onSubmit(event, text);
      setBody("");
      setEvent("COMMENT");
      onClose();
    } catch {
      /* the caller reports the error */
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={dialog} onClose={onClose} className="m-auto w-[min(520px,92vw)] rounded-2xl p-0 shadow-2xl backdrop:bg-stone-950/40 dark:bg-stone-900 dark:text-stone-100">
      <form className="p-6" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <h2 className="text-lg font-semibold">Finish your review</h2>
        <p className="mt-1 text-sm text-stone-500">Your margin comments are already on the PR. This adds an overall verdict.</p>
        <textarea ref={summary} name="body" rows={5} className="field mt-4" placeholder="Summary (optional for approvals)"
          value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="mt-4 space-y-2 text-sm">
          {CHOICES.map((c) => (
            <label key={c.value} className="choice">
              <input type="radio" name="event" value={c.value} checked={event === c.value} onChange={() => setEvent(c.value)} />{" "}
              <span><b>{c.label}</b><br /><span className="text-stone-500">{c.help}</span></span>
            </label>
          ))}
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy}>Submit review</button>
        </div>
      </form>
    </dialog>
  );
}
