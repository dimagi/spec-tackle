import type { DocRef } from "../api/types";
import { clearRefs, markRefs, targetCopy, wrapPhrase } from "./docRefs";

function view(html: string) {
  document.body.innerHTML = `<article class="view">${html}</article>`;
  return document.body.querySelector(".view")!;
}

const ref = (over: Partial<DocRef> = {}): DocRef =>
  ({ line: 3, text: "section 2", targetPath: null, targetStart: 5, targetEnd: 6, note: "", ...over });

test("a phrase in one text node is wrapped", () => {
  const v = view(`<p data-ls="3" data-le="4">Retry as in section 2 please.</p>`);
  expect(markRefs(v, [ref()])).toBe(1);
  const span = v.querySelector<HTMLElement>("span.doc-ref")!;
  expect(span.textContent).toBe("section 2");
  expect(span.dataset.ref).toBe("0");
  expect(span.tabIndex).toBe(0);
  expect(v.textContent).toBe("Retry as in section 2 please.");
});

test("a phrase across inline elements and a line break is wrapped piece by piece", () => {
  const v = view(`<p data-ls="3" data-le="4">as in Section\n<strong>2</strong>, then</p>`);
  expect(markRefs(v, [ref()])).toBe(1);
  const spans = [...v.querySelectorAll<HTMLElement>("span.doc-ref")];
  expect(spans.map((s) => s.textContent)).toEqual(["Section\n", "2"]);
  expect(spans.filter((s) => s.tabIndex === 0)).toHaveLength(1);
  expect(v.querySelector("strong span.doc-ref")).not.toBeNull();
});

test("the same phrase twice on a line marks both occurrences, once each", () => {
  const v = view(`<p data-ls="3" data-le="3">section 2 and section 2</p>`);
  expect(markRefs(v, [ref(), ref({ targetStart: 7, targetEnd: 8 })])).toBe(2);
  expect([...v.querySelectorAll<HTMLElement>("span.doc-ref")].map((s) => s.dataset.ref)).toEqual(["0", "1"]);
  // A third one has nothing left to match.
  expect(wrapPhrase(v.querySelector("p")!, "section 2", 2)).toBe(false);
});

test("a phrase that isn't on its line is skipped", () => {
  const v = view(`<p data-ls="1" data-le="1">section 2</p><p data-ls="3" data-le="3">nothing</p>`);
  expect(markRefs(v, [ref()])).toBe(0);
  expect(v.querySelector("span.doc-ref")).toBeNull();
});

test("special characters in a phrase are matched literally", () => {
  const v = view(`<p data-ls="3" data-le="3">see (§3.2) here</p>`);
  expect(markRefs(v, [ref({ text: "(§3.2)" })])).toBe(1);
});

test("clearRefs puts the text back", () => {
  const v = view(`<p data-ls="3" data-le="3">as in <em>section</em> 2.</p>`);
  const before = v.innerHTML;
  markRefs(v, [ref()]);
  clearRefs(v);
  expect(v.innerHTML).toBe(before);
  expect(v.querySelector("em")!.childNodes).toHaveLength(1);
});

test("targetCopy takes the outermost blocks inside the range, without anchors or markers", () => {
  const v = view(`
    <h2 id="retries" data-ls="5" data-le="5" class="has-thread">Retries</h2>
    <ul data-ls="6" data-le="7"><li data-ls="6" data-le="6">one <span class="doc-ref">x</span></li><li data-ls="7" data-le="7">two</li></ul>
    <p data-ls="9" data-le="9">later</p>`);
  const copy = targetCopy(v, 5, 7);
  expect([...copy.children].map((c) => c.tagName)).toEqual(["H2", "UL"]);
  expect(copy.querySelector("[data-ls], [id], .has-thread, .doc-ref")).toBeNull();
  expect(copy.textContent).toContain("one x");
});

test("targetCopy keeps list items in their list, numbered from the right place", () => {
  const v = view(`<ol data-ls="1" data-le="4"><li data-ls="1" data-le="1">a</li><li data-ls="2" data-le="2">b</li><li data-ls="3" data-le="3">c</li></ol>`);
  const copy = targetCopy(v, 2, 3);
  const ol = copy.querySelector("ol")!;
  expect(ol.getAttribute("start")).toBe("2");
  expect([...ol.children].map((li) => li.textContent)).toEqual(["b", "c"]);
});

test("targetCopy falls back to the block touching the range", () => {
  const v = view(`<p data-ls="1" data-le="9">a long paragraph</p>`);
  expect(targetCopy(v, 3, 4).textContent).toBe("a long paragraph");
});
