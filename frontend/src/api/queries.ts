import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import type { PRRef } from "../state/storage";
import { request } from "./request";
import type { Activity, ClaudeThread, LogicFunctions, LogicState, Page, PrSummary, Repo, Session } from "./types";

export const POLL_MS = 30_000;

export const activityKey = (pr: PRRef) => ["activity", pr.owner, pr.repo, pr.number];

export const claudeKey = (pr: PRRef) => ["claude", pr.owner, pr.repo, pr.number];

export const apiBase = (pr: PRRef) => `/api/pr/${pr.owner}/${pr.repo}/${pr.number}`;

export function useSession() {
  return useQuery({ queryKey: ["session"], queryFn: () => request<Session>("GET", "/api/session") });
}

export function usePage(pr: PRRef) {
  return useQuery({
    queryKey: ["page", pr.owner, pr.repo, pr.number],
    queryFn: () => request<Page>("GET", `${apiBase(pr)}/page`),
    staleTime: Infinity,
  });
}

/** Open PRs waiting on the viewer's review; fetched only once the switcher has been opened. */
export function useReviewRequests(enabled: boolean) {
  return useQuery({
    queryKey: ["review-requests"],
    queryFn: () => request<PrSummary[]>("GET", "/api/review-requests"),
    enabled,
    staleTime: 2 * 60_000,
  });
}

/** The PR's comments and state, polled every 30 seconds and when the tab comes back. */
export function useLiveActivity(pr: PRRef, initial: Activity) {
  const queryClient = useQueryClient();
  const key = activityKey(pr);
  const query = useQuery({
    queryKey: key,
    queryFn: () => request<Activity>("GET", `${apiBase(pr)}/activity`),
    initialData: initial,
    initialDataUpdatedAt: Date.now,
    staleTime: POLL_MS,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: true,
  });
  const { refetch, dataUpdatedAt } = query;

  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden && Date.now() - dataUpdatedAt > POLL_MS) refetch();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refetch, dataUpdatedAt]);

  const refresh = useCallback(async () => {
    await queryClient.refetchQueries({ queryKey: key, exact: true });
    return queryClient.getQueryData<Activity>(key)!;
  }, [queryClient, pr.owner, pr.repo, pr.number]);

  return {
    activity: query.data,
    lastSync: dataUpdatedAt,
    fetching: query.isFetching,
    error: query.error ? (query.error as Error).message : null,
    refresh,
  };
}

export function useClaudeThreads(pr: PRRef, enabled: boolean) {
  return useQuery({
    queryKey: claudeKey(pr),
    queryFn: () => request<ClaudeThread[]>("GET", `${apiBase(pr)}/claude/threads`),
    enabled,
  });
}

/** Repos to browse: yours when `query` is empty, else a GitHub search. */
export function useRepos(query: string, enabled = true) {
  return useQuery({
    queryKey: ["repos", query],
    queryFn: () => request<Repo[]>("GET", query ? `/api/repos?q=${encodeURIComponent(query)}` : "/api/repos"),
    enabled,
    staleTime: 2 * 60_000,
  });
}

export function useOpenPulls(owner: string, repo: string, enabled = true) {
  return useQuery({
    queryKey: ["pulls", owner, repo],
    queryFn: () => request<PrSummary[]>("GET", `/api/repos/${owner}/${repo}/pulls`),
    enabled,
    staleTime: 60_000,
  });
}

export const logicKey = (pr: PRRef, head: string) => ["logic", pr.owner, pr.repo, pr.number, head];

/** The Logic view's map for this PR, and whether one is being generated for `head`. */
export function useLogic(pr: PRRef, head: string) {
  return useQuery({
    queryKey: logicKey(pr, head),
    queryFn: () => request<LogicState>("GET", `${apiBase(pr)}/logic?head=${encodeURIComponent(head)}`),
  });
}

export function useLogicFunctions(mapId: string, blockId: string) {
  return useQuery({
    queryKey: ["logic-functions", mapId, blockId],
    queryFn: () => request<LogicFunctions>("GET", `/api/logic/${encodeURIComponent(mapId)}/blocks/${encodeURIComponent(blockId)}/functions`),
    staleTime: Infinity,
  });
}
