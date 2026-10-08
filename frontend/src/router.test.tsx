import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { ReviewRoute } from "./router";

afterEach(() => vi.unstubAllGlobals());

test("switching PRs survives a scrollTo that returns a promise, as newer Chrome's does", async () => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  vi.stubGlobal("scrollTo", vi.fn(() => Promise.resolve()));
  const router = createMemoryRouter([{ path: "/pr/:owner/:repo/:number", element: <ReviewRoute /> }], {
    initialEntries: ["/pr/o/r/7"],
  });
  render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router} /></QueryClientProvider>);
  expect(await screen.findByText("Loading pull request…")).toBeInTheDocument();

  await act(() => router.navigate("/pr/o/r/8"));

  expect(router.state.errors).toBeNull();
  expect(screen.getByText("Loading pull request…")).toBeInTheDocument();
  expect(window.scrollTo).toHaveBeenCalledTimes(2);
});
