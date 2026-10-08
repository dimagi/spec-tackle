import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Page } from "../../api/types";
import { makePage } from "../../test/fixtures";
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

function renderReview(page: Page) {
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
    return reply({});
  }));
  const router = createMemoryRouter([{ path: "/pr/:owner/:repo/:number", element: <ReviewPage /> }], { initialEntries: ["/pr/o/r/7"] });
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
