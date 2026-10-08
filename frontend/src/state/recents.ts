/** PRs recently opened in this browser, for the PR switcher. */

import { samePr } from "../lib/prRef";
import type { PRRef } from "./storage";

export type RecentPr = PRRef & { title: string; openedAt: string };

const KEY = "spec-tackle:recent-prs";
const MAX = 10;

const isRecent = (r: unknown): r is RecentPr => {
  const x = r as RecentPr | null;
  return !!x && typeof x.owner === "string" && typeof x.repo === "string"
    && typeof x.number === "number" && typeof x.title === "string";
};

export function loadRecents(): RecentPr[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(list) ? list.filter(isRecent) : [];
  } catch {
    return [];
  }
}

function save(list: RecentPr[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* private mode etc. */
  }
}

/** Put this PR at the top of the list, refreshing its title. */
export function recordRecent(pr: PRRef & { title: string }, now = new Date()) {
  const entry: RecentPr = { owner: pr.owner, repo: pr.repo, number: pr.number, title: pr.title, openedAt: now.toISOString() };
  save([entry, ...loadRecents().filter((r) => !samePr(r, pr))].slice(0, MAX));
}

export function removeRecent(pr: PRRef): RecentPr[] {
  const list = loadRecents().filter((r) => !samePr(r, pr));
  save(list);
  return list;
}
