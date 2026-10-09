import type { Activity, Page, PageFile, Thread } from "../api/types";

export const PR = { owner: "o", repo: "r", number: 7, url: "https://github.com/o/r/pull/7" };

export function makeThread(over: Partial<Thread> = {}): Thread {
  return {
    id: "T1", path: "docs/a.md", line: 2, startLine: null, originalLine: null, originalStartLine: null,
    isResolved: false, isOutdated: false, isFileLevel: false, side: "RIGHT", resolvedBy: null,
    comments: [{
      id: 101, author: { login: "ann", avatarUrl: "", isBot: false }, body: "Why?",
      bodyHTML: "<p>Why?</p>", createdAt: "2026-10-08T10:00:00Z", url: "https://github.com/c/101", canEdit: false,
    }],
    ...over,
  };
}

export function makeActivity(over: Partial<Activity> = {}): Activity {
  return { headSha: "abc1234", state: "OPEN", isDraft: false, viewer: { login: "me" }, threads: [], conversation: [], ...over };
}

export function makeFile(over: Partial<PageFile> = {}): PageFile {
  return {
    path: "docs/a.md", status: "modified", additions: 2, deletions: 1, hunks: [[1, 4]], wholeFile: false,
    markdown: true,
    rendered: '<h1 data-ls="1" data-le="1" id="title">Title</h1><p data-ls="2" data-le="3">two three</p>',
    diff: '<table class="diff"><tr class="code-line" data-ls="2" data-le="2"><td>two</td></tr></table>',
    outline: [{ level: 1, line: 1, id: "title", text: "Title" }],
    githubUrl: "https://github.com/o/r/pull/7/files",
    ...over,
  };
}

export function makePage(over: Partial<Page> = {}): Page {
  return {
    pr: PR,
    overview: {
      title: "Add spec", url: PR.url, bodyHTML: "<p>Desc</p>", author: { login: "ann", avatarUrl: "" },
      createdAt: "2026-10-08T09:00:00Z", baseRefName: "main", headRefName: "spec", headRefOid: "abc1234",
      additions: 2, deletions: 1, changedFiles: 1,
    },
    files: [makeFile()],
    activity: makeActivity(),
    viewer: { login: "me", name: null, avatarUrl: "" },
    claude: false,
    ...over,
  };
}
