import { Router, type Request, type Response } from 'express';
import { db, newId, now, q } from './db.js';
import { addTimeline } from './api.js';
import { emitToIncident, refreshIncident } from './realtime.js';
import { canSee } from './guests.js';
import { getUser, type UserRow } from './users.js';

/**
 * Notes: Markdown notepads that sit next to sheets in a war room. Saving sends the whole text
 * with the version it was based on; if someone else saved in between, the save is refused with
 * the current text so nobody silently overwrites a colleague.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_incident ON notes(incident_id, position);
`);

const MAX_BODY = 200_000;

export interface NoteRow {
  id: string;
  incident_id: string;
  name: string;
  body: string;
  version: number;
  position: number;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
}

const lines = (...l: string[]) => l.join('\n') + '\n';

export const NOTE_TEMPLATES: { key: string; label: string; description: string; name: string; body: string }[] = [
  { key: 'blank', label: 'Blank', description: 'An empty page.', name: 'Notes', body: '' },
  {
    key: 'working',
    label: 'Working notes',
    description: 'Current understanding, open questions, decisions, next steps.',
    name: 'Working notes',
    body: lines(
      '## What we know', '', '- Replace with what’s confirmed so far', '',
      '## Open questions', '', '- [ ] Replace with a question to answer', '',
      '## Decisions', '', '- Replace with a decision and who made it', '',
      '## Next steps', '', '- [ ] Replace with the next step and its owner',
    ),
  },
  {
    key: 'handoff',
    label: 'Shift handoff',
    description: 'What the next shift needs to pick up.',
    name: 'Shift handoff',
    body: lines(
      '## Handoff', '', '**From:** ', '**To:** ', '**Time (UTC):** ', '',
      '### Where things stand', '', 'Replace with a short summary.', '',
      '### In progress', '', '- [ ] Task — owner', '',
      '### Watch out for', '', '- Replace with risks or things not to touch', '',
      '### Contacts', '', '- Name — role — how to reach them',
    ),
  },
  {
    key: 'meeting',
    label: 'Call notes',
    description: 'Attendees, discussion and action items for a bridge call.',
    name: 'Call notes',
    body: lines(
      '## Call', '', '**When (UTC):** ', '**Attendees:** ', '',
      '### Discussion', '', '- Replace with what was discussed', '',
      '### Action items', '', '- [ ] Task — owner',
    ),
  },
];

class HttpError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}
const h =
  (fn: (req: Request, res: Response) => unknown) =>
  async (req: Request, res: Response) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
      console.error('[notes]', err);
      res.status(500).json({ error: 'internal error' });
    }
  };
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const getNote = (id: string) => q.get<NoteRow>('SELECT * FROM notes WHERE id = ?', id);
function mustNote(id: string, user: UserRow) {
  const n = getNote(id);
  if (!n || !canSee(user, n.incident_id, 'note', n.id)) throw new HttpError(404, 'note not found');
  return n;
}

const noteView = (n: NoteRow) => ({
  id: n.id,
  incidentId: n.incident_id,
  name: n.name,
  body: n.body,
  version: n.version,
  updatedBy: n.updated_by,
  updatedByName: n.updated_by ? getUser(n.updated_by)?.display_name ?? null : null,
  updatedAt: n.updated_at,
  createdBy: n.created_by,
  createdAt: n.created_at,
});

/** The note list for an incident's state, filtered to what the viewer may see. */
export function notesFor(viewer: UserRow, incidentId: string) {
  return q
    .all<{ id: string; name: string }>('SELECT id, name FROM notes WHERE incident_id = ? ORDER BY position, created_at', incidentId)
    .filter((n) => canSee(viewer, incidentId, 'note', n.id));
}

/** Notes for the postmortem export, with their headings pushed below the export's own. */
export function notesForExport(incidentId: string): string[] {
  const notes = q.all<NoteRow>('SELECT * FROM notes WHERE incident_id = ? ORDER BY position, created_at', incidentId);
  if (!notes.some((n) => n.body.trim())) return [];
  const out = ['## Notes', ''];
  for (const n of notes) {
    if (!n.body.trim()) continue;
    out.push(`### ${n.name}`, '');
    let fence = false;
    for (const line of n.body.split('\n')) {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      out.push(!fence && /^#{1,4} /.test(line) ? `###${line}` : line);
    }
    out.push('');
  }
  return out;
}

export function createNote(incidentId: string, userId: string | null, templateKey: string, name: string) {
  const tpl = NOTE_TEMPLATES.find((t) => t.key === templateKey) ?? NOTE_TEMPLATES[0];
  const id = newId();
  const ts = now();
  const pos = (q.get<{ p: number | null }>('SELECT MAX(position) AS p FROM notes WHERE incident_id = ?', incidentId)?.p ?? -1) + 1;
  q.run(
    'INSERT INTO notes (id, incident_id, name, body, position, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, incidentId, name || tpl.name, tpl.body, pos, userId, ts, userId, ts,
  );
  return id;
}

export const notesRouter = Router();

notesRouter.get('/note-templates', h(() => ({ templates: NOTE_TEMPLATES.map(({ key, label, description }) => ({ key, label, description })) })));

notesRouter.post(
  '/incidents/:id/notes',
  h((req) => {
    const inc = q.get<{ id: string }>('SELECT id FROM incidents WHERE id = ?', req.params.id);
    if (!inc) throw new HttpError(404, 'incident not found');
    if (req.user!.is_guest) throw new HttpError(403, 'guests can’t create notes');
    const id = createNote(inc.id, req.user!.id, str(req.body?.template, 40), str(req.body?.name, 80));
    addTimeline(inc.id, req.user!.id, 'note', `Note “${getNote(id)!.name}” created`);
    refreshIncident(inc.id);
    return { id };
  }),
);

notesRouter.get('/notes/:id', h((req) => ({ note: noteView(mustNote(req.params.id, req.user!)) })));

/** Save the text. `baseVersion` is the version the editor started from; a mismatch is a conflict. */
notesRouter.put(
  '/notes/:id/body',
  h((req) => {
    const n = mustNote(req.params.id, req.user!);
    if (typeof req.body?.body !== 'string') throw new HttpError(400, 'body must be text');
    const body = req.body.body.replace(/\r\n/g, '\n');
    if (body.length > MAX_BODY) throw new HttpError(413, 'This note is too long (200,000 characters at most). Split it into another note.');
    const base = Number(req.body?.baseVersion);
    if (base !== n.version) throw new HttpError(409, 'Someone else changed this note', { note: noteView(n) });
    if (body === n.body) return { note: noteView(n) };
    const ts = now();
    const r = q.run('UPDATE notes SET body = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND version = ?', body, req.user!.id, ts, n.id, base);
    if (r.changes !== 1) throw new HttpError(409, 'Someone else changed this note', { note: noteView(getNote(n.id)!) });
    const view = noteView(getNote(n.id)!);
    emitToIncident(n.incident_id, 'note:update', { noteId: n.id, note: view });
    return { note: view };
  }),
);

notesRouter.patch(
  '/notes/:id',
  h((req) => {
    const n = mustNote(req.params.id, req.user!);
    if (req.user!.is_guest) throw new HttpError(403, 'guests can’t rename notes');
    const name = str(req.body?.name, 80);
    if (!name) throw new HttpError(400, 'enter a name');
    if (name !== n.name) {
      q.run('UPDATE notes SET name = ? WHERE id = ?', name, n.id);
      addTimeline(n.incident_id, req.user!.id, 'note', `Note “${n.name}” renamed to “${name}”`);
      refreshIncident(n.incident_id);
      emitToIncident(n.incident_id, 'note:update', { noteId: n.id, note: noteView(getNote(n.id)!) });
    }
    return { ok: true };
  }),
);

notesRouter.delete(
  '/notes/:id',
  h((req) => {
    const n = mustNote(req.params.id, req.user!);
    if (req.user!.is_guest) throw new HttpError(403, 'guests can’t delete notes');
    q.run('DELETE FROM notes WHERE id = ?', n.id);
    addTimeline(n.incident_id, req.user!.id, 'note', `Note “${n.name}” deleted`);
    refreshIncident(n.incident_id);
    return { ok: true };
  }),
);
