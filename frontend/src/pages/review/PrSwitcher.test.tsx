import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import type { PrSummary } from "../../api/types";
import { usePrFilters } from "../../state/prFilters";
import { loadRecents, recordRecent } from "../../state/recents";
import { PrSwitcher } from "./PrSwitcher";

const CURRENT = { owner: "o", repo: "r", number: 7, title: "Add spec" };

const req = (number: number, title: string, over: Partial<PrSummary> = {}): PrSummary => ({
  owner: "dimagi", repo: "app", number, title, author: "ann",
  updatedAt: "2026-10-08T09:00:00Z", isDraft: false, review: "pending", url: `https://github.com/dimagi/app/pull/${number}`, ...over,
});

function respond(body: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

/** A row in Review requested; until the fetch lands, the same PR can show under Recent. */
const requestedOption = (name: RegExp) =>
  within(screen.getByRole("group", { name: "Review requested" })).findByRole("option", { name });

function Landed() {
  return <p>landed {useLocation().pathname}</p>;
}

function Harness({ initiallyOpen, beforeLeave }: { initiallyOpen: boolean; beforeLeave: () => boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return <PrSwitcher current={CURRENT} open={open} onOpenChange={setOpen} beforeLeave={beforeLeave} />;
}

function setup({ open = true, beforeLeave = () => true }: { open?: boolean; beforeLeave?: () => boolean } = {}) {
  const router = createMemoryRouter(
    [
      { path: "/pr/o/r/7", element: <Harness initiallyOpen={open} beforeLeave={beforeLeave} /> },
      { path: "/pr/:owner/:repo/:number", element: <Landed /> },
    ],
    { initialEntries: ["/pr/o/r/7"] },
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
}

beforeEach(() => {
  usePrFilters.setState(usePrFilters.getInitialState());
  localStorage.clear();
  recordRecent({ owner: "x", repo: "y", number: 1, title: "Old one" });
  recordRecent({ owner: "dimagi", repo: "app", number: 3, title: "Sync queue" });
  recordRecent(CURRENT);
});
afterEach(() => vi.unstubAllGlobals());

test("the title opens the dropdown with the input focused", async () => {
  respond([]);
  setup({ open: false });
  expect(screen.getByRole("heading")).toHaveTextContent("Add spec #7");
  await userEvent.click(screen.getByRole("button", { name: /Add spec/ }));
  expect(screen.getByRole("textbox", { name: "Pull request link or filter" })).toHaveFocus();
});

test("lists review requests, then recents not already listed, with the current PR marked", async () => {
  respond([req(3, "Sync queue"), req(4, "Draft thing", { isDraft: true }), req(5, "Signed off", { review: "approved" })]);
  setup();
  const requested = within(screen.getByRole("group", { name: "Review requested" }));
  expect(await requested.findByText("Sync queue")).toBeInTheDocument();
  expect(requested.queryByText("Draft thing")).toBeNull();
  expect(requested.getByText("2 pull requests more hidden by the filters")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Draft" }));
  await userEvent.click(screen.getByRole("button", { name: "Approved" }));
  expect(requested.getByText("Draft thing")).toBeInTheDocument();
  expect(requested.getByText("draft")).toBeInTheDocument();
  expect(requested.getByText("Signed off")).toBeInTheDocument();

  const recent = within(screen.getByRole("group", { name: "Recent" }));
  expect(recent.getByText("Add spec")).toBeInTheDocument();
  expect(recent.getByText("Old one")).toBeInTheDocument();
  expect(recent.queryByText("Sync queue")).toBeNull();
  expect(screen.getByRole("option", { name: /Add spec/ })).toContainElement(screen.getByLabelText("Current pull request"));
});

test("clicking a PR opens it", async () => {
  respond([req(3, "Sync queue")]);
  setup();
  await userEvent.click(await requestedOption(/Sync queue/));
  expect(await screen.findByText("landed /pr/dimagi/app/3")).toBeInTheDocument();
});

test("a pasted link opens on Enter", async () => {
  respond([]);
  setup();
  await userEvent.type(screen.getByRole("textbox"), "https://github.com/acme/specs/pull/12/files{Enter}");
  expect(await screen.findByText("landed /pr/acme/specs/12")).toBeInTheDocument();
});

test("typing filters both lists", async () => {
  respond([req(3, "Sync queue"), req(4, "Draft thing")]);
  setup();
  await screen.findByText("Sync queue");
  await userEvent.type(screen.getByRole("textbox"), "old");
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([expect.stringContaining("Old one")]);
});

test("Enter with no match and no link says so", async () => {
  respond([]);
  setup();
  await userEvent.type(screen.getByRole("textbox"), "zzz{Enter}");
  expect(screen.getByRole("alert")).toHaveTextContent("Not a GitHub pull request link");
});

test("arrow keys move the highlight; Enter opens it", async () => {
  respond([req(3, "Sync queue"), req(4, "Draft thing")]);
  setup();
  await screen.findByText("Sync queue");
  // Rows: #3, #4 (requested), then o/r#7 and x/y#1 (recent).
  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowUp}{Enter}");
  expect(await screen.findByText("landed /pr/dimagi/app/4")).toBeInTheDocument();
});

test("a failed fetch leaves recents and pasting working", async () => {
  respond({ error: "boom" }, 502);
  setup();
  expect(await screen.findByText(/Couldn't load review requests/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  expect(screen.getByText("Old one")).toBeInTheDocument();
});

test("an empty queue says so", async () => {
  respond([]);
  setup();
  expect(await screen.findByText("Nothing waiting on you")).toBeInTheDocument();
});

test("declining to leave keeps you on this PR", async () => {
  respond([req(3, "Sync queue")]);
  const beforeLeave = vi.fn(() => false);
  setup({ beforeLeave });
  await userEvent.click(await requestedOption(/Sync queue/));
  expect(beforeLeave).toHaveBeenCalled();
  expect(screen.queryByText(/^landed/)).toBeNull();
});

test("picking the current PR just closes the dropdown", async () => {
  respond([]);
  const beforeLeave = vi.fn(() => true);
  setup({ beforeLeave });
  await userEvent.click(screen.getByRole("option", { name: /Add spec/ }));
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(beforeLeave).not.toHaveBeenCalled();
  expect(screen.queryByText(/^landed/)).toBeNull();
});

test("a recent can be removed", async () => {
  respond([]);
  setup();
  await userEvent.click(screen.getByRole("button", { name: "Remove x/y#1 from recent" }));
  expect(screen.queryByText("Old one")).toBeNull();
  expect(loadRecents().map((r) => r.number)).not.toContain(1);
});

test("Escape and clicking outside close it", async () => {
  respond([]);
  setup();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("listbox")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: /Add spec/ }));
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  await userEvent.click(document.body);
  expect(screen.queryByRole("listbox")).toBeNull();
});
