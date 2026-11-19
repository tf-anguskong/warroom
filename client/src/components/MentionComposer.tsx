import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useApp } from '../lib/app';
import type { IncidentState, Presence } from '../types';
import { Avatar } from './ui';

interface Candidate {
  token: string;
  label: string;
  sub: string;
  kind: 'here' | 'role' | 'user';
  userId?: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The `@word` (or `@two words`) being typed just before the caret, if any. */
function activeQuery(text: string, caret: number) {
  const m = text.slice(0, caret).match(/(?:^|\s)@([^\s@]*(?: [^\s@]*)?)$/);
  return m ? { query: m[1], start: caret - m[1].length - 1 } : null;
}

interface Props {
  state: IncidentState;
  presence: Presence[];
  placeholder: string;
  onSend: (body: string) => Promise<boolean>;
}

/**
 * Chat composer with @mention autocomplete. What you see in the box is `@Name`; on send each
 * picked mention becomes a token (`<@userId>`, `<@role:commander>`, `<@here>`) so renames and
 * role handovers don't break it.
 */
export function MentionComposer({ state, presence, placeholder, onSend }: Props) {
  const { users, meta, me, userById } = useApp();
  const [draft, setDraft] = useState('');
  const [caret, setCaret] = useState(0);
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const picked = useRef(new Map<string, string>());
  const box = useRef<HTMLTextAreaElement>(null);

  const all = useMemo<Candidate[]>(() => {
    const here = new Map(presence.map((p) => [p.userId, p]));
    const roomName = (id: string | null) => state.voiceRooms.find((v) => v.id === id)?.name;
    const list: Candidate[] = [
      { token: 'here', label: 'here', sub: `Everyone in the war room now (${presence.length})`, kind: 'here' },
    ];
    for (const r of meta.roles) {
      const holder = userById(state.roles.find((x) => x.role === r.key)?.userId);
      if (holder) list.push({ token: `role:${r.key}`, label: r.label, sub: holder.displayName, kind: 'role' });
    }
    const people = users
      .filter((u) => u.id !== me.id && (!u.isGuest || u.guestIncidentId === state.incident.id))
      .map((u) => {
        const p = here.get(u.id);
        return {
          token: u.id,
          label: u.displayName,
          userId: u.id,
          kind: 'user' as const,
          sub: (u.isGuest ? 'Guest · ' : '') + (p ? (p.voiceRoomId ? `In ${roomName(p.voiceRoomId) ?? 'voice'}` : 'In the war room') : 'Not in the room'),
          present: Boolean(p),
        };
      })
      .sort((a, b) => Number(b.present) - Number(a.present) || a.label.localeCompare(b.label));
    return [...list, ...people];
  }, [users, meta.roles, state.roles, state.voiceRooms, presence, me.id, userById]);

  const active = activeQuery(draft, caret);
  const matches = useMemo(() => {
    if (!active || dismissed === active.start) return [];
    const q = active.query.toLowerCase();
    return all
      .filter((c) => {
        const l = c.label.toLowerCase();
        return !q || l.startsWith(q) || l.split(/\s+/).some((w) => w.startsWith(q));
      })
      .slice(0, 8);
  }, [all, active?.query, active?.start, dismissed]);
  const open = matches.length > 0;

  const pick = (c: Candidate) => {
    if (!active) return;
    const text = `@${c.label}`;
    picked.current.set(text, c.token);
    const next = draft.slice(0, active.start) + text + ' ' + draft.slice(caret);
    const pos = active.start + text.length + 1;
    setDraft(next);
    setIndex(0);
    requestAnimationFrame(() => {
      box.current?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  const encode = (text: string) => {
    let out = text;
    // Longest first so "@Alex Rivera" wins over a picked "@Alex".
    const entries = [...picked.current.entries(), ['@here', 'here'] as [string, string]].sort((a, b) => b[0].length - a[0].length);
    for (const [label, token] of entries) {
      out = out.replace(new RegExp(`(^|[^\\w@])${escapeRe(label)}(?![\\w])`, 'g'), `$1<@${token}>`);
    }
    return out;
  };

  const send = async () => {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    const ok = await onSend(encode(body));
    if (ok) picked.current.clear();
    else setDraft(body);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(matches[Math.min(index, matches.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(active!.start);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const sync = () => setCaret(box.current?.selectionStart ?? 0);

  return (
    <div className="composer">
      {open && (
        <div className="mention-menu" role="listbox" aria-label="Mention someone">
          {matches.map((c, i) => (
            <button
              key={c.token}
              role="option"
              aria-selected={i === index}
              className={i === index ? 'on' : ''}
              onMouseEnter={() => setIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(c);
              }}
            >
              {c.kind === 'user' ? <Avatar id={c.userId!} name={c.label} size={20} /> : <span className="mention-glyph">@</span>}
              <span className="mention-name">{c.kind === 'here' ? '@here' : c.label}</span>
              <span className="muted small">{c.sub}</span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={box}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setCaret(e.target.selectionStart);
          setIndex(0);
        }}
        onKeyDown={onKey}
        onKeyUp={sync}
        onClick={sync}
        rows={Math.min(8, Math.max(1, draft.split('\n').length))}
        placeholder={placeholder}
        aria-autocomplete="list"
        aria-expanded={open}
      />
      <button className="btn primary" onClick={send} disabled={!draft.trim()}>
        Send
      </button>
    </div>
  );
}
