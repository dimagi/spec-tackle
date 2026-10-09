import { usePrFilters, type StatusFilter } from "../state/prFilters";
import { Status } from "./Picker";

const STATUS: { value: StatusFilter; label: string }[] = [{ value: "open", label: "Open" }, { value: "draft", label: "Draft" }];

/** Quick filters for the PR lists: open or draft. */
export function PrFilters() {
  const { status, toggleStatus } = usePrFilters();
  const chip = (label: string, on: boolean, toggle: () => void) => (
    <button key={label} type="button" aria-pressed={on} onClick={toggle}
      // Keep focus in the filter box, so typing and the arrow keys keep working.
      onMouseDown={(e) => e.preventDefault()}
      className={`pr-chip ${on ? "on" : ""}`}>
      {label}
    </button>
  );
  return (
    <div role="group" aria-label="Status" className="flex gap-1 px-1 pt-2">
      {STATUS.map((s) => chip(s.label, status.has(s.value), () => toggleStatus(s.value)))}
    </div>
  );
}

/** Says how many PRs the filters hide, if any. */
export function HiddenByFilters({ count, shown }: { count: number; shown: number }) {
  if (!count) return null;
  const prs = `${count} pull request${count > 1 ? "s" : ""}`;
  return <Status>{shown ? `${prs} more hidden by the filters` : `${prs} hidden by the filters`}</Status>;
}
