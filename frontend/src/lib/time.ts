/** "just now", "5m ago", "3d ago" … */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 45) return "just now";
  const units: [number, string][] = [[60, "m"], [24, "h"], [7, "d"], [4.35, "w"], [12, "mo"], [Infinity, "y"]];
  let value = s / 60;
  let label = "m";
  for (const [size, unit] of units) {
    label = unit;
    if (value < size) break;
    value /= size;
  }
  return `${Math.max(1, Math.floor(value))}${label} ago`;
}
