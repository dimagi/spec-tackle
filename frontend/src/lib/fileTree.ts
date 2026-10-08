import type { PageFile } from "../api/types";

export type TreeDir = { kind: "dir"; name: string; path: string; children: TreeNode[] };
export type TreeFile = { kind: "file"; name: string; file: PageFile; index: number };
export type TreeNode = TreeDir | TreeFile;

/**
 * The changed files as a folder tree, like GitHub's: folders before files, each sorted by name,
 * and a folder whose only child is a folder merged into it ("src/app"). `index` is the file's
 * 1-based position on the page, which its section id uses.
 */
export function fileTree(files: PageFile[]): TreeNode[] {
  const root: TreeDir = { kind: "dir", name: "", path: "", children: [] };
  files.forEach((file, i) => {
    const parts = file.path.split("/");
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      const path = dir.path ? `${dir.path}/${part}` : part;
      let next = dir.children.find((c): c is TreeDir => c.kind === "dir" && c.name === part);
      if (!next) {
        next = { kind: "dir", name: part, path, children: [] };
        dir.children.push(next);
      }
      dir = next;
    }
    dir.children.push({ kind: "file", name: parts.at(-1)!, file, index: i + 1 });
  });
  return tidy(root.children);
}

function tidy(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    if (node.kind === "file") return node;
    let dir = node;
    while (dir.children.length === 1 && dir.children[0].kind === "dir") {
      const only = dir.children[0];
      dir = { ...only, name: `${dir.name}/${only.name}` };
    }
    return { ...dir, children: tidy(dir.children) };
  }).sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
}
