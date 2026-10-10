import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LogicBlock, Page, Trace } from "../../api/types";
import { stubReactFlowEnvironment } from "../../test/reactFlow";
import { makeActivity, makePage, makeThread } from "../../test/fixtures";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { ReviewPage } from "./ReviewPage";

function Home() {
  const location = useLocation();
  return <p>home{location.search}</p>;
}

afterEach(() => vi.unstubAllGlobals());

test("a signed-out reviewer is sent to sign in, and back here afterwards", async () => {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ error: "Sign in to GitHub first.", signedOut: true }), { status: 401 })));
  const router = createMemoryRouter(
    [{ path: "/", element: <Home /> }, { path: "/pr/:owner/:repo/:number", element: <ReviewPage /> }],
    { initialEntries: ["/pr/o/r/1"] },
  );

  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>);

  const home = await screen.findByText(/^home/);
  const params = new URLSearchParams(home.textContent!.slice(4));
  expect(params.get("notice")).toBe("Sign in to GitHub first.");
  expect(params.get("next")).toBeTruthy();
});

const ENTRY: LogicBlock = { id: "start", label: "Form is submitted", kind: "entry", change: "unchanged", next: [] };
const LOGIC_MAP = { id: "m1", headSha: "abc", summary: "Maps it.", blocks: [ENTRY], createdAt: "2026-10-08T09:00:00Z" };
const TRACE: Trace = {
  id: "t1", mapId: "m1", entryId: "start", proposed: true, usedAt: "",
  inputs: [], steps: [{ blockId: "start", input: {}, output: { ok: true }, note: "Accepts the form." }],
  outcome: { kind: "exit", message: "Done" },
};

function renderReview(page: Page, { url = "/pr/o/r/7", map = false }: { url?: string; map?: boolean } = {}) {
  // jsdom has no layout observers; the margin and scroll spy only need them to exist.
  class Observer { observe() {} unobserve() {} disconnect() {} }
  vi.stubGlobal("ResizeObserver", Observer);
  vi.stubGlobal("IntersectionObserver", Observer);
  // A rendered chart needs its nodes measured, which takes the fuller stand-ins.
  if (map) stubReactFlowEnvironment();
  const reply = (body: unknown) => new Response(JSON.stringify(body));
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/page")) return reply(page);
    if (url.endsWith("/activity")) return reply(page.activity);
    if (url.includes("/claude/threads")) return reply([]);
    if (url.includes("/logic?head=")) return reply({ available: true, map: map ? LOGIC_MAP : null, stale: false, running: false });
    if (url.includes("/api/logic/m1/walkthrough?entry=start")) return reply({ trace: TRACE, starting: [], running: false, error: null });
    return reply({});
  }));
  const router = createMemoryRouter([{ path: "/pr/:owner/:repo/:number", element: <ReviewPage /> }], { initialEntries: [url] });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>);
  return router;
}

test("with Claude, the Logic tab swaps views and the review page keeps its state underneath", async () => {
  const router = renderReview(makePage({ claude: true }));
  const tabs = await screen.findByRole("tablist");
  const box = document.querySelector<HTMLTextAreaElement>("#conversation textarea")!;
  await userEvent.type(box, "Half a thought");

  await userEvent.click(within(tabs).getByRole("tab", { name: "Logic view" }));
  expect(router.state.location.search).toBe("?view=logic");
  expect(await screen.findByRole("button", { name: "Generate logic map" })).toBeVisible();
  expect(document.getElementById("doc")).not.toBeVisible();

  await userEvent.click(within(tabs).getByRole("tab", { name: "Code view" }));
  expect(router.state.location.search).toBe("");
  expect(document.getElementById("doc")).toBeVisible();
  expect(document.querySelector<HTMLTextAreaElement>("#conversation textarea")!.value).toBe("Half a thought");
});

test("without Claude there are no page tabs", async () => {
  renderReview(makePage({ claude: false }));
  expect(await screen.findByText("Add spec", { selector: "h1 button *, h1 button" })).toBeInTheDocument();
  expect(screen.queryByRole("tablist")).toBeNull();
});

test("a thread enlarges over the page; Escape or the backdrop puts it back, and j moves to the next thread", async () => {
  const second = makeThread({ id: "T2", line: 3 });
  second.comments = [{ ...second.comments[0], id: 102, body: "And this?", bodyHTML: "<p>And this?</p>" }];
  Element.prototype.scrollIntoView ??= () => {}; // j scrolls to the thread; jsdom has no layout
  renderReview(makePage({ activity: makeActivity({ threads: [makeThread(), second] }) }));
  const card = (id: string) => document.querySelector(`[data-card="${id}"]`)!;

  await userEvent.click((await screen.findAllByRole("button", { name: "Enlarge thread" }))[0]);
  expect(card("T1")).toHaveClass("is-enlarged");
  expect(screen.getByRole("dialog", { name: "Comment thread" })).toBe(card("T1"));
  expect(document.body).toHaveClass("has-enlarged");

  await userEvent.keyboard("j");
  expect(card("T1")).not.toHaveClass("is-enlarged");
  expect(card("T2")).toHaveClass("is-enlarged");

  await userEvent.keyboard("{Escape}");
  expect(card("T2")).not.toHaveClass("is-enlarged");
  expect(document.body).not.toHaveClass("has-enlarged");

  await userEvent.click(within(card("T2") as HTMLElement).getByRole("button", { name: "Enlarge thread" }));
  await userEvent.click(screen.getByTestId("enlarge-backdrop"));
  expect(card("T2")).not.toHaveClass("is-enlarged");

  await userEvent.click(within(card("T2") as HTMLElement).getByRole("button", { name: "Enlarge thread" }));
  await userEvent.click(within(card("T2") as HTMLElement).getByRole("button", { name: "Shrink thread" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("?walk= opens the walkthrough in the Logic view; Esc, Code view and the button keep the URL in step", async () => {
  Element.prototype.scrollIntoView ??= () => {};
  const router = renderReview(makePage({ claude: true }), { url: "/pr/o/r/7?view=logic&walk=start", map: true });
  expect(await screen.findByRole("complementary", { name: "Walkthrough" })).toBeInTheDocument();

  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("complementary", { name: "Walkthrough" })).toBeNull();
  expect(router.state.location.search).toBe("?view=logic");

  await userEvent.click(screen.getByRole("button", { name: /Walkthrough/ }));
  expect(router.state.location.search).toBe("?view=logic&walk=start");
  expect(await screen.findByRole("complementary", { name: "Walkthrough" })).toBeInTheDocument();

  await userEvent.click(within(screen.getByRole("tablist")).getByRole("tab", { name: "Code view" }));
  expect(router.state.location.search).not.toContain("walk");
});
