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

test("a failing stream shows an error, does not loop, and Try again reopens it", async () => {
  current = { ...empty, running: true };
  const { result } = renderHook(() => useWalk("m1", "send"), { wrapper });
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  act(() => FakeEventSource.instances[0].onerror?.());
  await waitFor(() => expect(result.current.error).toBe("Lost contact with the walkthrough run"));
  await new Promise((r) => setTimeout(r, 50));
  expect(FakeEventSource.instances).toHaveLength(1);
  await act(() => result.current.run());
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
});

test("switching entries mid-run does not leak the old entry's run", async () => {
  current = { ...empty, starting: [{ name: "a", description: "d", value: 1 }] };
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const base = vi.mocked(fetch).getMockImplementation()!;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") await gate;
    if (String(url).includes("entry=job")) return new Response(JSON.stringify(current));
    return base(url, init);
  }));
  const { result, rerender } = renderHook(({ entry }) => useWalk("m1", entry), { wrapper, initialProps: { entry: "send" } });
  await waitFor(() => expect(result.current.data).toBeDefined());
  let pending!: Promise<void>;
  act(() => { pending = result.current.run({ a: 1 }); });
  rerender({ entry: "job" });
  await act(async () => { release(); await pending; });
  expect(result.current.progress).toBeNull();
  expect(result.current.posting).toBe(false);
  expect(FakeEventSource.instances.filter((s) => s.url.includes("entry=job"))).toHaveLength(0);
});

test("retry resends the inputs of the last run, even when it failed", async () => {
  current = { ...empty, starting: [{ name: "a", description: "d", value: 1 }] };
  const { result } = renderHook(() => useWalk("m1", "send"), { wrapper });
  await waitFor(() => expect(result.current.data).toBeDefined());
  const base = vi.mocked(fetch).getMockImplementation()!;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
    }
    return base(url, init);
  }));
  await act(() => result.current.run({ a: 5 }));
  await waitFor(() => expect(result.current.error).toBeTruthy());
  await act(() => result.current.retry());
  expect(posts).toEqual([{ entry: "send", inputs: { a: 5 } }, { entry: "send", inputs: { a: 5 } }]);
});
