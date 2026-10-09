import type { MentionUser } from "../api/types";

/** The `@handle` being typed just before the caret, if any: where its `@` is and what follows it. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  // An @ that starts a word (not an email's), followed by what a GitHub login can hold.
  const m = /(?:^|[^\w`@])@([A-Za-z0-9-]{0,39})$/.exec(text.slice(0, caret));
  if (!m) return null;
  return { start: caret - m[1].length - 1, query: m[1] };
}

/** `text` with the mention starting at `start` (up to the caret) replaced by `@login `. */
export function insertMention(text: string, start: number, caret: number, login: string): { text: string; caret: number } {
  const insert = `@${login} `;
  const rest = text.slice(caret).replace(/^\s/, "");
  return { text: text.slice(0, start) + insert + rest, caret: start + insert.length };
}

const matches = (u: MentionUser, query: string) => {
  const q = query.toLowerCase();
  return u.login.toLowerCase().startsWith(q) || (u.name ?? "").toLowerCase().split(/\s+/).some((w) => w.startsWith(q));
};

/** Suggestions for `query`: the PR's own people first, then the rest of the repo's, without repeats. */
export function rankMentions(participants: MentionUser[], others: MentionUser[], query: string, limit = 8): MentionUser[] {
  const found = new Map<string, MentionUser>();
  for (const u of [...participants.filter((p) => matches(p, query)), ...others]) {
    const key = u.login.toLowerCase();
    const seen = found.get(key);
    // The PR's people come without names; take one from the repo search when it has it.
    if (!seen) found.set(key, u);
    else if (!seen.name && u.name) found.set(key, { ...seen, name: u.name });
  }
  return [...found.values()].slice(0, limit);
}
