import { useRef, type ReactNode, type RefObject } from "react";
import type { Thread } from "../../api/types";
import { isCollapsible, isShown, threadRange } from "../../lib/threads";
import { useReview } from "../../state/review";
import { useReviewPage } from "./context";
import { ThreadCard } from "./ThreadCard";
import { useMarginEngine, type MarginEngine, type MarginItem } from "./hooks/useMarginEngine";

type Props = {
  docRef: RefObject<HTMLElement | null>;
  engineRef: RefObject<MarginEngine | null>;
  onResolve: (thread: Thread, resolved: boolean) => void;
  renderReply: (thread: Thread) => ReactNode;
};

const isInteractive = (target: EventTarget) => !!(target as Element).closest("a, textarea, button");

export function Margin({ docRef, engineRef, onResolve, renderReply }: Props) {
  const { activity, fresh } = useReviewPage();
  const s = useReview((st) => st);
  const marginRef = useRef<HTMLDivElement>(null);
  const filters = { filter: s.filter, hideBots: s.hideBots };

  const items: MarginItem[] = activity.threads.map((t) => ({
    id: t.id, kind: "thread", path: t.path, range: threadRange(t), resolved: t.isResolved, hidden: !isShown(t, filters),
  }));
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
            >
              {renderReply(t)}
            </ThreadCard>
          </div>
        );
      })}
    </div>
  );
}
