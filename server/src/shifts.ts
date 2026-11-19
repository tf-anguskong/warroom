import { Router, type Request, type Response } from 'express';
import { db, newId, now, q } from './db.js';
import { addTimeline, canControl, systemNotice } from './api.js';
import { emitToIncident, emitToUser } from './realtime.js';
import { getUser, isAdmin, type UserRow } from './users.js';

/**
 * Shift schedule for long-running war rooms: who is expected to be on, and when. Anyone can put
 * themselves on the schedule; the IC, room admins and app admins can schedule anyone. People get a
 * reminder before their shift, and the room sees a notice when shifts start and end.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  reminded INTEGER NOT NULL DEFAULT 0,
  announced_start INTEGER NOT NULL DEFAULT 0,
  announced_end INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_shifts_incident ON shifts(incident_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_shifts_due ON shifts(ends_at, announced_end);
`);

const MAX_SHIFT_HOURS = 24;
const MAX_REPEAT_DAYS = 30;
const REMIND_MINUTES = 15;

interface ShiftRow {
  id: string;
  incident_id: string;
  user_id: string;
  starts_at: string;
  ends_at: string;
  note: string;
  created_by: string | null;
  created_at: string;
  reminded: number;
  announced_start: number;
  announced_end: number;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
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
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
      console.error('[shifts]', err);
      res.status(500).json({ error: 'internal error' });
    }
  };
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const name = (id: string | null) => (id ? getUser(id)?.display_name ?? 'someone' : 'someone');
/** "14:00Z" when on the same UTC day as `ref`, otherwise "Nov 20 14:00Z". */
function when(iso: string, ref = new Date().toISOString()) {
  const d = new Date(iso);
  const t = `${iso.slice(11, 16)}Z`;
  return iso.slice(0, 10) === ref.slice(0, 10) ? t : `${d.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} ${t}`;
}

const view = (s: ShiftRow) => ({
  id: s.id,
  userId: s.user_id,
  userName: name(s.user_id),
  startsAt: s.starts_at,
  endsAt: s.ends_at,
  note: s.note,
  createdBy: s.created_by,
  createdByName: s.created_by ? name(s.created_by) : null,
});

export const shiftsOf = (incidentId: string) =>
  q.all<ShiftRow>('SELECT * FROM shifts WHERE incident_id = ? ORDER BY starts_at', incidentId).map(view);

const emitShifts = (incidentId: string) => emitToIncident(incidentId, 'shifts:update', { incidentId, shifts: shiftsOf(incidentId) });

/** Who may change shifts for `userId` in this incident. */
function mayEdit(actor: UserRow, incidentId: string, userId: string) {
  return actor.id === userId || isAdmin(actor) || canControl(actor, incidentId);
}

function parseTime(v: unknown, label: string) {
  const d = new Date(String(v ?? ''));
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `${label}: not a valid date and time`);
  d.setUTCSeconds(0, 0);
  return d;
}

function validate(startsAt: Date, endsAt: Date) {
  const hours = (endsAt.getTime() - startsAt.getTime()) / 3600e3;
  if (hours <= 0) throw new HttpError(400, 'The shift has to end after it starts');
  if (hours > MAX_SHIFT_HOURS) throw new HttpError(400, `A shift can be at most ${MAX_SHIFT_HOURS} hours; add another one for the rest`);
}

function overlap(incidentId: string, userId: string, startsAt: string, endsAt: string, exceptId = '') {
  return q.get<ShiftRow>(
    'SELECT * FROM shifts WHERE incident_id = ? AND user_id = ? AND id <> ? AND starts_at < ? AND ends_at > ?',
    incidentId, userId, exceptId, endsAt, startsAt,
  );
}

/** Postmortem export section. */
export function shiftsForExport(incidentId: string): string[] {
  const rows = q.all<ShiftRow>('SELECT * FROM shifts WHERE incident_id = ? ORDER BY starts_at', incidentId);
  if (!rows.length) return [];
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return [
    '## Shift schedule (UTC)',
    '',
    '| Person | Start | End | Hours | Note |',
    '|---|---|---|---|---|',
    ...rows.map(
      (s) =>
        `| ${cell(name(s.user_id))} | ${s.starts_at.slice(0, 16).replace('T', ' ')} | ${s.ends_at.slice(0, 16).replace('T', ' ')} | ${((new Date(s.ends_at).getTime() - new Date(s.starts_at).getTime()) / 3600e3).toFixed(1)} | ${cell(s.note)} |`,
    ),
    '',
  ];
}

export const shiftsRouter = Router();

shiftsRouter.get('/incidents/:id/shifts', h((req) => ({ shifts: shiftsOf(req.params.id) })));

/** Add a shift, optionally repeated daily. Body: { userId, startsAt, endsAt, note, repeatDays } */
shiftsRouter.post(
  '/incidents/:id/shifts',
  h((req) => {
    const actor = req.user!;
    const inc = q.get<{ id: string; status: string }>('SELECT id, status FROM incidents WHERE id = ?', req.params.id);
    if (!inc) throw new HttpError(404, 'incident not found');
    if (inc.status === 'resolved') throw new HttpError(400, 'This incident is resolved');
    const userId = str(req.body?.userId, 40) || actor.id;
    const person = getUser(userId);
    if (!person || !person.active || person.is_guest) throw new HttpError(400, 'Pick an active member of your organization');
    if (!mayEdit(actor, inc.id, userId)) throw new HttpError(403, 'Only the Incident Commander or a room admin can schedule other people');
    const start = parseTime(req.body?.startsAt, 'Start');
    const end = parseTime(req.body?.endsAt, 'End');
    validate(start, end);
    if (end.getTime() < Date.now()) throw new HttpError(400, 'That shift is already over');
    const repeat = Math.min(Math.max(Math.floor(Number(req.body?.repeatDays) || 1), 1), MAX_REPEAT_DAYS);
    const note = str(req.body?.note, 120);

    const planned: { startsAt: string; endsAt: string }[] = [];
    for (let i = 0; i < repeat; i++) {
      const s = new Date(start.getTime() + i * 86400e3).toISOString();
      const e = new Date(end.getTime() + i * 86400e3).toISOString();
      const clash = overlap(inc.id, userId, s, e);
      if (clash) throw new HttpError(409, `${person.display_name} is already on shift ${when(clash.starts_at)}–${when(clash.ends_at, clash.starts_at)}`);
      planned.push({ startsAt: s, endsAt: e });
    }
    const ids: string[] = [];
    db.exec('BEGIN');
    try {
      for (const p of planned) {
        const id = newId();
        q.run(
          'INSERT INTO shifts (id, incident_id, user_id, starts_at, ends_at, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          id, inc.id, userId, p.startsAt, p.endsAt, note, actor.id, now(),
        );
        ids.push(id);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    const first = planned[0];
    const who = userId === actor.id ? `${actor.display_name} is` : `${actor.display_name} scheduled ${person.display_name}`;
    addTimeline(
      inc.id,
      actor.id,
      'schedule',
      `${who}${userId === actor.id ? ' on shift' : ''} ${when(first.startsAt)}–${when(first.endsAt, first.startsAt)}${repeat > 1 ? `, daily for ${repeat} days` : ''}${note ? ` (${note})` : ''}`,
    );
    emitShifts(inc.id);
    void tick();
    return { ids };
  }),
);

shiftsRouter.patch(
  '/shifts/:id',
  h((req) => {
    const actor = req.user!;
    const s = q.get<ShiftRow>('SELECT * FROM shifts WHERE id = ?', req.params.id);
    if (!s) throw new HttpError(404, 'shift not found');
    if (!mayEdit(actor, s.incident_id, s.user_id)) throw new HttpError(403, 'Only the Incident Commander or a room admin can change other people’s shifts');
    const start = req.body?.startsAt !== undefined ? parseTime(req.body.startsAt, 'Start') : new Date(s.starts_at);
    const end = req.body?.endsAt !== undefined ? parseTime(req.body.endsAt, 'End') : new Date(s.ends_at);
    validate(start, end);
    const note = req.body?.note !== undefined ? str(req.body.note, 120) : s.note;
    const clash = overlap(s.incident_id, s.user_id, start.toISOString(), end.toISOString(), s.id);
    if (clash) throw new HttpError(409, `${name(s.user_id)} is already on shift ${when(clash.starts_at)}–${when(clash.ends_at, clash.starts_at)}`);
    const moved = start.toISOString() !== s.starts_at || end.toISOString() !== s.ends_at;
    q.run(
      // Moving a shift re-arms its reminder and announcements if they haven't happened yet.
      `UPDATE shifts SET starts_at = ?, ends_at = ?, note = ?,
         reminded = CASE WHEN ? > ? THEN 0 ELSE reminded END,
         announced_start = CASE WHEN ? > ? THEN 0 ELSE announced_start END,
         announced_end = CASE WHEN ? > ? THEN 0 ELSE announced_end END
       WHERE id = ?`,
      start.toISOString(), end.toISOString(), note,
      start.toISOString(), now(), start.toISOString(), now(), end.toISOString(), now(), s.id,
    );
    if (moved) {
      addTimeline(s.incident_id, actor.id, 'schedule', `${actor.display_name} moved ${name(s.user_id)}’s shift to ${when(start.toISOString())}–${when(end.toISOString(), start.toISOString())}`);
    }
    emitShifts(s.incident_id);
    return { ok: true };
  }),
);

shiftsRouter.delete(
  '/shifts/:id',
  h((req) => {
    const actor = req.user!;
    const s = q.get<ShiftRow>('SELECT * FROM shifts WHERE id = ?', req.params.id);
    if (!s) throw new HttpError(404, 'shift not found');
    if (!mayEdit(actor, s.incident_id, s.user_id)) throw new HttpError(403, 'Only the Incident Commander or a room admin can remove other people’s shifts');
    q.run('DELETE FROM shifts WHERE id = ?', s.id);
    addTimeline(s.incident_id, actor.id, 'schedule', `${actor.display_name} removed ${actor.id === s.user_id ? 'their' : `${name(s.user_id)}’s`} shift ${when(s.starts_at)}–${when(s.ends_at, s.starts_at)}`);
    emitShifts(s.incident_id);
    return { ok: true };
  }),
);

// ---------- reminders and start/end notices ----------

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const t = now();
    const soon = new Date(Date.now() + REMIND_MINUTES * 60e3).toISOString();
    const open = "AND incident_id IN (SELECT id FROM incidents WHERE status <> 'resolved')";
    for (const s of q.all<ShiftRow>(`SELECT * FROM shifts WHERE reminded = 0 AND starts_at <= ? AND starts_at > ? ${open}`, soon, t)) {
      q.run('UPDATE shifts SET reminded = 1 WHERE id = ?', s.id);
      emitToUser(s.user_id, 'shift:soon', { incidentId: s.incident_id, shift: view(s) });
    }
    for (const s of q.all<ShiftRow>(`SELECT * FROM shifts WHERE announced_start = 0 AND starts_at <= ? AND ends_at > ? ${open}`, t, t)) {
      q.run('UPDATE shifts SET announced_start = 1, reminded = 1 WHERE id = ?', s.id);
      systemNotice(s.incident_id, `🕑 **${name(s.user_id)}** is now on shift until ${when(s.ends_at)}${s.note ? ` · ${s.note}` : ''}.`);
      emitToUser(s.user_id, 'shift:started', { incidentId: s.incident_id, shift: view(s) });
      emitShifts(s.incident_id);
    }
    for (const s of q.all<ShiftRow>(`SELECT * FROM shifts WHERE announced_end = 0 AND ends_at <= ? ${open}`, t)) {
      q.run('UPDATE shifts SET announced_end = 1, announced_start = 1, reminded = 1 WHERE id = ?', s.id);
      // Who takes over: anyone whose shift is running now.
      const next = q
        .all<{ user_id: string }>('SELECT user_id FROM shifts WHERE incident_id = ? AND starts_at <= ? AND ends_at > ? AND user_id <> ?', s.incident_id, t, t, s.user_id)
        .map((r) => name(r.user_id));
      systemNotice(s.incident_id, `🕑 **${name(s.user_id)}**’s shift ended.${next.length ? ` On shift now: ${next.join(', ')}.` : ' Nobody is scheduled right now.'}`);
      emitToUser(s.user_id, 'shift:ended', { incidentId: s.incident_id, shift: view(s), onNow: next });
      emitShifts(s.incident_id);
    }
  } catch (err) {
    console.error('[shifts] tick failed', err);
  } finally {
    ticking = false;
  }
}
setInterval(() => void tick(), 30_000).unref();
setTimeout(() => void tick(), 3_000).unref();
