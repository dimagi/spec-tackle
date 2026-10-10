/** Links inside comments open in a new tab, so following one never leaves the review. */
export function externalLinks(el: Element | null, rel = "noopener") {
  el?.querySelectorAll("a").forEach((a) => {
    a.target = "_blank";
    a.rel = rel;
  });
}

/** A file's lines on GitHub at a commit. */
export function githubBlobUrl(repo: { owner: string; repo: string }, sha: string, path: string, start: number, end: number): string {
  return `https://github.com/${repo.owner}/${repo.repo}/blob/${sha}/${encodeURI(path)}#L${start}-L${end}`;
}
