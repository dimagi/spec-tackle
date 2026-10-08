import { useEffect, useRef, useState } from "react";
import type { ClaudeThread } from "../../../api/types";

export type Live = { tool: string; text: string };
export type StreamEvent = { type: string; text: string };

export const STARTED: Live = { tool: "Thinking…", text: "" };

/** One server event applied to a live answer; null when the turn is over (done, error or idle). */
export function streamStep(live: Live, ev: StreamEvent): Live | null {
  if (ev.type === "text") return { ...live, text: live.text + ev.text };
  if (ev.type === "tool") return { ...live, tool: ev.text };
  return null;
}

/** Follow every running turn; any tab (or a reload) can join part-way through. */
export function useClaudeStreams(threads: ClaudeThread[], onFinish: () => void): Map<string, Live> {
  const [lives, setLives] = useState(new Map<string, Live>());
  const sources = useRef(new Map<string, EventSource>());
  const finish = useRef(onFinish);
  finish.current = onFinish;

  useEffect(() => {
    for (const t of threads) {
      if (!t.running || sources.current.has(t.id)) continue;
      const source = new EventSource(`/api/claude/threads/${encodeURIComponent(t.id)}/events`);
      sources.current.set(t.id, source);
      const set = (live: Live | null) =>
        setLives((prev) => {
          const next = new Map(prev);
          if (live) next.set(t.id, live);
          else next.delete(t.id);
          return next;
        });
      let live = STARTED;
      set(live);
      const end = () => {
        source.close();
        sources.current.delete(t.id);
        set(null);
        finish.current();
      };
      source.onmessage = (e) => {
        const next = streamStep(live, JSON.parse(e.data));
        if (!next) return end();
        live = next;
        set(live);
      };
      source.onerror = end;
    }
  }, [threads]);

  useEffect(() => () => {
    sources.current.forEach((s) => s.close());
    sources.current.clear();
  }, []);
  return lives;
}
