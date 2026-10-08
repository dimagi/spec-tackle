import { useState } from "react";
import { request } from "../../api/request";

type LoginStatus = { state: "waiting" | "done" | "failed"; code?: string; url?: string; message?: string };

/** Only ever send people back to a page on this app. */
export function safeNext(next: string | null): string | null {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : null;
}

const GITHUB_ICON = "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z";
const PRIMARY = "rounded-xl bg-stone-900 px-5 py-2.5 font-semibold text-white shadow-sm hover:bg-stone-700 dark:bg-amber-400 dark:text-stone-950 dark:hover:bg-amber-300";

type Props = { ghCli: boolean; notice: string | null; onDone: () => void; pollMs?: number };

export function SignIn({ ghCli, notice, onDone, pollMs = 2000 }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "starting" | "waiting" | "retry">("idle");
  const [device, setDevice] = useState<{ code: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [token, setToken] = useState("");

  const start = async () => {
    setError(null);
    setPhase("starting");
    try {
      let status = await request<LoginStatus>("POST", "/auth/login");
      if (status.state === "failed") throw new Error(status.message);
      setDevice({ code: status.code!, url: status.url! });
      setPhase("waiting");
      while (status.state === "waiting") {
        await new Promise((r) => setTimeout(r, pollMs));
        status = await request<LoginStatus>("GET", "/auth/login");
      }
      if (status.state !== "done") throw new Error(status.message);
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setDevice(null);
      setPhase("retry");
    }
  };

  const useToken = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await request("POST", "/auth/token", { token });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm dark:border-stone-800 dark:bg-stone-900">
      <div className="flex items-start gap-3">
        <svg viewBox="0 0 16 16" className="mt-0.5 h-6 w-6 shrink-0 fill-current" aria-hidden="true"><path d={GITHUB_ICON} /></svg>
        <div>
          <h2 className="font-semibold">Sign in to GitHub to start</h2>
          <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
            {notice || "spec-tackle reads pull requests and posts your comments as you, so it needs your GitHub sign-in."}
          </p>
        </div>
      </div>

      {ghCli ? (
        <>
          {phase !== "waiting" && (
            <button onClick={start} disabled={phase === "starting"} className={`mt-5 inline-flex items-center gap-2 text-sm transition disabled:opacity-60 ${PRIMARY}`}>
              {phase === "starting" ? "Starting…" : phase === "retry" ? "Try again" : "Sign in with GitHub"}
            </button>
          )}
          {phase === "waiting" && device && (
            <div className="mt-5 space-y-4 text-sm">
              <div>
                <div className="text-stone-500">1. Copy your one-time code</div>
                <div className="mt-1.5 flex items-center gap-3">
                  <code className="rounded-lg bg-stone-100 px-3 py-1.5 font-mono text-2xl font-semibold tracking-[0.2em] dark:bg-stone-800">{device.code}</code>
                  <button
                    className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800"
                    onClick={async () => { try { await navigator.clipboard.writeText(device.code); setCopied(true); } catch { /* not allowed */ } }}
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>
              <div>
                <div className="text-stone-500">2. Enter it on GitHub and approve</div>
                <a href={device.url} target="_blank" rel="noopener" className={`mt-1.5 inline-flex ${PRIMARY}`}>Open GitHub ↗</a>
              </div>
              <div className="flex items-center gap-2 text-stone-500">
                <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" /> Waiting for you to approve on GitHub…
              </div>
            </div>
          )}
        </>
      ) : (
        <p className="mt-5 text-sm text-stone-600 dark:text-stone-400">
          Install the <a className="underline" href="https://cli.github.com" target="_blank" rel="noopener">GitHub CLI</a> and run{" "}
          <code className="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-xs dark:bg-stone-800">gh auth login</code>, then reload this page. Or use a token below.
        </p>
      )}

      <details className="mt-5 text-sm" open={!ghCli}>
        <summary className="cursor-pointer select-none text-stone-500 hover:text-stone-800 dark:hover:text-stone-200">Use a personal access token instead</summary>
        <form className="mt-3 flex flex-col gap-2 sm:flex-row" onSubmit={useToken}>
          <input
            name="token" type="password" autoComplete="off" required placeholder="github_pat_…" value={token}
            onChange={(e) => setToken(e.target.value)}
            className="flex-1 rounded-lg border border-stone-300 bg-white px-3 py-2 font-mono text-sm outline-none ring-amber-400/40 focus:border-amber-500 focus:ring-4 dark:border-stone-700 dark:bg-stone-900"
          />
          <button className="rounded-lg bg-stone-200 px-4 py-2 font-semibold hover:bg-stone-300 dark:bg-stone-800 dark:hover:bg-stone-700">Use token</button>
        </form>
        <p className="mt-2 text-xs text-stone-500">
          <a className="underline" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Create a fine-grained token</a>{" "}
          with <em>Contents: read</em> and <em>Pull requests: read and write</em>. It's kept in memory until spec-tackle stops.
        </p>
      </details>

      {error && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">{error}</p>}
    </section>
  );
}
