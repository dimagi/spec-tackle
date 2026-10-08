import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { PRRef } from "../state/storage";
import { apiBase } from "./queries";
import { request } from "./request";

export type Phase = "data" | "core" | "edges" | "tests" | "other";
export type MapSymbol = { name: string; kind: string; change: "added" | "modified" | "removed"; signatureChanged: boolean };

export type MapNode = {
  id: string;
  hop: 0 | 1;
  phase: Phase;
  module?: string | null;
  inGraph: boolean;
  // hop 0
  status?: string;
  additions?: number;
  deletions?: number;
  tag?: string | null;
  symbols?: MapSymbol[];
  // hop 1
  imports?: string[];
  references?: string[];
  indirectCount?: number;
  indirect?: string[];
};

export type MapEdge = { from: string; to: string; symbols: string[] };

export type ChangeKind = "function" | "method" | "class" | "attribute" | "module" | "file" | "caller";
export type ChangeNode = {
  id: string; // "path::qualname"
  file: string;
  label: string;
  kind: ChangeKind;
  change: "added" | "modified" | "removed" | "moved" | "caller";
  signatureChanged: boolean;
  additions: number;
  deletions: number;
  lines: [number, number] | null;
  baseLines: [number, number] | null;
  from?: { file: string; name: string };
};
export type ChangeEdgeType = "uses" | "probable" | "breaks-signature" | "breaks-removed" | "replaced" | "tests";
export type ChangeEdge = { from: string; to: string; type: ChangeEdgeType; line: number };
export type Changes = {
  nodes: ChangeNode[];
  edges: ChangeEdge[];
  readingPath: { phase: Phase | "check"; ids: string[] }[];
};

export type PRMap = {
  status: "ready";
  headSha: string;
  nodes: MapNode[];
  edges: MapEdge[];
  readingPath: { phase: Phase; files: string[] }[];
  limits: { importGraph: boolean; graphTruncated: boolean; baseMissing: boolean };
  skipped: { path: string; reason: string }[];
  changes?: Changes;
};

type MapResponse = PRMap | { status: "pending"; headSha: string } | { status: "error"; message: string; headSha: string };

/** The PR's map, polled while it's being built. The last ready map stays while a newer head is analysed. */
export function useMap(pr: PRRef, head: string, enabled: boolean) {
  const query = useQuery({
    queryKey: ["map", pr.owner, pr.repo, pr.number, head],
    queryFn: () => request<MapResponse>("GET", `${apiBase(pr)}/map`),
    enabled,
    refetchInterval: (q) => (q.state.data?.status === "pending" ? 2000 : false),
  });
  const [lastReady, setLastReady] = useState<PRMap | null>(null);
  const data = query.data;
  useEffect(() => {
    if (data?.status === "ready") setLastReady(data);
  }, [data]);
  const map = data?.status === "ready" ? data : lastReady;
  const pending = !data || data.status === "pending";
  return {
    map,
    pending,
    updating: pending && !!map,
    error: data?.status === "error" ? data.message : query.error ? (query.error as Error).message : null,
    retry: () => query.refetch(),
  };
}

export function useNarration(pr: PRRef) {
  return useMutation({ mutationFn: () => request<Record<string, string>>("POST", `${apiBase(pr)}/map/narrate`) });
}
