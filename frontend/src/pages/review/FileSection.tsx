import { useRef, useState } from "react";
import type { PageFile } from "../../api/types";
import { Html } from "../../components/Html";
import type { PRRef } from "../../state/storage";
import { DocRefs } from "./DocRefs";

export type FileView = "rendered" | "diff";

type Props = {
  file: PageFile;
  index: number;
  /** Set from outside (e.g. the Logic view's "Show in Code view"); otherwise the file keeps its own. */
  view?: FileView;
  onViewChange?: (path: string, view: FileView) => void;
  /** Set when Claude is available: offers "Find references" on a rendered document. */
  refs?: RefsTarget;
};

export type RefsTarget = {
  pr: PRRef;
  head: string;
  auto: boolean;
  /** Scroll to a line of a file on this page, switching its view if needed; false if no view shows it. */
  show: (path: string, line: number) => boolean;
};

/** Whether a file can switch between Document and Changes. */
export function hasViewToggle(file: PageFile): boolean {
  return !!(file.rendered && file.diff && !file.wholeFile);
}

/** A file opens on its changes when it has both views, otherwise on whichever it has. */
export function defaultView(file: PageFile): FileView {
  return file.rendered && !hasViewToggle(file) ? "rendered" : "diff";
}

/** The view that shows `line`: Changes when it's in the diff, else the document. Files without a toggle keep theirs. */
export function viewForLine(file: PageFile, line: number): FileView {
  if (!hasViewToggle(file)) return defaultView(file);
  return file.hunks.some(([start, end]) => start <= line && line <= end) ? "diff" : "rendered";
}

/** Whether one of the file's views shows `line`: the document shows every line, the changes only their hunks. */
export function showsLine(file: PageFile, line: number): boolean {
  return viewForLine(file, line) === "rendered" || file.hunks.some(([start, end]) => start <= line && line <= end);
}

export function FileSection({ file, index, view: chosen, onViewChange, refs }: Props) {
  const toggle = hasViewToggle(file);
  const sectionRef = useRef<HTMLElement>(null);
  const [own, setOwn] = useState<FileView>(defaultView(file));
  const view = chosen ?? own;
  const pick = (v: FileView) => {
    setOwn(v);
    onViewChange?.(file.path, v);
  };
  return (
    <section ref={sectionRef} id={`file-${index}`} className="file paper mb-6" data-path={file.path}>
      <div className="file-header">
        <div className="min-w-0">
          <div className="truncate font-mono text-xs text-stone-500" title={file.path}>{file.path}</div>
        </div>
        <span className={`status-pill status-${file.status}`}>{file.status}</span>
        <span className="font-mono text-xs text-emerald-600">+{file.additions}</span>
        <span className="font-mono text-xs text-rose-600">−{file.deletions}</span>
        <div className="ml-auto flex min-w-0 items-center gap-3">
          {refs && file.rendered && (
            <DocRefs pr={refs.pr} path={file.path} head={refs.head} auto={refs.auto} show={refs.show}
              active={view === "rendered"} section={sectionRef} />
          )}
          {toggle && (
            <div className="flex shrink-0 rounded-lg bg-stone-200/70 p-0.5 text-xs font-medium dark:bg-stone-800">
              <button className={`seg view-toggle ${view === "rendered" ? "on" : ""}`} data-view="rendered" onClick={() => pick("rendered")}>Document</button>
              <button className={`seg view-toggle ${view === "diff" ? "on" : ""}`} data-view="diff" onClick={() => pick("diff")}>Changes</button>
            </div>
          )}
        </div>
      </div>
      {file.rendered && (
        <Html as="article" html={file.rendered} className="view doc-body prose prose-stone max-w-none dark:prose-invert" data-view="rendered" hidden={view !== "rendered"} />
      )}
      {file.diff && (
        <Html html={file.diff} className="view overflow-x-auto" data-view="diff" hidden={view !== "diff"} />
      )}
      {!file.rendered && !file.diff && (
        <div className="px-8 py-10 text-center text-sm text-stone-500">
          No preview available (binary or very large file).{" "}
          <a className="text-amber-700 underline" href={file.githubUrl} target="_blank" rel="noopener">View on GitHub</a>
        </div>
      )}
    </section>
  );
}
