/** Pieces shared by the PR pickers: the top bar's switcher and the landing page's browser. */

import { useState, type ReactNode } from "react";
import type { PrSummary } from "../api/types";
import { RelativeTime } from "./RelativeTime";

/** Arrow-key highlight over `count` rows, kept in range as the rows change. */
export function useHighlight(count: number) {
  const [raw, setHighlight] = useState(0);
  const highlight = Math.max(0, Math.min(raw, count - 1));
  /** Handles ArrowUp/ArrowDown; true if it did. */
  const move = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return false;
    e.preventDefault();
    setHighlight(Math.max(0, Math.min(highlight + (e.key === "ArrowDown" ? 1 : -1), count - 1)));
    return true;
  };
  return { highlight, setHighlight, move };
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={title} className="mb-1">
      <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-stone-500">{title}</div>
      {children}
    </div>
  );
}

export function Status({ children }: { children: ReactNode }) {
  return <div className="px-2 py-1.5 text-sm text-stone-500">{children}</div>;
}

type OptionProps = {
  active: boolean; current?: boolean; children: ReactNode;
  onPick: () => void; onHover: () => void; onRemove?: () => void; removeLabel?: string;
};

export function Option({ active, current = false, children, onPick, onHover, onRemove, removeLabel }: OptionProps) {
  return (
    <div
      role="option" aria-selected={active} onClick={onPick} onMouseEnter={onHover}
      // Keep focus in the input so the keyboard keeps working.
      onMouseDown={(e) => e.preventDefault()}
      className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${active ? "bg-amber-100 dark:bg-amber-500/15" : ""}`}
    >
      <span className="w-3 shrink-0 text-amber-600 dark:text-amber-400">
        {current && <span aria-label="Current pull request">✓</span>}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
      {onRemove && (
        <button type="button" aria-label={removeLabel} onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="rounded px-1.5 text-stone-400 hover:bg-stone-200 hover:text-stone-700 dark:hover:bg-stone-800 dark:hover:text-stone-200">
          ×
        </button>
      )}
    </div>
  );
}

/** A PR row: repo and number, draft pill, title, author and last update. */
export function PrRow({ pr }: { pr: PrSummary }) {
  return (
    <>
      <div className="flex items-center gap-2 text-xs text-stone-500">
        <span className="font-mono">{pr.owner}/{pr.repo} #{pr.number}</span>
        {pr.isDraft && <span className="rounded bg-stone-200 px-1.5 text-[10px] font-semibold uppercase dark:bg-stone-700">draft</span>}
      </div>
      <div className="truncate font-medium">{pr.title}</div>
      <div className="text-xs text-stone-500">{pr.author ?? "ghost"} · updated <RelativeTime iso={pr.updatedAt} /></div>
    </>
  );
}
