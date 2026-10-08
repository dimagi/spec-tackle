/** Shapes of the JSON the FastAPI backend returns (see pages.py and render.normalize_activity). */

export type Person = { login: string; avatarUrl: string; isBot: boolean };
export type Viewer = { login: string; name: string | null; avatarUrl: string };

export type Comment = {
  id: number;
  author: Person;
  body: string;
  bodyHTML: string;
  createdAt: string;
  url: string;
};

export type Thread = {
  id: string;
  path: string;
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  originalStartLine: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  isFileLevel: boolean;
  side: "LEFT" | "RIGHT" | null;
  resolvedBy: string | null;
  comments: Comment[];
};

export type ConversationItem = Comment & { kind: "comment" | "review"; state?: string };

export type Activity = {
  headSha: string;
  state: string;
  isDraft: boolean;
  viewer: { login: string; avatarUrl?: string };
  threads: Thread[];
  conversation: ConversationItem[];
};

export type OutlineItem = { level: number; line: number; id: string; text: string };

export type PageFile = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  hunks: [number, number][];
  wholeFile: boolean;
  markdown: boolean;
  rendered: string | null;
  diff: string | null;
  outline: OutlineItem[];
  githubUrl: string;
};

export type PRInfo = { owner: string; repo: string; number: number; url: string };

export type ReviewRequest = {
  owner: string; repo: string; number: number; title: string;
  author: string | null; updatedAt: string; isDraft: boolean; url: string;
};

export type Overview = {
  title: string;
  url: string;
  bodyHTML: string;
  author: { login: string; avatarUrl: string };
  createdAt: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  additions: number;
  deletions: number;
  changedFiles: number;
};

export type Page = {
  pr: PRInfo;
  overview: Overview;
  files: PageFile[];
  activity: Activity;
  viewer: Viewer | null;
  claude: boolean;
};

export type ClaudeMessage = {
  role: "user" | "assistant" | "error";
  body: string;
  bodyHTML?: string;
  createdAt: string;
};

export type ClaudeThread = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  anchorText: string;
  commit: string;
  createdAt: string;
  running: boolean;
  messages: ClaudeMessage[];
};

export type Session = { viewer: Viewer | null; ghCli: boolean; claude: boolean };
