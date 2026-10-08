import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { apiBase, useLiveActivity, usePage } from "../../api/queries";
import { ApiError, onSignedOut } from "../../api/request";
import type { Page } from "../../api/types";
import { Toaster } from "../../components/Toaster";
import { applyActivity, initialSeen, type SeenState } from "../../lib/activity";
import { headingCounts, isBotThread } from "../../lib/threads";
import { createReviewStore, ReviewStoreContext, useReview } from "../../state/review";
import { loadPref, savePref, type PRRef } from "../../state/storage";
import { toast } from "../../state/toasts";
import { ReviewPageCtx, type ReviewPageContext } from "./context";
import { Description } from "./Description";
import { FileSection } from "./FileSection";
import { useMermaid } from "./hooks/useMermaid";
import { Rail } from "./Rail";
import { TopBar } from "./TopBar";

export function ReviewPage() {
  const params = useParams();
  const pr = useMemo<PRRef>(
    () => ({ owner: params.owner!, repo: params.repo!, number: Number(params.number) }),
    [params.owner, params.repo, params.number],
  );
  const page = usePage(pr);
  const [store] = useState(() => createReviewStore(pr));

  if (page.isPending) {
    return <div className="grid min-h-screen place-items-center text-sm text-stone-500">Loading pull request…</div>;
  }
  if (page.error) {
    const err = page.error as ApiError;
    if (err.signedOut) return <Navigate to={`/?next=${encodeURIComponent(location.pathname)}&notice=${encodeURIComponent(err.message)}`} replace />;
    return (
      <div className="grid min-h-screen place-items-center px-6">
        <div className="max-w-md rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {err.message} <button className="ml-2 font-semibold underline" onClick={() => page.refetch()}>Retry</button>
        </div>
      </div>
    );
  }
  return (
    <ReviewStoreContext.Provider value={store}>
      <Review page={page.data} pr={pr} />
      <Toaster />
    </ReviewStoreContext.Provider>
  );
}

function Review({ page, pr }: { page: Page; pr: PRRef }) {
  const navigate = useNavigate();
  const renderedSha = page.activity.headSha;
  const live = useLiveActivity(pr, page.activity);
  const activity = live.activity;
  const [seenState, setSeenState] = useState<SeenState>(() => {
    const s = initialSeen(loadPref<number[] | null>(pr, "seen", null), page.activity);
    savePref(pr, "seen", [...s.seen]);
    return s;
  });
  const seenRef = useRef(seenState);
  const [signedOut, setSignedOut] = useState(false);
  const unreadWhileHidden = useRef(0);
  const filter = useReview((s) => s.filter);
  const hideBots = useReview((s) => s.hideBots);
  const activate = useReview((s) => s.activate);
  const docRef = useRef<HTMLElement>(null);
  useMermaid(docRef);

  useEffect(() => {
    document.title = `${page.overview.title} · #${pr.number}`;
  }, [page.overview.title, pr.number]);

  // GitHub stopped accepting the sign-in: say so once, and offer a way back here after signing in.
  useEffect(() => {
    onSignedOut(() => {
      setSignedOut(true);
      toast("You're signed out of GitHub, so comments can't be posted or refreshed.", {
        kind: "error", timeout: 0, action: "Sign in",
        onAction: () => navigate(`/?next=${encodeURIComponent(location.pathname)}`),
      });
    });
  }, [navigate]);

  // Fold each poll into seen/fresh and announce what others wrote.
  const lastActivity = useRef(page.activity);
  useEffect(() => {
    if (activity === lastActivity.current) return;
    lastActivity.current = activity;
    setSignedOut(false);
    const next = applyActivity(seenRef.current, activity, renderedSha);
    seenRef.current = { seen: next.seen, fresh: next.fresh };
    setSeenState(seenRef.current);
    savePref(pr, "seen", [...next.seen]);
    const { arrivals } = next;
    if (arrivals.length) {
      const names = [...new Set(arrivals.map((a) => a.comment.author.login))].join(", ");
      const first = arrivals.find((a) => a.threadId);
      toast(`${arrivals.length} new comment${arrivals.length > 1 ? "s" : ""} from ${names}`, {
        timeout: 9000, action: "Show",
        onAction: () => first
          ? activate(first.threadId, { scroll: true })
          : document.getElementById("conversation")?.scrollIntoView({ behavior: "smooth" }),
      });
      for (const a of arrivals) {
        const el = a.threadId && document.querySelector(`[data-thread="${CSS.escape(a.threadId)}"]`);
        if (el) { el.classList.remove("flash"); void (el as HTMLElement).offsetWidth; el.classList.add("flash"); }
      }
      if (document.hidden) {
        unreadWhileHidden.current += arrivals.length;
        document.title = `(${unreadWhileHidden.current}) ${document.title.replace(/^\(\d+\) /, "")}`;
      }
    }
  }, [activity, renderedSha, pr, activate]);

  useEffect(() => {
    const onVisible = () => {
      if (document.hidden) return;
      unreadWhileHidden.current = 0;
      document.title = document.title.replace(/^\(\d+\) /, "");
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const filters = { filter, hideBots };
  const visibleThreads = activity.threads.filter((t) => !(hideBots && isBotThread(t)));
  const stats = { open: visibleThreads.filter((t) => !t.isResolved).length, resolved: visibleThreads.filter((t) => t.isResolved).length };
  const counts = headingCounts(page.files, activity.threads, filters);
  const conversationCount = activity.conversation.filter((c) => !(hideBots && c.author.isBot)).length;

  const ctx: ReviewPageContext = {
    page, pr, api: apiBase(pr), activity, fresh: seenState.fresh,
    markSeen: (id) => {
      seenRef.current = { seen: new Set(seenRef.current.seen).add(id), fresh: seenRef.current.fresh };
      setSeenState(seenRef.current);
    },
    refresh: live.refresh,
  };

  return (
    <ReviewPageCtx.Provider value={ctx}>
      <TopBar
        pr={page.pr} overview={page.overview} activity={activity} viewer={page.viewer}
        sync={{ fetching: live.fetching, error: live.error, lastSync: live.lastSync, signedOut }}
        newCommits={activity.headSha !== renderedSha}
        onRefresh={() => live.refresh()}
        onFinishReview={() => {}}
      />
      <div className="flex">
        <Rail files={page.files} claude={page.claude} stats={stats} headingCounts={counts}
          conversationCount={conversationCount} onStep={() => {}} />
        <div className="min-w-0 flex-1 px-4 py-8 lg:px-8">
          <div className="mx-auto flex max-w-[1600px] gap-6">
            <main id="doc" ref={docRef} className="relative min-w-0 flex-1">
              <Description overview={page.overview} />
              {page.files.map((file, i) => (
                <FileSection key={file.path} file={file} index={i + 1} />
              ))}
            </main>
            <div id="margin" className="relative hidden w-[340px] shrink-0 md:block xl:w-[380px]" />
          </div>
        </div>
      </div>
    </ReviewPageCtx.Provider>
  );
}
