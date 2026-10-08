import { useState } from "react";
import type { PageFile } from "../../api/types";
import { Html } from "../../components/Html";

export type FileView = "rendered" | "diff";

type Props = { file: PageFile; index: number; onViewChange?: (path: string, view: FileView) => void };

export function FileSection({ file, index, onViewChange }: Props) {
  const [view, setView] = useState<FileView>(file.rendered ? "rendered" : "diff");
  const toggle = !!(file.rendered && file.diff && !file.wholeFile);
  const pick = (v: FileView) => {
    setView(v);
    onViewChange?.(file.path, v);
  };
  return (
    <section id={`file-${index}`} className="file paper mb-6" data-path={file.path}>
      <div className="file-header">
        <div className="min-w-0">
          <div className="truncate font-mono text-xs text-stone-500" title={file.path}>{file.path}</div>
        </div>
        <span className={`status-pill status-${file.status}`}>{file.status}</span>
        <span className="font-mono text-xs text-emerald-600">+{file.additions}</span>
        <span className="font-mono text-xs text-rose-600">−{file.deletions}</span>
        {toggle && (
          <div className="ml-auto flex rounded-lg bg-stone-200/70 p-0.5 text-xs font-medium dark:bg-stone-800">
            <button className={`seg view-toggle ${view === "rendered" ? "on" : ""}`} data-view="rendered" onClick={() => pick("rendered")}>Document</button>
            <button className={`seg view-toggle ${view === "diff" ? "on" : ""}`} data-view="diff" onClick={() => pick("diff")}>Changes</button>
          </div>
        )}
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
