import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { RoomServiceClient } from 'livekit-server-sdk';
import { config, smtpEnabled } from './config.js';
import { guestCodeMail, mailStatus, sendMail } from './mail.js';
import { newId, now, q, tx } from './db.js';
import { createUser, getUser, isAdmin, logAdminAction, toPublic, updateUser, type UserRow } from './users.js';
import { refreshIncident, resyncUserChannels, visibleChannelIds } from './realtime.js';

/**
 * Guests are people outside the identity provider (vendors, outside IR firms, counsel) who get a
 * single-use link into ONE war room. What they can see is an explicit allowlist chosen on the
 * invite: channels, voice rooms, sheets, notes, and whether they can read the timeline. Everything else
 * (other incidents, integrations, exports, structure changes) is denied.
 */
export interface GuestScope {
  channels: string[];
  voiceRooms: string[];
  sheets: string[];
  notes: string[];
  timeline: boolean;
}

const EMPTY: GuestScope = { channels: [], voiceRooms: [], sheets: [], notes: [], timeline: false };

export function parseScope(raw: string | null | undefined): GuestScope {
  try {
    const s = JSON.parse(raw || '{}');
    return {
      channels: Array.isArray(s.channels) ? s.channels.map(String) : [],
      voiceRooms: Array.isArray(s.voiceRooms) ? s.voiceRooms.map(String) : [],
      sheets: Array.isArray(s.sheets) ? s.sheets.map(String) : [],
      notes: Array.isArray(s.notes) ? s.notes.map(String) : [],
      timeline: s.timeline === true,
    };
  } catch {
    return { ...EMPTY };
  }
}

/** Keep only things that really belong to (or are shared into) this incident. */
function cleanScope(incidentId: string, raw: unknown): GuestScope {
  const s = parseScope(JSON.stringify(raw ?? {}));
  const channels = new Set(visibleChannelIds(incidentId));
  const ids = (sql: string) => new Set(q.all<{ id: string }>(sql, incidentId).map((r) => r.id));
  const rooms = ids('SELECT id FROM voice_rooms WHERE incident_id = ? AND archived = 0');
  const sheets = ids('SELECT id FROM sheets WHERE incident_id = ?');
  const notes = ids('SELECT id FROM notes WHERE incident_id = ?');
  return {
    channels: [...new Set(s.channels)].filter((c) => channels.has(c)),
    voiceRooms: [...new Set(s.voiceRooms)].filter((v) => rooms.has(v)),
    sheets: [...new Set(s.sheets)].filter((x) => sheets.has(x)),
    notes: [...new Set(s.notes)].filter((x) => notes.has(x)),
    timeline: s.timeline,
  };
}

export const isGuest = (u: UserRow | undefined | null) => Boolean(u?.is_guest);

/** Can this user see this thing inside this incident? Always true for members of the organization. */
export function canSee(user: UserRow, incidentId: string, kind: 'channel' | 'voice' | 'sheet' | 'note' | 'timeline', id = ''): boolean {
  if (!user.is_guest) return true;
  if (user.guest_incident_id !== incidentId) return false;
  const s = parseScope(user.guest_scope);
  if (kind === 'timeline') return s.timeline;
  if (kind === 'channel') return s.channels.includes(id) && visibleChannelIds(incidentId).includes(id);
  if (kind === 'voice') return s.voiceRooms.includes(id);
  if (kind === 'note') return s.notes.includes(id);
  return s.sheets.includes(id);
}

/** Is a guest session still good? (Expiry, revocation, and the incident still being open.) */
export function guestSessionValid(user: UserRow) {
  if (!user.is_guest) return true;
  if (!user.guest_expires_at || new Date(user.guest_expires_at).getTime() <= Date.now()) return false;
  const inc = q.get<{ status: string }>('SELECT status FROM incidents WHERE id = ?', user.guest_incident_id ?? '');
  return Boolean(inc && inc.status !== 'resolved');
}

// ---------- the guest gate: deny by default ----------

const lookup = {
  channelOf: (messageId: string) => q.get<{ channel_id: string }>('SELECT channel_id FROM messages WHERE id = ?', messageId)?.channel_id ?? '',
  roomIncident: (id: string) => q.get<{ incident_id: string }>('SELECT incident_id FROM voice_rooms WHERE id = ?', id)?.incident_id ?? '',
  noteIncident: (id: string) => q.get<{ incident_id: string }>('SELECT incident_id FROM notes WHERE id = ?', id)?.incident_id ?? '',
  sheetIncident: (id: string) => q.get<{ incident_id: string }>('SELECT incident_id FROM sheets WHERE id = ?', id)?.incident_id ?? '',
  timelineIncident: (id: string) => q.get<{ incident_id: string }>('SELECT incident_id FROM timeline WHERE id = ?', id)?.incident_id ?? '',
};

type Rule = [method: string, pattern: RegExp, check: (u: UserRow, inc: string, m: RegExpMatchArray) => boolean];
const ID = '([0-9a-f-]{36})';
const RULES: Rule[] = [
  ['GET', /^\/api\/me$/, () => true],
  ['GET', /^\/api\/meta$/, () => true],
  ['GET', /^\/api\/users$/, () => true],
  ['GET', /^\/api\/incidents$/, () => true],
  ['GET', new RegExp(`^/api/incidents/${ID}$`), (_u, inc, m) => m[1] === inc],
  ['GET', new RegExp(`^/api/incidents/${ID}/timeline$`), (u, inc, m) => m[1] === inc && canSee(u, inc, 'timeline')],
  ['POST', new RegExp(`^/api/incidents/${ID}/timeline$`), (u, inc, m) => m[1] === inc && canSee(u, inc, 'timeline')],
  ['DELETE', new RegExp(`^/api/timeline/${ID}$`), (u, inc, m) => lookup.timelineIncident(m[1]) === inc && canSee(u, inc, 'timeline')],
  ['PUT', new RegExp(`^/api/incidents/${ID}/members/${ID}/task$`), (u, inc, m) => m[1] === inc && m[2] === u.id],
  ['GET', new RegExp(`^/api/channels/${ID}/(messages|pins)$`), (u, inc, m) => canSee(u, inc, 'channel', m[1])],
  ['POST', new RegExp(`^/api/channels/${ID}/(messages|mentions/read)$`), (u, inc, m) => canSee(u, inc, 'channel', m[1])],
  ['PATCH', new RegExp(`^/api/messages/${ID}$`), (u, inc, m) => canSee(u, inc, 'channel', lookup.channelOf(m[1]))],
  ['POST', new RegExp(`^/api/voice-rooms/${ID}/token$`), (u, inc, m) => lookup.roomIncident(m[1]) === inc && canSee(u, inc, 'voice', m[1])],
  ['GET', new RegExp(`^/api/notes/${ID}$`), (u, inc, m) => lookup.noteIncident(m[1]) === inc && canSee(u, inc, 'note', m[1])],
  ['PUT', new RegExp(`^/api/notes/${ID}/body$`), (u, inc, m) => lookup.noteIncident(m[1]) === inc && canSee(u, inc, 'note', m[1])],
  ['GET', new RegExp(`^/api/sheets/${ID}$`), (u, inc, m) => lookup.sheetIncident(m[1]) === inc && canSee(u, inc, 'sheet', m[1])],
  ['PUT', new RegExp(`^/api/sheets/${ID}/cells$`), (u, inc, m) => lookup.sheetIncident(m[1]) === inc && canSee(u, inc, 'sheet', m[1])],
  ['POST', new RegExp(`^/api/sheets/${ID}/rows$`), (u, inc, m) => lookup.sheetIncident(m[1]) === inc && canSee(u, inc, 'sheet', m[1])],
  ['DELETE', new RegExp(`^/api/sheets/${ID}/rows/[^/]+$`), (u, inc, m) => lookup.sheetIncident(m[1]) === inc && canSee(u, inc, 'sheet', m[1])],
];

/** Whether a guest may make this request. Anything not listed is refused. */
export function guestAllowed(req: Request, user: UserRow) {
  const path = req.originalUrl.split('?')[0].replace(/\/+$/, '');
  const inc = user.guest_incident_id ?? '';
  for (const [method, re, check] of RULES) {
    if (method !== req.method) continue;
    const m = path.match(re);
    if (m) return check(user, inc, m);
  }
  return false;
}

// ---------- tokens ----------

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
const LINK_HOURS = [1, 4, 8, 24, 72];
const ACCESS_HOURS = [2, 4, 8, 12, 24, 72];

interface InviteRow {
  id: string;
  incident_id: string;
  token_hash: string;
  label: string;
  org: string;
  note: string;
  scope: string;
  access_hours: number;
  created_by: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  used_by: string | null;
  used_ip: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  email: string | null;
  code_hash: string | null;
  code_expires_at: string | null;
  code_attempts: number;
  code_sends: string;
}

function inviteStatus(inv: InviteRow) {
  if (inv.revoked_at) return 'revoked';
  if (inv.used_at) return 'used';
  if (new Date(inv.expires_at).getTime() <= Date.now()) return 'expired';
  const inc = q.get<{ status: string }>('SELECT status FROM incidents WHERE id = ?', inv.incident_id);
  if (!inc || inc.status === 'resolved') return 'closed';
  return 'ok';
}

function scopeSummary(incidentId: string, s: GuestScope) {
  const name = (sql: string, id: string) => q.get<{ name: string }>(sql, id)?.name;
  return {
    channels: s.channels.map((c) => ({ id: c, name: name('SELECT name FROM channels WHERE id = ?', c) ?? 'channel' })),
    voiceRooms: s.voiceRooms.map((v) => ({ id: v, name: name('SELECT name FROM voice_rooms WHERE id = ?', v) ?? 'voice room' })),
    sheets: s.sheets.map((x) => ({ id: x, name: name('SELECT name FROM sheets WHERE id = ?', x) ?? 'sheet' })),
    notes: s.notes.map((x) => ({ id: x, name: name('SELECT name FROM notes WHERE id = ?', x) ?? 'note' })),
    timeline: s.timeline,
    incidentId,
  };
}

// ---------- revoking ----------

const livekit = () => new RoomServiceClient(config.livekit.apiUrl, config.livekit.apiKey, config.livekit.apiSecret);

/** End a guest's access now: sign them out everywhere and drop them from voice. */
export async function revokeGuest(userId: string, actorId: string | null, reason: string) {
  const g = getUser(userId);
  if (!g?.is_guest || !g.active) return false;
  updateUser(g.id, { active: 0, guest_expires_at: now() }); // emits user:deactivated → sockets closed
  const rooms = q.all<{ id: string }>('SELECT id FROM voice_rooms WHERE incident_id = ?', g.guest_incident_id ?? '');
  await Promise.all(rooms.map((r) => livekit().removeParticipant(`warroom-${r.id}`, g.id).catch(() => undefined)));
  const { addTimeline } = await import('./api.js');
  if (g.guest_incident_id) {
    addTimeline(g.guest_incident_id, actorId, 'guest', `Guest access ended for ${g.display_name}${g.guest_org ? ` (${g.guest_org})` : ''}: ${reason}`);
    refreshIncident(g.guest_incident_id);
  }
  logAdminAction(actorId, g.id, 'guest_revoked', reason);
  return true;
}

/** Every minute: end guest access that has expired or whose incident was resolved. */
export function startGuestSweeper() {
  const sweep = async () => {
    const guests = q.all<UserRow>('SELECT * FROM users WHERE is_guest = 1 AND active = 1');
    for (const g of guests) {
      if (guestSessionValid(g)) continue;
      const expired = !g.guest_expires_at || new Date(g.guest_expires_at).getTime() <= Date.now();
      await revokeGuest(g.id, null, expired ? 'access period ended' : 'incident resolved');
    }
  };
  setInterval(() => void sweep().catch((e) => console.error('[guests] sweep failed', e)), 60_000).unref();
  void sweep();
}

// ---------- routes (organization members) ----------

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
      console.error('[guests]', err);
      res.status(500).json({ error: 'internal error' });
    }
  };
const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

async function requireControl(req: Request, incidentId: string) {
  const { canControl } = await import('./api.js');
  if (req.user!.is_guest || !canControl(req.user!, incidentId)) {
    throw new HttpError(403, 'Only the Incident Commander or a room admin can manage guests');
  }
  const inc = q.get<{ id: string; number: number; status: string; title: string }>('SELECT id, number, status, title FROM incidents WHERE id = ?', incidentId);
  if (!inc) throw new HttpError(404, 'incident not found');
  return inc;
}

export const guestsRouter = Router();

/** Create a single-use invite. The link is returned once; only its hash is stored. */
guestsRouter.post(
  '/incidents/:id/invites',
  h(async (req) => {
    const inc = await requireControl(req, req.params.id);
    if (inc.status === 'resolved') throw new HttpError(400, 'This incident is resolved');
    const label = str(req.body?.label, 80);
    if (!label) throw new HttpError(400, "Enter the guest's name");
    const linkHours = LINK_HOURS.includes(Number(req.body?.linkHours)) ? Number(req.body.linkHours) : 24;
    const accessHours = ACCESS_HOURS.includes(Number(req.body?.accessHours)) ? Number(req.body.accessHours) : 12;
    const scope = cleanScope(inc.id, req.body?.scope);
    if (!scope.channels.length && !scope.voiceRooms.length && !scope.sheets.length && !scope.notes.length) {
      throw new HttpError(400, 'Give the guest access to at least one channel, voice room, sheet or note');
    }
    const email = str(req.body?.email, 254).toLowerCase();
    if (email && !EMAIL_RE.test(email)) throw new HttpError(400, 'That email address doesn’t look right');
    if (!email && smtpEnabled() && config.guestRequireEmail) {
      throw new HttpError(400, "Enter the guest's email: they'll need a code sent there to join");
    }
    const token = randomBytes(32).toString('base64url');
    const id = newId();
    const ts = now();
    q.run(
      `INSERT INTO invites (id, incident_id, token_hash, label, org, note, scope, access_hours, created_by, created_at, expires_at, email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      inc.id,
      hashToken(token),
      label,
      str(req.body?.org, 80),
      str(req.body?.note, 300),
      JSON.stringify(scope),
      accessHours,
      req.user!.id,
      ts,
      new Date(Date.now() + linkHours * 3600_000).toISOString(),
      email || null,
    );
    const { addTimeline } = await import('./api.js');
    const org = str(req.body?.org, 80);
    addTimeline(
      inc.id,
      req.user!.id,
      'guest',
      `${req.user!.display_name} created a guest invite for ${label}${org ? ` (${org})` : ''}${email ? `, verified by email to ${maskEmail(email)}` : ''}, link valid ${linkHours}h`,
    );
    logAdminAction(req.user!.id, null, 'guest_invited', `${label}${org ? ` (${org})` : ''} → INC-${String(inc.number).padStart(4, '0')}`);
    refreshIncident(inc.id);
    return { id, url: `${config.publicUrl}/join/${token}`, expiresAt: new Date(Date.now() + linkHours * 3600_000).toISOString() };
  }),
);

guestsRouter.get(
  '/incidents/:id/invites',
  h(async (req) => {
    const inc = await requireControl(req, req.params.id);
    const rows = q.all<InviteRow>('SELECT * FROM invites WHERE incident_id = ? ORDER BY created_at DESC', inc.id);
    return {
      invites: rows.map((r) => ({
        id: r.id,
        label: r.label,
        org: r.org,
        note: r.note,
        status: inviteStatus(r),
        createdBy: r.created_by,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        accessHours: r.access_hours,
        usedAt: r.used_at,
        usedBy: r.used_by,
        revokedAt: r.revoked_at,
        revokedBy: r.revoked_by,
        email: r.email,
        scope: scopeSummary(inc.id, parseScope(r.scope)),
      })),
    };
  }),
);

/** Cancel an invite that hasn't been used yet. */
guestsRouter.delete(
  '/invites/:id',
  h(async (req) => {
    const inv = q.get<InviteRow>('SELECT * FROM invites WHERE id = ?', req.params.id);
    if (!inv) throw new HttpError(404, 'invite not found');
    await requireControl(req, inv.incident_id);
    if (inv.used_at) throw new HttpError(400, 'Already used; end the guest’s access instead');
    q.run('UPDATE invites SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL', now(), req.user!.id, inv.id);
    const { addTimeline } = await import('./api.js');
    addTimeline(inv.incident_id, req.user!.id, 'guest', `${req.user!.display_name} cancelled the guest invite for ${inv.label}`);
    refreshIncident(inv.incident_id);
    return { ok: true };
  }),
);

/** Change what a guest can see after they've joined. */
guestsRouter.put(
  '/incidents/:id/guests/:userId/scope',
  h(async (req) => {
    const inc = await requireControl(req, req.params.id);
    const g = getUser(req.params.userId);
    if (!g?.is_guest || g.guest_incident_id !== inc.id) throw new HttpError(404, 'guest not found');
    const scope = cleanScope(inc.id, req.body?.scope);
    updateUser(g.id, { guest_scope: JSON.stringify(scope) });
    const s = scopeSummary(inc.id, scope);
    const { addTimeline } = await import('./api.js');
    addTimeline(
      inc.id,
      req.user!.id,
      'guest',
      `${req.user!.display_name} changed ${g.display_name}'s guest access: ${[
        ...s.channels.map((c) => `#${c.name}`),
        ...s.voiceRooms.map((v) => v.name),
        ...s.sheets.map((x) => x.name),
        ...s.notes.map((x) => x.name),
        ...(s.timeline ? ['timeline'] : []),
      ].join(', ') || 'nothing'}`,
    );
    resyncUserChannels(g.id);
    refreshIncident(inc.id);
    return { ok: true };
  }),
);

guestsRouter.post(
  '/incidents/:id/guests/:userId/revoke',
  h(async (req) => {
    const inc = await requireControl(req, req.params.id);
    const g = getUser(req.params.userId);
    if (!g?.is_guest || g.guest_incident_id !== inc.id) throw new HttpError(404, 'guest not found');
    await revokeGuest(g.id, req.user!.id, `revoked by ${req.user!.display_name}`);
    return { ok: true };
  }),
);

/** Guests of an incident, for the people panel (scope included only for those who can manage it). */
export function guestsOf(incidentId: string, forUser: UserRow, manage: boolean) {
  return q
    .all<UserRow>('SELECT * FROM users WHERE is_guest = 1 AND guest_incident_id = ? ORDER BY created_at', incidentId)
    // Former guests stay listed (inactive) so names in chat and the record still resolve.
    .filter((g) => !forUser.is_guest || g.id === forUser.id)
    .map((g) => ({
      ...toPublic(g),
      invitedBy: g.invited_by,
      ...(manage || g.id === forUser.id ? { scope: scopeSummary(incidentId, parseScope(g.guest_scope)) } : {}),
    }));
}

// ---------- email codes ----------

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;
const CODE_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const SEND_GAP_S = 30;
const SENDS_PER_HOUR = 5;

/** d***@example.com: enough for the guest to recognize, not enough to harvest. */
export function maskEmail(e: string) {
  const [user, domain] = e.split('@');
  return `${user.slice(0, 1)}${'*'.repeat(Math.max(2, Math.min(user.length - 1, 6)))}@${domain}`;
}

const codeKey = createHash('sha256').update(`guest-code:${config.sessionSecret}`).digest();
const hashCode = (inviteId: string, code: string) => createHmac('sha256', codeKey).update(`${inviteId}:${code}`).digest('hex');

/** The guest this invite created, if they can still sign back in with it. */
function resumableGuest(inv: InviteRow) {
  if (!inv.used_by || !inv.email || inv.revoked_at) return null;
  const g = getUser(inv.used_by);
  return g && g.active && !g.deleted && guestSessionValid(g) ? g : null;
}

type CodeCheck = 'ok' | 'missing' | 'expired' | 'wrong' | 'locked';

/** Check a code; a right code is spent, a wrong one counts against the limit. */
function checkCode(inv: InviteRow, code: unknown): CodeCheck {
  const c = typeof code === 'string' ? code.replace(/\D/g, '') : '';
  if (!c) return 'missing';
  const row = q.get<InviteRow>('SELECT * FROM invites WHERE id = ?', inv.id)!;
  if (!row.code_hash || !row.code_expires_at || new Date(row.code_expires_at).getTime() <= Date.now()) return 'expired';
  if (row.code_attempts >= MAX_ATTEMPTS) return 'locked';
  const a = Buffer.from(hashCode(inv.id, c), 'hex');
  const b = Buffer.from(row.code_hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    q.run('UPDATE invites SET code_attempts = code_attempts + 1 WHERE id = ?', inv.id);
    return row.code_attempts + 1 >= MAX_ATTEMPTS ? 'locked' : 'wrong';
  }
  q.run('UPDATE invites SET code_hash = NULL, code_expires_at = NULL, code_attempts = 0 WHERE id = ?', inv.id);
  return 'ok';
}

const CODE_ERRORS: Record<Exclude<CodeCheck, 'ok'>, string> = {
  missing: 'Enter the code from the email',
  expired: 'That code has expired. Send a new one.',
  wrong: 'That code isn’t right. Check the newest email and try again.',
  locked: 'Too many wrong codes. Send a new code.',
};

// ---------- public: redeem a link ----------

export const inviteAuthRouter = Router();

function findInvite(token: string) {
  if (!/^[A-Za-z0-9_-]{30,60}$/.test(token)) return undefined;
  return q.get<InviteRow>('SELECT * FROM invites WHERE token_hash = ?', hashToken(token));
}

/** Look at a link without using it (mail scanners prefetch links; only the POSTs spend it). */
inviteAuthRouter.get('/auth/invite/:token', (req, res) => {
  const inv = findInvite(req.params.token);
  if (!inv) return res.status(404).json({ status: 'invalid' });
  const status = inviteStatus(inv);
  const resume = status === 'used' ? resumableGuest(inv) : null;
  if (status !== 'ok' && !resume) return res.json({ status });
  const inc = q.get<{ number: number; title: string; severity: string }>('SELECT number, title, severity FROM incidents WHERE id = ?', inv.incident_id)!;
  res.json({
    status: resume ? 'resume' : status,
    incidentKey: `INC-${String(inc.number).padStart(4, '0')}`,
    incidentTitle: inc.title,
    severity: inc.severity,
    label: resume ? resume.display_name : inv.label,
    org: inv.org,
    note: inv.note,
    invitedBy: getUser(inv.created_by)?.display_name ?? 'someone',
    accessHours: inv.access_hours,
    accessEndsAt: resume?.guest_expires_at ?? null,
    linkExpiresAt: inv.expires_at,
    requiresCode: Boolean(inv.email),
    email: inv.email ? maskEmail(inv.email) : null,
    devOutbox: Boolean(inv.email) && mailStatus().devOutbox,
    scope: scopeSummary(inv.incident_id, parseScope(resume ? resume.guest_scope : inv.scope)),
  });
});

/**
 * Email a fresh one-time code to the address on the invite. A new code replaces the old one.
 * Limited to one every 30 s and five an hour per invite.
 */
inviteAuthRouter.post('/auth/invite/:token/code', async (req, res) => {
  const inv = findInvite(req.params.token);
  if (!inv || !inv.email) return res.status(404).json({ error: 'This link is not valid' });
  const status = inviteStatus(inv);
  if (status !== 'ok' && !(status === 'used' && resumableGuest(inv))) {
    return res.status(410).json({ error: `This link can’t be used (${status})`, status });
  }
  const nowMs = Date.now();
  const sends = (JSON.parse(inv.code_sends || '[]') as string[]).filter((t) => nowMs - new Date(t).getTime() < 3600_000);
  const last = sends.length ? new Date(sends[sends.length - 1]).getTime() : 0;
  if (nowMs - last < SEND_GAP_S * 1000) {
    const wait = Math.ceil((SEND_GAP_S * 1000 - (nowMs - last)) / 1000);
    return res.status(429).json({ error: `Wait ${wait} seconds before sending another code`, retryAfter: wait });
  }
  if (sends.length >= SENDS_PER_HOUR) {
    return res.status(429).json({ error: 'Too many codes sent for this invite. Try again in an hour or ask for a new link.' });
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const inc = q.get<{ number: number }>('SELECT number FROM incidents WHERE id = ?', inv.incident_id)!;
  const incidentKey = `INC-${String(inc.number).padStart(4, '0')}`;
  try {
    await sendMail(guestCodeMail({ to: inv.email, code, incidentKey, invitedBy: getUser(inv.created_by)?.display_name ?? 'Someone', minutes: CODE_MINUTES }));
  } catch (err) {
    console.error('[guests] code email failed', err instanceof Error ? err.message : err);
    return res.status(502).json({ error: 'We couldn’t send the email right now. Try again in a minute, or tell the person who invited you.' });
  }
  q.run(
    'UPDATE invites SET code_hash = ?, code_expires_at = ?, code_attempts = 0, code_sends = ? WHERE id = ?',
    hashCode(inv.id, code),
    new Date(nowMs + CODE_MINUTES * 60_000).toISOString(),
    JSON.stringify([...sends, new Date(nowMs).toISOString()]),
    inv.id,
  );
  res.json({ sentTo: maskEmail(inv.email), expiresInMinutes: CODE_MINUTES, resendAfter: SEND_GAP_S });
});

/** Spend the link: exactly once, atomically (and only with a valid email code if the invite has an email). */
inviteAuthRouter.post('/auth/invite/:token/accept', async (req, res) => {
  const inv = findInvite(req.params.token);
  if (!inv) return res.status(404).json({ error: 'This link is not valid' });
  const status = inviteStatus(inv);
  if (status !== 'ok') return res.status(410).json({ error: `This link can’t be used (${status})`, status });
  if (inv.email) {
    const c = checkCode(inv, req.body?.code);
    if (c !== 'ok') return res.status(c === 'missing' ? 400 : 401).json({ error: CODE_ERRORS[c], code: c });
  }
  const displayName = str(req.body?.displayName, 80) || inv.label;
  const ts = now();
  const expiresAt = new Date(Date.now() + inv.access_hours * 3600_000).toISOString();
  let guest: UserRow | null = null;
  tx(() => {
    const r = q.run(
      `UPDATE invites SET used_at = ?, used_ip = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
      ts,
      req.ip ?? null,
      inv.id,
      ts,
    );
    if (r.changes !== 1) return;
    guest = createUser({ userName: `guest-${newId()}@guest.invalid`, displayName, title: inv.org || null, email: inv.email });
    q.run(
      `UPDATE users SET is_guest = 1, guest_incident_id = ?, guest_expires_at = ?, guest_org = ?, invited_by = ?, guest_scope = ? WHERE id = ?`,
      inv.incident_id,
      expiresAt,
      inv.org || null,
      inv.created_by,
      inv.scope,
      guest.id,
    );
    q.run('UPDATE invites SET used_by = ? WHERE id = ?', guest.id, inv.id);
    q.run('INSERT OR IGNORE INTO incident_members (incident_id, user_id, joined_at) VALUES (?, ?, ?)', inv.incident_id, guest.id, ts);
  });
  if (!guest) return res.status(410).json({ error: 'This link has already been used', status: 'used' });
  const g = getUser((guest as UserRow).id)!;
  const { addTimeline, systemNotice } = await import('./api.js');
  const { startGuestSession } = await import('./auth.js');
  const inviter = getUser(inv.created_by)?.display_name ?? 'someone';
  const who = `${g.display_name}${inv.org ? ` (${inv.org})` : ''}`;
  addTimeline(
    inv.incident_id,
    g.id,
    'guest',
    `${who} joined as a guest using an invite from ${inviter}${inv.email ? `, email verified (${maskEmail(inv.email)})` : ''}; access until ${expiresAt.slice(11, 16)} UTC`,
  );
  systemNotice(inv.incident_id, `**${who}** joined as a **guest** (invited by ${inviter}${inv.email ? ', email verified' : ''})`);
  logAdminAction(inv.created_by, g.id, 'guest_joined', who);
  await startGuestSession(res, g, inv.access_hours * 3600);
  refreshIncident(inv.incident_id);
  res.json({ incidentId: inv.incident_id });
});

/** Sign a guest back in (new device, cleared cookies) with the same link plus a fresh email code. */
inviteAuthRouter.post('/auth/invite/:token/resume', async (req, res) => {
  const inv = findInvite(req.params.token);
  const g = inv && inviteStatus(inv) === 'used' ? resumableGuest(inv) : null;
  if (!inv || !g) return res.status(410).json({ error: 'This guest access has ended' });
  const c = checkCode(inv, req.body?.code);
  if (c !== 'ok') return res.status(c === 'missing' ? 400 : 401).json({ error: CODE_ERRORS[c], code: c });
  const { addTimeline } = await import('./api.js');
  const { startGuestSession } = await import('./auth.js');
  addTimeline(inv.incident_id, g.id, 'guest', `${g.display_name} signed back in as a guest (email code to ${maskEmail(inv.email!)})`);
  const ttl = Math.max(60, Math.floor((new Date(g.guest_expires_at!).getTime() - Date.now()) / 1000));
  await startGuestSession(res, g, ttl);
  res.json({ incidentId: inv.incident_id });
});

/** Development without SMTP: read the codes that would have been emailed. */
inviteAuthRouter.get('/auth/dev-outbox', async (_req, res) => {
  if (!mailStatus().devOutbox || !config.devAuth) return res.status(404).json({ error: 'not available' });
  const { devOutbox } = await import('./mail.js');
  res.json({ messages: devOutbox.map(({ to, subject, at }) => ({ to, subject, at })) });
});

// ---------- admin: email settings ----------

guestsRouter.get('/admin/mail', (req, res) => {
  if (!isAdmin(req.user!)) return res.status(403).json({ error: 'admins only' });
  res.json(mailStatus());
});

guestsRouter.post('/admin/mail/test', async (req, res) => {
  if (!isAdmin(req.user!)) return res.status(403).json({ error: 'admins only' });
  const to = str(req.body?.to, 254).toLowerCase();
  if (!EMAIL_RE.test(to)) return res.status(400).json({ error: 'Enter a valid email address' });
  try {
    const r = await sendMail({
      to,
      subject: 'War Room test email',
      text: `This is a test from War Room, sent by ${req.user!.display_name}. Guest sign-in codes will arrive like this.`,
    });
    logAdminAction(req.user!.id, null, 'mail_test', to);
    res.json({ ok: true, dev: r.dev });
  } catch (err) {
    res.status(502).json({ error: `Sending failed: ${err instanceof Error ? err.message : String(err)}` });
  }
});
