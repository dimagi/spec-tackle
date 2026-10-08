import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { safeNext, SignIn } from "./SignIn";

function respond(routes: Record<string, unknown[]>) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const body = routes[key].shift();
    const status = (body as { status?: number })?.status ?? 200;
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

test("only same-site paths are followed after signing in", () => {
  expect(safeNext("/pr/o/r/7")).toBe("/pr/o/r/7");
  expect(safeNext("//evil.example")).toBeNull();
  expect(safeNext("https://evil.example")).toBeNull();
  expect(safeNext(null)).toBeNull();
});

test("the GitHub device flow shows the code, waits, then finishes", async () => {
  respond({
    "POST /auth/login": [{ state: "waiting", code: "ABCD-1234", url: "https://github.com/login/device" }],
    "GET /auth/login": [{ state: "waiting" }, { state: "done", viewer: { login: "me" } }],
  });
  const onDone = vi.fn();
  render(<SignIn ghCli notice={null} onDone={onDone} pollMs={0} />);

  await userEvent.click(screen.getByRole("button", { name: "Sign in with GitHub" }));

  expect(await screen.findByText("ABCD-1234")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open GitHub ↗" })).toHaveAttribute("href", "https://github.com/login/device");
  await waitFor(() => expect(onDone).toHaveBeenCalled());
});

test("a failed sign-in shows why and offers to try again", async () => {
  respond({ "POST /auth/login": [{ state: "failed", message: "gh exited" }] });
  render(<SignIn ghCli notice={null} onDone={vi.fn()} pollMs={0} />);

  await userEvent.click(screen.getByRole("button", { name: "Sign in with GitHub" }));

  expect(await screen.findByText("gh exited")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
});

test("a pasted token signs in", async () => {
  const fetch = respond({ "POST /auth/token": [{ viewer: { login: "me" } }] });
  const onDone = vi.fn();
  render(<SignIn ghCli={false} notice={null} onDone={onDone} pollMs={0} />);

  await userEvent.type(screen.getByPlaceholderText("github_pat_…"), "github_pat_x");
  await userEvent.click(screen.getByRole("button", { name: "Use token" }));

  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(fetch.mock.calls[0][1]!.body).toBe('{"token":"github_pat_x"}');
});

test("without the GitHub CLI it explains how to sign in", () => {
  render(<SignIn ghCli={false} notice="GitHub no longer accepts your sign-in." onDone={vi.fn()} pollMs={0} />);
  expect(screen.getByText("GitHub no longer accepts your sign-in.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Sign in with GitHub" })).toBeNull();
});
