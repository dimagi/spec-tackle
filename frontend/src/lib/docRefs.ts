import type { DocRef } from "../api/types";
import { elementsInRange } from "./anchors";

const SKIP = "svg, script, style";
// Classes the review UI adds to blocks; a copy in the popup shouldn't look like an anchor.
const UI_CLASSES = ["has-thread", "has-claude", "is-active-anchor", "is-drafting", "line-flash"];

/** Remove every reference marker from a view, leaving its text as it was. */
export function clearRefs(view: Element) {
  for (const span of view.querySelectorAll("span.doc-ref")) {
    const parent = span.parentNode!;
    span.replaceWith(...span.childNodes);
    parent.normalize();
  }
}

/**
 * Wrap each reference's phrase in `<span class="doc-ref" data-ref="i">`, searching the
 * blocks that cover its line. Returns how many references were found.
 */
export function markRefs(view: Element, refs: DocRef[]): number {
  let found = 0;
  refs.forEach((ref, i) => {
    if (elementsInRange(view, ref.line, ref.line).some((block) => wrapPhrase(block, ref.text, i))) found++;
  });
  return found;
}

/** Wrap the first unmarked occurrence of `phrase` under `root`, even across inline elements. */
export function wrapPhrase(root: Element, phrase: string, index: number): boolean {
  const pattern = phrase.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
  if (!pattern) return false;
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  // Text already marked is blanked out, so a new match can't overlap or cross it.
  const text = nodes
    .map((n) => (n.parentElement?.closest(".doc-ref") ? "\0".repeat(n.data.length) : n.data))
    .join("");
  const match = new RegExp(pattern, "i").exec(text);
  if (!match) return false;
  const start = match.index, end = start + match[0].length;

  const pieces: [Text, number, number][] = [];
  let offset = 0;
  for (const node of nodes) {
    const from = Math.max(start, offset), to = Math.min(end, offset + node.data.length);
    if (from < to) pieces.push([node, from - offset, to - offset]);
    offset += node.data.length;
  }
  // Last first, so splitting one node never shifts the offsets of the pieces still to do.
  pieces.reverse().forEach(([node, from, to], i) => {
    if (to < node.data.length) node.splitText(to);
    const piece = from > 0 ? node.splitText(from) : node;
    const span = document.createElement("span");
    span.className = "doc-ref";
    span.dataset.ref = String(index);
    // Only the first piece takes keyboard focus.
    if (i === pieces.length - 1) span.tabIndex = 0;
    piece.replaceWith(span);
    span.append(piece);
  });
  return true;
}

/**
 * Copies of the blocks that make up source lines [start, end], ready to show elsewhere:
 * the outermost blocks inside the range, or the innermost ones touching it if none fit.
 */
export function targetCopy(view: Element, start: number, end: number): HTMLElement {
  const inside = [...view.querySelectorAll<HTMLElement>("[data-ls]")].filter(
    (el) => +el.dataset.ls! >= start && +el.dataset.le! <= end,
  );
  let blocks: Element[] = inside.filter((el) => !inside.some((other) => other !== el && other.contains(el)));
  if (!blocks.length) blocks = elementsInRange(view, start, end);

  const out = document.createElement("div");
  // The list the last copied item went into, so its siblings join it.
  let listSource: Element | null = null;
  let listCopy: Element | null = null;
  for (const block of blocks) {
    const copy = block.cloneNode(true) as Element;
    const parent = block.parentElement;
    // List items keep their list, so bullets and numbering still show.
    if (block.tagName === "LI" && parent) {
      if (listSource !== parent || !listCopy) {
        listCopy = parent.cloneNode(false) as Element;
        if (listCopy.tagName === "OL") {
          const first = [...parent.children].indexOf(block);
          listCopy.setAttribute("start", String(+(listCopy.getAttribute("start") ?? 1) + first));
        }
        out.append(listCopy);
        listSource = parent;
      }
      listCopy.append(copy);
    } else {
      listSource = listCopy = null;
      out.append(copy);
    }
  }
  for (const el of [out, ...out.querySelectorAll<HTMLElement>("*")]) {
    // Diagrams style themselves by their ids, so those stay.
    if (!el.closest("svg")) el.removeAttribute("id");
    el.removeAttribute("data-ls");
    el.removeAttribute("data-le");
    el.classList.remove(...UI_CLASSES);
  }
  for (const span of out.querySelectorAll("span.doc-ref")) span.replaceWith(...span.childNodes);
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
