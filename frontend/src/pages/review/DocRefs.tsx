import { useQueryClient } from "@tanstack/react-query";
import { Html } from "../../components/Html";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { apiBase, docRefsKey, useDocRefs, useRefTarget } from "../../api/queries";
import { request } from "../../api/request";
import type { DocRef, DocRefsState } from "../../api/types";
import { elementsInRange } from "../../lib/anchors";
import { clearRefs, markRefs, targetCopy } from "../../lib/docRefs";
import { scrollToLine } from "../../lib/scrollToLine";
import type { PRRef } from "../../state/storage";
import { toast } from "../../state/toasts";

type Props = {
  pr: PRRef;
  path: string;
  /** The commit the page's document was rendered from. */
  head: string;
  /** Find references, and check lines changed by new commits, without being asked. */
  auto: boolean;
  /** Whether the document is the view on show; markers only go in it then. */
  active: boolean;
  section: RefObject<HTMLElement | null>;
  /** Scroll to a line of a file on this page, switching its view if needed; false if no view shows it. */
  show: (path: string, line: number) => boolean;
};

type Scope = "full" | "changed";

type Popup = { refsId: string; index: number; ref: DocRef; rect: DOMRect };

const SHOW_DELAY = 120;
const HIDE_DELAY = 200;

/**
 * The file header's "Find references" button. Once Claude has found the references, in
 * this file or elsewhere in the repo, it marks them and shows what each points at on hover.
 * References from an older commit are carried forward by the server; the lines that
 * changed since are checked on request, or straight away when `auto` is on.
 * See docs/specs/2026-10-09-doc-references-design.md.
 */
export function DocRefs({ pr, path, head, auto, active, section, show }: Props) {
  const query = useDocRefs(pr, path, head);
  const queryClient = useQueryClient();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("Starting…");
  const [shown, setShown] = useState(true);
  const [found, setFound] = useState<number | null>(null);
  const [popup, setPopup] = useState<Popup | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const api = apiBase(pr);
  const data = query.data;
  // Line numbers only fit the document they were found in.
  const current = data?.refs && !data.stale ? data.refs : null;
  const view = () => section.current?.querySelector('.view[data-view="rendered"]') ?? null;

  // Rejoin a run that's already going (another tab, or before a reload).
  useEffect(() => {
    if (data?.running) setRunning(true);
  }, [data?.running]);

  useEffect(() => {
    if (!running) return;
    const params = `path=${encodeURIComponent(path)}&head=${encodeURIComponent(head)}`;
    const source = new EventSource(`${api}/refs/events?${params}`);
    const key = docRefsKey(pr, path, head);
    const end = async (checkError = false) => {
      source.close();
      setRunning(false);
      await queryClient.invalidateQueries({ queryKey: key });
      // A run can end before this stream joins it; its error then comes with the state.
      const error = checkError && queryClient.getQueryData<DocRefsState>(key)?.error;
      if (error) toast(error, { kind: "error", timeout: 8000 });
    };
    source.onmessage = (e) => {
      const event = JSON.parse(e.data) as { type: string; text?: string };
      if (event.type === "tool") setProgress(event.text ?? "Working…");
      else {
        if (event.type === "error") toast(event.text ?? "Finding references failed", { kind: "error", timeout: 8000 });
        end(event.type === "idle");
      }
    };
    source.onerror = () => end();
    return () => source.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, api, path, head]);

  // Mark the phrases in the document, and take the marks away again when they change.
  useEffect(() => {
    const el = view();
    setPopup(null);
    if (!el || !current || !shown || !active) {
      setFound(null);
      return;
    }
    setFound(markRefs(el, current.refs));
    // A phrase can be split into pieces; the arrow for another file goes after the last one.
    const last = new Map<string, HTMLElement>();
    for (const span of el.querySelectorAll<HTMLElement>("span.doc-ref")) {
      if (current.refs[+span.dataset.ref!].targetPath) last.set(span.dataset.ref!, span);
    }
    for (const span of last.values()) span.classList.add("is-external");
    return () => clearRefs(el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, shown, active]);

  // Hover or focus shows the popup; click or Enter jumps to the target.
  useEffect(() => {
    const el = view();
    if (!el || !current) return;
    const marker = (target: EventTarget | null) =>
      target instanceof Element ? target.closest<HTMLElement>("span.doc-ref") : null;
    const refOf = (span: HTMLElement) => current.refs[+span.dataset.ref!];
    const open = (span: HTMLElement, delay: number) => {
      clearTimeout(timer.current);
      const index = +span.dataset.ref!;
      timer.current = setTimeout(
        () => setPopup({ refsId: current.id, index, ref: refOf(span), rect: span.getBoundingClientRect() }),
        delay,
      );
    };
    const jump = (span: HTMLElement) => {
      clearTimeout(timer.current);
      setPopup(null);
      goTo({ pr, head, path, ref: refOf(span), show });
    };
    const onOver = (e: Event) => {
      const span = marker(e.target);
      if (span) open(span, SHOW_DELAY);
    };
    const onOut = (e: Event) => {
      if (marker(e.target) && !marker((e as MouseEvent).relatedTarget)) hideSoon(timer, setPopup);
    };
    const onFocus = (e: Event) => {
      const span = marker(e.target);
      if (span) open(span, 0);
    };
    const onClick = (e: Event) => {
      const span = marker(e.target);
      if (!span) return;
      e.preventDefault(); // a phrase inside a link jumps here, not there
      jump(span);
    };
    const onKey = (e: Event) => {
      const span = marker(e.target);
      if (span && (e as KeyboardEvent).key === "Enter") jump(span);
      if (span && (e as KeyboardEvent).key === "Escape") setPopup(null);
    };
    el.addEventListener("mouseover", onOver);
    el.addEventListener("mouseout", onOut);
    el.addEventListener("focusin", onFocus);
    el.addEventListener("focusout", onOut);
    el.addEventListener("click", onClick);
    el.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer.current);
      el.removeEventListener("mouseover", onOver);
      el.removeEventListener("mouseout", onOut);
      el.removeEventListener("focusin", onFocus);
      el.removeEventListener("focusout", onOut);
      el.removeEventListener("click", onClick);
      el.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, path, pr, head, show]);

  // The popup is placed against the page as it was; scrolling the page closes it.
  useEffect(() => {
    if (!popup) return;
    const close = () => setPopup(null);
    window.addEventListener("scroll", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close);
      window.removeEventListener("resize", close);
    };
  }, [popup]);

  const generate = async (scope: Scope = "full") => {
    setProgress("Starting…");
    try {
      const started = await request<DocRefsState>("POST", `${api}/refs`, { path, head, scope });
      setShown(true);
      if (started.running) setRunning(true);
      else queryClient.invalidateQueries({ queryKey: docRefsKey(pr, path, head) });
    } catch (err) {
      toast((err as Error).message, { kind: "error", timeout: 8000 });
    }
  };

  // With auto on, search a document that has no references yet, or check its changed lines.
  // Each commit and kind of run is tried once, so a failure doesn't start it again.
  const tried = useRef<string | null>(null);
  useEffect(() => {
    if (!auto || !data?.available || running || data.running || data.error) return;
    const scope: Scope | null = !data.refs || data.stale ? "full" : data.refs.pending.length ? "changed" : null;
    if (!scope || tried.current === `${head}:${scope}`) return;
    tried.current = `${head}:${scope}`;
    generate(scope);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, data, running, head]);

  if (!data?.available) return null;
  const failed = data.error ? `Last try failed: ${data.error}` : "";
  const again = (
    <button type="button" className="nav-btn" title={failed || "Find references again"} aria-label="Find references again" onClick={() => generate("full")}>↻</button>
  );
  let control;
  if (running) {
    control = (
      <span className="flex min-w-0 items-center gap-2 text-xs text-stone-500" role="status">
        <span className="spinner shrink-0" aria-hidden="true" />
        <span className="truncate" title={progress}>{progress}</span>
      </span>
    );
  } else if (current) {
    const count = found ?? current.refs.length;
    const changed = current.pending.length;
    const outdated = current.outdated
      ? ` ${current.outdated} outdated by changes since ${current.basedOn?.slice(0, 7)} ${current.outdated === 1 ? "is" : "are"} hidden.`
      : "";
    control = (
      <>
        {current.refs.length ? (
          <button type="button" className="nav-btn" aria-pressed={shown} onClick={() => setShown(!shown)}
            title={(shown ? "Hide the reference markers." : "Show the reference markers.") + outdated}>
            {count} reference{count === 1 ? "" : "s"}
          </button>
        ) : (
          <span className="text-xs text-stone-500" title={outdated.trim() || undefined}>No references found</span>
        )}
        {changed > 0 && (
          <button type="button" className="nav-btn" onClick={() => generate("changed")}
            title={failed || `Look for references in the lines changed since ${current.basedOn?.slice(0, 7)}.${outdated}`}>
            Check {changed} changed line{changed === 1 ? "" : "s"}
          </button>
        )}
        {again}
      </>
    );
  } else {
    const title = failed
      ? failed
      : data.stale && data.refs
        ? `Found for ${data.refs.headSha.slice(0, 7)}; this page shows ${head.slice(0, 7)}`
        : "Ask Claude to mark phrases that point at other parts of this file";
    control = (
      <button type="button" className="nav-btn doc-refs-find" title={title} onClick={() => generate("full")}>
        {data.stale ? "Find references again" : "Find references"}
      </button>
    );
  }

  return (
    <>
      <div className="flex min-w-0 items-center gap-1.5">{control}</div>
      {popup && createPortal(
        <RefPopup popup={popup} path={path} view={view()} onEnter={() => clearTimeout(timer.current)}
          onLeave={() => hideSoon(timer, setPopup)} />,
        document.body,
      )}
    </>
  );
}

function hideSoon(timer: { current: ReturnType<typeof setTimeout> | undefined }, setPopup: (p: null) => void) {
  clearTimeout(timer.current);
  timer.current = setTimeout(() => setPopup(null), HIDE_DELAY);
}

const WIDTH = 448;
const MAX_HEIGHT = 320;

/**
 * Show a reference's target: on this page when a view of its file shows the line (the
 * view on show first), otherwise on GitHub in a new tab.
 */
function goTo({ pr, head, path, ref, show }: {
  pr: PRRef; head: string; path: string; ref: DocRef; show: (path: string, line: number) => boolean;
}) {
  const target = ref.targetPath ?? path;
  const section = document.querySelector<HTMLElement>(`section.file[data-path="${CSS.escape(target)}"]`);
  const shown = section?.querySelector<HTMLElement>(".view:not([hidden])");
  if (shown && elementsInRange(shown, ref.targetStart, ref.targetEnd).length) {
    scrollToLine(target, ref.targetStart, shown.dataset.view === "diff" ? "diff" : "rendered");
  } else if (!show(target, ref.targetStart)) {
    window.open(githubLines(pr, head, target, ref), "_blank", "noopener");
  }
}

function githubLines(pr: PRRef, head: string, path: string, ref: DocRef): string {
  return `https://github.com/${pr.owner}/${pr.repo}/blob/${head}/${encodeURI(path)}#L${ref.targetStart}-L${ref.targetEnd}`;
}

/** What a reference points at, next to the phrase. */
function RefPopup({ popup, path, view, onEnter, onLeave }: {
  popup: Popup; path: string; view: Element | null; onEnter: () => void; onLeave: () => void;
}) {
  const { ref, rect } = popup;
  const width = Math.min(WIDTH, innerWidth - 16);
  const left = Math.max(8, Math.min(rect.left, innerWidth - width - 8));
  const below = innerHeight - rect.bottom >= Math.min(MAX_HEIGHT, rect.top);
  const place = below ? { top: rect.bottom + 6 } : { bottom: innerHeight - rect.top + 6 };
  const range = ref.targetStart === ref.targetEnd ? `${ref.targetStart}` : `${ref.targetStart}–${ref.targetEnd}`;
  const where = ref.targetPath && ref.targetPath !== path ? `${ref.targetPath}:${range}` : `lines ${range}`;
  return (
    <div role="tooltip" className="doc-ref-popup" style={{ left, width, maxHeight: MAX_HEIGHT, ...place }}
      onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <div className="doc-ref-popup-head">
        <span className="truncate font-semibold">{ref.note || `“${ref.text}”`}</span>
        <span className="ml-auto shrink-0 font-mono">{where}</span>
      </div>
      {ref.targetPath
        ? <ElsewhereTarget refsId={popup.refsId} index={popup.index} />
        : <SameFileTarget view={view} ref_={ref} />}
    </div>
  );
}

const PROSE = "doc-ref-popup-body prose prose-stone prose-sm max-w-none dark:prose-invert";

/** A copy of the target blocks already rendered on this page. */
function SameFileTarget({ view, ref_ }: { view: Element | null; ref_: DocRef }) {
  const html = useMemo(
    () => (view ? targetCopy(view, ref_.targetStart, ref_.targetEnd).innerHTML : ""),
    [view, ref_.targetStart, ref_.targetEnd],
  );
  return <div className={PROSE} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Lines from another file, fetched from the checkout: rendered markdown or highlighted code. */
function ElsewhereTarget({ refsId, index }: { refsId: string; index: number }) {
  const target = useRefTarget(refsId, index);
  if (target.error) return <p className="doc-ref-popup-note text-red-700 dark:text-red-300">Couldn't load it: {(target.error as Error).message}</p>;
  const data = target.data;
  if (!data) return <p className="doc-ref-popup-note">Loading…</p>;
  return (
    <>
      {data.kind === "markdown" ? (
        <Html className={PROSE} html={data.html} />
      ) : (
        <div className="doc-ref-popup-body">
          <pre className="logic-code">
            {data.lines.map((l) => (
              <div key={l.n} className={`logic-line${l.changed ? " changed" : ""}`}>
                <span className="ln">{l.n}</span>
                <Html as="code" html={l.html} />
              </div>
            ))}
          </pre>
        </div>
      )}
      {data.truncated && <p className="doc-ref-popup-note">Showing the first {data.end - data.start + 1} lines.</p>}
    </>
  );
}
