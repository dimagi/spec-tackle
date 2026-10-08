import { loadPref, savePref, type PRRef } from "../../state/storage";

type Reviewed = Record<string, string>; // path → hash of the diff that was reviewed

/** FNV-1a: a short fingerprint of a file's diff, so a reviewed file un-ticks when it changes. */
export function patchHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

export const loadReviewed = (pr: PRRef): Reviewed => loadPref<Reviewed>(pr, "map-reviewed", {});

export const isReviewed = (reviewed: Reviewed, path: string, diff: string) => reviewed[path] === patchHash(diff);

export function toggleReviewed(pr: PRRef, path: string, diff: string): Reviewed {
  const reviewed = { ...loadReviewed(pr) };
  if (isReviewed(reviewed, path, diff)) delete reviewed[path];
  else reviewed[path] = patchHash(diff);
  savePref(pr, "map-reviewed", reviewed);
  return reviewed;
}
