import { useEffect } from "react";
import { useSearchParams } from "react-router";
import { useSession } from "../../api/queries";
import spectacles from "../../assets/spectacles.svg?raw";
import { Html } from "../../components/Html";
import { ThemeSwitch } from "../../components/ThemeSwitch";
import { ViewerBadge } from "../../components/ViewerBadge";
import { safeNext, SignIn } from "./SignIn";

export function IndexPage() {
  const [params] = useSearchParams();
  const session = useSession();
  const next = safeNext(params.get("next"));
  const error = params.get("error");

  useEffect(() => { document.title = "spec-tackle"; }, []);

  return (
    <div className="min-h-screen">
      <div className="fixed right-5 top-4 flex items-center gap-3">
        {session.data && <ViewerBadge viewer={session.data.viewer} />}
        <ThemeSwitch />
      </div>
      <main className="mx-auto grid min-h-screen max-w-6xl content-center items-center gap-x-16 gap-y-10 px-6 py-16 lg:grid-cols-[minmax(0,1fr)_460px]">
        <Html className="w-full max-w-[320px] lg:order-last lg:max-w-none" aria-hidden="true" html={spectacles} />
        <div>
          <div className="mb-10">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
              spec-tackle
            </div>
            <h1 className="font-serif text-5xl font-semibold leading-tight tracking-tight">Read the spec.<br />Not the diff.</h1>
            <p className="mt-4 max-w-lg text-lg text-stone-600 dark:text-stone-400">
              Paste a GitHub pull request link to open it as a readable document. Comments sit in the margin, and anything you write is posted to the PR.
            </p>
          </div>

          {session.data && !session.data.viewer && (
            <SignIn ghCli={session.data.ghCli} notice={params.get("notice")} onDone={() => window.location.assign(next || window.location.pathname)} />
          )}
          {session.data?.viewer && (
            <form action="/" method="get" className="flex flex-col gap-3 sm:flex-row">
              <input
                name="url" required autoFocus defaultValue={params.get("url") ?? ""} placeholder="https://github.com/org/repo/pull/123"
                className="flex-1 rounded-xl border border-stone-300 bg-white px-4 py-3 text-base shadow-sm outline-none ring-amber-400/40 placeholder:text-stone-400 focus:border-amber-500 focus:ring-4 dark:border-stone-700 dark:bg-stone-900"
              />
              <button className="rounded-xl bg-stone-900 px-6 py-3 font-semibold text-white shadow-sm transition hover:bg-stone-700 dark:bg-amber-400 dark:text-stone-950 dark:hover:bg-amber-300">
                Open for review →
              </button>
            </form>
          )}
          {(error || session.error) && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
              {error || (session.error as Error).message}
            </div>
          )}
          <p className="mt-8 text-sm text-stone-500">
            Tip: open one directly with <code className="rounded bg-stone-200 px-1.5 py-0.5 font-mono text-xs dark:bg-stone-800">uv run spec-tackle &lt;pr-link&gt;</code>
          </p>
        </div>
      </main>
    </div>
  );
}
