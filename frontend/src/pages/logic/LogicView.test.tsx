import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LogicBlock, LogicFunctions, LogicMap, LogicState } from "../../api/types";
import { loadPref } from "../../state/storage";
import { LogicView } from "./LogicView";

const mermaid = vi.hoisted(() => {
  /** A stand-in for Mermaid: one <g> per node or subgraph line, labelled with its text. */
  const fakeSvg = (source: string) => {
    const parts = source.split("\n").flatMap((line) => {
      const sub = /^\s*subgraph (c\d+)\["(.*)"\]$/.exec(line);
      if (sub) return [`<g class="cluster" id="${sub[1]}"><g class="cluster-label"><text>${sub[2]}</text></g></g>`];
      const node = /^\s*(n\d+)\W+"(.*)"\W+$/.exec(line);
      if (node) return [`<g class="node" id="flowchart-${node[1]}-7"><text>${node[2]}</text></g>`];
      return [];
    });
    return `<svg>${parts.join("")}</svg>`;
  };
  return {
    fakeSvg,
    initialize: vi.fn(),
    render: vi.fn(async (_id: string, source: string) => ({ svg: fakeSvg(source) })),
  };
});
vi.mock("mermaid", () => ({ default: { initialize: mermaid.initialize, render: mermaid.render } }));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  send(event: object) { act(() => this.onmessage?.({ data: JSON.stringify(event) })); }
}

const PR = { owner: "o", repo: "r", number: 7 };
const HEAD = "abc1234aaaa";

const leaf = (id: string, label: string, over: Partial<LogicBlock> = {}): LogicBlock => ({
  id, label, kind: "step", change: "added", next: [], functions: [{ path: "app/visits.py", symbol: "save", start: 2, end: 3 }], ...over,
});
const BLOCKS: LogicBlock[] = [
  { id: "start", label: "Form is submitted", kind: "entry", change: "unchanged", next: [{ to: "save" }] },
  { id: "save", label: "Save and sync", kind: "step", change: "added", next: [], children: [
    leaf("store", "Store the visit", { next: [{ to: "sync" }] }),
    leaf("sync", "Queue a sync", { kind: "async", functions: [{ path: "lib/queue.py", symbol: "push", start: 1, end: 1 }] }),
  ] },
];
const MAP: LogicMap = { id: "m1", headSha: HEAD, summary: "Retries failed submissions.", blocks: BLOCKS, createdAt: "2026-10-08T09:00:00Z" };
const STORE_FNS: LogicFunctions = {
  label: "Store the visit", headSha: HEAD,
  functions: [{ path: "app/visits.py", symbol: "save", start: 2, end: 3, inDiff: true, lines: [
    { n: 2, html: "<span>def save():</span>", changed: false },
    { n: 3, html: "<span>    retry()</span>", changed: true },
  ] }],
};
const SYNC_FNS: LogicFunctions = {
  label: "Queue a sync", headSha: HEAD,
  functions: [{ path: "lib/queue.py", symbol: "push", start: 1, end: 1, inDiff: false, lines: [{ n: 1, html: "push()", changed: false }] }],
};

const state = (over: Partial<LogicState> = {}): LogicState => ({ available: true, map: null, stale: false, running: false, ...over });
const LOGIC = `/api/pr/o/r/7/logic`;

let routes: Record<string, unknown>;
let calls: string[];

function serve() {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    calls.push(key);
    const hit = routes[key];
    if (hit === undefined) return new Response(JSON.stringify({ error: `no route ${key}` }), { status: 500 });
    return new Response(JSON.stringify(typeof hit === "function" ? hit() : hit));
  }));
}

function setup(onShowInReview = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}><LogicView pr={PR} head={HEAD} onShowInReview={onShowInReview} /></QueryClientProvider>,
  );
  return { ...view, onShowInReview };
}

const node = (name: RegExp) => screen.findByRole("button", { name });

/** The progress stream, once the component has opened it (after the POST resolves). */
async function opened() {
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  return FakeEventSource.instances[0];
}

beforeEach(() => {
  localStorage.clear();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  mermaid.render.mockImplementation(async (_id: string, source: string) => ({ svg: mermaid.fakeSvg(source) }));
  routes = {
    [`GET ${LOGIC}?head=${HEAD}`]: state({ map: MAP }),
    "GET /api/logic/m1/blocks/store/functions": STORE_FNS,
    "GET /api/logic/m1/blocks/sync/functions": SYNC_FNS,
  };
  serve();
});
// Unmount before un-stubbing, so a leftover effect never runs without the fake EventSource.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("shows nothing when Claude isn't available", async () => {
  routes[`GET ${LOGIC}?head=${HEAD}`] = state({ available: false });
  const { container } = setup();
  await waitFor(() => expect(calls).toContain(`GET ${LOGIC}?head=${HEAD}`));
  await waitFor(() => expect(container).toBeEmptyDOMElement());
});

test("generate, follow progress, then show the map", async () => {
  let current = state();
  routes[`GET ${LOGIC}?head=${HEAD}`] = () => current;
  routes[`POST ${LOGIC}`] = state({ running: true, head: HEAD });
  setup();
  expect(await screen.findByText(/Private: runs on your machine/)).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Generate logic map" }));
  const source = await opened();
  expect(source.url).toBe(`${LOGIC}/events?head=${HEAD}`);
  source.send({ type: "tool", text: "Reading app/visits.py" });
  expect(screen.getByText("Reading app/visits.py")).toBeInTheDocument();

  current = state({ map: MAP });
  source.send({ type: "done", mapId: "m1" });
  expect(await screen.findByText("Retries failed submissions.")).toBeInTheDocument();
  expect(source.close).toHaveBeenCalled();
  expect(screen.queryByText("Reading app/visits.py")).toBeNull();
});

test("rejoins a run that's already going", async () => {
  routes[`GET ${LOGIC}?head=${HEAD}`] = state({ running: true });
  setup();
  expect(await screen.findByText("Working…")).toBeInTheDocument();
  expect((await opened()).url).toBe(`${LOGIC}/events?head=${HEAD}`);
});

test("a failed run shows the error and can be tried again", async () => {
  routes[`GET ${LOGIC}?head=${HEAD}`] = state();
  routes[`POST ${LOGIC}`] = state({ running: true, head: HEAD });
  setup();
  await userEvent.click(await screen.findByRole("button", { name: "Generate logic map" }));
  (await opened()).send({ type: "error", text: "Claude's map didn't pass validation: blocks" });
  expect(await screen.findByText(/didn't pass validation/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(calls.filter((c) => c === `POST ${LOGIC}`)).toHaveLength(2);
});

test("a stale map says so and can be regenerated", async () => {
  routes[`GET ${LOGIC}?head=${HEAD}`] = state({ map: { ...MAP, headSha: "0ld0000ffff" }, stale: true });
  routes[`POST ${LOGIC}`] = state({ map: { ...MAP, headSha: "0ld0000ffff" }, stale: true, running: true, head: HEAD });
  setup();
  const banner = await screen.findByText(/Generated for/);
  expect(banner).toHaveTextContent("Generated for 0ld0000; the PR is now at abc1234.");
  await userEvent.click(screen.getByRole("button", { name: "Regenerate" }));
  expect(calls).toContain(`POST ${LOGIC}`);
  expect(screen.getByText("Retries failed submissions.")).toBeInTheDocument();  // the old map stays up
});

test("clicking a block expands it, clicking its title collapses it, and the choice is kept", async () => {
  setup();
  await userEvent.click(await node(/Save and sync ⊕/));
  expect(await screen.findByRole("button", { name: /⊖ Save and sync/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Store the visit/ })).toBeInTheDocument();
  expect(loadPref(PR, "logicExpanded", [])).toEqual(["save"]);

  await userEvent.click(screen.getByRole("button", { name: /⊖ Save and sync/ }));
  expect(await node(/Save and sync ⊕/)).toBeInTheDocument();
  expect(loadPref(PR, "logicExpanded", [])).toEqual([]);
});

test("Expand all and Collapse all", async () => {
  setup();
  await node(/Form is submitted/);
  await userEvent.click(screen.getByRole("button", { name: "Expand all" }));
  expect(await node(/Queue a sync/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Collapse all" }));
  expect(await node(/Save and sync ⊕/)).toBeInTheDocument();
});

test("a leaf opens its functions with the changed lines marked; Esc closes them", async () => {
  localStorage.setItem("spec-tackle:o/r#7:logicExpanded", JSON.stringify(["save"]));
  const { onShowInReview } = setup();
  await userEvent.click(await node(/Store the visit/));
  const panel = await screen.findByRole("complementary", { name: "Store the visit" });
  expect(await within(panel).findByText("save")).toBeInTheDocument();
  expect(within(panel).getByText("app/visits.py:2–3")).toBeInTheDocument();
  const changed = within(panel).getByText("retry()").closest(".logic-line")!;
  expect(changed).toHaveClass("changed");

  await userEvent.click(within(panel).getByRole("button", { name: "Show in Review" }));
  expect(onShowInReview).toHaveBeenCalledWith("app/visits.py", 3);

  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("complementary")).toBeNull();
});

test("a function outside the PR links to GitHub instead", async () => {
  localStorage.setItem("spec-tackle:o/r#7:logicExpanded", JSON.stringify(["save"]));
  setup();
  await userEvent.click(await node(/Queue a sync/));
  const panel = await screen.findByRole("complementary", { name: "Queue a sync" });
  expect(await within(panel).findByText("unchanged by this PR")).toBeInTheDocument();
  expect(within(panel).getByRole("link", { name: "View on GitHub" }))
    .toHaveAttribute("href", `https://github.com/o/r/blob/${HEAD}/lib/queue.py#L1-L1`);
});

test("blocks are keyboard operable", async () => {
  setup();
  const save = await node(/Save and sync ⊕/);
  expect(save).toHaveAttribute("tabindex", "0");
  save.focus();
  await userEvent.keyboard("{Enter}");
  expect(await screen.findByRole("button", { name: /⊖ Save and sync/ })).toBeInTheDocument();
});

test("if Mermaid fails, the map is shown as a list that still works", async () => {
  mermaid.render.mockRejectedValue(new Error("Parse error"));
  setup();
  const list = await screen.findByRole("tree", { name: "Logic map" });
  expect(list).toBeVisible();
  await userEvent.click(within(list).getByRole("button", { name: /Save and sync/ }));
  await userEvent.click(await within(list).findByRole("button", { name: /Store the visit/ }));
  expect(await screen.findByRole("complementary", { name: "Store the visit" })).toBeInTheDocument();
});
