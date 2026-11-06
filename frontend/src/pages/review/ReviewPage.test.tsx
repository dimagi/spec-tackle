import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Draft, Page } from "../../api/types";
import { makeActivity, makeDraft, makeFile, makePage, makeReplyDraft, makeThread } from "../../test/fixtures";
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

type Call = { method: string; url: string; body: unknown };

/** The review page over a fake API that keeps drafts; returns the requests it made. */
function renderWithDrafts(page: Page, drafts: Draft[], answer: (call: Call) => unknown = () => ({})) {
  class Observer { observe() {} unobserve() {} disconnect() {} }
  vi.stubGlobal("ResizeObserver", Observer);
  vi.stubGlobal("IntersectionObserver", Observer);
  Element.prototype.scrollIntoView ??= () => {};
  const calls: Call[] = [];
  let list = drafts;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const call = { method, url, body: init?.body ? JSON.parse(init.body as string) : undefined };
    if (method !== "GET") calls.push(call);
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.endsWith("/page")) return reply(page);
    if (url.endsWith("/activity")) return reply(page.activity);
    if (url.endsWith("/drafts") && method === "GET") return reply({ drafts: list, githubPending: 0 });
    if (url.endsWith("/drafts") && method === "POST") {
      const created = makeDraft({ id: "D-new", body: call.body.body, startLine: call.body.start, endLine: call.body.end });
      list = [...list, created];
      return reply(created);
    }
    if (url.endsWith("/review")) {
      const result = answer(call) as { status?: number };
      if (result.status) return reply(result, result.status);
      list = [];
      return reply(result);
    }
    return reply(answer(call));
  }));
  const router = createMemoryRouter([{ path: "/pr/:owner/:repo/:number", element: <ReviewPage /> }], { initialEntries: ["/pr/o/r/7"] });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>);
  return calls;
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});

test("Add to review keeps a comment as a draft in the margin and counts it", async () => {
  const calls = renderWithDrafts(makePage({ drafts: true }), []);
  await userEvent.click(await screen.findByText("two three"));
  await userEvent.type(screen.getByPlaceholderText(/What should change/), "Why three?");

  await userEvent.click(screen.getByRole("button", { name: "Add to review" }));

  expect(await screen.findByText("Draft · only you")).toBeInTheDocument();
  expect(calls).toEqual([{ method: "POST", url: "/api/pr/o/r/7/drafts",
    body: { path: "docs/a.md", start: 2, end: 3, commit: "abc1234", body: "Why three?" } }]);
  expect(document.querySelector('[data-card="D-new"]')).toHaveTextContent("Why three?");
  expect(screen.queryByPlaceholderText(/What should change/)).toBeNull();
  expect(screen.getByRole("button", { name: "Finish review · 1" })).toBeInTheDocument();
});

test("without the local store there is nothing to draft with", async () => {
  renderWithDrafts(makePage({ drafts: false }), []);
  await userEvent.click(await screen.findByText("two three"));
  expect(screen.getByPlaceholderText(/What should change/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Add to review" })).toBeNull();
});

test("a resolved thread with a drafted reply stays open, showing the draft", async () => {
  localStorage.clear(); // the Open filter, which hides resolved threads
  const bare = makeThread({ id: "T2", line: 1, isResolved: true });
  bare.comments = [{ ...bare.comments[0], id: 102 }];
  const page = makePage({ drafts: true, activity: makeActivity({ threads: [makeThread({ isResolved: true }), bare] }) });
  renderWithDrafts(page, [makeReplyDraft({ threadId: "T1" })]);

  const card = await screen.findByText("Agreed");

  expect(card.closest("[data-card]")).toHaveAttribute("data-card", "T1");
  expect(card.closest("[data-card]")).toBeVisible();
  expect(document.querySelector('[data-card="T1"]')).not.toHaveClass("is-collapsed");
  expect(document.querySelector('[data-card="T2"]')).not.toBeVisible();
});

test("submitting the review sends the drafts and says how many", async () => {
  const calls = renderWithDrafts(makePage({ drafts: true }), [makeDraft()], () => ({ sent: 1, held: 0 }));
  await userEvent.click(await screen.findByRole("button", { name: "Finish review · 1" }));
  expect(await screen.findByText("1 draft will be posted with this review.")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Submit review" }));

  expect(await screen.findByText("Review submitted with 1 draft")).toBeInTheDocument();
  expect(calls).toEqual([{ method: "POST", url: "/api/pr/o/r/7/review", body: { event: "COMMENT", body: "" } }]);
  expect(await screen.findByRole("button", { name: "Finish review" })).toBeInTheDocument();
  expect(screen.queryByText("Draft · only you")).toBeNull();
});

test("a draft that can't be sent closes the dialog and becomes the active card", async () => {
  renderWithDrafts(makePage({ drafts: true }), [makeDraft()],
    () => ({ status: 502, error: "A draft couldn't be added to the review: nope", draftId: "D1" }));
  await userEvent.click(await screen.findByRole("button", { name: "Finish review · 1" }));
  await userEvent.click(screen.getByRole("button", { name: "Submit review" }));

  expect(await screen.findByText("A draft couldn't be added to the review: nope")).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  // The draft is the active card: its passage is marked as such.
  await waitFor(() => expect(document.querySelector(".has-draft.is-active-anchor")).not.toBeNull());
});

test("re-attaching an outdated draft moves it to the passage clicked next", async () => {
  const moved = makeDraft({ outdated: false, startLine: 1, endLine: 1, anchorText: "Title" });
  const calls = renderWithDrafts(makePage({ drafts: true }), [makeDraft({ outdated: true })], () => moved);
  await userEvent.click(await screen.findByRole("button", { name: "Re-attach" }));
  expect(screen.getByText(/Click a passage or select text/)).toBeInTheDocument();

  await userEvent.click(screen.getByText("Title", { selector: "h1[data-ls]" }));

  expect(calls).toEqual([{ method: "PATCH", url: "/api/drafts/D1",
    body: { path: "docs/a.md", start: 1, end: 1, commit: "abc1234" } }]);
  await waitFor(() => expect(screen.queryByText("Outdated")).toBeNull());
  expect(screen.queryByPlaceholderText(/What should change/)).toBeNull(); // no composer opened
  expect(document.querySelector('[data-card="D1"]')).toHaveTextContent("L1");
});

test("Escape cancels re-attaching", async () => {
  renderWithDrafts(makePage({ drafts: true }), [makeDraft({ outdated: true })]);
  await userEvent.click(await screen.findByRole("button", { name: "Re-attach" }));

  await userEvent.keyboard("{Escape}");

  expect(screen.queryByText(/Click a passage or select text/)).toBeNull();
  expect(screen.getByRole("button", { name: "Re-attach" })).toBeInTheDocument();
});

test("asking Claude while Claude threads are hidden shows them again, so the answer isn't lost", async () => {
  localStorage.setItem("spec-tackle:o/r#7:showClaude", "false");
  const thread = {
    id: "C1", path: "docs/a.md", startLine: 2, endLine: 3, anchorText: "two three", commit: "abc1234",
    createdAt: "2026-10-15T00:00:00Z", running: false,
    messages: [{ role: "user", body: "Why three?", createdAt: "2026-10-15T00:00:00Z" }],
  };
  renderWithDrafts(makePage({ claude: true }), [], (call) =>
    call.url.endsWith("/claude/threads") ? (call.method === "POST" ? thread : []) : {});
  await userEvent.click(await screen.findByText("two three"));
  await userEvent.click(screen.getByRole("button", { name: "Ask Claude" }));
  await userEvent.type(screen.getByPlaceholderText(/Ask Claude about this passage/), "Why three?{Control>}{Enter}{/Control}");

  await waitFor(() => expect(document.querySelector('[data-card="C1"]')).toBeVisible());
  expect(screen.getByRole("checkbox", { name: /Show Claude threads/ })).toBeChecked();
  localStorage.clear();
});
