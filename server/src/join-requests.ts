import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { db, newId, now, q, tx } from './db.js';
import { emailCanSend } from './email-login.js';
import { ACCESS_HOURS, canInviteMembers, cleanScope, insertInvite, maskEmail, unverifiedMemberBlock } from './guests.js';
import { refreshIncident } from './realtime.js';
import { logAdminAction, type UserRow } from './users.js';

/**
 * Asking to join from the room's own link. Someone without an account opens the war room link, says
 * who they are, and waits. Whoever runs the room (IC, room admins, admins) lets them in as a
 * responder or a guest, or turns them down. Letting someone in makes an ordinary single-use invite
 * that only the person who asked receives (they hold the request's secret), so the normal join rules
 * still apply: an email code when War Room can send email, and no signing in as an existing account.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS join_requests (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  secret_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  org TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  ip TEXT,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT,
  decided_at TEXT,
  kind TEXT,
  scope TEXT,
  access_hours INTEGER,
  invite_id TEXT
);
CREATE INDEX IF NOT EXISTS join_requests_incident ON join_requests(incident_id, status);
`);

interface JoinRequestRow {
  id: string;
  incident_id: string;
  secret_hash: string;
  name: string;
  email: string;
  org: string;
  note: string;
  ip: string | null;
  created_at: string;
  status: 'pending' | 'admitted' | 'denied' | 'cancelled';
  decided_by: string | null;
  decided_at: string | null;
  kind: 'guest' | 'member' | null;
  scope: string | null;
  access_hours: number | null;
  invite_id: string | null;
}

/** How long a request waits for an answer, and how long someone who was let in has to come in. */
const PENDING_MINUTES = 30;
const ADMITTED_HOURS = 1;
/** At most this many waiting at once per room, and this many asks per address per 10 minutes. */
const MAX_PENDING = 25;
const PER_IP = 5;
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');
const key = (n: number) => `INC-${String(n).padStart(4, '0')}`;
const ID_RE = /^[0-9a-f-]{36}$/;

const isPendingNow = (r: JoinRequestRow) => r.status === 'pending' && Date.now() - new Date(r.created_at).getTime() < PENDING_MINUTES * 60_000;

/** Requests still waiting for an answer, for the people who run the room. */
export function pendingJoinRequests(incidentId: string) {
  const since = new Date(Date.now() - PENDING_MINUTES * 60_000).toISOString();
  return q
    .all<JoinRequestRow>("SELECT * FROM join_requests WHERE incident_id = ? AND status = 'pending' AND created_at > ? ORDER BY created_at", incidentId, since)
    .map((r) => ({ id: r.id, name: r.name, email: r.email, org: r.org, note: r.note, createdAt: r.created_at }));
}

function openIncident(id: string) {
  if (!ID_RE.test(id)) return null;
  const inc = q.get<{ id: string; number: number; status: string }>('SELECT id, number, status FROM incidents WHERE id = ?', id);
  return inc && inc.status !== 'resolved' ? inc : null;
}

/** The request, if `secret` is the one handed to the person who asked. */
function ownRequest(id: string, secret: unknown) {
  if (!ID_RE.test(id) || typeof secret !== 'string' || !/^[A-Za-z0-9_-]{20,60}$/.test(secret)) return null;
  const r = q.get<JoinRequestRow>('SELECT * FROM join_requests WHERE id = ?', id);
  if (!r) return null;
  const a = Buffer.from(sha(secret), 'hex');
  const b = Buffer.from(r.secret_hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b) ? r : null;
}

// Per-address limit, in memory (a restart forgets it, which is fine).
const recent = new Map<string, number[]>();
function tooMany(ip: string) {
  const t = Date.now();
  const hits = (recent.get(ip) ?? []).filter((x) => t - x < 600_000);
  if (hits.length >= PER_IP) return true;
  recent.set(ip, [...hits, t]);
  if (recent.size > 5000) recent.clear();
  return false;
}

// ---------- the person asking (not signed in) ----------

export const joinRequestAuthRouter = Router();

/** What the link is: shown on the ask-to-join page. Only the incident key, not its title. */
joinRequestAuthRouter.get('/auth/rooms/:id', (req, res) => {
  const inc = openIncident(req.params.id);
  if (!inc) return res.status(404).json({ error: 'This war room link isn’t valid, or the incident is closed' });
  res.json({ incidentKey: key(inc.number), emailCode: emailCanSend() });
});

joinRequestAuthRouter.post('/auth/rooms/:id/join-requests', (req, res) => {
  const inc = openIncident(req.params.id);
  if (!inc) return res.status(404).json({ error: 'This war room link isn’t valid, or the incident is closed' });
  const name = str(req.body?.name, 80);
  const email = str(req.body?.email, 254).toLowerCase();
  if (!name) return res.status(400).json({ error: 'Enter your name' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter your email address' });
  if (tooMany(req.ip ?? '')) return res.status(429).json({ error: 'Too many requests from here. Wait a few minutes and try again.' });
  const since = new Date(Date.now() - PENDING_MINUTES * 60_000).toISOString();
  const waiting = q.get<{ n: number }>("SELECT COUNT(*) AS n FROM join_requests WHERE incident_id = ? AND status = 'pending' AND created_at > ?", inc.id, since)!.n;
  if (waiting >= MAX_PENDING) return res.status(429).json({ error: 'Too many people are waiting to join this room. Try again in a few minutes.' });
  const secret = randomBytes(24).toString('base64url');
  const id = newId();
  tx(() => {
    // Asking again replaces your earlier request.
    q.run("UPDATE join_requests SET status = 'cancelled' WHERE incident_id = ? AND email = ? AND status = 'pending'", inc.id, email);
    q.run(
      'INSERT INTO join_requests (id, incident_id, secret_hash, name, email, org, note, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, inc.id, sha(secret), name, email, str(req.body?.org, 80), str(req.body?.note, 300), req.ip ?? null, now(),
    );
  });
  refreshIncident(inc.id);
  res.json({ id, secret, incidentKey: key(inc.number), waitMinutes: PENDING_MINUTES });
});

/**
 * Where the request stands. Once someone lets them in, the first check makes their invite and
 * returns its link: once, to the holder of the secret.
 */
joinRequestAuthRouter.post('/auth/join-requests/:id/status', (req, res) => {
  const r = ownRequest(req.params.id, req.body?.secret);
  if (!r) return res.status(404).json({ error: 'Request not found' });
  const inc = q.get<{ number: number; status: string }>('SELECT number, status FROM incidents WHERE id = ?', r.incident_id)!;
  const base = { incidentKey: key(inc.number) };
  if (inc.status === 'resolved') return res.json({ ...base, status: 'closed' });
  if (r.status === 'pending') return res.json({ ...base, status: isPendingNow(r) ? 'pending' : 'expired' });
  if (r.status !== 'admitted') return res.json({ ...base, status: r.status });
  if (r.invite_id) return res.json({ ...base, status: 'used' });
  if (Date.now() - new Date(r.decided_at!).getTime() > ADMITTED_HOURS * 3600_000) return res.json({ ...base, status: 'expired' });
  let url: string | null = null;
  try {
    tx(() => {
    const inv = insertInvite({
      incidentId: r.incident_id,
      kind: r.kind === 'member' ? 'member' : 'guest',
      label: r.name,
      org: r.org,
      note: r.note,
      scope: JSON.parse(r.scope ?? '{}'),
      accessHours: r.access_hours ?? 12,
      linkHours: ADMITTED_HOURS,
      email: r.email,
      createdBy: r.decided_by!,
      // With email, they prove the address with a code like any invite; without, asking was the proof.
      codeMode: emailCanSend() ? 'email' : 'link',
    });
    const claimed = q.run('UPDATE join_requests SET invite_id = ? WHERE id = ? AND invite_id IS NULL', inv.id, r.id);
    if (claimed.changes !== 1) throw new Error('claimed');
    url = `/join/${inv.token}`;
    });
  } catch (e) {
    if (!(e instanceof Error && e.message === 'claimed')) throw e;
  }
  if (!url) return res.json({ ...base, status: 'used' });
  res.json({ ...base, status: 'admitted', kind: r.kind, url });
});

joinRequestAuthRouter.post('/auth/join-requests/:id/cancel', (req, res) => {
  const r = ownRequest(req.params.id, req.body?.secret);
  if (!r) return res.status(404).json({ error: 'Request not found' });
  q.run("UPDATE join_requests SET status = 'cancelled' WHERE id = ? AND status = 'pending'", r.id);
  refreshIncident(r.incident_id);
  res.json({ ok: true });
});

// ---------- whoever runs the room ----------

export const joinRequestsRouter = Router();

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
      console.error('[join-requests]', err);
      res.status(500).json({ error: 'internal error' });
    }
  };

async function pendingFor(req: Request) {
  const { canControl } = await import('./api.js');
  const user = req.user as UserRow;
  if (user.is_guest || !canControl(user, req.params.id)) throw new HttpError(403, 'Only the Incident Commander or a room admin can answer join requests');
  const inc = openIncident(req.params.id);
  if (!inc) throw new HttpError(400, 'This incident is resolved');
  const r = q.get<JoinRequestRow>('SELECT * FROM join_requests WHERE id = ? AND incident_id = ?', req.params.requestId, inc.id);
  if (!r) throw new HttpError(404, 'Request not found');
  if (!isPendingNow(r)) throw new HttpError(409, r.status === 'pending' ? 'That request has expired' : `Someone already answered that request (${r.status === 'admitted' ? 'let in' : r.status === 'denied' ? 'turned down' : 'cancelled'})`);
  return { inc, r, user };
}

const who = (r: JoinRequestRow) => `${r.name}${r.org ? ` (${r.org})` : ''}, ${maskEmail(r.email)}`;

joinRequestsRouter.post(
  '/incidents/:id/join-requests/:requestId/admit',
  h(async (req) => {
    const { inc, r, user } = await pendingFor(req);
    const kind = req.body?.kind === 'member' ? 'member' : 'guest';
    if (kind === 'member' && !(await canInviteMembers(user, inc.id))) throw new HttpError(403, 'You can’t let people in as responders here');
    if (kind === 'member' && unverifiedMemberBlock(user)) throw new HttpError(403, unverifiedMemberBlock(user)!);
    const scope = kind === 'member' ? { channels: [], voiceRooms: [], sheets: [], notes: [], timeline: false, agents: false } : cleanScope(inc.id, req.body?.scope);
    if (kind === 'guest' && !scope.channels.length && !scope.voiceRooms.length && !scope.sheets.length && !scope.notes.length) {
      throw new HttpError(400, 'Give the guest access to at least one channel, voice room, sheet or note');
    }
    const accessHours = ACCESS_HOURS.includes(Number(req.body?.accessHours)) ? Number(req.body.accessHours) : 12;
    const done = q.run(
      "UPDATE join_requests SET status = 'admitted', decided_by = ?, decided_at = ?, kind = ?, scope = ?, access_hours = ? WHERE id = ? AND status = 'pending'",
      user.id, now(), kind, JSON.stringify(scope), accessHours, r.id,
    );
    if (done.changes !== 1) throw new HttpError(409, 'Someone already answered that request');
    const { addTimeline } = await import('./api.js');
    addTimeline(inc.id, user.id, 'access', `${user.display_name} let ${who(r)} in as a ${kind === 'member' ? 'responder' : `guest (access for ${accessHours}h)`} from a request to join${r.note ? `: “${r.note}”` : ''}`);
    logAdminAction(user.id, null, 'join_request_admitted', `${r.name} <${maskEmail(r.email)}> as ${kind} → ${key(inc.number)}`);
    refreshIncident(inc.id);
    return { ok: true };
  }),
);

joinRequestsRouter.post(
  '/incidents/:id/join-requests/:requestId/deny',
  h(async (req) => {
    const { inc, r, user } = await pendingFor(req);
    const done = q.run("UPDATE join_requests SET status = 'denied', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'", user.id, now(), r.id);
    if (done.changes !== 1) throw new HttpError(409, 'Someone already answered that request');
    const { addTimeline } = await import('./api.js');
    addTimeline(inc.id, user.id, 'access', `${user.display_name} turned down a request to join from ${who(r)}`);
    logAdminAction(user.id, null, 'join_request_denied', `${r.name} <${maskEmail(r.email)}> → ${key(inc.number)}`);
    refreshIncident(inc.id);
    return { ok: true };
  }),
);
