import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DocRefs as DocRefsData, DocRefsState } from "../../api/types";
import { scrollToLine } from "../../lib/scrollToLine";
import { makeFile } from "../../test/fixtures";
import { FileSection } from "./FileSection";

vi.mock("../../lib/scrollToLine", () => ({ scrollToLine: vi.fn() }));

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
const HTML = `
  <h2 data-ls="1" data-le="1">Retries</h2>
  <p data-ls="3" data-le="3">Back off for <strong>five</strong> tries.</p>
  <p data-ls="5" data-le="5">As in the Retries section above.</p>`;
const FOUND: DocRefsData = {
  id: "x", path: "docs/a.md", headSha: HEAD, createdAt: "", pending: [], basedOn: null, outdated: 0,
  refs: [{ line: 5, text: "Retries section", targetPath: null, targetStart: 1, targetEnd: 3, note: "Retries" }],
};
const state = (over: Partial<DocRefsState> = {}): DocRefsState => ({ available: true, refs: null, stale: false, running: false, ...over });
const GET = `GET /api/pr/o/r/7/refs?path=docs%2Fa.md&head=${HEAD}`;

let routes: Record<string, unknown>;
let calls: { key: string; body?: string }[];

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    calls.push({ key, body: init?.body as string | undefined });
    const hit = routes[key];
    if (hit === undefined) return new Response(JSON.stringify({ error: `no route ${key}` }), { status: 500 });
    return new Response(JSON.stringify(typeof hit === "function" ? hit() : hit));
  }));
});
afterEach(() => {
  cleanup(); // before the stubs go, so a run starting as a test ends still finds them
  vi.unstubAllGlobals();
});

function setup({ auto = false } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const file = makeFile({ wholeFile: true, status: "added", rendered: HTML });
  return render(
    <QueryClientProvider client={client}>
      <FileSection file={file} index={1} refs={{ pr: PR, head: HEAD, auto }} />
    </QueryClientProvider>,
  );
}

test("Find references runs Claude for this file and marks what it found", async () => {
  let current = state();
  routes = { [GET]: () => current, "POST /api/pr/o/r/7/refs": state({ running: true }) };
  const { container } = setup();

  await userEvent.click(await screen.findByRole("button", { name: "Find references" }));
  expect(calls.find((c) => c.key.startsWith("POST"))!.body).toBe(JSON.stringify({ path: "docs/a.md", head: HEAD, scope: "full" }));
  const [source] = FakeEventSource.instances;
  expect(source.url).toBe(`/api/pr/o/r/7/refs/events?path=docs%2Fa.md&head=${HEAD}`);
  source.send({ type: "tool", text: "Reading docs/a.md…" });
  expect(screen.getByRole("status")).toHaveTextContent("Reading docs/a.md…");

  current = state({ refs: FOUND });
  source.send({ type: "done" });
  expect(await screen.findByRole("button", { name: "1 reference" })).toBeInTheDocument();
  expect(container.querySelector(".doc-ref")).toHaveTextContent("Retries section");
});

test("hovering a marker shows its target; clicking jumps there", async () => {
  routes = { [GET]: state({ refs: FOUND }) };
  const { container } = setup();
  await screen.findByRole("button", { name: "1 reference" });
  const marker = container.querySelector<HTMLElement>(".doc-ref")!;

  fireEvent.mouseOver(marker);
  const popup = await screen.findByRole("tooltip");
  expect(popup).toHaveTextContent("Retries");
  expect(popup).toHaveTextContent("Back off for five tries.");
  expect(popup).toHaveTextContent("lines 1–3");
  expect(popup.querySelector("[data-ls]")).toBeNull();

  fireEvent.click(marker);
  expect(scrollToLine).toHaveBeenCalledWith("docs/a.md", 1, "rendered");
  expect(screen.queryByRole("tooltip")).toBeNull();
});

test("the count button hides and shows the markers", async () => {
  routes = { [GET]: state({ refs: FOUND }) };
  const { container } = setup();
  const button = await screen.findByRole("button", { name: "1 reference" });
  await userEvent.click(button);
  expect(container.querySelector(".doc-ref")).toBeNull();
  expect(container.querySelector('[data-ls="5"]')).toHaveTextContent("As in the Retries section above.");
  await userEvent.click(screen.getByRole("button", { name: "1 reference" }));
  expect(container.querySelector(".doc-ref")).not.toBeNull();
});

test("references found for another commit aren't marked, and offer to find them again", async () => {
  routes = { [GET]: state({ refs: { ...FOUND, headSha: "old0000" }, stale: true }) };
  const { container } = setup();
  const button = await screen.findByRole("button", { name: "Find references again" });
  expect(button).toHaveAttribute("title", expect.stringContaining("old0000"));
  expect(container.querySelector(".doc-ref")).toBeNull();
});

test("nothing shows when Claude isn't available", async () => {
  routes = { [GET]: state({ available: false }) };
  setup();
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(screen.queryByRole("button", { name: /references/ })).toBeNull();
});

const ELSEWHERE: DocRefsData = {
  ...FOUND,
  refs: [{ line: 3, text: "five", targetPath: "app/codes.py", targetStart: 2, targetEnd: 3, note: "MAX_TRIES" }],
};

test("a reference to another file shows its lines from the server", async () => {
  routes = {
    [GET]: state({ refs: ELSEWHERE }),
    "GET /api/refs/x/0/target": {
      path: "app/codes.py", start: 2, end: 3, truncated: false, inDiff: true, githubUrl: "", kind: "code",
      lines: [{ n: 2, html: "MAX_TRIES = 5", changed: true }, { n: 3, html: "DELAY = 1", changed: false }],
    },
  };
  const { container } = setup();
  await screen.findByRole("button", { name: "1 reference" });
  const marker = container.querySelector<HTMLElement>(".doc-ref")!;
  expect(marker).toHaveTextContent("five");
  expect(marker).toHaveClass("is-external");

  fireEvent.mouseOver(marker);
  const popup = await screen.findByRole("tooltip");
  expect(popup).toHaveTextContent("app/codes.py:2–3");
  expect(await within(popup).findByText("MAX_TRIES = 5")).toBeInTheDocument();
  expect(popup.querySelector(".logic-line.changed")).toHaveTextContent("MAX_TRIES = 5");
});

test("clicking a reference to a file that isn't on the page opens it on GitHub", async () => {
  routes = { [GET]: state({ refs: ELSEWHERE }) };
  const open = vi.fn();
  vi.stubGlobal("open", open);
  const { container } = setup();
  await screen.findByRole("button", { name: "1 reference" });
  fireEvent.click(container.querySelector(".doc-ref")!);
  expect(open).toHaveBeenCalledWith(`https://github.com/o/r/blob/${HEAD}/app/codes.py#L2-L3`, "_blank", "noopener");
  expect(scrollToLine).not.toHaveBeenCalledWith("app/codes.py", 2, expect.anything());
});

test("clicking a reference to a file on the page scrolls to it in the view it shows", async () => {
  routes = { [GET]: state({ refs: ELSEWHERE }) };
  const { container } = setup();
  const other = document.createElement("section");
  other.className = "file";
  other.dataset.path = "app/codes.py";
  other.innerHTML = `<div class="view" data-view="diff"></div>`;
  document.body.append(other);
  await screen.findByRole("button", { name: "1 reference" });
  fireEvent.click(container.querySelector(".doc-ref")!);
  expect(scrollToLine).toHaveBeenCalledWith("app/codes.py", 2, "diff");
  other.remove();
});

const POST = "POST /api/pr/o/r/7/refs";
const posted = () => calls.filter((c) => c.key === POST).map((c) => JSON.parse(c.body!));
const CARRIED: DocRefsData = { ...FOUND, basedOn: "old0000", pending: [3, 4], outdated: 1 };

test("after a new commit, the lines that changed can be checked on their own", async () => {
  routes = { [GET]: state({ refs: CARRIED }), [POST]: state({ running: true }) };
  const { container } = setup();
  // The references that still hold are shown straight away.
  const count = await screen.findByRole("button", { name: "1 reference" });
  expect(count).toHaveAttribute("title", expect.stringContaining("1 outdated by changes since old0000"));
  expect(container.querySelector(".doc-ref")).not.toBeNull();

  await userEvent.click(screen.getByRole("button", { name: "Check 2 changed lines" }));
  expect(posted()).toEqual([{ path: "docs/a.md", head: HEAD, scope: "changed" }]);
});

test("with auto on, a document without references is searched straight away, once", async () => {
  routes = { [GET]: state(), [POST]: state({ running: true }) };
  setup({ auto: true });
  await waitFor(() => expect(posted()).toEqual([{ path: "docs/a.md", head: HEAD, scope: "full" }]));
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  FakeEventSource.instances[0].send({ type: "error", text: "boom" });
  await waitFor(() => expect(calls.filter((c) => c.key === GET).length).toBeGreaterThan(1));
  expect(posted()).toHaveLength(1);
});

test("with auto on, changed lines are checked straight away", async () => {
  routes = { [GET]: state({ refs: CARRIED }), [POST]: state({ running: true }) };
  setup({ auto: true });
  await waitFor(() => expect(posted()).toEqual([{ path: "docs/a.md", head: HEAD, scope: "changed" }]));
});

test("with auto off, nothing runs without a click", async () => {
  routes = { [GET]: state({ refs: CARRIED }) };
  setup();
  await screen.findByRole("button", { name: "Check 2 changed lines" });
  expect(posted()).toEqual([]);
});

test("markers stay out of the Changes view", async () => {
  routes = { [GET]: state({ refs: FOUND }) };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const file = makeFile({ rendered: HTML });  // modified: opens on Changes
  const { container } = render(
    <QueryClientProvider client={client}>
      <FileSection file={file} index={1} refs={{ pr: PR, head: HEAD, auto: false }} />
    </QueryClientProvider>,
  );
  await screen.findByRole("button", { name: "1 reference" });
  expect(container.querySelector(".doc-ref")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Document" }));
  expect(container.querySelector(".doc-ref")).not.toBeNull();
});
