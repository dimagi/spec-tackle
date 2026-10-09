import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import type { PrSummary, Repo } from "../../api/types";
import { usePrFilters } from "../../state/prFilters";
import { recordRecent } from "../../state/recents";
import { BrowsePrs } from "./BrowsePrs";

const repo = (owner: string, name: string, over: Partial<Repo> = {}): Repo => ({
  owner, repo: name, description: `${name} repo`, isPrivate: false, pushedAt: "2026-10-08T09:00:00Z", openPrs: 2, ...over,
});
const pr = (number: number, title: string, over: Partial<PrSummary> = {}): PrSummary => ({
  owner: "dimagi", repo: "connect", number, title, author: "ann", updatedAt: "2026-10-08T09:00:00Z",
  isDraft: false, review: "pending", url: `https://github.com/dimagi/connect/pull/${number}`, ...over,
});

const MINE = [repo("dimagi", "connect", { openPrs: 4, isPrivate: true }), repo("me", "dots")];
const SEARCH = [repo("dimagi", "commcare-connect")];
const PULLS = [pr(5, "Retry spec"), pr(6, "Draft thing", { isDraft: true })];

type Routes = Record<string, { status?: number; body: unknown }>;

function serve(routes: Routes) {
  const fetch = vi.fn(async (url: string) => {
    const hit = routes[url];
    if (!hit) return new Response(JSON.stringify({ error: `no route ${url}` }), { status: 500 });
    return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const DEFAULT_ROUTES: Routes = {
  "/api/repos": { body: MINE },
  "/api/repos?q=dimagi%2Fcomm": { body: SEARCH },
  "/api/repos/dimagi/connect/pulls": { body: PULLS },
};

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}{location.search}</p>;
}

function setup(start = "/") {
  const router = createMemoryRouter(
    [
      { path: "/", element: <><BrowsePrs /><Where /></> },
      { path: "/pr/:owner/:repo/:number", element: <Where /> },
    ],
    { initialEntries: [start] },
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  return router;
}

const optionTexts = () => screen.getAllByRole("option").map((o) => o.textContent);

beforeEach(() => {
  localStorage.clear();
  usePrFilters.setState(usePrFilters.getInitialState());
});
afterEach(() => vi.unstubAllGlobals());

test("lists recently opened repos first, then your GitHub repos, each once", async () => {
  serve(DEFAULT_ROUTES);
  recordRecent({ owner: "x", repo: "y", number: 1, title: "Old" });
  recordRecent({ owner: "dimagi", repo: "connect", number: 5, title: "Retry spec" });
  setup();
  await screen.findByText("me/dots");
  expect(optionTexts()).toEqual([
    expect.stringContaining("dimagi/connect"), expect.stringContaining("x/y"), expect.stringContaining("me/dots"),
  ]);
  const connect = screen.getAllByRole("option")[0];
  expect(connect).toHaveTextContent("4 open");
  expect(within(connect).getByText("private")).toBeInTheDocument();
});

test("picking a repo lists its open PRs and remembers the repo in the URL", async () => {
  serve(DEFAULT_ROUTES);
  setup();
  await userEvent.click(await screen.findByRole("option", { name: /dimagi\/connect/ }));
  expect(await screen.findByText("Retry spec")).toBeInTheDocument();
  expect(screen.getByText("1 pull request more hidden by the filters")).toBeInTheDocument();
  expect(screen.getByTestId("where")).toHaveTextContent("/?repo=dimagi%2Fconnect");

  await userEvent.click(screen.getByRole("option", { name: /Retry spec/ }));
  expect(screen.getByTestId("where")).toHaveTextContent("/pr/dimagi/connect/5");
});

test("a repo in the URL opens straight on its PRs; Change repo goes back", async () => {
  serve(DEFAULT_ROUTES);
  setup("/?repo=dimagi/connect");
  expect(await screen.findByText("Retry spec")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /Change repo/ }));
  expect(await screen.findByText("me/dots")).toBeInTheDocument();
  expect(screen.getByTestId("where")).toHaveTextContent(/^\/$/);
});

test("typing filters your repos and searches GitHub", async () => {
  const fetch = serve(DEFAULT_ROUTES);
  setup();
  await screen.findByText("me/dots");
  await userEvent.type(screen.getByRole("textbox", { name: "Find a repository" }), "dimagi/comm");
  expect(await screen.findByText("dimagi/commcare-connect")).toBeInTheDocument();
  expect(screen.queryByText("me/dots")).toBeNull();
  expect(fetch).toHaveBeenCalledWith("/api/repos?q=dimagi%2Fcomm", expect.anything());
  // Only the settled text is searched, not every keystroke.
  expect(fetch.mock.calls.filter(([url]) => String(url).startsWith("/api/repos?q="))).toHaveLength(1);
});

test("the PR filter matches title, number or author", async () => {
  serve(DEFAULT_ROUTES);
  setup("/?repo=dimagi/connect");
  await screen.findByText("Retry spec");
  await userEvent.click(screen.getByRole("button", { name: "Draft" }));
  const box = screen.getByRole("textbox", { name: "Filter pull requests" });
  await userEvent.type(box, "draft");
  expect(optionTexts()).toEqual([expect.stringContaining("Draft thing")]);
  await userEvent.clear(box);
  await userEvent.type(box, "#5");
  expect(optionTexts()).toEqual([expect.stringContaining("Retry spec")]);
});

test("arrow keys and Enter pick a repo, then a PR", async () => {
  serve(DEFAULT_ROUTES);
  setup();
  await screen.findByText("me/dots");
  await userEvent.click(screen.getByRole("textbox", { name: "Find a repository" }));
  await userEvent.keyboard("{ArrowDown}{ArrowUp}{Enter}");
  await screen.findByText("Retry spec");
  await userEvent.click(screen.getByRole("textbox", { name: "Filter pull requests" }));
  await userEvent.click(screen.getByRole("button", { name: "Draft" }));
  expect(screen.getByRole("textbox", { name: "Filter pull requests" })).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(screen.getByTestId("where")).toHaveTextContent("/pr/dimagi/connect/6");
});

test("a failed repo list says so and keeps recents", async () => {
  serve({ "/api/repos": { status: 502, body: { error: "boom" } } });
  recordRecent({ owner: "x", repo: "y", number: 1, title: "Old" });
  setup();
  expect(await screen.findByText(/Couldn't load your repositories/)).toBeInTheDocument();
  expect(screen.getByRole("option", { name: /x\/y/ })).toBeInTheDocument();
});

test("an unknown repo shows GitHub's message", async () => {
  serve({ "/api/repos/o/nope/pulls": { status: 404, body: { error: "Repository not found" } } });
  setup("/?repo=o/nope");
  expect(await screen.findByText(/Repository not found/)).toBeInTheDocument();
});

test("a repo with no open PRs says so", async () => {
  serve({ "/api/repos/dimagi/connect/pulls": { body: [] } });
  setup("/?repo=dimagi/connect");
  expect(await screen.findByText("No open pull requests")).toBeInTheDocument();
});

test("nothing found says so", async () => {
  serve({ "/api/repos": { body: [] }, "/api/repos?q=zzz": { body: [] } });
  setup();
  await userEvent.type(screen.getByRole("textbox", { name: "Find a repository" }), "zzz");
  await waitFor(() => expect(screen.getByText("No repositories found")).toBeInTheDocument());
});

test("by default only open PRs show; the Draft chip brings drafts back", async () => {
  serve({ "/api/repos/dimagi/connect/pulls": { body: [
    pr(5, "Retry spec"), pr(6, "Draft thing", { isDraft: true }),
    pr(7, "Signed off", { review: "approved" }), pr(8, "Needs work", { review: "changes_requested" }),
  ] } });
  setup("/?repo=dimagi/connect");
  await screen.findByText("Retry spec");
  expect(optionTexts()).toEqual([
    expect.stringContaining("Retry spec"), expect.stringContaining("Signed off"), expect.stringContaining("Needs work"),
  ]);
  expect(screen.getByText("approved")).toBeInTheDocument();
  expect(screen.getByText("changes requested")).toBeInTheDocument();
  expect(screen.getByText("1 pull request more hidden by the filters")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Draft" }));
  expect(screen.getByRole("button", { name: "Draft" })).toHaveAttribute("aria-pressed", "true");
  expect(optionTexts()).toHaveLength(4);

  // Only drafts; turning off the last chip does nothing.
  await userEvent.click(screen.getByRole("button", { name: "Open" }));
  await userEvent.click(screen.getByRole("button", { name: "Draft" }));
  expect(optionTexts()).toEqual([expect.stringContaining("Draft thing")]);
  expect(screen.getByText("3 pull requests more hidden by the filters")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Approved" })).toBeNull();
});
