import { useRef, type ReactNode, type RefObject } from "react";
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

  return (
    <div id="margin" ref={marginRef} className="relative hidden w-[340px] shrink-0 md:block xl:w-[380px]">
      {activity.threads.map((t) => {
        const collapsible = isCollapsible(t);
        const collapsed = collapsible && !s.expanded.has(t.id) && s.active !== t.id;
        return (
          <div
            key={t.id}
            data-card={t.id}
            data-thread={t.id}
            className={`thread-card ${collapsed ? "is-collapsed" : ""}`}
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
          className="thread-card claude"
          hidden={!s.showClaude}
          onClick={(e) => { if (!isInteractive(e.target) && s.active !== t.id) s.activate(t.id); }}
        >
          <ClaudeCard
            thread={t} headSha={activity.headSha} live={claude.lives.get(t.id) ?? null}
            onFollowUp={(q) => claude.onFollowUp(t, q)} onDelete={() => claude.onDelete(t)}
            onFocus={() => { if (s.active !== t.id) s.activate(t.id); }}
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
