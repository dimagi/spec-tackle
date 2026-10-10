import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Page } from "../../api/types";
import { makeActivity, makeFile, makePage, makeThread } from "../../test/fixtures";
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

function renderReview(page: Page, entry = "/pr/o/r/7") {
  // jsdom has no layout observers; the margin and scroll spy only need them to exist.
  class Observer { observe() {} unobserve() {} disconnect() {} }
  vi.stubGlobal("ResizeObserver", Observer);
  vi.stubGlobal("IntersectionObserver", Observer);
  const reply = (body: unknown) => new Response(JSON.stringify(body));
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/page")) return reply(page);
    if (url.endsWith("/activity")) return reply(page.activity);
    if (url.includes("/claude/threads")) return reply([]);
    if (url.includes("/logic?head=")) return reply({ available: true, map: null, stale: false, running: false });
    if (url.includes("/calls?head=")) return reply({ headSha: "abc1234", nodes: [], edges: [], other: [], truncated: null, depth: { up: 3, down: 3 } });
    return reply({});
  }));
  const router = createMemoryRouter([{ path: "/pr/:owner/:repo/:number", element: <ReviewPage /> }], { initialEntries: [entry] });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>);
  return router;
}

test("with Claude, the Logic tab swaps views and the review page keeps its state underneath", async () => {
  const router = renderReview(makePage({ claude: true }));
  const tabs = await screen.findByRole("tablist");
  const box = document.querySelector<HTMLTextAreaElement>("#conversation textarea")!;
  await userEvent.type(box, "Half a thought");

  await userEvent.click(within(tabs).getByRole("tab", { name: "Visualize" }));
  expect(router.state.location.search).toBe("?view=logic");
  expect(await screen.findByRole("button", { name: "Generate logic map" })).toBeVisible();
  expect(document.getElementById("doc")).not.toBeVisible();

  await userEvent.click(within(tabs).getByRole("tab", { name: "Code view" }));
  expect(router.state.location.search).toBe("");
  expect(document.getElementById("doc")).toBeVisible();
  expect(document.querySelector<HTMLTextAreaElement>("#conversation textarea")!.value).toBe("Half a thought");
});

test("without Claude, a PR with Python changes still gets the Logic tab, opening on Calls", async () => {
  localStorage.clear();
  const router = renderReview(makePage({ claude: false, files: [makeFile(), makeFile({ path: "app/retry.py", markdown: false })] }));
  const tabs = await screen.findByRole("tablist");
  await userEvent.click(within(tabs).getByRole("tab", { name: "Visualize" }));
  expect(router.state.location.search).toBe("?view=logic");
  expect(await screen.findByRole("tab", { name: "Calls" })).toHaveAttribute("aria-selected", "true");
  expect(await screen.findByText("This PR changes no Python functions.")).toBeInTheDocument();
});

test("the Logic mode is kept in ?mode=calls, so a reload comes back to it", async () => {
  localStorage.clear();
  const files = [makeFile(), makeFile({ path: "app/retry.py", markdown: false })];
  const router = renderReview(makePage({ claude: true, files }), "/pr/o/r/7?view=logic&mode=calls");
  expect(await screen.findByRole("tab", { name: "Calls" })).toHaveAttribute("aria-selected", "true");
  await userEvent.click(screen.getByRole("tab", { name: "Flow" }));
  expect(router.state.location.search).toBe("?view=logic&mode=flow");
  await userEvent.click(screen.getByRole("tab", { name: "Calls" }));
  expect(router.state.location.search).toBe("?view=logic&mode=calls");
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
