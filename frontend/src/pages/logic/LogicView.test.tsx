import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LogicBlock, LogicFunctions, LogicMap, LogicState, Trace } from "../../api/types";
import { layoutFlow } from "../../lib/logicFlow";
import { loadPref } from "../../state/storage";
import { stubReactFlowEnvironment } from "../../test/reactFlow";
import { LogicView } from "./LogicView";

// The real layout runs (ELK); one test makes it fail to check the list fallback.
vi.mock("../../lib/logicFlow", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../lib/logicFlow")>();
  return { ...real, layoutFlow: vi.fn(real.layoutFlow) };
});

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
const TEST_BLOCK: LogicBlock = {
  id: "spec", label: "Test: retries are tried five times", kind: "step", change: "added", next: [],
  functions: [{ path: "tests/test_retry.py", symbol: "test_five_tries", start: 1, end: 9 }],
};
const MAP: LogicMap = { id: "m1", headSha: HEAD, summary: "Retries failed submissions.", blocks: [...BLOCKS, TEST_BLOCK], createdAt: "2026-10-08T09:00:00Z" };
const STORE_FNS: LogicFunctions = {
  label: "Store the visit", headSha: HEAD,
  functions: [{ path: "app/visits.py", symbol: "save", start: 2, end: 3, inDiff: true, step: "Store the visit", lines: [
    { n: 2, html: "<span>def save():</span>", changed: false },
    { n: 3, html: "<span>    retry()</span>", changed: true },
  ] }],
};
const SYNC_FNS: LogicFunctions = {
  label: "Queue a sync", headSha: HEAD,
  functions: [{ path: "lib/queue.py", symbol: "push", start: 1, end: 1, inDiff: false, step: "Queue a sync", lines: [{ n: 1, html: "push()", changed: false }] }],
};
const SAVE_FNS: LogicFunctions = {
  label: "Save and sync", headSha: HEAD,
  functions: [...STORE_FNS.functions, ...SYNC_FNS.functions],
};

const TRACE: Trace = {
  id: "t1", mapId: "m1", entryId: "start", proposed: true, usedAt: "",
  inputs: [{ name: "form", description: "The form", value: { id: 7 } }],
  steps: [
    { blockId: "start", input: { form: { id: 7 } }, output: { ok: true }, note: "Accepts the form." },
    { blockId: "store", input: { id: 7 }, output: { saved: true }, note: "Stores it." },
    { blockId: "sync", input: { id: 7 }, output: { queued: true }, note: "Queues it.",
      danger: [{ kind: "external", note: "Posts to the sync webhook" }] },
  ],
  outcome: { kind: "stopped", message: "The sync job runs elsewhere" },
};
const WALK = "/api/logic/m1/walkthrough";

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

function setup(onShowInReview = vi.fn(), initialWalk: string | null = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper() {
    const [walk, setWalk] = useState<string | null>(initialWalk);
    return <LogicView pr={PR} head={HEAD} walk={walk} onWalk={setWalk} onShowInReview={onShowInReview} />;
  }
  const view = render(<QueryClientProvider client={client}><Wrapper /></QueryClientProvider>);
  return { ...view, onShowInReview };
}

const node = (name: RegExp) => screen.findByRole("button", { name });

/** Click with Ctrl (or ⌘) held: the modifier has to stay down across the click. */
async function modClick(el: Element, key: "Control" | "Meta" = "Control") {
  const user = userEvent.setup();
  await user.keyboard(`{${key}>}`);
  await user.click(el);
  await user.keyboard(`{/${key}}`);
}

/** The progress stream, once the component has opened it (after the POST resolves). */
async function opened() {
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  return FakeEventSource.instances[0];
}

beforeEach(() => {
  localStorage.clear();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  stubReactFlowEnvironment();
  routes = {
    [`GET ${LOGIC}?head=${HEAD}`]: state({ map: MAP }),
    "GET /api/logic/m1/blocks/store/functions": STORE_FNS,
    "GET /api/logic/m1/blocks/sync/functions": SYNC_FNS,
    "GET /api/logic/m1/blocks/save/functions": SAVE_FNS,
    [`GET ${WALK}?entry=start`]: { trace: TRACE, starting: TRACE.inputs, running: false, error: null },
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

test("Ctrl-click expands a block, Ctrl-click on its title collapses it, and the choice is kept", async () => {
  setup();
  await modClick(await node(/Save and sync ⊕/));
  expect(await screen.findByRole("button", { name: /⊖ Save and sync/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Store the visit/ })).toBeInTheDocument();
  expect(loadPref(PR, "logicExpanded", [])).toEqual(["save"]);
  expect(screen.queryByRole("complementary")).toBeNull();

  await modClick(screen.getByRole("button", { name: /⊖ Save and sync/ }));
  expect(await node(/Save and sync ⊕/)).toBeInTheDocument();
  expect(loadPref(PR, "logicExpanded", [])).toEqual([]);
});

test("⌘-click expands too, for Macs", async () => {
  setup();
  await modClick(await node(/Save and sync ⊕/), "Meta");
  expect(await screen.findByRole("button", { name: /⊖ Save and sync/ })).toBeInTheDocument();
});

test("a plain click on an expandable block shows the code of every step inside it", async () => {
  setup();
  await userEvent.click(await node(/Save and sync ⊕/));
  const panel = await screen.findByRole("complementary", { name: "Save and sync" });
  expect(await within(panel).findByText("save")).toBeInTheDocument();
  expect(within(panel).getByText("push")).toBeInTheDocument();
  expect(within(panel).getByText("Store the visit")).toBeInTheDocument();
  expect(within(panel).getByText("Queue a sync")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /⊖ Save and sync/ })).toBeNull();  // not expanded
});

test("a plain click on an expanded block's title shows its code too", async () => {
  localStorage.setItem("spec-tackle:o/r#7:logicExpanded", JSON.stringify(["save"]));
  setup();
  await userEvent.click(await node(/⊖ Save and sync/));
  expect(await screen.findByRole("complementary", { name: "Save and sync" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /⊖ Save and sync/ })).toBeInTheDocument();  // still expanded
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
  expect(within(panel).queryByText("Store the visit", { selector: ".logic-step" })).toBeNull();
  const changed = within(panel).getByText("retry()").closest(".logic-line")!;
  expect(changed).toHaveClass("changed");

  await userEvent.click(within(panel).getByRole("button", { name: "Show in Code view" }));
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

test("blocks are keyboard operable: Enter shows the code, Ctrl+Enter expands", async () => {
  setup();
  const save = await node(/Save and sync ⊕/);
  expect(save).toHaveAttribute("tabindex", "0");
  expect(save).toHaveAccessibleName(/Ctrl-click to expand/);
  const user = userEvent.setup();
  save.focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("complementary", { name: "Save and sync" })).toBeInTheDocument();
  save.focus();
  await user.keyboard("{Control>}{Enter}{/Control}");
  expect(await screen.findByRole("button", { name: /⊖ Save and sync/ })).toBeInTheDocument();
});

test("if the layout fails, the map is shown as a list that still works", async () => {
  vi.mocked(layoutFlow).mockRejectedValueOnce(new Error("ELK failed"));
  setup();
  const list = await screen.findByRole("tree", { name: "Logic map" });
  expect(list).toBeVisible();
  await userEvent.click(within(list).getByRole("button", { name: "Expand Save and sync" }));
  await userEvent.click(await within(list).findByRole("button", { name: /Store the visit/ }));
  expect(await screen.findByRole("complementary", { name: "Store the visit" })).toBeInTheDocument();
});

test("the legend explains the red outline", async () => {
  setup();
  await node(/Form is submitted/);
  expect(screen.getByText(/red outline: exit/)).toBeInTheDocument();
});

test("a run that failed while nobody watched shows its error", async () => {
  routes[`GET ${LOGIC}?head=${HEAD}`] = state({ error: "Couldn't fetch the repository: gone" });
  setup();
  expect(await screen.findByText("Couldn't fetch the repository: gone")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
});

test("a run started for a newer head is followed at that head, so the new map isn't called stale", async () => {
  const NEW = "def5678bbbb";
  routes[`GET ${LOGIC}?head=${HEAD}`] = state();
  routes[`POST ${LOGIC}`] = state({ running: true, head: NEW });
  routes[`GET ${LOGIC}?head=${NEW}`] = state({ map: { ...MAP, headSha: NEW } });
  setup();
  await userEvent.click(await screen.findByRole("button", { name: "Generate logic map" }));
  const source = await opened();
  expect(source.url).toBe(`${LOGIC}/events?head=${NEW}`);
  source.send({ type: "done", mapId: "m1" });
  expect(await screen.findByText("Retries failed submissions.")).toBeInTheDocument();
  expect(screen.queryByText(/Generated for/)).toBeNull();
});

test("test blocks are hidden until you ask for them, and the choice is kept", async () => {
  setup();
  await node(/Form is submitted/);
  expect(screen.queryByRole("button", { name: /Test: retries/ })).toBeNull();

  const toggle = screen.getByRole("button", { name: "Show tests (1)" });
  expect(toggle).toHaveAttribute("aria-pressed", "false");
  await userEvent.click(toggle);
  expect(await node(/Test: retries are tried five times/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Hide tests (1)" })).toHaveAttribute("aria-pressed", "true");
  expect(loadPref(PR, "logicShowTests", false)).toBe(true);
});

test("the Walkthrough button opens the panel on the first entry and expands the path without saving it", async () => {
  setup();
  await userEvent.click(await screen.findByRole("button", { name: /Walkthrough/ }));
  const panel = await screen.findByRole("complementary", { name: "Walkthrough" });
  expect(await within(panel).findByText("Accepts the form.")).toBeInTheDocument();
  // "Save and sync" holds steps of the trace, so it's expanded for the walkthrough...
  expect(await node(/⊖ Save and sync/)).toBeInTheDocument();
  // ...without touching the reviewer's saved choice.
  expect(loadPref(PR, "logicExpanded", [])).toEqual([]);
  expect((await node(/^Form is submitted/)).className).toMatch(/walk-current/);
  // The panel's danger list has a "Queue a sync" button too; the chart's is the one outside it.
  const queued = (await screen.findAllByRole("button", { name: /^Queue a sync/ })).find((b) => !b.closest("aside"));
  expect(queued).toHaveAccessibleName(/flagged as dangerous: External effect/);

  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("complementary", { name: "Walkthrough" })).toBeNull();
  expect(await node(/^Save and sync ⊕/)).toBeInTheDocument();
  expect(document.querySelector(".walk-current, .walk-step")).toBeNull();
});

test("clicking a visited block jumps to its step; others open their code", async () => {
  setup(vi.fn(), "start");
  const panel = await screen.findByRole("complementary", { name: "Walkthrough" });
  await within(panel).findByText("Step 1 of 3");
  await userEvent.click(within(panel).getByRole("button", { name: /Next/ }));
  await userEvent.click(within(panel).getByRole("button", { name: /Next/ }));
  await userEvent.click(await node(/^Store the visit/));
  expect(within(panel).getByText("Step 2 of 3")).toBeInTheDocument();
});

test("Show code opens the function panel, and Back returns to the same step", async () => {
  setup(vi.fn(), "start");
  const panel = await screen.findByRole("complementary", { name: "Walkthrough" });
  await userEvent.click(await within(panel).findByRole("button", { name: /Next/ }));
  await userEvent.click(within(panel).getByRole("button", { name: /Show code/ }));
  const code = await screen.findByRole("complementary", { name: "Store the visit" });
  await userEvent.click(within(code).getByRole("button", { name: /Back to walkthrough/ }));
  expect(await screen.findByText("Step 2 of 3")).toBeInTheDocument();
});

test("an unknown ?walk= entry falls back to the first entry", async () => {
  setup(vi.fn(), "gone");
  const panel = await screen.findByRole("complementary", { name: "Walkthrough" });
  expect(within(panel).getByRole("combobox", { name: "Entry" })).toHaveValue("start");
  await within(panel).findByText("Accepts the form.");
  expect(calls).not.toContain(`GET ${WALK}?entry=gone`);
});

test("a step in a hidden test block is still drawn", async () => {
  routes[`GET ${WALK}?entry=start`] = {
    trace: { ...TRACE, steps: [TRACE.steps[0], { blockId: "spec", input: {}, output: {}, note: "Runs the test." }] },
    starting: TRACE.inputs, running: false, error: null,
  };
  setup(vi.fn(), "start");
  expect(await node(/^Test: retries are tried five times/)).toBeInTheDocument();
});

test("with no entry blocks the Walkthrough button is disabled", async () => {
  routes[`GET ${LOGIC}?head=${HEAD}`] = state({ map: { ...MAP, blocks: [{ ...BLOCKS[1] }] } });
  setup();
  const button = await screen.findByRole("button", { name: /Walkthrough/ });
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute("title", "This map has no entry blocks");
});
