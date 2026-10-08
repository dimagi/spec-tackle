import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { Activity } from "../../api/types";

/** Resolve or reopen a thread: shown at once, rolled back if GitHub refuses. */
export async function setResolved(
  queryClient: QueryClient,
  key: QueryKey,
  threadId: string,
  resolved: boolean,
  post: (threadId: string, resolved: boolean) => Promise<unknown>,
) {
  const flip = (to: boolean) =>
    queryClient.setQueryData<Activity>(key, (a) =>
      a && { ...a, threads: a.threads.map((t) => (t.id === threadId ? { ...t, isResolved: to } : t)) });
  flip(resolved);
  try {
    await post(threadId, resolved);
  } catch (err) {
    flip(!resolved);
    throw err;
  }
}
