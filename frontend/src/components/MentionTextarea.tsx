import {
  createContext, useContext, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState,
  type KeyboardEvent, type Ref, type TextareaHTMLAttributes,
} from "react";
import type { MentionUser } from "../api/types";
import { insertMention, mentionAt, rankMentions } from "../lib/mentions";
import { useDebounced } from "../lib/useDebounced";

/** Where @mention suggestions come from: the PR's people first, then a search of the repo's. */
export type Mentions = { participants: MentionUser[]; search: (query: string) => Promise<MentionUser[]> };

export const MentionsCtx = createContext<Mentions | null>(null);

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
  /** Suggest people after an `@`; off for text that never reaches GitHub. */
  mentions?: boolean;
  ref?: Ref<HTMLTextAreaElement | null>;
};

/** A textarea that suggests GitHub users to @mention, like GitHub's own comment box. */
export function MentionTextarea({ value, onValueChange, mentions = true, ref, onKeyDown, onBlur, ...rest }: Props) {
  const source = useContext(MentionsCtx);
  const inner = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => inner.current!, []);
  const listId = useId();
  const [caret, setCaret] = useState<number | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const pendingCaret = useRef<number | null>(null);

  const token = mentions && source && caret !== null ? mentionAt(value, caret) : null;
  const active = token && token.start !== dismissed ? token : null;
  const query = useDebounced(active?.query ?? "", 150);
  const [found, setFound] = useState<{ query: string; users: MentionUser[] } | null>(null);
  const searching = !!active && !!source;
  useEffect(() => {
    if (!searching) return;
    let live = true;
    source!.search(query).then((users) => { if (live) setFound({ query, users }); }, () => {});
    return () => { live = false; };
  }, [searching, source, query]);
  const others = found && found.query === active?.query ? found.users : [];
  const options = active ? rankMentions(source!.participants, others, active.query) : [];
  const open = options.length > 0;
  const current = Math.min(highlight, Math.max(options.length - 1, 0));

  useLayoutEffect(() => {
    if (pendingCaret.current === null || !inner.current) return;
    inner.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [value]);

  const track = (el: HTMLTextAreaElement) => {
    const at = el.selectionStart === el.selectionEnd ? el.selectionStart : null;
    if (at !== caret) setHighlight(0);
    // Escape hides the list for one @; a new one shows it again.
    if (at === null || !mentionAt(el.value, at)) setDismissed(null);
    setCaret(at);
  };

  const pick = (u: MentionUser) => {
    if (!active || caret === null) return;
    const next = insertMention(value, active.start, caret, u.login);
    pendingCaret.current = next.caret;
    setCaret(next.caret);
    onValueChange(next.text);
  };

  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setHighlight((current + step + options.length) % options.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(options[current]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(active!.start);
        return;
      }
    }
    onKeyDown?.(e);
  };

  return (
    <div className="mention-wrap">
      <textarea
        {...rest}
        ref={inner}
        value={value}
        role={mentions && source ? "combobox" : undefined}
        aria-autocomplete={mentions && source ? "list" : undefined}
        aria-expanded={mentions && source ? open : undefined}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${current}` : undefined}
        onChange={(e) => { onValueChange(e.target.value); track(e.target); }}
        onSelect={(e) => track(e.currentTarget)}
        onKeyDown={keyDown}
        onBlur={(e) => { setCaret(null); onBlur?.(e); }}
      />
      {open && (
        <ul id={listId} role="listbox" aria-label="People to mention" className="mention-list">
          {options.map((u, i) => (
            <li key={u.login} id={`${listId}-${i}`} role="option" aria-selected={i === current}
              onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setHighlight(i)} onClick={() => pick(u)}>
              {u.avatarUrl ? <img src={u.avatarUrl} alt="" /> : <span className="avatar-blank" />}
              <b>{u.login}</b>
              {u.name && <span className="truncate text-stone-500">{u.name}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
