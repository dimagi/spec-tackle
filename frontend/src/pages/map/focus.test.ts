import type { ChangeEdge } from "../../api/map";
import { focusSet, sliceDiff } from "./focus";

const e = (from: string, to: string, type: ChangeEdge["type"] = "uses"): ChangeEdge => ({ from, to, type, line: 1 });

test("focus is everything upstream and downstream of a change", () => {
  const edges = [e("a", "b"), e("b", "c"), e("x", "a"), e("y", "z")];
  expect([...focusSet(edges, "b")].sort()).toEqual(["a", "b", "c", "x"]);
});

test("focus terminates on cycles", () => {
  const edges = [e("a", "b"), e("b", "a"), e("b", "c")];
  expect([...focusSet(edges, "a")].sort()).toEqual(["a", "b", "c"]);
});

test("replaced-by guesses aren't followed", () => {
  expect([...focusSet([e("old", "new", "replaced"), e("new", "dep")], "new")].sort()).toEqual(["dep", "new"]);
});

const DIFF = '<table class="diff">'
  + '<tr class="diff-hunk"><td colspan="3">@@ -1,6 +1,6 @@</td></tr>'
  + '<tr class="diff-ctx" data-ls="1" data-le="1"><td class="ln">1</td><td class="ln">1</td><td class="code">import os</td></tr>'
  + '<tr class="diff-del"><td class="ln">4</td><td class="ln"></td><td class="code">-def f(a):</td></tr>'
  + '<tr class="diff-add" data-ls="4" data-le="4"><td class="ln"></td><td class="ln">4</td><td class="code">+def f(a, b):</td></tr>'
  + '<tr class="diff-ctx" data-ls="5" data-le="5"><td class="ln">5</td><td class="ln">5</td><td class="code">    return a</td></tr>'
  + '<tr class="diff-ctx" data-ls="8" data-le="8"><td class="ln">8</td><td class="ln">8</td><td class="code">def g():</td></tr>'
  + "</table>";

test("a change's diff is only the rows inside it", () => {
  const html = sliceDiff(DIFF, [4, 5], [4, 5]);
  const div = document.createElement("div");
  div.innerHTML = html;
  expect([...div.querySelectorAll("tr")].map((r) => r.textContent)).toEqual(["4-def f(a):", "4+def f(a, b):", "55    return a"]);
});

test("a removed change shows its deleted rows", () => {
  const div = document.createElement("div");
  div.innerHTML = sliceDiff(DIFF, null, [4, 4]);
  expect(div.querySelectorAll("tr")).toHaveLength(1);
});
