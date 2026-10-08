/** Per-PR browser storage, with the same keys and JSON values the old UI used. */

export type PRRef = { owner: string; repo: string; number: number };

export const prKey = (pr: PRRef) => `spec-tackle:${pr.owner}/${pr.repo}#${pr.number}`;

export function loadPref<T>(pr: PRRef, name: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`${prKey(pr)}:${name}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function savePref(pr: PRRef, name: string, value: unknown) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(`${prKey(pr)}:${name}`);
    else localStorage.setItem(`${prKey(pr)}:${name}`, JSON.stringify(value));
  } catch {
    /* private mode etc. */
  }
}
