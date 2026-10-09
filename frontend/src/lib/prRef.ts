import type { PRRef } from "../state/storage";

const URL_RE = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/;
const SHORT_RE = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;

/** A PR from a GitHub PR link (any tab) or `owner/repo#123`, like the server's parse_pr_url. */
export function parsePrRef(text: string): PRRef | null {
  const value = text.trim();
  const m = URL_RE.exec(value) ?? SHORT_RE.exec(value);
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
}

export const prPath = (pr: PRRef) => `/pr/${pr.owner}/${pr.repo}/${pr.number}`;

export const samePr = (a: PRRef, b: PRRef) => a.owner === b.owner && a.repo === b.repo && a.number === b.number;
