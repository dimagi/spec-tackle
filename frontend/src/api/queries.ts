import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import type { PRRef } from "../state/storage";
import { request } from "./request";
import type { Activity, ClaudeThread, Page, Session } from "./types";

export const POLL_MS = 30_000;

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

/** The PR's comments and state, polled every 30 seconds and when the tab comes back. */
export function useLiveActivity(pr: PRRef, initial: Activity) {
  const queryClient = useQueryClient();
  const key = ["activity", pr.owner, pr.repo, pr.number];
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
    queryKey: ["claude", pr.owner, pr.repo, pr.number],
    queryFn: () => request<ClaudeThread[]>("GET", `${apiBase(pr)}/claude/threads`),
    enabled,
  });
}
