import { forwardRef, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useApp } from '../lib/app';
import { filesFrom, humanSize, nameFor, uploadFile } from '../lib/upload';
import type { FileItem, IncidentState, Presence } from '../types';
import { Avatar, Icons } from './ui';

interface Pending {
  key: string;
  name: string;
  size: number;
  preview: string | null;
  progress: number;
  item?: FileItem;
  error?: string;
}

export interface ComposerHandle {
  addFiles: (files: File[]) => void;
}

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
  /** Where uploads go; without it the composer has no attachments. */
  channelId?: string;
  onSend: (body: string, attachments: string[]) => Promise<boolean>;
}

/**
 * Chat composer with @mention autocomplete. What you see in the box is `@Name`; on send each
 * picked mention becomes a token (`<@userId>`, `<@role:commander>`, `<@here>`) so renames and
 * role handovers don't break it.
 */
export const MentionComposer = forwardRef<ComposerHandle, Props>(function MentionComposer({ state, presence, placeholder, channelId, onSend }, ref) {
  const { users, meta, me, userById, toast } = useApp();
  const [pending, setPending] = useState<Pending[]>([]);
  const picker = useRef<HTMLInputElement>(null);

  /** Start uploading straight away so Send is instant; the message only references finished uploads. */
  const addFiles = (files: File[]) => {
    if (!channelId || !files.length) return;
    for (const file of files.slice(0, 10)) {
      const key = `${Date.now()}-${Math.random()}`;
      const preview = /^image\/(png|jpeg|gif|webp)$/.test(file.type) ? URL.createObjectURL(file) : null;
      setPending((p) => [...p, { key, name: nameFor(file), size: file.size, preview, progress: 0 }]);
      uploadFile(state.incident.id, file, { source: 'chat', channelId }, (f) => setPending((p) => p.map((x) => (x.key === key ? { ...x, progress: f } : x))))
        .then((item) => setPending((p) => p.map((x) => (x.key === key ? { ...x, progress: 1, item } : x))))
        .catch((e: Error) => {
          setPending((p) => p.map((x) => (x.key === key ? { ...x, error: e.message } : x)));
          toast({ text: `${nameFor(file)}: ${e.message}`, tone: 'error' }, 7000);
        });
    }
  };
  useImperativeHandle(ref, () => ({ addFiles }));
  const removePending = (key: string) =>
    setPending((p) => {
      const x = p.find((y) => y.key === key);
      if (x?.preview) URL.revokeObjectURL(x.preview);
      return p.filter((y) => y.key !== key);
    });
  const uploading = pending.some((p) => !p.item && !p.error);
  const ready = pending.filter((p) => p.item);
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
    if ((!body && !ready.length) || uploading) return;
    setDraft('');
    const sentPending = pending;
    setPending([]);
    const ok = await onSend(encode(body), ready.map((p) => p.item!.id));
    if (ok) {
      picked.current.clear();
      sentPending.forEach((p) => p.preview && URL.revokeObjectURL(p.preview));
    } else {
      setDraft(body);
      setPending(sentPending);
    }
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
    <div className="composer-wrap">
      {pending.length > 0 && (
        <div className="pending-files">
          {pending.map((p) => (
            <div key={p.key} className={`pending-file ${p.error ? 'failed' : ''}`} title={p.error ?? `${p.name} · ${humanSize(p.size)}`}>
              {p.preview ? <img src={p.preview} alt="" /> : <span className="file-icon">{Icons.paperclip}</span>}
              <span className="pending-name">{p.name}</span>
              <span className="muted small">{p.error ? 'failed' : p.item ? humanSize(p.size) : `${Math.round(p.progress * 100)}%`}</span>
              {!p.item && !p.error && (
                <span className="pending-bar">
                  <span style={{ width: `${Math.round(p.progress * 100)}%` }} />
                </span>
              )}
              <button className="icon-btn sm" aria-label={`Remove ${p.name}`} onClick={() => removePending(p.key)}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}
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
      {channelId && (
        <>
          <button className="icon-btn attach-btn" title="Attach files or screenshots (you can also paste or drop them)" aria-label="Attach files" onClick={() => picker.current?.click()}>
            {Icons.paperclip}
          </button>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
        </>
      )}
      <textarea
        ref={box}
        onPaste={(e) => {
          const files = filesFrom(e.clipboardData);
          if (files.length && channelId) {
            e.preventDefault();
            addFiles(files);
          }
        }}
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
      <button className="btn primary" onClick={send} disabled={(!draft.trim() && !ready.length) || uploading} title={uploading ? 'Waiting for uploads to finish' : undefined}>
        Send
      </button>
    </div>
    </div>
  );
});
