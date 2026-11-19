import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, ApiError } from '../lib/api';
import { useApp } from '../lib/app';
import { getSocket } from '../lib/socket';
import { utcTime } from '../lib/format';
import type { IncidentState, Presence } from '../types';
import { Avatar, Icons, Modal } from './ui';

interface Note {
  id: string;
  incidentId: string;
  name: string;
  body: string;
  version: number;
  updatedBy: string | null;
  updatedByName: string | null;
  updatedAt: string;
}

type Mode = 'edit' | 'split' | 'preview';
type Status = 'saved' | 'dirty' | 'saving' | 'error';

const SAVE_DELAY = 800;
const MODE_KEY = 'warroom.noteMode';
const readMode = (): Mode => {
  try {
    const m = localStorage.getItem(MODE_KEY);
    return m === 'edit' || m === 'preview' || m === 'split' ? m : 'split';
  } catch {
    return 'split';
  }
};

function ago(iso: string) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${utcTime(iso, true).slice(0, 16)}Z`;
}

/** A Markdown notepad: edit, preview or both side by side; saves itself; shows who else is here. */
export function NoteView({ noteId, state, presence }: { noteId: string; state: IncidentState; presence: Presence[] }) {
  const { me, toast } = useApp();
  const [base, setBase] = useState<Note | null>(null); // last version from the server
  const [text, setText] = useState('');
  const [status, setStatus] = useState<Status>('saved');
  const [conflict, setConflict] = useState<Note | null>(null);
  const [showTheirs, setShowTheirs] = useState(false);
  const [mode, setModeState] = useState<Mode>(readMode);
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [, tick] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ text: '', base: null as Note | null, saving: false, conflict: false, sent: null as string | null });
  latest.current.text = text;
  latest.current.base = base;
  latest.current.conflict = Boolean(conflict);

  const setMode = (m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* private window */
    }
  };

  useEffect(() => {
    let alive = true;
    api.get<{ note: Note }>(`/api/notes/${noteId}`).then((r) => {
      if (!alive) return;
      setBase(r.note);
      setText(r.note.body);
      setStatus('saved');
      if (!r.note.body && readMode() === 'preview') setModeState('edit');
    });
    return () => {
      alive = false;
    };
  }, [noteId]);

  const save = useCallback(async () => {
    const cur = latest.current;
    if (!cur.base || cur.saving || cur.conflict) return;
    if (cur.text === cur.base.body) {
      setStatus('saved');
      return;
    }
    cur.saving = true;
    setStatus('saving');
    const sent = cur.text;
    cur.sent = sent;
    try {
      const r = await api.put<{ note: Note }>(`/api/notes/${noteId}/body`, { body: sent, baseVersion: cur.base.version });
      setBase(r.note);
      latest.current.base = r.note;
      setStatus(latest.current.text === r.note.body ? 'saved' : 'dirty');
      if (latest.current.text !== r.note.body) schedule();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const body = await api.get<{ note: Note }>(`/api/notes/${noteId}`).catch(() => null);
        if (body) setConflict(body.note);
        setStatus('dirty');
      } else {
        setStatus('error');
        toast({ text: e instanceof ApiError ? e.message : 'Could not save the note', tone: 'error' }, 6000);
      }
    } finally {
      latest.current.saving = false;
      latest.current.sent = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, toast]);

  const schedule = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), SAVE_DELAY);
  };

  // Save what's pending when leaving the note.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      const cur = latest.current;
      if (cur.base && !cur.conflict && cur.text !== cur.base.body) {
        void api.put(`/api/notes/${noteId}/body`, { body: cur.text, baseVersion: cur.base.version }).catch(() => undefined);
      }
    },
    [noteId],
  );

  // Someone else saved: take it if we have no unsaved changes, otherwise it's a conflict to resolve.
  useEffect(() => {
    const s = getSocket();
    const on = (e: { noteId: string; note: Note }) => {
      if (e.noteId !== noteId) return;
      const cur = latest.current;
      if (!cur.base || e.note.version <= cur.base.version) {
        if (cur.base && e.note.name !== cur.base.name) setBase({ ...cur.base, name: e.note.name });
        return;
      }
      if (e.note.body === cur.text || (e.note.body === cur.sent && e.note.updatedBy === me.id)) {
        // Our own save arriving back (or the same text): just move the base forward.
        setBase(e.note);
        latest.current.base = e.note;
      } else if (cur.text === cur.base.body) {
        setBase(e.note);
        setText(e.note.body);
        setStatus('saved');
      } else {
        // Someone (maybe you in another tab) saved different text while this one has unsaved edits.
        if (timer.current) clearTimeout(timer.current);
        setConflict(e.note);
        latest.current.conflict = true;
      }
    };
    s.on('note:update', on);
    return () => {
      s.off('note:update', on);
    };
  }, [noteId, me.id]);

  // Refresh "edited 3m ago".
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const change = (v: string) => {
    setText(v);
    setStatus('dirty');
    schedule();
  };

  const useTheirs = () => {
    if (!conflict) return;
    setBase(conflict);
    setText(conflict.body);
    setConflict(null);
    setShowTheirs(false);
    setStatus('saved');
  };
  const keepMine = () => {
    if (!conflict) return;
    setBase(conflict);
    latest.current.base = conflict;
    latest.current.conflict = false;
    setConflict(null);
    setShowTheirs(false);
    void save();
  };

  /** Wrap the selection (or insert at the cursor) for the toolbar and shortcuts. */
  const wrap = (before: string, after = before, placeholder = '') => {
    const el = area.current;
    if (!el) return;
    const { selectionStart: a, selectionEnd: b, value } = el;
    const sel = value.slice(a, b) || placeholder;
    const next = value.slice(0, a) + before + sel + after + value.slice(b);
    change(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + before.length, a + before.length + sel.length);
    });
  };
  const linePrefix = (prefix: string) => {
    const el = area.current;
    if (!el) return;
    const { selectionStart: a, selectionEnd: b, value } = el;
    const start = value.lastIndexOf('\n', a - 1) + 1;
    const end = value.indexOf('\n', b);
    const block = value.slice(start, end === -1 ? undefined : end);
    const lines = block.split('\n');
    const all = lines.every((l) => l.startsWith(prefix));
    const next = lines.map((l) => (all ? l.slice(prefix.length) : prefix + l)).join('\n');
    change(value.slice(0, start) + next + (end === -1 ? '' : value.slice(end)));
    requestAnimationFrame(() => el.focus());
  };
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 's') {
      e.preventDefault();
      if (timer.current) clearTimeout(timer.current);
      void save();
    } else if (mod && e.key === 'b') {
      e.preventDefault();
      wrap('**', '**', 'bold');
    } else if (mod && e.key === 'i') {
      e.preventDefault();
      wrap('_', '_', 'italic');
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) return;
      wrap('  ', '');
    } else if (e.key === 'Enter' && !e.shiftKey) {
      // Continue a list on Enter.
      const el = e.currentTarget;
      const { selectionStart: a, value } = el;
      const lineStart = value.lastIndexOf('\n', a - 1) + 1;
      const line = value.slice(lineStart, a);
      const m = line.match(/^(\s*)([-*+]|\d+\.)\s(\[[ xX]\]\s)?/);
      if (!m) return;
      e.preventDefault();
      if (line.trim() === m[0].trim()) {
        // Empty item: end the list.
        change(value.slice(0, lineStart) + value.slice(a));
        requestAnimationFrame(() => el.setSelectionRange(lineStart, lineStart));
        return;
      }
      const bullet = /\d+\./.test(m[2]) ? `${Number.parseInt(m[2], 10) + 1}.` : m[2];
      const insert = `\n${m[1]}${bullet} ${m[3] ? '[ ] ' : ''}`;
      change(value.slice(0, a) + insert + value.slice(el.selectionEnd));
      requestAnimationFrame(() => el.setSelectionRange(a + insert.length, a + insert.length));
    }
  };

  /** Tick a checklist item in the preview: flip `[ ]` / `[x]` on that source line. */
  const toggleTask = (line: number) => {
    const lines = text.split('\n');
    const l = lines[line - 1];
    if (l === undefined) return;
    lines[line - 1] = l.replace(/^(\s*(?:[-*+]|\d+\.)\s+)\[([ xX])\]/, (_m, p: string, c: string) => `${p}[${c === ' ' ? 'x' : ' '}]`);
    change(lines.join('\n'));
  };

  const components = useMemo<Components>(
    () => ({
      a: ({ node: _n, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
      li: ({ node, className, children, ...props }) => {
        const line = node?.position?.start.line;
        if (!className?.includes('task-list-item') || !line) return <li className={className} {...props}>{children}</li>;
        return (
          <li
            className={`${className} clickable-task`}
            {...props}
            onClick={(e) => {
              if ((e.target as HTMLElement).tagName === 'INPUT') {
                e.preventDefault();
                toggleTask(line);
              }
            }}
          >
            {children}
          </li>
        );
      },
      input: ({ node: _n, ...props }) => (props.type === 'checkbox' ? <input {...props} disabled={false} readOnly /> : <input {...props} />),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [text],
  );

  if (!base) return <div className="skeleton tall" />;

  const viewers = presence.filter((p) => p.view === `note:${noteId}` && p.userId !== me.id);
  const statusText =
    status === 'saving'
      ? 'Saving…'
      : status === 'dirty'
        ? 'Unsaved changes'
        : status === 'error'
          ? 'Not saved'
          : `Saved · edited ${base.updatedByName ? `by ${base.updatedBy === me.id ? 'you' : base.updatedByName} ` : ''}${ago(base.updatedAt)}`;

  const preview = (body: string): ReactNode =>
    body.trim() ? (
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {body}
      </ReactMarkdown>
    ) : (
      <p className="muted">Nothing here yet. Switch to Edit and start typing; Markdown works (# headings, - lists, - [ ] checklists, **bold**, `code`, tables).</p>
    );

  return (
    <div className="note-view">
      <div className="view-head">
        {renaming && !me.isGuest ? (
          <input
            className="title-input"
            autoFocus
            defaultValue={base.name}
            onBlur={(e) => {
              setRenaming(false);
              if (e.target.value.trim() && e.target.value !== base.name) api.patch(`/api/notes/${noteId}`, { name: e.target.value });
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <h2 onClick={() => !me.isGuest && setRenaming(true)} title={me.isGuest ? undefined : 'Click to rename'}>
            {Icons.note} {base.name}
          </h2>
        )}
        <div className="avatar-stack">
          {viewers.map((v) => (
            <Avatar key={v.userId} id={v.userId} name={`${v.displayName} has this note open`} size={24} />
          ))}
        </div>
        <span className={`note-status small ${status === 'error' ? 'danger-text' : status === 'saved' ? 'muted' : 'warn-text'}`}>{statusText}</span>
        <div className="spacer" />
        <div className="seg">
          {(['edit', 'split', 'preview'] as Mode[]).map((m) => (
            <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
              {m === 'edit' ? 'Edit' : m === 'split' ? 'Split' : 'Preview'}
            </button>
          ))}
        </div>
        <a className="btn ghost sm" href={`data:text/markdown;charset=utf-8,${encodeURIComponent(text)}`} download={`${base.name.replace(/[^\w.-]+/g, '_')}.md`} title="Download as Markdown">
          {Icons.download} .md
        </a>
        {!me.isGuest && (
          <button className="icon-btn" title="Delete note" aria-label="Delete note" onClick={() => setConfirmDelete(true)}>
            {Icons.trash}
          </button>
        )}
      </div>

      {conflict && (
        <div className="alert warn note-conflict">
          <div className="grow">
            <strong>{conflict.updatedByName ?? 'Someone'}</strong> saved a newer version at {utcTime(conflict.updatedAt)}Z while you were editing. Your changes aren’t
            saved yet.
          </div>
          <button className="btn ghost sm" onClick={() => setShowTheirs((v) => !v)}>
            {showTheirs ? 'Hide' : 'Show'} their version
          </button>
          <button className="btn secondary sm" onClick={useTheirs}>
            Use theirs
          </button>
          <button className="btn primary sm" onClick={keepMine}>
            Keep mine
          </button>
        </div>
      )}

      {mode !== 'preview' && (
        <div className="note-toolbar" role="toolbar" aria-label="Formatting">
          <button title="Heading" onClick={() => linePrefix('## ')}>
            H
          </button>
          <button title="Bold (Ctrl+B)" onClick={() => wrap('**', '**', 'bold')}>
            <strong>B</strong>
          </button>
          <button title="Italic (Ctrl+I)" onClick={() => wrap('_', '_', 'italic')}>
            <em>I</em>
          </button>
          <button title="Bulleted list" onClick={() => linePrefix('- ')}>
            •
          </button>
          <button title="Checklist" onClick={() => linePrefix('- [ ] ')}>
            ☐
          </button>
          <button title="Code" onClick={() => wrap('`', '`', 'code')}>
            {'</>'}
          </button>
          <button title="Code block" onClick={() => wrap('\n```\n', '\n```\n', 'paste logs here')}>
            {'{ }'}
          </button>
          <button title="Link" onClick={() => wrap('[', '](https://)', 'text')}>
            {Icons.link}
          </button>
          <button title="Table" onClick={() => wrap('\n| Column | Column |\n|---|---|\n| ', ' |  |\n', 'value')}>
            {Icons.grid}
          </button>
          <span className="muted small note-hint">Markdown · Ctrl+S saves now · saves automatically</span>
        </div>
      )}

      <div className={`note-body mode-${mode}`}>
        {mode !== 'preview' && (
          <textarea
            ref={area}
            className="note-editor mono"
            value={text}
            onChange={(e) => change(e.target.value)}
            onKeyDown={onKey}
            onBlur={() => status === 'dirty' && void save()}
            spellCheck
            placeholder={'# Heading\n\n- bullet\n- [ ] checklist item\n\n**bold**, `code`, [link](https://…)'}
            aria-label={`${base.name} (Markdown)`}
          />
        )}
        {mode !== 'edit' && <div className="md-body note-preview">{preview(text)}</div>}
        {showTheirs && conflict && (
          <div className="md-body note-preview theirs">
            <div className="muted small">Their version ({conflict.updatedByName ?? 'someone'})</div>
            {preview(conflict.body)}
          </div>
        )}
      </div>

      {confirmDelete && (
        <Modal
          title={`Delete “${base.name}”?`}
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={async () => {
                  await api.del(`/api/notes/${noteId}`);
                  setConfirmDelete(false);
                }}
              >
                Delete note
              </button>
            </>
          }
        >
          <p>The note is deleted for everyone in {state.incident.key}. This can’t be undone; download it first if you want a copy.</p>
        </Modal>
      )}
    </div>
  );
}
