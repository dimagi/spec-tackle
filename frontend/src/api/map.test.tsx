import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useMap } from "./map";

const pr = { owner: "o", repo: "r", number: 7 };
const ready = (head: string) => ({ status: "ready", headSha: head, nodes: [], edges: [], readingPath: [], limits: { importGraph: true, graphTruncated: false, baseMissing: false }, skipped: [] });

afterEach(() => vi.unstubAllGlobals());

test("keeps the old map while updating", async () => {
  const replies = [ready("aaa"), { status: "pending", headSha: "bbb" }];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(replies.shift() ?? { status: "pending", headSha: "bbb" }))));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

  const { result, rerender } = renderHook(({ head }) => useMap(pr, head, true), { wrapper, initialProps: { head: "aaa" } });
  await waitFor(() => expect(result.current.map?.headSha).toBe("aaa"));

  rerender({ head: "bbb" });

  await waitFor(() => expect(result.current.updating).toBe(true));
  expect(result.current.map?.headSha).toBe("aaa");
});
