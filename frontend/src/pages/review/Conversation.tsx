import { useLayoutEffect, useRef, useState } from "react";
import type { ConversationItem } from "../../api/types";
import { CommentEditor } from "../../components/CommentEditor";
import { CommentMenu } from "../../components/CommentMenu";
import { Html } from "../../components/Html";
import { MentionTextarea } from "../../components/MentionTextarea";
import { RelativeTime } from "../../components/RelativeTime";
import { externalLinks } from "../../lib/links";

const VERDICTS: Record<string, string> = { APPROVED: "approved", CHANGES_REQUESTED: "requested changes", COMMENTED: "reviewed", DISMISSED: "review dismissed" };

type Props = {
  items: ConversationItem[]; fresh: Set<number>; hideBots: boolean;
  onPost: (body: string) => Promise<unknown>;
  onEdit?: (item: ConversationItem, body: string) => Promise<unknown>;
};

export function Conversation({ items, fresh, hideBots, onPost, onEdit }: Props) {
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = items.filter((c) => !(hideBots && c.author.isBot));
  const list = useRef<HTMLOListElement>(null);
  useLayoutEffect(() => externalLinks(list.current));

  const submit = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await onPost(body);
      setText("");
    } catch {
      /* the caller reports the error; keep the text */
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="conversation" className="paper px-8 py-6 sm:px-12">
      <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-stone-500">Conversation</h2>
      <ol ref={list} className="space-y-4">
        {shown.length ? shown.map((c) => (
          <li key={c.id} className="convo-item">
            <img src={c.author.avatarUrl} alt="" />
            <div className="min-w-0 flex-1">
              <div className="comment-meta text-sm">
                <b>{c.author.login}</b>
                {c.kind === "review" && <span className={`verdict verdict-${c.state}`}>{VERDICTS[c.state!] || c.state}</span>}
                {c.author.isBot && <span className="chip chip-bot">bot</span>}
                <RelativeTime iso={c.createdAt} />
                {fresh.has(c.id) && <span className="chip chip-new">new</span>}
                <CommentMenu url={c.url} onEdit={c.canEdit && onEdit ? () => setEditing(c.id) : undefined} className="ml-auto self-center" />
              </div>
              {editing === c.id && onEdit ? (
                <div className="mt-1">
                  <CommentEditor initial={c.body} onCancel={() => setEditing(null)}
                    onSave={async (body) => { await onEdit(c, body); setEditing(null); }} />
                </div>
              ) : c.bodyHTML && <Html html={c.bodyHTML} className="comment-body gh-body prose prose-stone prose-sm mt-1 max-w-none dark:prose-invert" />}
            </div>
          </li>
        )) : <li className="text-sm text-stone-500">No general comments yet.</li>}
      </ol>
      <form className="mt-6" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <MentionTextarea
          name="body" rows={3} placeholder="Leave a general comment on the PR…" className="field" value={text}
          onValueChange={setText}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }}
        />
        <div className="mt-2 flex justify-end">
          <button className="btn-primary" disabled={busy}>Comment</button>
        </div>
      </form>
    </section>
  );
}
