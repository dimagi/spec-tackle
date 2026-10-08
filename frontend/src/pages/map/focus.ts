import type { ChangeEdge } from "../../api/map";

/** A change plus everything that uses it (upstream) and everything it uses (downstream). */
export function focusSet(edges: ChangeEdge[], id: string): Set<string> {
  const followed = edges.filter((e) => e.type !== "replaced");
  const seen = new Set([id]);
  for (const [from, to] of [["from", "to"], ["to", "from"]] as const) {
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of followed) {
        if (e[from] === cur && !seen.has(e[to])) {
          seen.add(e[to]);
          stack.push(e[to]);
        }
      }
    }
  }
  return seen;
}

const within = (n: number, span: [number, number] | null) => !!span && n >= span[0] && n <= span[1];

/** The rows of a file's rendered diff that belong to one change: its head lines, and its deleted base lines. */
export function sliceDiff(diffHtml: string, lines: [number, number] | null, baseLines: [number, number] | null): string {
  const doc = new DOMParser().parseFromString(diffHtml, "text/html");
  const rows = [...doc.querySelectorAll("tr")].filter((tr) => {
    const head = tr.getAttribute("data-ls");
    if (head) return within(+head, lines);
    if (tr.classList.contains("diff-del")) return within(+(tr.querySelector("td")?.textContent ?? "0"), baseLines);
    return false;
  });
  return `<table class="diff">${rows.map((r) => r.outerHTML).join("")}</table>`;
}
