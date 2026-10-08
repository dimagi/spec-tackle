import { render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { makeActivity, makePage } from "../../test/fixtures";
import { TopBar } from "./TopBar";

const page = makePage();
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: MemoryRouter });
const sync = { fetching: false, error: null, lastSync: Date.now(), signedOut: false };

function renderBar(over: Partial<Parameters<typeof TopBar>[0]> = {}) {
  return render(
    <TopBar pr={page.pr} overview={page.overview} activity={makeActivity()} viewer={page.viewer}
      sync={sync} newCommits={false} onRefresh={() => {}} onFinishReview={() => {}} {...over} />,
  );
}

test("shows the PR title, repo and branches", () => {
  renderBar();
  expect(screen.getByRole("heading")).toHaveTextContent("Add spec #7");
  expect(screen.getByText("o/r")).toBeInTheDocument();
  expect(screen.getByText("spec")).toBeInTheDocument();
});

test("an open draft PR is labelled draft", () => {
  renderBar({ activity: makeActivity({ isDraft: true }) });
  expect(screen.getByTestId("pr-state")).toHaveTextContent("draft");
});

test("a merged PR is labelled merged", () => {
  renderBar({ activity: makeActivity({ state: "MERGED" }) });
  expect(screen.getByTestId("pr-state")).toHaveTextContent("merged");
});

test("sync status reads live, checking, failed or signed out", () => {
  const { rerender } = renderBar();
  expect(screen.getByTestId("sync-label")).toHaveTextContent("Live · just now");
  const props = { pr: page.pr, overview: page.overview, activity: makeActivity(), viewer: page.viewer,
    newCommits: false, onRefresh: () => {}, onFinishReview: () => {} };
  rerender(<TopBar {...props} sync={{ ...sync, fetching: true }} />);
  expect(screen.getByTestId("sync-label")).toHaveTextContent("Checking…");
  rerender(<TopBar {...props} sync={{ ...sync, error: "boom" }} />);
  expect(screen.getByTestId("sync-label")).toHaveTextContent("Sync failed — retrying");
  rerender(<TopBar {...props} sync={{ ...sync, signedOut: true }} />);
  expect(screen.getByTestId("sync-label")).toHaveTextContent("Signed out");
});

test("new commits show a reload banner", () => {
  renderBar({ newCommits: true });
  expect(screen.getByText("New commits pushed")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
});
