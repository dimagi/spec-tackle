import { useEffect, useRef, useState } from "react";
import type { Draft } from "../../api/types";
import { MentionTextarea } from "../../components/MentionTextarea";
import { toast } from "../../state/toasts";

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

/** What submitting does with the reviewer's drafts. */
export type ReviewDrafts = {
  /** Drafts that go out with the review. */
  sending: number;
  /** Comment drafts held back because their text changed. */
  outdated: number;
  /** Reply drafts whose thread no longer exists; they can only be deleted. */
  orphans: Draft[];
  /** Comments waiting in a review started on github.com, which are published too. */
  githubPending: number;
  onDelete: (draft: Draft) => void;
};

type Props = {
  open: boolean;
  onClose: () => void;
  onSubmit: (event: ReviewEvent, body: string) => Promise<unknown>;
  drafts?: ReviewDrafts;
};

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const CHOICES: { value: ReviewEvent; label: string; help: string }[] = [
  { value: "COMMENT", label: "Comment", help: "General feedback, no verdict." },
  { value: "APPROVE", label: "Approve", help: "The spec is good to go." },
  { value: "REQUEST_CHANGES", label: "Request changes", help: "Must be addressed before merging." },
];

export function FinishReview({ open, onClose, onSubmit, drafts }: Props) {
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

  const sending = drafts?.sending ?? 0;
  const touchesDrafts = !!drafts && (sending > 0 || drafts.outdated > 0 || drafts.orphans.length > 0 || drafts.githubPending > 0);

  const submit = async () => {
    const text = body.trim();
    // A Comment review may consist of its drafts alone.
    const needsSummary = event === "REQUEST_CHANGES" || (event === "COMMENT" && !sending);
    if (needsSummary && !text) {
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
        {drafts && touchesDrafts ? (
          <div className="mt-1 space-y-1 text-sm text-stone-500" data-testid="review-drafts">
            {sending > 0 && <p>{count(sending, "draft", "drafts")} will be posted with this review.</p>}
            {drafts.outdated > 0 && <p>{count(drafts.outdated, "outdated draft stays", "outdated drafts stay")} behind.</p>}
            {drafts.githubPending > 0 && (
              <p>You also have {count(drafts.githubPending, "pending comment", "pending comments")} on GitHub; they'll be submitted too.</p>
            )}
            {drafts.orphans.length > 0 && (
              <>
                <p>{count(drafts.orphans.length, "reply", "replies")} to a deleted thread won't be sent:</p>
                <ul className="space-y-1">
                  {drafts.orphans.map((d) => (
                    <li key={d.id} className="flex items-start gap-2">
                      <span className="min-w-0 flex-1 truncate">{d.body}</span>
                      <button type="button" className="icon-btn" onClick={() => drafts.onDelete(d)}>Delete</button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ) : (
          <p className="mt-1 text-sm text-stone-500">Your margin comments are already on the PR. This adds an overall verdict.</p>
        )}
        <MentionTextarea ref={summary} name="body" rows={5} className="field mt-4" placeholder="Summary (optional for approvals)"
          value={body} onValueChange={setBody} />
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
