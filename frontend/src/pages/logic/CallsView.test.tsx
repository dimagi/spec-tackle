import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CallEdge, CallNode, CallSource, CallTree } from "../../api/types";
import { layoutCalls } from "../../lib/callTree";
import { loadPref } from "../../state/storage";
import { stubReactFlowEnvironment } from "../../test/reactFlow";
import { CallsView } from "./CallsView";

vi.mock("../../lib/callTree", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../lib/callTree")>();
  return { ...real, layoutCalls: vi.fn(real.layoutCalls) };
});

const PR = { owner: "o", repo: "r", number: 7 };
const HEAD = "abc1234aaaa";
const CALLS = `/api/pr/o/r/7/calls`;

const node = (id: string, over: Partial<CallNode> = {}): CallNode => ({
  id, path: id.split("::")[0], symbol: id.split("::")[1], start: 1, end: 2, kind: "function",
  change: "unchanged", signatureChanged: false, decorators: [], test: false, up: null, down: null, ...over,
});
const edge = (from: string, to: string, over: Partial<CallEdge> = {}): CallEdge => ({
  from, to, kind: "call", lines: [5], notUpdated: false, ...over,
});

const TREE: CallTree = {
  headSha: HEAD,
  nodes: [
    node("app/retry.py::backoff", { change: "changed", signatureChanged: true, up: 0, down: 0 }),
    node("app/forms.py::send", { up: 1, start: 4, end: 5, decorators: ['router.post("/send")'] }),
    node("app/web.py::handle", { up: 2 }),
    node("app/clock.py::sleep", { down: 1 }),
    node("tests/test_retry.py::test_backoff", { up: 1, test: true }),
  ],
  edges: [
    edge("app/forms.py::send", "app/retry.py::backoff", { notUpdated: true }),
    edge("app/web.py::handle", "app/forms.py::send"),
    edge("app/retry.py::backoff", "app/clock.py::sleep", { lines: [2] }),
    edge("tests/test_retry.py::test_backoff", "app/retry.py::backoff", { notUpdated: true }),
  ],
  other: [{ path: "docs/retry.md", reason: "not Python" }],
  truncated: null,
  depth: { up: 3, down: 3 },
};
const SOURCE: CallSource = {
  path: "app/retry.py", symbol: "backoff", start: 1, end: 2, inDiff: true,
  lines: [{ n: 1, html: "def backoff(tries, base):", changed: true }, { n: 2, html: "    sleep()", changed: false }],
};

let routes: Record<string, unknown>;
let requested: string[];

beforeEach(() => {
  localStorage.clear();
  stubReactFlowEnvironment();
  routes = {
    [`GET ${CALLS}?head=${HEAD}`]: TREE,
    [`GET ${CALLS}/source?head=${HEAD}&node=${encodeURIComponent("app/retry.py::backoff")}`]: SOURCE,
  };
  requested = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    requested.push(key);
    const hit = routes[key];
    if (hit === undefined) return new Response(JSON.stringify({ detail: `no route ${key}` }), { status: 500 });
    if (hit instanceof Response) return hit;
    return new Response(JSON.stringify(hit));
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup(props: Partial<React.ComponentProps<typeof CallsView>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onShowInReview = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <CallsView pr={PR} head={HEAD} focus={null} onShowInReview={onShowInReview} {...props} />
    </QueryClientProvider>,
  );
  return { onShowInReview };
}

const card = (name: RegExp) => screen.findByRole("button", { name });
const chart = () => document.querySelector(".logic-flow") as HTMLElement;

test("loading, then the summary and the chart", async () => {
  setup();
  expect(screen.getByText(/Reading the code/)).toBeInTheDocument();
  expect(await screen.findByText("1 changed function, 2 callers, 1 callee · 1 caller not updated")).toBeInTheDocument();
  expect(await card(/changed function backoff, signature changed/)).toBeInTheDocument();
  expect(within(chart()).getByText("backoff()")).toBeInTheDocument();
  expect(within(chart()).getByText("send()")).toBeInTheDocument();
  expect(within(chart()).getByText("sleep()")).toBeInTheDocument();
  expect(within(chart()).getByText("handle()")).toBeInTheDocument(); // 2 caller hops by default
});

test("a PR without Python changes says so and lists the other files", async () => {
  routes[`GET ${CALLS}?head=${HEAD}`] = { ...TREE, nodes: [], edges: [] };
  setup();
  expect(await screen.findByText("This PR changes no Python functions.")).toBeInTheDocument();
  expect(screen.getByText("docs/retry.md")).toBeInTheDocument();
});

test("a failure shows the error and can be tried again", async () => {
  routes[`GET ${CALLS}?head=${HEAD}`] = new Response(JSON.stringify({ detail: "Couldn't fetch the repository: down" }), { status: 502 });
  setup();
  expect(await screen.findByText(/Couldn't fetch the repository: down/)).toBeInTheDocument();
  routes[`GET ${CALLS}?head=${HEAD}`] = TREE;
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await card(/changed function backoff/)).toBeInTheDocument();
});

test("a truncated tree says how much is shown", async () => {
  routes[`GET ${CALLS}?head=${HEAD}`] = { ...TREE, truncated: "nodes", depth: { up: 2, down: 1 } };
  setup();
  expect(await screen.findByText(/Showing 2 caller hops and 1 callee hop; the full tree is too large/)).toBeInTheDocument();
});

test("the hop steppers change what's shown, stay within the tree's depth, and are kept", async () => {
  setup();
  await card(/backoff/);
  await userEvent.click(screen.getByRole("button", { name: "Fewer caller hops" }));
  await waitFor(() => expect(within(chart()).queryByText("handle()")).not.toBeInTheDocument());
  expect(within(chart()).getByText("send()")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "More caller hops" })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "Fewer callee hops" }));
  await waitFor(() => expect(within(chart()).queryByText("sleep()")).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: "Fewer callee hops" })).toBeDisabled();
  expect(loadPref(PR, "callsDepth", null)).toEqual({ up: 1, down: 0 });
});

test("tests are hidden at first and counted on what they call", async () => {
  setup();
  expect(await card(/backoff.*1 test/)).toBeInTheDocument();
  expect(within(chart()).queryByText("test_backoff()")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Show tests (1)" }));
  expect(await within(chart()).findByText("test_backoff()")).toBeInTheDocument();
  expect(loadPref(PR, "callsShowTests", false)).toBe(true);
});

test("only breakage keeps the changed signature and the callers that weren't updated", async () => {
  setup();
  await card(/backoff/);
  await userEvent.click(screen.getByRole("button", { name: "Only breakage" }));
  await waitFor(() => expect(within(chart()).queryByText("sleep()")).not.toBeInTheDocument());
  expect(within(chart()).getByText("send()")).toBeInTheDocument();
});

test("clicking a node opens its panel with its callers and callees; Esc closes it", async () => {
  setup();
  await userEvent.click(await card(/changed function backoff/));
  const panel = await screen.findByRole("complementary", { name: "backoff()" });
  expect(within(panel).getByText("app/retry.py:1–2")).toBeInTheDocument();
  expect(panel.querySelector(".logic-line.changed")).toHaveTextContent("def backoff(tries, base):");
  expect(within(panel).getByRole("button", { name: /send\(\).*app\/forms\.py:5/ })).toBeInTheDocument();
  expect(within(panel).getByRole("button", { name: /sleep\(\).*app\/retry\.py:2/ })).toBeInTheDocument();

  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("complementary")).not.toBeInTheDocument());
  expect(within(chart()).getByRole("button", { name: /function sleep/ })).not.toHaveClass("faded");
});

test("a Called by item focuses that node and opens it", async () => {
  routes[`GET ${CALLS}?head=${HEAD}`] = {
    ...TREE,
    nodes: [...TREE.nodes, node("app/other.py::resend", { up: 1 })],
    edges: [...TREE.edges, edge("app/other.py::resend", "app/retry.py::backoff")],
  };
  routes[`GET ${CALLS}/source?head=${HEAD}&node=${encodeURIComponent("app/forms.py::send")}`] = { ...SOURCE, symbol: "send", path: "app/forms.py", start: 4, end: 5, inDiff: false };
  setup();
  await userEvent.click(await card(/changed function backoff/));
  const panel = await screen.findByRole("complementary", { name: "backoff()" });
  await userEvent.click(within(panel).getByRole("button", { name: /^send\(\)/ }));
  const next = await screen.findByRole("complementary", { name: "send()" });
  expect(within(next).getByText('@router.post("/send")')).toBeInTheDocument();
  expect(within(next).getByRole("link", { name: "View on GitHub" })).toHaveAttribute(
    "href", `https://github.com/o/r/blob/${HEAD}/app/forms.py#L4-L5`,
  );
  // What send calls, what calls it, and further down stay; backoff's other caller fades.
  await waitFor(() => expect(within(chart()).getByRole("button", { name: /function resend/ })).toHaveClass("faded"));
  expect(within(chart()).getByRole("button", { name: /function handle/ })).not.toHaveClass("faded");
  expect(within(chart()).getByRole("button", { name: /function sleep/ })).not.toHaveClass("faded");
});

test("Show in Code view goes to the first changed line", async () => {
  const { onShowInReview } = setup();
  await userEvent.click(await card(/changed function backoff/));
  const panel = await screen.findByRole("complementary", { name: "backoff()" });
  await userEvent.click(await within(panel).findByRole("button", { name: "Show in Code view" }));
  expect(onShowInReview).toHaveBeenCalledWith("app/retry.py", 1);
});

test("a focus from outside opens that node", async () => {
  setup({ focus: "app/retry.py::backoff" });
  expect(await screen.findByRole("complementary", { name: "backoff()" })).toBeInTheDocument();
});

test("the entry badge marks route handlers", async () => {
  setup();
  expect(await card(/function send.*entry/)).toBeInTheDocument();
});

test("if the layout fails, the tree is shown as a list that still opens nodes", async () => {
  vi.mocked(layoutCalls).mockRejectedValueOnce(new Error("elk"));
  setup();
  expect(await screen.findByText(/couldn't be laid out/)).toBeInTheDocument();
  const list = screen.getByRole("tree", { name: "Call tree" });
  await userEvent.click(within(list).getAllByRole("button", { name: /backoff\(\)/ })[0]);
  expect(await screen.findByRole("complementary", { name: "backoff()" })).toBeInTheDocument();
});
