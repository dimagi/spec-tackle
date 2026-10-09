import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Comment, Thread } from "../../api/types";
import { CommentEditor } from "../../components/CommentEditor";
import { CommentMenu } from "../../components/CommentMenu";
import { RelativeTime } from "../../components/RelativeTime";
import { externalLinks } from "../../lib/links";
import { rangeLabel, threadRange } from "../../lib/threads";

export type ThreadCardProps = {
  thread: Thread;
  collapsed: boolean;
  collapsible: boolean;
  active: boolean;
  fresh: Set<number>;
  bodyExpanded: (commentId: number) => boolean;
  onExpand: () => void;
  onCollapse: () => void;
  onExpandBody: (commentId: number) => void;
  onResolve: (resolved: boolean) => void;
  /** Save an edited comment; without it, comments can't be edited here. */
  onEdit?: (comment: Comment, body: string) => Promise<unknown>;
  /** The reply box, below the comments. */
  children?: ReactNode;
};

const textOf = (html: string) => {
  const div = document.createElement("div");
  div.innerHTML = html;
  return (div.textContent ?? "").replace(/\s+/g, " ").trim();
};


type CommentViewProps = {
  c: Comment; fresh: boolean; expanded: boolean; onExpand: () => void;
  onEdit?: (body: string) => Promise<unknown>;
};

function CommentView({ c, fresh, expanded, onExpand, onEdit }: CommentViewProps) {
  const body = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  // Fade out very long comments (bot reviews!) behind a "Show more".
  const [tall, setTall] = useState(false);
  useLayoutEffect(() => {
    externalLinks(body.current);
    if (body.current && body.current.scrollHeight > 230) setTall(true);
  }, [c.bodyHTML, editing]);
  const clamped = tall && !expanded;
  return (
    <div className="comment" data-comment={c.id}>
      <img className="avatar" src={c.author.avatarUrl} alt="" />
      <div className="min-w-0 flex-1">
        <div className="comment-meta">
          <b>{c.author.login}</b>
          {c.author.isBot && <span className="chip chip-bot">bot</span>}
          <RelativeTime iso={c.createdAt} />
          {fresh && <span className="chip chip-new">new</span>}
          <CommentMenu url={c.url} onEdit={c.canEdit && onEdit ? () => setEditing(true) : undefined} className="ml-auto self-center" />
        </div>
        {editing && onEdit ? (
          <CommentEditor initial={c.body} onCancel={() => setEditing(false)}
            onSave={async (text) => { await onEdit(text); setEditing(false); }} />
        ) : (
          <>
            <div ref={body} className={`comment-body prose prose-stone prose-sm max-w-none dark:prose-invert ${clamped ? "clamped" : ""}`}
              dangerouslySetInnerHTML={{ __html: c.bodyHTML }} />
            {clamped && <button className="more-btn" onClick={onExpand}>Show more</button>}
          </>
        )}
      </div>
    </div>
  );
}

export function ThreadCard({ thread: t, collapsed, collapsible, active, fresh, bodyExpanded, onExpand, onCollapse, onExpandBody, onResolve, onEdit, children }: ThreadCardProps) {
  const range = threadRange(t);
  const freshCount = t.comments.filter((c) => fresh.has(c.id)).length;
  let where: ReactNode = null;
  if (t.isFileLevel) where = <span className="chip">File</span>;
  else if (t.side === "LEFT") where = <span className="chip">Removed line</span>;
  else if (range) where = <span className="chip" title={t.path}>{rangeLabel(...range)}</span>;
  const first = t.comments[0];

  return (
    <>
      <div className="thread-head">
        {where}
        {t.isOutdated && <span className="chip chip-outdated" title="The text changed after this comment">Outdated</span>}
        {t.isResolved && <span className="chip chip-resolved">Resolved{t.resolvedBy ? ` by ${t.resolvedBy}` : ""}</span>}
        {freshCount > 0 && <span className="chip chip-new">{freshCount} new</span>}
        <span className="flex-1" />
        {t.isResolved
          ? <button className="icon-btn" onClick={() => onResolve(false)}>Reopen</button>
          : <button className="icon-btn" title="Mark as resolved" onClick={() => onResolve(true)}>✓ Resolve</button>}
        <a className="icon-btn" href={first.url} target="_blank" rel="noopener" title="Open on GitHub">↗</a>
      </div>
      <div className="thread-body">
        {collapsed ? (
          <div className="collapsed-summary" data-testid="collapsed-summary" onClick={onExpand}>
            <img src={first.author.avatarUrl} alt="" />
            <b className="shrink-0 text-[12.5px] text-stone-700 dark:text-stone-200">{first.author.login}</b>
            <span className="text">{textOf(first.bodyHTML).slice(0, 160)}</span>
            {t.comments.length > 1 && <span className="shrink-0 text-[11px]">+{t.comments.length - 1}</span>}
          </div>
        ) : (
          <>
            {t.comments.map((c) => (
              <CommentView key={c.id} c={c} fresh={fresh.has(c.id)} expanded={bodyExpanded(c.id)} onExpand={() => onExpandBody(c.id)}
                onEdit={onEdit && ((body) => onEdit(c, body))} />
            ))}
            {collapsible && !active && (
              <div className="px-3 pb-2"><button className="more-btn" onClick={onCollapse}>Collapse</button></div>
            )}
          </>
        )}
      </div>
      {!collapsed && children}
    </>
  );
}
