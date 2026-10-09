import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import type { ClaudeThread, Comment, Thread } from "../../api/types";
import { isCollapsible, isShown, threadRange } from "../../lib/threads";
import { useReview } from "../../state/review";
import { useReviewPage } from "./context";
import { ClaudeCard } from "./ClaudeCard";
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
};

const isInteractive = (target: EventTarget) => !!(target as Element).closest("a, textarea, button");

export function Margin({ docRef, engineRef, onResolve, onEdit, renderReply, composer, claude }: Props) {
  const { activity, fresh } = useReviewPage();
  const s = useReview((st) => st);
  const marginRef = useRef<HTMLDivElement>(null);
  const filters = { filter: s.filter, hideBots: s.hideBots };

  const items: MarginItem[] = activity.threads.map((t) => ({
    id: t.id, kind: "thread", path: t.path, range: threadRange(t), resolved: t.isResolved, hidden: !isShown(t, filters),
  }));
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
        const collapsible = isCollapsible(t);
        const collapsed = collapsible && !s.expanded.has(t.id) && s.active !== t.id;
        return (
          <div
            key={t.id}
            data-card={t.id}
            data-thread={t.id}
            className={`thread-card ${collapsed ? "is-collapsed" : ""} ${s.enlarged === t.id ? "is-enlarged" : ""}`}
            {...enlargedProps(t.id, "Comment thread")}
            hidden={!isShown(t, filters)}
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
