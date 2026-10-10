/** A function's source, as the Visualize panels show it. */
import type { PRRef } from "../../state/storage";
import { Html } from "../../components/Html";
import { githubBlobUrl } from "../../lib/links";

type Line = { n: number; html: string; changed: boolean };

/** Highlighted lines with numbers; the PR's changed lines are marked. */
export function SourceLines({ lines }: { lines: Line[] }) {
  return (
    <pre className="logic-code">
      {lines.map((l) => (
        <div key={l.n} className={`logic-line${l.changed ? " changed" : ""}`}>
          <span className="ln">{l.n}</span>
          <Html as="code" html={l.html} />
        </div>
      ))}
    </pre>
  );
}

type LinkProps = {
  pr: PRRef; head: string; path: string; start: number; end: number;
  /** The file is in the PR's diff, so the Code view has it. */
  inDiff: boolean;
  /** Where to land in the Code view: the first changed line, or the start. */
  line: number;
  onShowInReview: (path: string, line: number) => void;
};

/** Show in Code view for a file in the PR; View on GitHub for one outside it. */
export function SourceLink({ pr, head, path, start, end, inDiff, line, onShowInReview }: LinkProps) {
  const cls = "text-xs font-semibold text-amber-700 hover:underline dark:text-amber-300";
  return inDiff ? (
    <button type="button" className={cls} onClick={() => onShowInReview(path, line)}>Show in Code view</button>
  ) : (
    <a className={cls} target="_blank" rel="noopener" href={githubBlobUrl(pr, head, path, start, end)}>View on GitHub</a>
  );
}
