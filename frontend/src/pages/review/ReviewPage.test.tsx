import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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
