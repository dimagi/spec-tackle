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
};

/** One entry's walkthrough: its state, a run (proposing without inputs), and the run's progress. */
export function useWalk(mapId: string, entry: string | null): WalkRun {
  const query = useWalkthrough(mapId, entry);
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  // Each entry proposes by itself at most once per mount; after a failure, Try again does it.
  const proposed = useRef(new Set<string>());
  const url = `/api/logic/${encodeURIComponent(mapId)}/walkthrough`;

  useEffect(() => { setProgress(null); setError(null); }, [mapId, entry]);

  const run = async (inputs?: Record<string, unknown>) => {
    if (!entry) return;
    setError(null);
    setPosting(true);
    try {
      const state = await request<WalkState>("POST", url, inputs === undefined ? { entry } : { entry, inputs });
      queryClient.setQueryData(walkKey(mapId, entry), state);
      if (state.running) setProgress("Starting…");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPosting(false);
    }
  };

  const data = query.data;
  // Rejoin a run that's already going (another tab, or before a reload).
  useEffect(() => {
    if (data?.running && progress === null) setProgress("Working…");
  }, [data?.running, progress]);

  useEffect(() => {
    if (!entry || !data || data.starting || data.running || data.error || posting || progress !== null) return;
    const key = `${mapId}:${entry}`;
    if (proposed.current.has(key)) return;
    proposed.current.add(key);
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, entry, mapId, posting, progress]);

  const streaming = progress !== null;
  useEffect(() => {
    if (!streaming || !entry) return;
    const source = new EventSource(`${url}/events?entry=${encodeURIComponent(entry)}`);
    const end = () => {
      source.close();
      // Until the refetch lands, the cached state still says running; without this, the
      // rejoin effect above would open the stream again.
      queryClient.setQueryData<WalkState>(walkKey(mapId, entry), (old) => old && { ...old, running: false });
      setProgress(null);
      void queryClient.invalidateQueries({ queryKey: walkKey(mapId, entry) });
    };
    source.onmessage = (e) => {
      const event = JSON.parse(e.data) as { type: string; text?: string };
      if (event.type === "tool") setProgress(event.text ?? "Working…");
      else {
        if (event.type === "error") setError(event.text ?? "The walkthrough failed");
        end();
      }
    };
    source.onerror = end;
    return () => source.close();
  }, [streaming, entry, mapId, url, queryClient]);

  return {
    data,
    loadError: (query.error as Error | null) ?? null,
    progress,
    error: progress ? null : error ?? data?.error ?? null,
    posting,
    run,
  };
}
