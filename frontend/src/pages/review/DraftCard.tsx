import { useState } from "react";
import type { Draft } from "../../api/types";
import { CommentEditor } from "../../components/CommentEditor";
import { RelativeTime } from "../../components/RelativeTime";
import { rangeLabel } from "../../lib/threads";

export type DraftCardProps = {
  draft: Draft;
  /** The reviewer is picking new lines for this draft. */
  reattaching: boolean;
  onSave: (body: string) => Promise<unknown>;
  onDelete: () => void;
  /** Start (or cancel) picking new lines for an outdated draft. */
  onReattach: (on: boolean) => void;
};

/** Why a draft can't go out yet, or that it already has. */
function DraftState({ draft }: { draft: Draft }) {
  if (draft.sent) return <div className="hint">Waiting to be submitted</div>;
  if (draft.error) return <div className="hint warn">Couldn't be sent: {draft.error}</div>;
  return null;
}

/** The draft's text: plain, since rendering markdown would mean sending it to GitHub. */
function DraftBody({ draft, editing, onSave, onDone }: {
  draft: Draft; editing: boolean; onSave: (body: string) => Promise<unknown>; onDone: () => void;
}) {
  if (editing) {
    return <CommentEditor initial={draft.body} onCancel={onDone} onSave={async (text) => { await onSave(text); onDone(); }} />;
  }
  return <div className="comment-body whitespace-pre-wrap">{draft.body}</div>;
}

/** A comment kept for the review, shown in the margin beside its lines. */
export function DraftCard({ draft: d, reattaching, onSave, onDelete, onReattach }: DraftCardProps) {
  const [editing, setEditing] = useState(false);
  return (
    <>
      <div className="thread-head">
        {d.startLine != null && d.endLine != null && <span className="chip" title={d.path ?? ""}>{rangeLabel(d.startLine, d.endLine)}</span>}
        <span className="chip chip-draft">Draft · only you</span>
        {d.outdated && <span className="chip chip-outdated" title="The text changed after you wrote this">Outdated</span>}
        <span className="flex-1" />
        {!d.sent && !editing && (
          <>
            <button className="icon-btn" onClick={() => setEditing(true)}>Edit</button>
            <button className="icon-btn" title="Delete this draft" onClick={onDelete}>Delete</button>
          </>
        )}
      </div>
      <DraftState draft={d} />
      {d.outdated && (
        <div className="draft-outdated">
          <div className="hint">The text here changed, so this stays behind when you submit. It was about:</div>
          <blockquote>{d.anchorText}</blockquote>
          {reattaching ? (
            <div className="hint warn">
              Click a passage or select text to move this draft there.{" "}
              <button className="icon-btn" onClick={() => onReattach(false)}>Cancel</button>
            </div>
          ) : (
            <div className="px-3 pt-1.5"><button className="btn-secondary" onClick={() => onReattach(true)}>Re-attach</button></div>
          )}
        </div>
      )}
      <div className="thread-body">
        <div className="comment"><div className="min-w-0 flex-1">
          <DraftBody draft={d} editing={editing} onSave={onSave} onDone={() => setEditing(false)} />
        </div></div>
      </div>
    </>
  );
}

type DraftReplyProps = { draft: Draft; onSave: (body: string) => Promise<unknown>; onDelete: () => void };

/** A reply kept for the review, shown at the bottom of its thread. */
export function DraftReply({ draft: d, onSave, onDelete }: DraftReplyProps) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="comment draft-reply" data-draft={d.id}>
      <div className="min-w-0 flex-1">
        <div className="comment-meta">
          <b>You</b>
          <span className="chip chip-draft" title="Only you can see this until you submit your review">Draft</span>
          <RelativeTime iso={d.updatedAt} />
          <span className="flex-1" />
          {!d.sent && !editing && (
            <>
              <button className="icon-btn" onClick={() => setEditing(true)}>Edit</button>
              <button className="icon-btn" title="Delete this draft" onClick={onDelete}>Delete</button>
            </>
          )}
        </div>
        <DraftState draft={d} />
        <DraftBody draft={d} editing={editing} onSave={onSave} onDone={() => setEditing(false)} />
      </div>
    </div>
  );
}
