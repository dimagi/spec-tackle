import { elementsInRange, selectionToRange } from "./anchors";

function view(html: string) {
  document.body.innerHTML = html;
  return document.body.querySelector(".view")!;
}

test("elementsInRange returns the innermost overlapping elements", () => {
  const v = view(`
    <div class="view">
      <p data-ls="1" data-le="2">intro</p>
      <table data-ls="3" data-le="6">
        <tr data-ls="3" data-le="3"><td>head</td></tr>
        <tr data-ls="5" data-le="5"><td>row</td></tr>
      </table>
      <p data-ls="8" data-le="8">outro</p>
    </div>`);

  const hits = elementsInRange(v, 4, 5).map((el) => el.textContent?.trim());

  expect(hits).toEqual(["row"]);
});

test("elementsInRange keeps a block when no child overlaps", () => {
  const v = view(`<div class="view"><p data-ls="1" data-le="4">para</p></div>`);
  expect(elementsInRange(v, 2, 2)).toHaveLength(1);
});

function select(start: Node, end: Node) {
  const range = document.createRange();
  range.setStart(start, 0);
  range.setEnd(end, end.textContent!.length);
  const sel = getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  return sel;
}

test("selectionToRange spans the selected blocks of one file", () => {
  document.body.innerHTML = `
    <section class="file" data-path="a.md"><div class="view">
      <p data-ls="1" data-le="1">first block</p><p data-ls="3" data-le="4">second block</p>
    </div></section>`;
  const [a, b] = document.querySelectorAll("p");

  const range = selectionToRange(select(a.firstChild!, b.firstChild!));

  expect(range).toMatchObject({ path: "a.md", start: 1, end: 4 });
});

test("selectionToRange quotes only a fragment of one block", () => {
  document.body.innerHTML = `<section class="file" data-path="a.md"><div class="view">
      <p data-ls="2" data-le="2">whole block</p></div></section>`;
  const p = document.querySelector("p")!;

  expect(selectionToRange(select(p.firstChild!, p.firstChild!))?.quote).toBeNull();
});

test("selectionToRange refuses a selection across two files", () => {
  document.body.innerHTML = `
    <section class="file" data-path="a.md"><div class="view"><p data-ls="1" data-le="1">a</p></div></section>
    <section class="file" data-path="b.md"><div class="view"><p data-ls="1" data-le="1">b</p></div></section>`;
  const [a, b] = document.querySelectorAll("p");

  expect(selectionToRange(select(a.firstChild!, b.firstChild!))).toBeNull();
});
