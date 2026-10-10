import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { WalkState } from "../../api/types";
import { useWalk } from "./useWalk";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  send(event: object) { act(() => this.onmessage?.({ data: JSON.stringify(event) })); }
}

const URL_ = "/api/logic/m1/walkthrough";
const empty: WalkState = { trace: null, starting: null, running: false, error: null };
let current: WalkState;
let posts: unknown[];

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  current = empty;
  posts = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ...current, running: true }));
    }
    if (url === `${URL_}?entry=send`) return new Response(JSON.stringify(current));
    return new Response("{}", { status: 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

test("an entry without starting inputs proposes once, and follows the run", async () => {
  const { result } = renderHook(() => useWalk("m1", "send"), { wrapper });
  await waitFor(() => expect(posts).toEqual([{ entry: "send" }]));
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  const source = FakeEventSource.instances[0];
  expect(source.url).toBe(`${URL_}/events?entry=send`);
  source.send({ type: "tool", text: "Reading app/visits.py" });
  expect(result.current.progress).toBe("Reading app/visits.py");
  current = { ...empty, starting: [{ name: "a", description: "d", value: 1 }] };
  source.send({ type: "done", traceId: "t1" });
  await waitFor(() => expect(result.current.data?.starting).toHaveLength(1));
  expect(result.current.progress).toBeNull();
  expect(posts).toHaveLength(1);
});

test("a failed proposal is shown and not retried by itself", async () => {
  const { result } = renderHook(() => useWalk("m1", "send"), { wrapper });
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  current = { ...empty, error: "Claude's walkthrough didn't pass validation: x" };
  FakeEventSource.instances[0].send({ type: "error", text: "Claude's walkthrough didn't pass validation: x" });
  await waitFor(() => expect(result.current.error).toMatch(/didn't pass validation/));
  await new Promise((r) => setTimeout(r, 50));
  expect(posts).toHaveLength(1);
});

test("run sends the inputs", async () => {
  current = { ...empty, starting: [{ name: "a", description: "d", value: 1 }] };
  const { result } = renderHook(() => useWalk("m1", "send"), { wrapper });
  await waitFor(() => expect(result.current.data).toBeDefined());
  await act(() => result.current.run({ a: 2 }));
  expect(posts).toEqual([{ entry: "send", inputs: { a: 2 } }]);
});
