import { makeFile } from "../test/fixtures";
import { fileTree, type TreeNode } from "./fileTree";

/** The tree as indented lines: folders end in "/", files carry their page index. */
function lines(nodes: TreeNode[], depth = 0): string[] {
  return nodes.flatMap((n) => n.kind === "dir"
    ? [`${"  ".repeat(depth)}${n.name}/`, ...lines(n.children, depth + 1)]
    : [`${"  ".repeat(depth)}${n.name} #${n.index}`]);
}

const tree = (...paths: string[]) => lines(fileTree(paths.map((path) => makeFile({ path }))));

test("files are grouped by folder, folders first, both sorted by name", () => {
  expect(tree("z.md", "docs/b.md", "docs/a.md", "app/x.py")).toEqual([
    "app/", "  x.py #4", "docs/", "  a.md #3", "  b.md #2", "z.md #1",
  ]);
});

test("a chain of single folders is merged into one", () => {
  expect(tree("src/spec_tackle/app.py", "src/spec_tackle/static/app.js")).toEqual([
    "src/spec_tackle/", "  static/", "    app.js #2", "  app.py #1",
  ]);
});

test("a folder that holds files and folders is not merged", () => {
  expect(tree("docs/a.md", "docs/specs/b.md")).toEqual([
    "docs/", "  specs/", "    b.md #2", "  a.md #1",
  ]);
});

test("merged folders keep the full path, for collapsing", () => {
  const [dir] = fileTree([makeFile({ path: "a/b/c.md" })]);
  expect(dir).toMatchObject({ kind: "dir", name: "a/b", path: "a/b" });
});
