/** The review sidebar's width, which the reviewer can drag; kept across PRs. */

export const RAIL_DEFAULT = 256;
export const RAIL_MIN = 200;
export const RAIL_MAX = 640;
const KEY = "spec-tackle:rail-width";

export const clampRailWidth = (px: number) => Math.round(Math.min(RAIL_MAX, Math.max(RAIL_MIN, px)));

export function loadRailWidth(): number {
  try {
    const saved = Number(localStorage.getItem(KEY));
    return saved ? clampRailWidth(saved) : RAIL_DEFAULT;
  } catch {
    return RAIL_DEFAULT;
  }
}

export function saveRailWidth(px: number) {
  try {
    if (px === RAIL_DEFAULT) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(px));
  } catch {
    /* private mode etc. */
  }
}
