import { useLayoutEffect, useRef } from "react";
import type { ClaudeMessage, ClaudeThread } from "../../api/types";
import { RelativeTime } from "../../components/RelativeTime";
import { externalLinks } from "../../lib/links";
import { rangeLabel } from "../../lib/threads";
import type { Live } from "./hooks/claudeStream";
import { ReplyBox } from "./ReplyBox";
import { EnlargeButton } from "./ThreadCard";

type Props = {
  thread: ClaudeThread;
  headSha: string;
  live: Live | null;
  onFollowUp: (question: string) => Promise<unknown>;
  onDelete: () => void;
  onFocus: () => void;
  enlarged?: boolean;
  onEnlarge?: (enlarged: boolean) => void;
};

function Message({ m }: { m: ClaudeMessage }) {
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    externalLinks(body.current, "noopener noreferrer");
  }, [m.bodyHTML]);
  if (m.role === "user") {
    return (
      <div className="comment"><div className="min-w-0 flex-1">
        <div className="comment-meta"><b>You</b><RelativeTime iso={m.createdAt} /></div>
        <div className="comment-body whitespace-pre-wrap">{m.body}</div>
      </div></div>
    );
  }
  if (m.role === "error") {
    return (
      <div className="comment claude-error"><div className="min-w-0 flex-1">
        <div className="comment-meta"><b>Couldn't answer</b><RelativeTime iso={m.createdAt} /></div>
        <div className="comment-body">{m.body}</div>
      </div></div>
    );
  }
  return (
    <div className="comment"><div className="min-w-0 flex-1">
      <div className="comment-meta"><b>Claude</b><RelativeTime iso={m.createdAt} /></div>
      <div ref={body} className="comment-body prose prose-stone prose-sm max-w-none dark:prose-invert" dangerouslySetInnerHTML={{ __html: m.bodyHTML ?? "" }} />
    </div></div>
  );
}

export function ClaudeCard({ thread: t, headSha, live, onFollowUp, onDelete, onFocus, enlarged = false, onEnlarge }: Props) {
  const last = t.messages[t.messages.length - 1];
  return (
    <>
      <div className="thread-head">
        <span className="chip chip-claude">Claude · private</span>
        <span className="chip" title={t.path}>{rangeLabel(t.startLine, t.endLine)}</span>
        <span className="flex-1" />
        <button className="icon-btn" title="Delete this thread" onClick={onDelete}>Delete</button>
        {onEnlarge && <EnlargeButton enlarged={enlarged} onEnlarge={onEnlarge} />}
      </div>
      <div className="claude-note">
        {t.commit !== headSha && (
          <div className="hint">Asked on <code>{t.commit.slice(0, 7)}</code>; the PR is now at <code>{headSha.slice(0, 7)}</code>.</div>
        )}
      </div>
      <div className="thread-body">
        {t.messages.map((m, i) => <Message key={i} m={m} />)}
        {live ? (
          <div className="comment"><div className="min-w-0 flex-1">
            <div className="comment-meta"><b>Claude</b><span className="spinner" /><span className="text-[11px] text-stone-400">{live.tool}</span></div>
            {live.text && <div className="comment-body whitespace-pre-wrap">{live.text}</div>}
          </div></div>
        ) : !t.running && last?.role === "user" ? (
          <div className="hint warn">Interrupted. Ask again.</div>
        ) : null}
      </div>
      <ReplyBox
        threadId={t.id} placeholder="Ask a follow-up…" help="Private · ⌘↵ to ask" submitLabel="Ask"
        disabled={!!live} onSubmit={onFollowUp} onFocus={onFocus}
      />
    </>
  );
}
