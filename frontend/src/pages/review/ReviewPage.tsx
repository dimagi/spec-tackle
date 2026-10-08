import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { activityKey, apiBase, claudeKey, useClaudeThreads, useLiveActivity, usePage } from "../../api/queries";
import { ApiError, onSignedOut, request } from "../../api/request";
import type { ClaudeThread, Comment, Page, Thread } from "../../api/types";
import { Toaster } from "../../components/Toaster";
import { applyActivity, initialSeen, type SeenState } from "../../lib/activity";
import { headingCounts, isBotThread, isShown, stepThread } from "../../lib/threads";
import { createReviewStore, ReviewStoreContext, useReview, useReviewStore, type ComposerTarget } from "../../state/review";
import { loadPref, savePref, type PRRef } from "../../state/storage";
import { toast } from "../../state/toasts";
import { setResolved } from "./actions";
import { Composer } from "./Composer";
import { ReviewPageCtx, type ReviewPageContext } from "./context";
import { Conversation } from "./Conversation";
import { FinishReview, type ReviewEvent } from "./FinishReview";
import { Description } from "./Description";
import { FileSection } from "./FileSection";
import { useClaudeStreams } from "./hooks/claudeStream";
import { useKeyboard } from "./hooks/useKeyboard";
import type { MarginEngine } from "./hooks/useMarginEngine";
import { useMermaid } from "./hooks/useMermaid";
import { Margin } from "./Margin";
import { GutterButton } from "./GutterButton";
import { Rail } from "./Rail";
import { ReplyBox } from "./ReplyBox";
import { SelectionButton, useSelection } from "./SelectionButton";
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
  // Bumped when a file switches Document/Changes, so margin anchors are recomputed.
  const [, setViewVersion] = useState(0);
  const [signedOut, setSignedOut] = useState(false);
  const unreadWhileHidden = useRef(0);
  const filter = useReview((s) => s.filter);
  const hideBots = useReview((s) => s.hideBots);
  const activate = useReview((s) => s.activate);
  const docRef = useRef<HTMLElement>(null);
  const engineRef = useRef<MarginEngine | null>(null);
  const active = useReview((s) => s.active);
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

  const markSeen = (id: number) => {
    seenRef.current = { seen: new Set(seenRef.current.seen).add(id), fresh: seenRef.current.fresh };
    setSeenState(seenRef.current);
  };
  const store = useReviewStore();
  const queryClient = useQueryClient();
  const composer = useReview((s) => s.composer);
  const composerDirty = useRef(false);
  const onDirtyChange = useCallback((dirty: boolean) => { composerDirty.current = dirty; }, []);
  const { selection, clear: clearSelection } = useSelection();
  const api = apiBase(pr);
  const fail = (err: unknown) => toast((err as Error).message, { kind: "error", timeout: 8000 });

  const openComposer = (target: ComposerTarget) => {
    if (store.getState().composer && composerDirty.current && !confirm("Discard your unsent text?")) return;
    composerDirty.current = false;
    clearSelection();
    store.getState().openComposer(target);
  };
  const closeComposer = () => {
    composerDirty.current = false;
    store.getState().closeComposer();
  };
  const commentOnSelection = (mode: "comment" | "claude") => {
    if (!selection || (mode === "claude" && !page.claude)) return false;
    openComposer({ path: selection.path, start: selection.start, end: selection.end, quote: selection.quote, mode });
    return true;
  };

  const postComment = async (body: string) => {
    const c = store.getState().composer!;
    try {
      const created = await request<Comment>("POST", `${api}/comments`, { path: c.path, start: c.start, end: c.end, body, commit: renderedSha });
      markSeen(created.id);
      closeComposer();
      toast("Comment posted to the PR");
      const latest = await live.refresh();
      const thread = latest.threads.find((t) => t.comments.some((x) => x.id === created.id));
      if (thread) activate(thread.id);
    } catch (err) {
      fail(err);
      throw err;
    }
  };

  const claudeThreads = useClaudeThreads(pr, page.claude);
  const claudeList = claudeThreads.data ?? [];
  const lives = useClaudeStreams(claudeList, () => claudeThreads.refetch());
  useEffect(() => {
    if (claudeThreads.error) toast(`Couldn't load Claude threads: ${(claudeThreads.error as Error).message}`, { kind: "error" });
  }, [claudeThreads.error]);
  const upsertClaude = (thread: ClaudeThread) =>
    queryClient.setQueryData<ClaudeThread[]>(claudeKey(pr), (list = []) =>
      list.some((t) => t.id === thread.id) ? list.map((t) => (t.id === thread.id ? thread : t)) : [...list, thread]);

  const askClaude = async (question: string) => {
    const c = store.getState().composer!;
    try {
      const thread = await request<ClaudeThread>("POST", `${api}/claude/threads`, { path: c.path, start: c.start, end: c.end, commit: renderedSha, question });
      closeComposer();
      upsertClaude(thread);
      activate(thread.id);
    } catch (err) {
      fail(err);
      throw err;
    }
  };

  const followUp = async (thread: ClaudeThread, question: string) => {
    try {
      upsertClaude(await request<ClaudeThread>("POST", `/api/claude/threads/${encodeURIComponent(thread.id)}/messages`, { question }));
    } catch (err) {
      fail(err);
      throw err;
    }
  };

  const deleteClaude = async (thread: ClaudeThread) => {
    if (!confirm("Delete this Claude thread? This can't be undone.")) return;
    try {
      await request("DELETE", `/api/claude/threads/${encodeURIComponent(thread.id)}`);
      queryClient.setQueryData<ClaudeThread[]>(claudeKey(pr), (list = []) => list.filter((t) => t.id !== thread.id));
      if (store.getState().active === thread.id) activate(null);
    } catch (err) {
      fail(err);
    }
  };

  const postReply = async (thread: Thread, body: string) => {
    try {
      const created = await request<Comment>("POST", `${api}/replies`, { commentId: thread.comments[0].id, body });
      markSeen(created.id);
      await live.refresh();
    } catch (err) {
      fail(err);
      throw err;
    }
  };

  const resolve = async (thread: Thread, resolved: boolean): Promise<void> => {
    if (resolved && store.getState().active === thread.id) activate(null);
    try {
      await setResolved(queryClient, activityKey(pr), thread.id, resolved, (id, to) =>
        request("POST", `/api/threads/${encodeURIComponent(id)}/resolve`, { resolved: to }));
      toast(resolved ? "Thread resolved" : "Thread reopened", resolved ? { action: "Undo", onAction: () => resolve(thread, false) } : {});
      live.refresh();
    } catch (err) {
      fail(err);
    }
  };

  const [reviewOpen, setReviewOpen] = useState(false);

  const postConversation = async (body: string) => {
    try {
      const created = await request<Comment>("POST", `${api}/conversation`, { body });
      markSeen(created.id);
      await live.refresh();
    } catch (err) {
      fail(err);
      throw err;
    }
  };

  const submitReview = async (event: ReviewEvent, body: string) => {
    try {
      const created = await request<Comment>("POST", `${api}/review`, { event, body });
      markSeen(created.id);
      toast(event === "APPROVE" ? "Approved ✓" : "Review submitted");
      await live.refresh();
    } catch (err) {
      fail(err);
      throw err;
    }
  };

  const step = (direction: 1 | -1) => {
    const engine = engineRef.current;
    if (!engine) return;
    const list = activity.threads
      .filter((t) => isShown(t, filters) && !t.isResolved)
      .map((t) => ({ id: t.id, top: engine.anchorTop(t.id) }))
      .filter((t): t is { id: string; top: number } => t.top !== null)
      .sort((a, b) => a.top - b.top);
    const next = stepThread(list, active, direction, scrollY + innerHeight * 0.3);
    if (next) activate(next, { scroll: true });
    else toast("No open threads 🎉");
  };

  useKeyboard({
    step,
    escape: () => {
      if (store.getState().composer && !composerDirty.current) closeComposer();
      activate(null);
    },
    comment: commentOnSelection,
    reply: () => {
      if (!active) return;
      document.querySelector<HTMLTextAreaElement>(`[data-card="${CSS.escape(active)}"] .thread-reply textarea`)?.focus();
    },
  });

  // Clicking a highlighted passage activates its thread (cycling if several share it).
  const onDocClick = (e: React.MouseEvent) => {
    const target = e.target as Element;
    if (target.closest("a, button, summary, input, textarea")) return;
    if (!getSelection()?.isCollapsed) return;
    const anchor = target.closest(".has-thread, .has-claude");
    const list = anchor ? engineRef.current?.threadsAt(anchor) ?? [] : [];
    if (list.length) {
      activate(list[(list.indexOf(active ?? "") + 1) % list.length]);
      return;
    }
    const block = target.closest<HTMLElement>(".view [data-ls]");
    if (block) {
      const path = block.closest<HTMLElement>("section.file")!.dataset.path!;
      const start = +block.dataset.ls!, end = +block.dataset.le!;
      if (composer && composer.path === path && composer.start === start && composer.end === end) return;
      openComposer({ path, start, end, quote: null, mode: "comment" });
    } else if (active && active !== "composer") {
      activate(null);
    }
  };

  const ctx: ReviewPageContext = {
    page, pr, api, activity, fresh: seenState.fresh,
    markSeen,
    refresh: live.refresh,
  };

  return (
    <ReviewPageCtx.Provider value={ctx}>
      <TopBar
        pr={page.pr} overview={page.overview} activity={activity} viewer={page.viewer}
        sync={{ fetching: live.fetching, error: live.error, lastSync: live.lastSync, signedOut }}
        newCommits={activity.headSha !== renderedSha}
        onRefresh={() => live.refresh()}
        onFinishReview={() => setReviewOpen(true)}
      />
      <div className="flex">
        <Rail files={page.files} claude={page.claude} stats={stats} headingCounts={counts}
          conversationCount={conversationCount} onStep={step} />
        <div className="min-w-0 flex-1 px-4 py-8 lg:px-8">
          <div className="mx-auto flex max-w-[1600px] gap-6">
            <main id="doc" ref={docRef} className="relative min-w-0 flex-1" onClick={onDocClick}>
              <GutterButton docRef={docRef} onAdd={(block) => openComposer({
                path: block.closest<HTMLElement>("section.file")!.dataset.path!,
                start: +block.dataset.ls!, end: +block.dataset.le!, quote: null, mode: "comment",
              })} />
              <Description overview={page.overview} />
              {page.files.map((file, i) => (
                <FileSection key={file.path} file={file} index={i + 1} onViewChange={() => setViewVersion((v) => v + 1)} />
              ))}
              <Conversation items={activity.conversation} fresh={seenState.fresh} hideBots={hideBots} onPost={postConversation} />
            </main>
            <Margin
              docRef={docRef} engineRef={engineRef} onResolve={resolve}
              renderReply={(t) => (
                <ReplyBox pr={pr} threadId={t.id} onSubmit={(body) => postReply(t, body)}
                  onFocus={() => { if (store.getState().active !== t.id) activate(t.id); }} />
              )}
              claude={{ threads: claudeList, lives, onFollowUp: followUp, onDelete: deleteClaude }}
              composer={composer && (
                <Composer
                  key={`${composer.path}:${composer.start}:${composer.end}`}
                  target={composer} file={page.files.find((f) => f.path === composer.path)!}
                  claude={page.claude} api={api}
                  onModeChange={(mode) => store.getState().setComposerMode(mode)}
                  onCancel={closeComposer}
                  onSubmit={(body, mode) => (mode === "claude" ? askClaude(body) : postComment(body))}
                  onDirtyChange={onDirtyChange}
                />
              )}
            />
          </div>
        </div>
      </div>
      <FinishReview open={reviewOpen} onClose={() => setReviewOpen(false)} onSubmit={submitReview} />
      <SelectionButton selection={selection} claude={page.claude} onComment={() => commentOnSelection("comment")} />
    </ReviewPageCtx.Provider>
  );
}
