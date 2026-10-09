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

/** A PR in a list: the review queue or a repo's open PRs. */
export type PrSummary = {
  owner: string; repo: string; number: number; title: string;
  author: string | null; updatedAt: string; isDraft: boolean; url: string;
};

export type Repo = {
  owner: string; repo: string; description: string | null;
  isPrivate: boolean; pushedAt: string | null; openPrs: number;
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

export type LogicKind = "entry" | "step" | "decision" | "loop" | "async" | "exit";
export type LogicChange = "added" | "changed" | "unchanged";
export type FunctionRef = { path: string; symbol: string; start: number; end: number };

export type LogicBlock = {
  id: string; label: string; kind: LogicKind; change: LogicChange;
  next: { to: string; label?: string }[];
  children?: LogicBlock[];
  functions?: FunctionRef[];
};

export type LogicMap = { id: string; headSha: string; summary: string; blocks: LogicBlock[]; createdAt: string };

/** GET/POST …/logic. `head` comes back from POST: the commit the run is for. */
export type LogicState = { available: boolean; map: LogicMap | null; stale: boolean; running: boolean; error?: string | null; head?: string };

export type LogicFunction = FunctionRef & {
  lines: { n: number; html: string; changed: boolean }[];
  inDiff: boolean;
  /** The step (leaf block) this function belongs to; a parent block shows all its steps' code. */
  step: string;
  missing?: string;
};

export type LogicFunctions = { label: string; headSha: string; functions: LogicFunction[] };

/** A phrase in a document that points at other lines: of the same file when `targetPath` is null. */
export type DocRef = {
  line: number; text: string; targetPath: string | null; targetStart: number; targetEnd: number; note: string;
};
/** GET /api/refs/{id}/{index}/target: what a reference to another file points at. */
export type RefTarget = {
  path: string; start: number; end: number; truncated: boolean; inDiff: boolean; githubUrl: string;
} & ({ kind: "markdown"; html: string } | { kind: "code"; lines: { n: number; html: string; changed: boolean }[] });
export type DocRefs = {
  id: string; path: string; headSha: string; refs: DocRef[]; createdAt: string;
  /** Carried forward from an older commit: document lines still to check, and references dropped as outdated. */
  pending: number[]; basedOn: string | null; outdated: number;
};
/** GET/POST …/refs for one file. */
export type DocRefsState = { available: boolean; refs: DocRefs | null; stale: boolean; running: boolean; error?: string | null };
