import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useWalkthrough, walkKey } from "../../api/queries";
import { request } from "../../api/request";
import type { WalkState } from "../../api/types";

export type WalkRun = {
  data: WalkState | undefined;
  loadError: Error | null;
  /** Claude's latest activity while a run is going; null otherwise. */
  progress: string | null;
  error: string | null;
  posting: boolean;
  run: (inputs?: Record<string, unknown>) => Promise<void>;
  /** Run again with the inputs of this entry's last run (none: propose), e.g. after a failure. */
  retry: () => Promise<void>;
};

/** One entry's walkthrough: its state, a run (proposing without inputs), and the run's progress. */
export function useWalk(mapId: string, entry: string | null): WalkRun {
  const query = useWalkthrough(mapId, entry);
  const queryClient = useQueryClient();
  const currentKey = `${mapId}:${entry}`;
  const current = useRef(currentKey);
  current.current = currentKey;
  // Progress, error and posting belong to the entry that started them.
  type Keyed = { key: string; text: string } | null;
  const [progressState, setProgressState] = useState<Keyed>(null);
  const [errorState, setErrorState] = useState<Keyed>(null);
  const [postingKey, setPostingKey] = useState<string | null>(null);
  const progress = progressState?.key === currentKey ? progressState.text : null;
  const localError = errorState?.key === currentKey ? errorState.text : null;
  const posting = postingKey === currentKey;
  // Each entry proposes by itself at most once per mount; after a failure, Try again does it.
  const proposed = useRef(new Set<string>());
  // Entries whose stream broke: don't rejoin them by themselves, or a failing stream loops.
  const noRejoin = useRef(new Set<string>());
  const url = `/api/logic/${encodeURIComponent(mapId)}/walkthrough`;

  const setProgressFor = (key: string, text: string | null) => setProgressState(text === null ? null : { key, text });
  const setErrorFor = (key: string, text: string | null) => setErrorState(text === null ? null : { key, text });

  useEffect(() => { setProgressState(null); setErrorState(null); }, [mapId, entry]);

  // What each entry's last run was asked to do, so Try again resends the values that failed.
  const lastInputs = useRef(new Map<string, Record<string, unknown> | undefined>());

  const run = async (inputs?: Record<string, unknown>) => {
    if (!entry) return;
    const key = currentKey;
    lastInputs.current.set(key, inputs);
    noRejoin.current.delete(key);
    setErrorFor(key, null);
    setPostingKey(key);
    try {
      const state = await request<WalkState>("POST", url, inputs === undefined ? { entry } : { entry, inputs });
      queryClient.setQueryData(walkKey(mapId, entry), state);
      if (state.running && current.current === key) setProgressFor(key, "Starting…");
    } catch (err) {
      if (current.current === key) setErrorFor(key, (err as Error).message);
    } finally {
      setPostingKey((k) => (k === key ? null : k));
    }
  };

  const data = query.data;
  // Rejoin a run that's already going (another tab, or before a reload).
  useEffect(() => {
    if (data?.running && progress === null && !noRejoin.current.has(currentKey)) setProgressFor(currentKey, "Working…");
  }, [data?.running, progress, currentKey]);

  useEffect(() => {
    if (!entry || !data || data.starting || data.running || data.error || posting || progress !== null) return;
    if (proposed.current.has(currentKey)) return;
    proposed.current.add(currentKey);
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, entry, mapId, posting, progress]);

  const streaming = progress !== null;
  useEffect(() => {
    if (!streaming || !entry) return;
    const key = `${mapId}:${entry}`;
    const source = new EventSource(`${url}/events?entry=${encodeURIComponent(entry)}`);
    const end = () => {
      source.close();
      // Until the refetch lands, the cached state still says running; without this, the
      // rejoin effect above would open the stream again.
      queryClient.setQueryData<WalkState>(walkKey(mapId, entry), (old) => old && { ...old, running: false });
      setProgressFor(key, null);
      void queryClient.invalidateQueries({ queryKey: walkKey(mapId, entry) });
    };
    source.onmessage = (e) => {
      const event = JSON.parse(e.data) as { type: string; text?: string };
      if (event.type === "tool") setProgressFor(key, event.text ?? "Working…");
      else {
        if (event.type === "error") setErrorFor(key, event.text ?? "The walkthrough failed");
        end();
      }
    };
    source.onerror = () => {
      noRejoin.current.add(key);
      // The cached running:false below must not trigger a proposal either.
      proposed.current.add(key);
      setErrorFor(key, "Lost contact with the walkthrough run");
      end();
    };
    return () => source.close();
  }, [streaming, entry, mapId, url, queryClient]);

  return {
    data,
    loadError: (query.error as Error | null) ?? null,
    progress,
    error: progress ? null : localError ?? data?.error ?? null,
    posting,
    run,
    retry: () => run(lastInputs.current.get(currentKey)),
  };
}
