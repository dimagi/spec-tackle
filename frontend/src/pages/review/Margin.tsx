import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import type { ClaudeThread, Comment, Draft, Thread } from "../../api/types";
import { isCollapsible, isShown, threadRange } from "../../lib/threads";
import { useReview } from "../../state/review";
import { useReviewPage } from "./context";
import { ClaudeCard } from "./ClaudeCard";
import { DraftCard, DraftReply } from "./DraftCard";
import type { Live } from "./hooks/claudeStream";
import { ThreadCard } from "./ThreadCard";
import { useMarginEngine, type MarginEngine, type MarginItem } from "./hooks/useMarginEngine";

type Props = {
  docRef: RefObject<HTMLElement | null>;
  engineRef: RefObject<MarginEngine | null>;
  onResolve: (thread: Thread, resolved: boolean) => void;
  onEdit: (comment: Comment, body: string) => Promise<unknown>;
  renderReply: (thread: Thread) => ReactNode;
  /** The composer card's content, when one is open. */
  composer: ReactNode;
  claude: {
    threads: ClaudeThread[];
    lives: Map<string, Live>;
    onFollowUp: (thread: ClaudeThread, question: string) => Promise<unknown>;
    onDelete: (thread: ClaudeThread) => void;
  };
  /** Comments and replies kept for the review. */
  drafts: {
    list: Draft[];
    onSave: (draft: Draft, body: string) => Promise<unknown>;
    onDelete: (draft: Draft) => void;
    onReattach: (draft: Draft, on: boolean) => void;
  };
};

const isInteractive = (target: EventTarget) => !!(target as Element).closest("a, textarea, button");

export function Margin({ docRef, engineRef, onResolve, onEdit, renderReply, composer, claude, drafts }: Props) {
  const { activity, fresh } = useReviewPage();
  const s = useReview((st) => st);
  const marginRef = useRef<HTMLDivElement>(null);
  const filters = { filter: s.filter, hideBots: s.hideBots };

  const commentDrafts = drafts.list.filter((d) => d.kind === "comment");
  const replyDrafts = (t: Thread) => drafts.list.filter((d) => d.kind === "reply" && d.threadId === t.id);
  // A thread holding a drafted reply is always shown in full, so the draft can't go out unseen.
  const shown = (t: Thread) => isShown(t, filters) || replyDrafts(t).length > 0;

  const items: MarginItem[] = activity.threads.map((t) => ({
    id: t.id, kind: "thread", path: t.path, range: threadRange(t), resolved: t.isResolved, hidden: !shown(t),
  }));
  for (const d of commentDrafts) {
    items.push({ id: d.id, kind: "draft", path: d.path!, range: [d.startLine!, d.endLine!], hidden: false });
  }
  for (const t of claude.threads) {
    items.push({ id: t.id, kind: "claude", path: t.path, range: [t.startLine, t.endLine], hidden: !s.showClaude });
  }
  if (s.composer) {
    items.push({ id: "composer", kind: "composer", path: s.composer.path, range: [s.composer.start, s.composer.end], hidden: false });
  }
  const engine = useMarginEngine(docRef, marginRef, items, s.active, s.scrollSeq);
  engineRef.current = engine.current;

  // A thread that gets hidden (say, resolved under the Open filter) can't stay enlarged.
  const enlargedShown = items.some((i) => i.id === s.enlarged && !i.hidden);
  useEffect(() => {
    if (s.enlarged && !enlargedShown) s.enlarge(null);
  }, [s.enlarged, enlargedShown]);

  // The page behind an enlarged thread stays put.
  useEffect(() => {
    document.body.classList.toggle("has-enlarged", !!s.enlarged);
    return () => document.body.classList.remove("has-enlarged");
  }, [s.enlarged]);
  const enlargedProps = (id: string, label: string) => (s.enlarged === id
    ? { role: "dialog", "aria-modal": true, "aria-label": label }
    : {});

  return (
    <div id="margin" ref={marginRef} className="relative hidden w-[340px] shrink-0 md:block xl:w-[380px]">
      {enlargedShown && <div className="enlarge-backdrop" data-testid="enlarge-backdrop" onClick={() => s.enlarge(null)} />}
      {activity.threads.map((t) => {
        const replies = replyDrafts(t);
        const collapsible = isCollapsible(t) && !replies.length;
        const collapsed = collapsible && !s.expanded.has(t.id) && s.active !== t.id;
        return (
          <div
            key={t.id}
            data-card={t.id}
            data-thread={t.id}
            className={`thread-card ${collapsed ? "is-collapsed" : ""} ${s.enlarged === t.id ? "is-enlarged" : ""}`}
            {...enlargedProps(t.id, "Comment thread")}
            hidden={!shown(t)}
            onClick={(e) => { if (!isInteractive(e.target) && s.active !== t.id) s.activate(t.id); }}
          >
            <ThreadCard
              thread={t} collapsed={collapsed} collapsible={collapsible} active={s.active === t.id} fresh={fresh}
              bodyExpanded={(id) => s.expandedBodies.has(id)}
              onExpand={() => s.expand(t.id)} onCollapse={() => s.collapse(t.id)}
              onExpandBody={(id) => { s.expandBody(id); engine.current.scheduleLayout(); }}
              onResolve={(resolved) => onResolve(t, resolved)}
              onEdit={onEdit}
              enlarged={s.enlarged === t.id} onEnlarge={(on) => s.enlarge(on ? t.id : null)}
            >
              {replies.map((d) => (
                <DraftReply key={d.id} draft={d} onSave={(body) => drafts.onSave(d, body)} onDelete={() => drafts.onDelete(d)} />
              ))}
              {renderReply(t)}
            </ThreadCard>
          </div>
        );
      })}
      {claude.threads.map((t) => (
        <div
          key={t.id}
          data-card={t.id}
          data-claude={t.id}
          className={`thread-card claude ${s.enlarged === t.id ? "is-enlarged" : ""}`}
          {...enlargedProps(t.id, "Claude thread")}
          hidden={!s.showClaude}
          onClick={(e) => { if (!isInteractive(e.target) && s.active !== t.id) s.activate(t.id); }}
        >
          <ClaudeCard
            thread={t} headSha={activity.headSha} live={claude.lives.get(t.id) ?? null}
            onFollowUp={(q) => claude.onFollowUp(t, q)} onDelete={() => claude.onDelete(t)}
            onFocus={() => { if (s.active !== t.id) s.activate(t.id); }}
            enlarged={s.enlarged === t.id} onEnlarge={(on) => s.enlarge(on ? t.id : null)}
          />
        </div>
      ))}
      {commentDrafts.map((d) => (
        <div
          key={d.id}
          data-card={d.id}
          data-draft={d.id}
          className="thread-card draft"
          onClick={(e) => { if (!isInteractive(e.target) && s.active !== d.id) s.activate(d.id); }}
        >
          <DraftCard
            draft={d} reattaching={s.reattaching === d.id}
            onSave={(body) => drafts.onSave(d, body)} onDelete={() => drafts.onDelete(d)}
            onReattach={(on) => drafts.onReattach(d, on)}
          />
        </div>
      ))}
      {s.composer && (
        <div
          data-card="composer"
          className={`thread-card composer ${s.composer.mode === "claude" ? "is-claude" : ""}`}
          onClick={(e) => { if (!isInteractive(e.target) && s.active !== "composer") s.activate("composer"); }}
        >
          {composer}
        </div>
      )}
    </div>
  );
}
