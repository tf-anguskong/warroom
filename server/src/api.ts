import { Router, type Request, type Response } from 'express';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import { config } from './config.js';
import { newId, now, q, tx } from './db.js';
import { requireAuth } from './auth.js';
import {
  activeCounts,
  emitDashboard,
  emitToChannel,
  emitToIncident,
  broadcastPresence,
  emitToUser,
  presenceFor,
  joinIncidentToChannel,
  refreshIncident,
  removeIncidentFromChannel,
  visibleChannelIds,
} from './realtime.js';
import { ROLES, SEVERITIES, SHEET_TEMPLATES, STATUSES, type Column } from './templates.js';
import { adminGroupIds, adminSources, bus, getUser, isAdmin, logAdminAction, otherActiveAdmins, toPublic, updateUser, type UserRow } from './users.js';
import { mailStatus } from './mail.js';
import { mentionedUserIds, mentionsToText, resolveMentions } from './mentions.js';
import { canSee, guestsOf, signInCodeBlock } from './guests.js';
import { notesFor, notesForExport } from './notes.js';
import { attachmentsOf, attachToMessage, filesForExport, pendingUploads } from './files.js';
import { shiftsForExport, shiftsOf } from './shifts.js';
import { linkedProviders, providerLabel, ssoProviders } from './sso.js';

interface IncidentRow {
  id: string;
  number: number;
  title: string;
  summary: string;
  severity: string;
  status: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

interface ChannelRow {
  id: string;
  incident_id: string;
  name: string;
  topic: string;
  created_by: string | null;
  created_at: string;
  archived: number;
}

interface SheetRow {
  id: string;
  incident_id: string;
  name: string;
  columns: string;
  position: number;
}

interface MessageRow {
  id: string;
  channel_id: string;
  user_id: string | null;
  body: string;
  kind: string;
  pinned: number;
  created_at: string;
  edited_at: string | null;
  display_name?: string | null;
}

export const api = Router();
api.use(requireAuth);

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Wrap a handler so thrown HttpErrors become JSON responses. */
const h =
  (fn: (req: Request, res: Response) => unknown) =>
  async (req: Request, res: Response) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
      console.error('[api]', err);
      res.status(500).json({ error: 'internal error' });
    }
  };

const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const incidentKey = (n: number) => `INC-${String(n).padStart(4, '0')}`;

function mustIncident(id: string) {
  const inc = q.get<IncidentRow>('SELECT * FROM incidents WHERE id = ?', id);
  if (!inc) throw new HttpError(404, 'incident not found');
  return inc;
}
function mustChannel(id: string) {
  const ch = q.get<ChannelRow>('SELECT * FROM channels WHERE id = ?', id);
  if (!ch) throw new HttpError(404, 'channel not found');
  return ch;
}
function mustSheet(id: string) {
  const s = q.get<SheetRow>('SELECT * FROM sheets WHERE id = ?', id);
  if (!s) throw new HttpError(404, 'sheet not found');
  return s;
}

function serializeIncident(i: IncidentRow) {
  return {
    id: i.id,
    number: i.number,
    key: incidentKey(i.number),
    title: i.title,
    summary: i.summary,
    severity: i.severity,
    status: i.status,
    createdBy: i.created_by,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    resolvedAt: i.resolved_at,
  };
}

function serializeMessage(m: MessageRow) {
  return {
    id: m.id,
    channelId: m.channel_id,
    userId: m.user_id,
    displayName: m.display_name ?? (m.user_id ? getUser(m.user_id)?.display_name : null) ?? 'System',
    body: m.body,
    kind: m.kind,
    pinned: Boolean(m.pinned),
    mentions: m.kind === 'msg' ? mentionedUserIds(m.id) : [],
    // Names for every person token in the body, so mentions render even for people the viewer can't look up.
    mentionNames: Object.fromEntries(
      [...m.body.matchAll(/<@([0-9a-f-]{36})>/g)].map(([, id]) => [id, getUser(id)?.display_name ?? 'unknown']),
    ),
    createdAt: m.created_at,
    editedAt: m.edited_at,
    attachments: attachmentsOf(m.id),
  };
}

// ---------- timeline & system messages ----------

export function addTimeline(
  incidentId: string,
  userId: string | null,
  type: string,
  text: string,
  ref: Record<string, unknown> | null = null,
  ts = now(),
) {
  const id = newId();
  q.run(
    'INSERT INTO timeline (id, incident_id, ts, user_id, type, text, ref) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id,
    incidentId,
    ts,
    userId,
    type,
    text,
    ref ? JSON.stringify(ref) : null,
  );
  const entry = {
    id,
    incidentId,
    ts,
    userId,
    displayName: userId ? getUser(userId)?.display_name ?? null : null,
    type,
    text,
    ref,
  };
  emitToIncident(incidentId, 'timeline:new', entry);
  return entry;
}

/**
 * Post a message. For people's messages, `incidentId` is the war room it was sent from; it decides
 * who `@here` and role mentions reach (a shared channel can be open in several war rooms).
 */
export function postMessage(channelId: string, userId: string | null, body: string, kind = 'msg', incidentId?: string, attachments: string[] = []) {
  const id = newId();
  q.run(
    'INSERT INTO messages (id, channel_id, user_id, body, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    channelId,
    userId,
    body,
    kind,
    now(),
  );
  if (kind === 'msg' && userId) recordMentions(id, channelId, userId, body, incidentId);
  if (attachments.length && userId) attachToMessage(id, channelId, userId, attachments);
  const msg = serializeMessage(q.get<MessageRow>('SELECT * FROM messages WHERE id = ?', id)!);
  emitToChannel(channelId, 'message:new', msg);
  return msg;
}

/** Post a system notice to an incident's primary channel. */
export function systemNotice(incidentId: string, body: string) {
  const ch = q.get<{ id: string }>(
    'SELECT id FROM channels WHERE incident_id = ? AND archived = 0 ORDER BY created_at LIMIT 1',
    incidentId,
  );
  if (ch) postMessage(ch.id, null, body, 'system');
}


// ---------- mentions ----------

function recordMentions(messageId: string, channelId: string, authorId: string, body: string, fromIncident?: string) {
  const ch = q.get<ChannelRow>('SELECT * FROM channels WHERE id = ?', channelId);
  if (!ch) return;
  const incidentId = fromIncident && visibleChannelIds(fromIncident).includes(channelId) ? fromIncident : ch.incident_id;
  const targets = resolveMentions(body, incidentId).filter((u) => {
    const row = u !== authorId ? getUser(u) : undefined;
    return Boolean(row && canSee(row, incidentId, 'channel', channelId));
  });
  if (!targets.length) return;
  const inc = q.get<IncidentRow>('SELECT * FROM incidents WHERE id = ?', incidentId)!;
  const author = getUser(authorId);
  const preview = mentionsToText(body).replace(/```[\s\S]*?```/g, '[code]').replace(/\s+/g, ' ').slice(0, 140);
  for (const userId of targets) {
    q.run('INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?, ?)', messageId, userId);
    emitToUser(userId, 'mention', {
      messageId,
      channelId,
      channelName: ch.name,
      incidentId,
      incidentKey: incidentKey(inc.number),
      by: author?.display_name ?? 'Someone',
      preview,
    });
  }
}

/** Unread mentions for a user, per channel, among the given channels. */
function unreadMentions(userId: string, channelIds: string[]): Record<string, number> {
  if (!channelIds.length) return {};
  const rows = q.all<{ channel_id: string; n: number }>(
    `SELECT m.channel_id, COUNT(*) AS n FROM message_mentions mm JOIN messages m ON m.id = mm.message_id
     WHERE mm.user_id = ? AND mm.read_at IS NULL AND m.channel_id IN (${channelIds.map(() => '?').join(',')})
     GROUP BY m.channel_id`,
    userId,
    ...channelIds,
  );
  return Object.fromEntries(rows.map((r) => [r.channel_id, r.n]));
}

// ---------- war room control ----------

const roomAdminIds = (incidentId: string) =>
  q
    .all<{ user_id: string }>('SELECT user_id FROM incident_room_admins WHERE incident_id = ? ORDER BY granted_at', incidentId)
    .map((r) => r.user_id);

export const commanderOf = (incidentId: string) => commanderId(incidentId);
const commanderId = (incidentId: string) =>
  q.get<{ user_id: string }>("SELECT user_id FROM incident_roles WHERE incident_id = ? AND role = 'commander'", incidentId)?.user_id ?? null;

/**
 * Who runs the room: the Incident Commander, room admins, and app admins. If nobody holds either
 * (IC unassigned, no room admins), anyone in the room can act so the room is never locked.
 */
export function canControl(user: UserRow, incidentId: string) {
  if (user.is_guest) return false;
  if (isAdmin(user)) return true;
  const ic = commanderId(incidentId);
  const admins = roomAdminIds(incidentId);
  if (user.id === ic || admins.includes(user.id)) return true;
  return !ic && admins.length === 0;
}

function requireControl(req: Request, incidentId: string, what: string) {
  if (!canControl(req.user!, incidentId)) {
    throw new HttpError(403, `Only the Incident Commander or a room admin can ${what}`);
  }
}

const livekit = () => new RoomServiceClient(config.livekit.apiUrl, config.livekit.apiKey, config.livekit.apiSecret);

/** Where someone is in voice right now, if anywhere, for this incident. */
function voiceTarget(incidentId: string, userId: string) {
  const p = presenceFor(incidentId).find((x) => x.userId === userId);
  const room = p?.voiceRoomId
    ? q.get<{ id: string; name: string }>('SELECT id, name FROM voice_rooms WHERE id = ? AND incident_id = ?', p.voiceRoomId, incidentId)
    : undefined;
  return { present: Boolean(p), room };
}

function markMember(incidentId: string, user: UserRow) {
  const r = q.run(
    'INSERT OR IGNORE INTO incident_members (incident_id, user_id, joined_at) VALUES (?, ?, ?)',
    incidentId,
    user.id,
    now(),
  );
  if (r.changes) {
    addTimeline(incidentId, user.id, 'joined', `${user.display_name} joined the war room`);
    // So everyone already in the room sees the new member (roles, roster, assignments) without reloading.
    refreshIncident(incidentId);
  }
}

// ---------- incidents ----------

api.get(
  '/meta',
  h(() => {
    const m = mailStatus();
    return {
      roles: ROLES,
      severities: SEVERITIES,
      statuses: STATUSES,
      templates: SHEET_TEMPLATES,
      guestEmail: { enabled: m.configured || m.devOutbox, required: m.requireEmail, dev: m.devOutbox },
      /** 'now' = temporary quick War Room: export before teardown, invite responders by email. */
      mode: config.mode,
    };
  }),
);

api.get(
  '/users',
  h((req) => {
    const me = req.user!;
    const all = q.all<UserRow>('SELECT * FROM users WHERE active = 1 AND deleted = 0 ORDER BY display_name');
    if (!me.is_guest) return { users: all.map(toPublic) };
    // Guests see only the people in their war room, not the organization's directory.
    const inc = me.guest_incident_id!;
    const ids = new Set<string>([
      me.id,
      ...q.all<{ user_id: string }>('SELECT user_id FROM incident_members WHERE incident_id = ?', inc).map((r) => r.user_id),
      ...q.all<{ user_id: string }>('SELECT user_id FROM incident_roles WHERE incident_id = ?', inc).map((r) => r.user_id),
      ...q.all<{ user_id: string }>('SELECT user_id FROM assignments WHERE incident_id = ?', inc).map((r) => r.user_id),
    ]);
    return { users: all.filter((u) => ids.has(u.id)).map(toPublic) };
  }),
);

api.get(
  '/incidents',
  h((req) => {
    const filter = str(req.query.filter) || 'active';
    const where =
      filter === 'resolved' ? "WHERE status = 'resolved'" : filter === 'all' ? '' : "WHERE status <> 'resolved'";
    const rows = q
      .all<IncidentRow>(
        `SELECT * FROM incidents ${where} ORDER BY CASE WHEN status = 'resolved' THEN 1 ELSE 0 END, severity, created_at DESC`,
      )
      .filter((i) => !req.user!.is_guest || i.id === req.user!.guest_incident_id);
    const counts = activeCounts();
    return {
      incidents: rows.map((i) => {
        const ic = q.get<{ user_id: string }>(
          "SELECT user_id FROM incident_roles WHERE incident_id = ? AND role = 'commander'",
          i.id,
        );
        return {
          ...serializeIncident(i),
          commander: ic ? getUser(ic.user_id)?.display_name ?? null : null,
          members: q.get<{ n: number }>('SELECT COUNT(*) AS n FROM incident_members WHERE incident_id = ?', i.id)!.n,
          present: counts[i.id]?.present ?? 0,
          inVoice: counts[i.id]?.inVoice ?? 0,
          mentions: Object.values(unreadMentions(req.user!.id, visibleChannelIds(i.id))).reduce((a, b) => a + b, 0),
        };
      }),
    };
  }),
);

export function createSheet(incidentId: string, userId: string, templateKey: string, name?: string) {
  const tpl = SHEET_TEMPLATES.find((t) => t.key === templateKey) ?? SHEET_TEMPLATES.find((t) => t.key === 'blank')!;
  const id = newId();
  const columns: Column[] = tpl.columns.map((c) => ({ ...c, id: newId().slice(0, 8) }));
  const position =
    (q.get<{ p: number | null }>('SELECT MAX(position) AS p FROM sheets WHERE incident_id = ?', incidentId)?.p ?? -1) + 1;
  const ts = now();
  q.run(
    'INSERT INTO sheets (id, incident_id, name, columns, position, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id,
    incidentId,
    name || tpl.name,
    JSON.stringify(columns),
    position,
    userId,
    ts,
  );
  for (let i = 0; i < (tpl.rows ?? 20); i++) {
    q.run(
      'INSERT INTO sheet_rows (id, sheet_id, position, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
      newId(),
      id,
      i + 1,
      userId,
      ts,
    );
  }
  return id;
}

function createVoiceRoom(incidentId: string, userId: string, name: string, kind: 'main' | 'breakout') {
  const id = newId();
  q.run(
    'INSERT INTO voice_rooms (id, incident_id, name, kind, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    incidentId,
    name,
    kind,
    userId,
    now(),
  );
  return id;
}

export function createChannel(incidentId: string, userId: string, name: string, topic: string, voiceRoomIds: string[]) {
  const id = newId();
  q.run(
    'INSERT INTO channels (id, incident_id, name, topic, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    incidentId,
    name,
    topic,
    userId,
    now(),
  );
  for (const vr of voiceRoomIds) {
    q.run('INSERT OR IGNORE INTO channel_voice_links (channel_id, voice_room_id) VALUES (?, ?)', id, vr);
  }
  return id;
}

const channelName = (s: string) =>
  s
    .toLowerCase()
    .replace(/^#/, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

api.post(
  '/incidents',
  h((req) => {
    const user = req.user!;
    const title = str(req.body?.title, 200);
    if (!title) throw new HttpError(400, 'title required');
    const severity = SEVERITIES.includes(req.body?.severity) ? req.body.severity : 'SEV3';
    const summary = str(req.body?.summary, 4000);
    const templates: string[] = Array.isArray(req.body?.templates) ? req.body.templates.map(String) : ['actions'];

    const id = newId();
    const number = tx(() => {
      const n = (q.get<{ n: number | null }>('SELECT MAX(number) AS n FROM incidents')?.n ?? 0) + 1;
      const ts = now();
      q.run(
        `INSERT INTO incidents (id, number, title, summary, severity, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'investigating', ?, ?, ?)`,
        id,
        n,
        title,
        summary,
        severity,
        user.id,
        ts,
        ts,
      );
      q.run(
        "INSERT INTO incident_roles (incident_id, role, user_id, assigned_at) VALUES (?, 'commander', ?, ?)",
        id,
        user.id,
        ts,
      );
      q.run('INSERT INTO incident_members (incident_id, user_id, joined_at) VALUES (?, ?, ?)', id, user.id, ts);
      const main = createVoiceRoom(id, user.id, 'Main Bridge', 'main');
      createChannel(id, user.id, 'general', 'Main incident discussion', [main]);
      createChannel(id, user.id, 'decisions', 'Decisions and approvals only', [main]);
      for (const t of templates) createSheet(id, user.id, t);
      return n;
    });
    addTimeline(id, user.id, 'declared', `${incidentKey(number)} declared at ${severity}: ${title}`);
    addTimeline(id, user.id, 'role', `${user.display_name} is Incident Commander`);
    emitDashboard();
    bus.emit("incident:declared", { incidentId: id, userId: user.id });
    return { id, key: incidentKey(number) };
  }),
);

api.get(
  '/incidents/:id',
  h((req) => {
    const inc = mustIncident(req.params.id);
    const viewer = req.user!;
    markMember(inc.id, viewer);
    const voiceRoomsAll = q.all<{ id: string; name: string; kind: string; objective: string; objective_by: string | null; objective_at: string | null }>(
      "SELECT id, name, kind, objective, objective_by, objective_at FROM voice_rooms WHERE incident_id = ? AND archived = 0 ORDER BY kind = 'main' DESC, created_at",
      inc.id,
    );
    const voiceRooms = voiceRoomsAll.filter((v) => canSee(viewer, inc.id, 'voice', v.id));
    const channelIds = visibleChannelIds(inc.id).filter((c) => canSee(viewer, inc.id, 'channel', c));
    const channels = channelIds
      .map((cid) => mustChannel(cid))
      .filter((c) => !c.archived)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((c) => {
        const owner = c.incident_id === inc.id ? inc : mustIncident(c.incident_id);
        return {
          id: c.id,
          name: c.name,
          topic: c.topic,
          incidentId: c.incident_id,
          incidentKey: incidentKey(owner.number),
          shared: c.incident_id !== inc.id,
          voiceRoomIds: q
            .all<{ voice_room_id: string }>('SELECT voice_room_id FROM channel_voice_links WHERE channel_id = ?', c.id)
            .map((r) => r.voice_room_id),
          sharedWith: q
            .all<{ incident_id: string; number: number; title: string }>(
              `SELECT s.incident_id, i.number, i.title FROM channel_shares s JOIN incidents i ON i.id = s.incident_id
               WHERE s.channel_id = ?`,
              c.id,
            )
            .map((r) => ({ incidentId: r.incident_id, key: incidentKey(r.number), title: r.title })),
        };
      });
    const sheets = q
      .all<SheetRow>('SELECT id, name, position FROM sheets WHERE incident_id = ? ORDER BY position', inc.id)
      .filter((s) => canSee(viewer, inc.id, 'sheet', s.id))
      .map((s) => ({ id: s.id, name: s.name }));
    const manageGuests = canControl(viewer, inc.id);
    const roles = q
      .all<{ role: string; user_id: string }>('SELECT role, user_id FROM incident_roles WHERE incident_id = ?', inc.id)
      .map((r) => ({ role: r.role, userId: r.user_id }));
    return {
      incident: serializeIncident(inc),
      roles,
      roomAdmins: roomAdminIds(inc.id),
      canControl: canControl(req.user!, inc.id),
      unreadMentions: unreadMentions(req.user!.id, channels.map((c) => c.id)),
      assignments: q
        .all<{ target_kind: string; target_id: string; user_id: string; lead: number; assigned_by: string | null; assigned_at: string }>(
          'SELECT * FROM assignments WHERE incident_id = ? ORDER BY assigned_at',
          inc.id,
        )
        .filter((a) => (a.target_kind === 'voice' ? voiceRooms.some((v) => v.id === a.target_id) : channels.some((c) => c.id === a.target_id)))
        .map((a) => ({
          targetKind: a.target_kind,
          targetId: a.target_id,
          userId: a.user_id,
          lead: Boolean(a.lead),
          assignedBy: a.assigned_by,
          assignedAt: a.assigned_at,
        })),
      members: q
        .all<{
          user_id: string;
          joined_at: string;
          task: string;
          task_by: string | null;
          task_at: string | null;
          away_since: string | null;
          away_until: string | null;
          away_note: string;
        }>(
          'SELECT user_id, joined_at, task, task_by, task_at, away_since, away_until, away_note FROM incident_members WHERE incident_id = ? ORDER BY joined_at',
          inc.id,
        )
        // Guests don't see what everyone else is working on, only their own task.
        .map((m) => (viewer.is_guest && m.user_id !== viewer.id ? { ...m, task: '', task_by: null, task_at: null } : m))
        .map((m) => ({
          userId: m.user_id,
          joinedAt: m.joined_at,
          task: m.task,
          taskBy: m.task_by,
          taskAt: m.task_at,
          away: m.away_since ? { since: m.away_since, until: m.away_until, note: m.away_note } : null,
          // For whoever runs the room: can they give this person a new sign-in code? (null = yes, else why not)
          ...(manageGuests
            ? {
                codeBlock:
                  inc.status === 'resolved'
                    ? 'This incident is resolved'
                    : (() => {
                        const t = getUser(m.user_id);
                        return t ? signInCodeBlock(viewer, inc.id, t, commanderId(inc.id)) : 'Account not found';
                      })(),
              }
            : {}),
        })),
      guests: guestsOf(inc.id, viewer, manageGuests),
      // Pending asks for command: everyone in the room can see who asked (it's on the timeline anyway).
      commandRequests: viewer.is_guest
        ? []
        : q
            .all<{ user_id: string; note: string; requested_at: string }>('SELECT user_id, note, requested_at FROM command_requests WHERE incident_id = ? ORDER BY requested_at', inc.id)
            .map((r) => ({ userId: r.user_id, note: r.note, requestedAt: r.requested_at })),
      canSeeTimeline: canSee(viewer, inc.id, 'timeline'),
      voiceRooms: voiceRooms.map(({ objective_by, objective_at, ...v }) => ({
        ...v,
        objectiveBy: objective_by,
        objectiveAt: objective_at,
        channelIds: channels.filter((c) => c.voiceRoomIds.includes(v.id)).map((c) => c.id),
      })),
      channels,
      sheets,
      notes: notesFor(viewer, inc.id),
      // Guests don't see the team's schedule.
      shifts: viewer.is_guest ? [] : shiftsOf(inc.id),
    };
  }),
);

const STATUS_LABEL: Record<string, string> = {
  investigating: 'Investigating',
  identified: 'Identified',
  mitigating: 'Mitigating',
  monitoring: 'Monitoring',
  resolved: 'Resolved',
};

api.patch(
  '/incidents/:id',
  h((req) => {
    const inc = mustIncident(req.params.id);
    const user = req.user!;
    const b = req.body ?? {};
    const changes: string[] = [];
    if (typeof b.title === 'string' && str(b.title, 200) && str(b.title, 200) !== inc.title) {
      q.run('UPDATE incidents SET title = ? WHERE id = ?', str(b.title, 200), inc.id);
      addTimeline(inc.id, user.id, 'summary', `Title changed to “${str(b.title, 200)}”`);
      changes.push('title');
    }
    if (typeof b.summary === 'string' && b.summary !== inc.summary) {
      q.run('UPDATE incidents SET summary = ? WHERE id = ?', str(b.summary, 4000), inc.id);
      addTimeline(inc.id, user.id, 'summary', 'Incident summary updated');
      changes.push('summary');
    }
    if (
      (SEVERITIES.includes(b.severity) && b.severity !== inc.severity) ||
      (STATUSES.includes(b.status) && b.status !== inc.status)
    ) {
      requireControl(req, inc.id, 'change severity or status');
    }
    if (SEVERITIES.includes(b.severity) && b.severity !== inc.severity) {
      q.run('UPDATE incidents SET severity = ? WHERE id = ?', b.severity, inc.id);
      const dir = b.severity < inc.severity ? 'raised' : 'lowered';
      addTimeline(inc.id, user.id, 'severity', `Severity ${dir} from ${inc.severity} to ${b.severity}`);
      systemNotice(inc.id, `${user.display_name} ${dir} severity to **${b.severity}**`);
      changes.push('severity');
    }
    if (STATUSES.includes(b.status) && b.status !== inc.status) {
      q.run('UPDATE incidents SET status = ?, resolved_at = ? WHERE id = ?', b.status, b.status === 'resolved' ? now() : null, inc.id);
      addTimeline(inc.id, user.id, 'status', `Status: ${STATUS_LABEL[inc.status]} → ${STATUS_LABEL[b.status]}`);
      systemNotice(inc.id, `${user.display_name} set status to **${STATUS_LABEL[b.status]}**`);
      changes.push('status');
    }
    if (changes.length) {
      q.run('UPDATE incidents SET updated_at = ? WHERE id = ?', now(), inc.id);
      refreshIncident(inc.id);
      emitDashboard();
    }
    return { ok: true, changes };
  }),
);

api.put(
  '/incidents/:id/roles/:role',
  h((req) => {
    const inc = mustIncident(req.params.id);
    const role = ROLES.find((r) => r.key === req.params.role);
    if (!role) throw new HttpError(400, 'unknown role');
    // Command: the IC, room admins and admins can give it to anyone. Anyone else can step into an
    // empty seat, but otherwise has to ask (POST /incidents/:id/command/request).
    if (role.key === 'commander') {
      const actor = req.user!;
      if (actor.is_guest) throw new HttpError(403, 'Guests can’t take or assign Incident Command');
      const takingEmptySeat = !commanderId(inc.id) && String(req.body?.userId ?? '') === actor.id;
      if (!canControl(actor, inc.id) && !takingEmptySeat) {
        throw new HttpError(403, 'Only the Incident Commander, a room admin or an admin can hand over command. Use “Request command” to ask for it.');
      }
      return handOffCommand(req, inc);
    }
    requireControl(req, inc.id, 'assign roles');
    const userId = req.body?.userId ? String(req.body.userId) : null;
    if (userId) {
      const target = getUser(userId);
      if (!target || !target.active) throw new HttpError(400, 'unknown user');
      q.run(
        `INSERT INTO incident_roles (incident_id, role, user_id, assigned_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (incident_id, role) DO UPDATE SET user_id = excluded.user_id, assigned_at = excluded.assigned_at`,
        inc.id,
        role.key,
        userId,
        now(),
      );
      addTimeline(inc.id, req.user!.id, 'role', `${target.display_name} assigned as ${role.label}`);
      systemNotice(inc.id, `${target.display_name} is now **${role.label}**`);
    } else {
      q.run('DELETE FROM incident_roles WHERE incident_id = ? AND role = ?', inc.id, role.key);
      addTimeline(inc.id, req.user!.id, 'role', `${role.label} unassigned`);
    }
    refreshIncident(inc.id);
    emitDashboard();
    return { ok: true };
  }),
);


function handOffCommand(req: Request, inc: IncidentRow) {
  const actor = req.user!;
  const toId = req.body?.userId ? String(req.body.userId) : null;
  const note = str(req.body?.note, 300);
  const prevId = commanderId(inc.id);
  if (toId === prevId) return { ok: true };
  const to = toId ? getUser(toId) : null;
  if (toId && (!to || !to.active || to.deleted)) throw new HttpError(400, 'unknown user');
  if (to?.is_guest) throw new HttpError(400, 'A guest can’t be Incident Commander');
  const prev = prevId ? getUser(prevId) : null;
  if (to) {
    q.run(
      `INSERT INTO incident_roles (incident_id, role, user_id, assigned_at) VALUES (?, 'commander', ?, ?)
       ON CONFLICT (incident_id, role) DO UPDATE SET user_id = excluded.user_id, assigned_at = excluded.assigned_at`,
      inc.id,
      to.id,
      now(),
    );
  } else {
    q.run("DELETE FROM incident_roles WHERE incident_id = ? AND role = 'commander'", inc.id);
  }
  const by = actor.id === to?.id ? `${actor.display_name} took command` : `by ${actor.display_name}`;
  const text = to
    ? `Incident Command ${prev ? `handed from ${prev.display_name} to ${to.display_name}` : `assigned to ${to.display_name}`} (${by})`
    : `Incident Command released by ${actor.display_name}${prev ? ` (was ${prev.display_name})` : ''}`;
  addTimeline(inc.id, actor.id, 'role', note ? `${text}. Handoff note: ${note}` : text);
  // Whoever asked has their answer now.
  q.run('DELETE FROM command_requests WHERE incident_id = ?', inc.id);
  systemNotice(inc.id, to ? `🎖 **${to.display_name}** is now **Incident Commander**${prev ? ` (from ${prev.display_name})` : ''}${note ? ` — ${note}` : ''}` : `Incident Command is **unassigned**`);
  for (const u of [to?.id, prev?.id]) {
    if (u && u !== actor.id) {
      emitToUser(u, 'command:changed', { incidentId: inc.id, to: to?.display_name ?? null, from: prev?.display_name ?? null, by: actor.display_name, you: u === to?.id, note });
    }
  }
  refreshIncident(inc.id);
  emitDashboard();
  return { ok: true };
}

/** Ask the current Incident Commander for command. They (and room admins) are notified. */
api.post(
  '/incidents/:id/command/request',
  h((req) => {
    const inc = mustIncident(req.params.id);
    const user = req.user!;
    if (user.is_guest) throw new HttpError(403, 'Guests can’t be Incident Commander');
    const ic = commanderId(inc.id);
    if (!ic) throw new HttpError(400, 'Nobody is Incident Commander yet; you can take command directly.');
    if (ic === user.id) throw new HttpError(400, 'You’re already the Incident Commander.');
    const prev = q.get<{ requested_at: string }>('SELECT requested_at FROM command_requests WHERE incident_id = ? AND user_id = ?', inc.id, user.id);
    if (prev && Date.now() - new Date(prev.requested_at).getTime() < 60_000) throw new HttpError(429, 'You asked less than a minute ago. Give them a moment.');
    const note = str(req.body?.note, 300);
    q.run(
      `INSERT INTO command_requests (incident_id, user_id, note, requested_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (incident_id, user_id) DO UPDATE SET note = excluded.note, requested_at = excluded.requested_at`,
      inc.id, user.id, note, now(),
    );
    addTimeline(inc.id, user.id, 'role', `${user.display_name} asked for Incident Command${note ? `: ${note}` : ''}`);
    for (const id of new Set([ic, ...roomAdminIds(inc.id)])) {
      if (id !== user.id) emitToUser(id, 'command:requested', { incidentId: inc.id, userId: user.id, by: user.display_name, note });
    }
    refreshIncident(inc.id);
    return { ok: true };
  }),
);

/** Turn down a request for command (IC, room admins, admins). */
api.post(
  '/incidents/:id/command/decline',
  h((req) => {
    const inc = mustIncident(req.params.id);
    requireControl(req, inc.id, 'answer requests for command');
    const userId = str(req.body?.userId, 40);
    const r = q.run('DELETE FROM command_requests WHERE incident_id = ? AND user_id = ?', inc.id, userId);
    if (!r.changes) return { ok: true };
    const who = getUser(userId);
    const note = str(req.body?.note, 300);
    addTimeline(inc.id, req.user!.id, 'role', `${req.user!.display_name} declined ${who?.display_name ?? 'a'}’s request for Incident Command${note ? `: ${note}` : ''}`);
    emitToUser(userId, 'command:declined', { incidentId: inc.id, by: req.user!.display_name, note });
    refreshIncident(inc.id);
    return { ok: true };
  }),
);

// ---------- voice rooms ----------

api.post(
  '/incidents/:id/voice-rooms',
  h((req) => {
    const inc = mustIncident(req.params.id);
    const name = str(req.body?.name, 60);
    if (!name) throw new HttpError(400, 'name required');
    const id = createVoiceRoom(inc.id, req.user!.id, name, 'breakout');
    if (req.body?.withChannel !== false) {
      createChannel(inc.id, req.user!.id, channelName(name) || 'breakout', `Breakout: ${name}`, [id]);
    }
    addTimeline(inc.id, req.user!.id, 'voice', `Breakout room “${name}” opened`);
    refreshIncident(inc.id);
    return { id };
  }),
);

api.patch(
  '/voice-rooms/:id',
  h((req) => {
    const vr = q.get<{ id: string; incident_id: string; name: string; kind: string }>(
      'SELECT * FROM voice_rooms WHERE id = ?',
      req.params.id,
    );
    if (!vr) throw new HttpError(404, 'voice room not found');
    if (typeof req.body?.name === 'string' && str(req.body.name, 60)) {
      q.run('UPDATE voice_rooms SET name = ? WHERE id = ?', str(req.body.name, 60), vr.id);
    }
    if (req.body?.archived === true) {
      requireControl(req, vr.incident_id, 'close breakout rooms');
      if (vr.kind === 'main') throw new HttpError(400, 'cannot close the main bridge');
      q.run('UPDATE voice_rooms SET archived = 1 WHERE id = ?', vr.id);
      addTimeline(vr.incident_id, req.user!.id, 'voice', `Breakout room “${vr.name}” closed`);
    }
    refreshIncident(vr.incident_id);
    return { ok: true };
  }),
);

api.post(
  '/voice-rooms/:id/token',
  h(async (req) => {
    const vr = q.get<{ id: string; incident_id: string; name: string }>(
      'SELECT * FROM voice_rooms WHERE id = ? AND archived = 0',
      req.params.id,
    );
    if (!vr) throw new HttpError(404, 'voice room not found');
    const user = req.user!;
    const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
      identity: user.id,
      name: user.display_name,
      ttl: user.is_guest && user.guest_expires_at
        ? Math.max(60, Math.floor((new Date(user.guest_expires_at).getTime() - Date.now()) / 1000))
        : '6h',
      metadata: JSON.stringify({ incidentId: vr.incident_id, guest: Boolean(user.is_guest) }),
    });
    at.addGrant({
      room: `warroom-${vr.id}`,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    return { url: config.livekit.url, token: await at.toJwt(), roomName: vr.name };
  }),
);

/** IC can call everyone back to a room (e.g. the main bridge). */
api.post(
  '/voice-rooms/:id/summon',
  h((req) => {
    const vr = q.get<{ id: string; incident_id: string; name: string }>('SELECT * FROM voice_rooms WHERE id = ?', req.params.id);
    if (!vr) throw new HttpError(404, 'voice room not found');
    requireControl(req, vr.incident_id, 'call everyone to a room');
    emitToIncident(vr.incident_id, 'voice:summon', {
      voiceRoomId: vr.id,
      name: vr.name,
      by: req.user!.display_name,
    });
    addTimeline(vr.incident_id, req.user!.id, 'voice', `${req.user!.display_name} called everyone to ${vr.name}`);
    return { ok: true };
  }),
);


/** Grant or revoke room admin for this incident. */
api.put(
  '/incidents/:id/room-admins/:userId',
  h((req) => {
    const inc = mustIncident(req.params.id);
    requireControl(req, inc.id, 'manage room admins');
    const target = getUser(req.params.userId);
    if (!target || !target.active || target.deleted) throw new HttpError(400, 'unknown user');
    if (req.body?.admin !== false) {
      const r = q.run(
        'INSERT OR IGNORE INTO incident_room_admins (incident_id, user_id, granted_by, granted_at) VALUES (?, ?, ?, ?)',
        inc.id,
        target.id,
        req.user!.id,
        now(),
      );
      if (r.changes) {
        addTimeline(inc.id, req.user!.id, 'role', `${target.display_name} made a room admin`);
        systemNotice(inc.id, `${target.display_name} is now a **room admin**`);
      }
    } else {
      const r = q.run('DELETE FROM incident_room_admins WHERE incident_id = ? AND user_id = ?', inc.id, target.id);
      if (r.changes) addTimeline(inc.id, req.user!.id, 'role', `${target.display_name} is no longer a room admin`);
    }
    refreshIncident(inc.id);
    return { ok: true };
  }),
);

/** Move someone to a voice room. If they aren't in voice, they get an invitation instead. */
api.post(
  '/incidents/:id/voice/move',
  h((req) => {
    const inc = mustIncident(req.params.id);
    requireControl(req, inc.id, 'move people between voice rooms');
    const userId = str(req.body?.userId);
    const to = q.get<{ id: string; name: string }>(
      'SELECT id, name FROM voice_rooms WHERE id = ? AND incident_id = ? AND archived = 0',
      str(req.body?.voiceRoomId),
      inc.id,
    );
    if (!to) throw new HttpError(404, 'voice room not found');
    const target = getUser(userId);
    if (!target) throw new HttpError(404, 'user not found');
    const where = voiceTarget(inc.id, userId);
    if (!where.present) throw new HttpError(409, `${target.display_name} isn't in the war room right now`);
    if (!canSee(target, inc.id, 'voice', to.id)) {
      throw new HttpError(400, `${target.display_name} is a guest without access to ${to.name}; change their guest access first`);
    }
    if (where.room?.id === to.id) return { ok: true, moved: false, invited: false };
    emitToUser(userId, 'voice:moved', {
      incidentId: inc.id,
      voiceRoomId: to.id,
      name: to.name,
      by: req.user!.display_name,
      invite: !where.room,
    });
    return { ok: true, moved: Boolean(where.room), invited: !where.room };
  }),
);

/** Mute someone's microphone (they can unmute themselves) or remove them from voice. */
api.post(
  '/incidents/:id/voice/:action(mute|remove)',
  h(async (req) => {
    const inc = mustIncident(req.params.id);
    const action = req.params.action as 'mute' | 'remove';
    requireControl(req, inc.id, action === 'mute' ? 'mute people' : 'remove people from voice');
    const userId = str(req.body?.userId);
    const target = getUser(userId);
    if (!target) throw new HttpError(404, 'user not found');
    const { room } = voiceTarget(inc.id, userId);
    if (!room) throw new HttpError(409, `${target.display_name} isn't in voice`);
    const lkRoom = `warroom-${room.id}`;
    try {
      if (action === 'remove') {
        await livekit().removeParticipant(lkRoom, userId);
      } else {
        const info = await livekit().getParticipant(lkRoom, userId);
        const mic = info.tracks.find((t) => t.source === TrackSource.MICROPHONE && !t.muted);
        if (!mic) return { ok: true, alreadyMuted: true };
        await livekit().mutePublishedTrack(lkRoom, userId, mic.sid, true);
      }
    } catch (err) {
      console.error(`[voice] ${action} failed`, err);
      throw new HttpError(502, `Couldn't reach the voice server to ${action} ${target.display_name}`);
    }
    emitToUser(userId, action === 'mute' ? 'voice:muted' : 'voice:removed', {
      incidentId: inc.id,
      name: room.name,
      by: req.user!.display_name,
    });
    if (action === 'remove') {
      addTimeline(inc.id, req.user!.id, 'voice', `${target.display_name} was removed from ${room.name}`);
    }
    return { ok: true };
  }),
);


// ---------- assignments: who is on which voice room / channel, and what they're working on ----------

type TargetKind = 'voice' | 'channel';

function assignmentTarget(incidentId: string, kind: unknown, id: unknown) {
  if (kind === 'voice') {
    const vr = q.get<{ id: string; name: string; objective: string }>(
      'SELECT id, name, objective FROM voice_rooms WHERE id = ? AND incident_id = ? AND archived = 0',
      String(id),
      incidentId,
    );
    if (vr) return { kind: 'voice' as TargetKind, id: vr.id, label: vr.name, objective: vr.objective };
  }
  if (kind === 'channel' && visibleChannelIds(incidentId).includes(String(id))) {
    const ch = mustChannel(String(id));
    if (!ch.archived) return { kind: 'channel' as TargetKind, id: ch.id, label: `#${ch.name}`, objective: null };
  }
  throw new HttpError(404, 'voice room or channel not found in this war room');
}

/** Channel to announce an assignment in: the channel itself, or the voice room's first linked channel. */
function announceChannel(incidentId: string, kind: TargetKind, id: string) {
  if (kind === 'channel') return id;
  return (
    q.get<{ channel_id: string }>(
      `SELECT l.channel_id FROM channel_voice_links l JOIN channels c ON c.id = l.channel_id
       WHERE l.voice_room_id = ? AND c.archived = 0 ORDER BY c.created_at LIMIT 1`,
      id,
    )?.channel_id ?? null
  );
}

/**
 * Set who is assigned to a voice room or channel (the full list), who leads it, and for voice
 * rooms the objective. Every change lands on the timeline with who made it.
 */
api.put(
  '/incidents/:id/assignments',
  h((req) => {
    const inc = mustIncident(req.params.id);
    requireControl(req, inc.id, 'assign people');
    const target = assignmentTarget(inc.id, req.body?.targetKind, req.body?.targetId);
    const actor = req.user!;
    const wanted = [...new Set<string>((Array.isArray(req.body?.userIds) ? req.body.userIds : []).map(String))];
    for (const u of wanted) {
      const row = getUser(u);
      if (!row || !row.active || row.deleted) throw new HttpError(400, 'unknown user');
    }
    for (const u of wanted) {
      const row = getUser(u)!;
      if (!canSee(row, inc.id, target.kind, target.id)) {
        throw new HttpError(400, `${row.display_name} is a guest without access to ${target.label}; change their guest access first`);
      }
    }
    const leadId = req.body?.leadId && wanted.includes(String(req.body.leadId)) ? String(req.body.leadId) : null;
    const before = q.all<{ user_id: string; lead: number }>(
      'SELECT user_id, lead FROM assignments WHERE incident_id = ? AND target_kind = ? AND target_id = ?',
      inc.id,
      target.kind,
      target.id,
    );
    const prevIds = before.map((b) => b.user_id);
    const prevLead = before.find((b) => b.lead)?.user_id ?? null;
    const added = wanted.filter((u) => !prevIds.includes(u));
    const removed = prevIds.filter((u) => !wanted.includes(u));
    const ts = now();
    const name = (u: string) => getUser(u)?.display_name ?? 'someone';

    tx(() => {
      for (const u of removed) {
        q.run('DELETE FROM assignments WHERE incident_id = ? AND target_kind = ? AND target_id = ? AND user_id = ?', inc.id, target.kind, target.id, u);
      }
      for (const u of wanted) {
        q.run(
          `INSERT INTO assignments (incident_id, target_kind, target_id, user_id, lead, assigned_by, assigned_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (incident_id, target_kind, target_id, user_id) DO UPDATE SET lead = excluded.lead`,
          inc.id,
          target.kind,
          target.id,
          u,
          u === leadId ? 1 : 0,
          actor.id,
          ts,
        );
      }
    });

    const notes: string[] = [];
    if (added.length) notes.push(`assigned ${added.map(name).join(', ')} to ${target.label}`);
    if (removed.length) notes.push(`took ${removed.map(name).join(', ')} off ${target.label}`);
    if (leadId !== prevLead) notes.push(leadId ? `made ${name(leadId)} lead of ${target.label}` : `cleared the lead of ${target.label}`);

    if (target.kind === 'voice' && typeof req.body?.objective === 'string') {
      const objective = str(req.body.objective, 300);
      if (objective !== target.objective) {
        q.run('UPDATE voice_rooms SET objective = ?, objective_by = ?, objective_at = ? WHERE id = ?', objective, actor.id, ts, target.id);
        notes.push(objective ? `set the objective of ${target.label}: “${objective}”` : `cleared the objective of ${target.label}`);
      }
    }

    if (notes.length) {
      const text = `${actor.display_name} ${notes.join('; ')}`;
      addTimeline(inc.id, actor.id, 'assign', text, { targetKind: target.kind, targetId: target.id });
      const ch = announceChannel(inc.id, target.kind, target.id);
      if (ch) postMessage(ch, null, text.replace(actor.display_name, `**${actor.display_name}**`), 'system');
    }
    for (const u of new Set([...added, ...(leadId && leadId !== prevLead ? [leadId] : [])])) {
      if (u === actor.id) continue;
      emitToUser(u, 'assigned', {
        incidentId: inc.id,
        incidentKey: incidentKey(inc.number),
        targetKind: target.kind,
        targetId: target.id,
        label: target.label,
        lead: u === leadId,
        by: actor.display_name,
      });
    }
    refreshIncident(inc.id);
    return { ok: true, added, removed, leadId };
  }),
);

/** What someone is working on right now. You can set your own; the IC and room admins can set anyone's. */
api.put(
  '/incidents/:id/members/:userId/task',
  h((req) => {
    const inc = mustIncident(req.params.id);
    const actor = req.user!;
    const target = getUser(req.params.userId);
    if (!target || target.deleted) throw new HttpError(404, 'user not found');
    if (target.id !== actor.id) requireControl(req, inc.id, "set other people's tasks");
    const task = str(req.body?.task, 300);
    const ts = now();
    q.run(
      `INSERT INTO incident_members (incident_id, user_id, joined_at, task, task_by, task_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (incident_id, user_id) DO UPDATE SET task = excluded.task, task_by = excluded.task_by, task_at = excluded.task_at`,
      inc.id,
      target.id,
      ts,
      task,
      actor.id,
      ts,
    );
    const by = target.id === actor.id ? '' : ` (set by ${actor.display_name})`;
    addTimeline(inc.id, actor.id, 'task', task ? `${target.display_name} is working on: ${task}${by}` : `${target.display_name} has no current task${by}`);
    if (target.id !== actor.id) {
      emitToUser(target.id, 'task:set', { incidentId: inc.id, task, by: actor.display_name });
    }
    refreshIncident(inc.id);
    return { ok: true };
  }),
);

/**
 * Away from keyboard: mark yourself away (optionally with a note and when you'll be back), or back.
 * Body: { away: true, note?, minutes? } or { away: false }.
 */
api.put(
  '/incidents/:id/away',
  h((req) => {
    const inc = mustIncident(req.params.id);
    const user = req.user!;
    const ts = now();
    if (req.body?.away) {
      const note = str(req.body?.note, 120);
      const minutes = Number(req.body?.minutes);
      const until = Number.isFinite(minutes) && minutes > 0 && minutes <= 24 * 60 ? new Date(Date.now() + minutes * 60_000).toISOString() : null;
      q.run(
        `INSERT INTO incident_members (incident_id, user_id, joined_at, away_since, away_until, away_note) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (incident_id, user_id) DO UPDATE SET away_since = excluded.away_since, away_until = excluded.away_until, away_note = excluded.away_note`,
        inc.id, user.id, ts, ts, until, note,
      );
    } else {
      q.run('UPDATE incident_members SET away_since = NULL, away_until = NULL, away_note = \'\' WHERE incident_id = ? AND user_id = ?', inc.id, user.id);
    }
    broadcastPresence(inc.id);
    refreshIncident(inc.id);
    return { ok: true };
  }),
);

// ---------- channels ----------

api.post(
  '/incidents/:id/channels',
  h((req) => {
    const inc = mustIncident(req.params.id);
    const name = channelName(str(req.body?.name, 60));
    if (!name) throw new HttpError(400, 'name required');
    const voiceRoomIds: string[] = (Array.isArray(req.body?.voiceRoomIds) ? req.body.voiceRoomIds : [])
      .map(String)
      .filter((v: string) => q.get('SELECT 1 FROM voice_rooms WHERE id = ? AND incident_id = ?', v, inc.id));
    const id = createChannel(inc.id, req.user!.id, name, str(req.body?.topic, 200), voiceRoomIds);
    joinIncidentToChannel(inc.id, id);
    addTimeline(inc.id, req.user!.id, 'channel', `Channel #${name} created`);
    refreshIncident(inc.id);
    return { id };
  }),
);

api.patch(
  '/channels/:id',
  h((req) => {
    const ch = mustChannel(req.params.id);
    if (typeof req.body?.name === 'string' && channelName(req.body.name)) {
      q.run('UPDATE channels SET name = ? WHERE id = ?', channelName(req.body.name), ch.id);
    }
    if (typeof req.body?.topic === 'string') q.run('UPDATE channels SET topic = ? WHERE id = ?', str(req.body.topic, 200), ch.id);
    if (req.body?.archived === true) q.run('UPDATE channels SET archived = 1 WHERE id = ?', ch.id);
    refreshIncident(ch.incident_id);
    for (const s of q.all<{ incident_id: string }>('SELECT incident_id FROM channel_shares WHERE channel_id = ?', ch.id)) {
      refreshIncident(s.incident_id);
    }
    return { ok: true };
  }),
);

/** Attach a channel to a set of voice rooms in the incident it is viewed from. */
api.put(
  '/channels/:id/voice-links',
  h((req) => {
    const ch = mustChannel(req.params.id);
    const incidentId = str(req.body?.incidentId) || ch.incident_id;
    const ids: string[] = (Array.isArray(req.body?.voiceRoomIds) ? req.body.voiceRoomIds : []).map(String);
    tx(() => {
      q.run(
        'DELETE FROM channel_voice_links WHERE channel_id = ? AND voice_room_id IN (SELECT id FROM voice_rooms WHERE incident_id = ?)',
        ch.id,
        incidentId,
      );
      for (const v of ids) {
        if (q.get('SELECT 1 FROM voice_rooms WHERE id = ? AND incident_id = ?', v, incidentId)) {
          q.run('INSERT OR IGNORE INTO channel_voice_links (channel_id, voice_room_id) VALUES (?, ?)', ch.id, v);
        }
      }
    });
    refreshIncident(incidentId);
    return { ok: true };
  }),
);

api.post(
  '/channels/:id/shares',
  h((req) => {
    const ch = mustChannel(req.params.id);
    const target = mustIncident(String(req.body?.incidentId ?? ''));
    if (target.id === ch.incident_id) throw new HttpError(400, 'channel already belongs to that incident');
    const owner = mustIncident(ch.incident_id);
    q.run(
      'INSERT OR IGNORE INTO channel_shares (channel_id, incident_id, shared_by, shared_at) VALUES (?, ?, ?, ?)',
      ch.id,
      target.id,
      req.user!.id,
      now(),
    );
    joinIncidentToChannel(target.id, ch.id);
    addTimeline(owner.id, req.user!.id, 'channel', `#${ch.name} shared with ${incidentKey(target.number)}`);
    addTimeline(target.id, req.user!.id, 'channel', `#${ch.name} shared in from ${incidentKey(owner.number)}`);
    postMessage(ch.id, null, `${req.user!.display_name} shared this channel with ${incidentKey(target.number)} — ${target.title}`, 'system');
    refreshIncident(owner.id);
    refreshIncident(target.id);
    return { ok: true };
  }),
);

api.delete(
  '/channels/:id/shares/:incidentId',
  h((req) => {
    const ch = mustChannel(req.params.id);
    q.run('DELETE FROM channel_shares WHERE channel_id = ? AND incident_id = ?', ch.id, req.params.incidentId);
    q.run(
      'DELETE FROM channel_voice_links WHERE channel_id = ? AND voice_room_id IN (SELECT id FROM voice_rooms WHERE incident_id = ?)',
      ch.id,
      req.params.incidentId,
    );
    removeIncidentFromChannel(req.params.incidentId, ch.id);
    refreshIncident(ch.incident_id);
    refreshIncident(req.params.incidentId);
    return { ok: true };
  }),
);

api.get(
  '/channels/:id/messages',
  h((req) => {
    const ch = mustChannel(req.params.id);
    const before = str(req.query.before);
    const limit = Math.min(200, Number(req.query.limit ?? 100) || 100);
    const rows = q.all<MessageRow>(
      `SELECT m.*, u.display_name FROM messages m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.channel_id = ? ${before ? 'AND m.created_at < ?' : ''}
       ORDER BY m.created_at DESC LIMIT ?`,
      ...(before ? [ch.id, before, limit] : [ch.id, limit]),
    );
    return { messages: rows.reverse().map(serializeMessage), hasMore: rows.length === limit };
  }),
);

api.get(
  '/channels/:id/pins',
  h((req) => {
    const ch = mustChannel(req.params.id);
    const rows = q.all<MessageRow>(
      `SELECT m.*, u.display_name FROM messages m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.channel_id = ? AND m.pinned = 1 ORDER BY m.created_at`,
      ch.id,
    );
    return { messages: rows.map(serializeMessage) };
  }),
);

api.post(
  '/channels/:id/messages',
  h((req) => {
    const ch = mustChannel(req.params.id);
    const body = str(req.body?.body, 20000);
    const wanted = Array.isArray(req.body?.attachments) ? req.body.attachments.map(String).slice(0, 10) : [];
    const attachments = pendingUploads(ch.id, req.user!.id, wanted);
    if (wanted.length && attachments.length !== wanted.length) throw new HttpError(400, 'an attachment is missing or already sent; upload it again');
    if (!body && !attachments.length) throw new HttpError(400, 'empty message');
    return { message: postMessage(ch.id, req.user!.id, body, 'msg', str(req.body?.incidentId) || undefined, attachments) };
  }),
);

/** Mark my mentions in a channel as read (called when I open it). */
api.post(
  '/channels/:id/mentions/read',
  h((req) => {
    const ch = mustChannel(req.params.id);
    q.run(
      `UPDATE message_mentions SET read_at = ? WHERE user_id = ? AND read_at IS NULL
       AND message_id IN (SELECT id FROM messages WHERE channel_id = ?)`,
      now(),
      req.user!.id,
      ch.id,
    );
    return { ok: true };
  }),
);

api.patch(
  '/messages/:id',
  h((req) => {
    const m = q.get<MessageRow>('SELECT * FROM messages WHERE id = ?', req.params.id);
    if (!m) throw new HttpError(404, 'message not found');
    const ch = mustChannel(m.channel_id);
    if (typeof req.body?.body === 'string') {
      if (m.user_id !== req.user!.id) throw new HttpError(403, 'can only edit your own messages');
      q.run('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?', str(req.body.body, 20000), now(), m.id);
    }
    if (typeof req.body?.pinned === 'boolean') {
      q.run('UPDATE messages SET pinned = ? WHERE id = ?', req.body.pinned ? 1 : 0, m.id);
      if (req.body.pinned) {
        const incidentId = str(req.body.incidentId) || ch.incident_id;
        addTimeline(incidentId, req.user!.id, 'pin', mentionsToText(m.body).slice(0, 500), { messageId: m.id, channelId: ch.id });
      }
    }
    const updated = serializeMessage(
      q.get<MessageRow>('SELECT m.*, u.display_name FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ?', m.id)!,
    );
    emitToChannel(ch.id, 'message:updated', updated);
    return { message: updated };
  }),
);

// ---------- timeline ----------

const HUMAN_TYPES = ['note', 'decision', 'action', 'finding'];

api.get(
  '/incidents/:id/timeline',
  h((req) => {
    const inc = mustIncident(req.params.id);
    const rows = q.all<{ id: string; ts: string; user_id: string | null; type: string; text: string; ref: string | null; display_name: string | null }>(
      `SELECT t.*, u.display_name FROM timeline t LEFT JOIN users u ON u.id = t.user_id
       WHERE t.incident_id = ? ORDER BY t.ts`,
      inc.id,
    );
    return {
      entries: rows.map((r) => ({
        id: r.id,
        incidentId: inc.id,
        ts: r.ts,
        userId: r.user_id,
        displayName: r.display_name,
        type: r.type,
        text: r.text,
        ref: r.ref ? JSON.parse(r.ref) : null,
      })),
    };
  }),
);

api.post(
  '/incidents/:id/timeline',
  h((req) => {
    const inc = mustIncident(req.params.id);
    const type = HUMAN_TYPES.includes(req.body?.type) ? req.body.type : 'note';
    const text = str(req.body?.text, 4000);
    if (!text) throw new HttpError(400, 'text required');
    let ts = now();
    if (req.body?.ts) {
      const d = new Date(String(req.body.ts));
      if (Number.isNaN(d.getTime())) throw new HttpError(400, 'invalid timestamp');
      ts = d.toISOString();
    }
    const ref = req.body?.messageId ? { messageId: String(req.body.messageId), channelId: str(req.body.channelId) } : null;
    return { entry: addTimeline(inc.id, req.user!.id, type, text, ref, ts) };
  }),
);

api.delete(
  '/timeline/:id',
  h((req) => {
    const t = q.get<{ id: string; incident_id: string; user_id: string | null; type: string }>('SELECT * FROM timeline WHERE id = ?', req.params.id);
    if (!t) throw new HttpError(404, 'entry not found');
    if (!HUMAN_TYPES.includes(t.type) && t.type !== 'pin') throw new HttpError(400, 'system entries cannot be removed');
    if (t.user_id !== req.user!.id && !isAdmin(req.user!)) throw new HttpError(403, 'not your entry');
    q.run('DELETE FROM timeline WHERE id = ?', t.id);
    emitToIncident(t.incident_id, 'timeline:deleted', { id: t.id });
    return { ok: true };
  }),
);

api.get(
  '/incidents/:id/export.md',
  h((req, res) => {
    const inc = mustIncident(req.params.id);
    const key = incidentKey(inc.number);
    const lines: string[] = [];
    lines.push(`# ${key}: ${inc.title}`, '');
    lines.push(`- **Severity:** ${inc.severity}`);
    lines.push(`- **Status:** ${STATUS_LABEL[inc.status] ?? inc.status}`);
    lines.push(`- **Declared:** ${inc.created_at.replace('T', ' ').slice(0, 19)} UTC`);
    if (inc.resolved_at) lines.push(`- **Resolved:** ${inc.resolved_at.replace('T', ' ').slice(0, 19)} UTC`);
    lines.push('');
    if (inc.summary) lines.push('## Summary', '', inc.summary, '');
    lines.push('## Roles', '');
    for (const r of ROLES) {
      const row = q.get<{ user_id: string }>('SELECT user_id FROM incident_roles WHERE incident_id = ? AND role = ?', inc.id, r.key);
      lines.push(`- **${r.label}:** ${row ? getUser(row.user_id)?.display_name ?? '—' : '_unassigned_'}`);
    }
    const members = q.all<{ display_name: string }>(
      'SELECT u.display_name FROM incident_members m JOIN users u ON u.id = m.user_id WHERE m.incident_id = ? ORDER BY m.joined_at',
      inc.id,
    );
    lines.push('', `**Participants (${members.length}):** ${members.map((m) => m.display_name).join(', ')}`, '');
    const asg = q.all<{ target_kind: string; target_id: string; user_id: string; lead: number }>(
      'SELECT target_kind, target_id, user_id, lead FROM assignments WHERE incident_id = ? ORDER BY lead DESC, assigned_at',
      inc.id,
    );
    if (asg.length) {
      lines.push('## Who did what', '', '| Workstream | Lead | Assigned | Objective |', '|---|---|---|---|');
      const targets = [...new Map(asg.map((a) => [`${a.target_kind}:${a.target_id}`, a])).values()];
      for (const t of targets) {
        const label =
          t.target_kind === 'voice'
            ? q.get<{ name: string }>('SELECT name FROM voice_rooms WHERE id = ?', t.target_id)?.name ?? 'voice room'
            : `#${q.get<{ name: string }>('SELECT name FROM channels WHERE id = ?', t.target_id)?.name ?? 'channel'}`;
        const objective =
          t.target_kind === 'voice' ? q.get<{ objective: string }>('SELECT objective FROM voice_rooms WHERE id = ?', t.target_id)?.objective ?? '' : '';
        const mine = asg.filter((a) => a.target_kind === t.target_kind && a.target_id === t.target_id);
        const nm = (id: string) => getUser(id)?.display_name ?? 'unknown';
        lines.push(
          `| ${label} | ${mine.filter((a) => a.lead).map((a) => nm(a.user_id)).join(', ') || '—'} | ${mine.map((a) => nm(a.user_id)).join(', ')} | ${objective.replace(/\|/g, '\\|')} |`,
        );
      }
      lines.push('');
    }
    lines.push('## Timeline (UTC)', '', '| Time | Type | Entry | By |', '|---|---|---|---|');
    const rows = q.all<{ ts: string; type: string; text: string; display_name: string | null }>(
      'SELECT t.ts, t.type, t.text, u.display_name FROM timeline t LEFT JOIN users u ON u.id = t.user_id WHERE t.incident_id = ? ORDER BY t.ts',
      inc.id,
    );
    const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
    for (const r of rows) {
      lines.push(`| ${r.ts.replace("T", " ").slice(0, 19)} | ${r.type} | ${cell(mentionsToText(r.text))} | ${r.display_name ?? ''} |`);
    }
    const pins = q.all<MessageRow>(
      `SELECT m.*, u.display_name FROM messages m LEFT JOIN users u ON u.id = m.user_id
       JOIN channels c ON c.id = m.channel_id WHERE c.incident_id = ? AND m.pinned = 1 ORDER BY m.created_at`,
      inc.id,
    );
    const noteLines = notesForExport(inc.id);
    if (noteLines.length) lines.push('', ...noteLines);
    const shiftLines = shiftsForExport(inc.id);
    if (shiftLines.length) lines.push('', ...shiftLines);
    const fileLines = filesForExport(inc.id);
    if (fileLines.length) lines.push('', ...fileLines);
    if (pins.length) {
      lines.push('', '## Pinned messages', '');
      for (const p of pins) {
        lines.push(`> **${p.display_name ?? 'System'}** (${p.created_at.slice(0, 19).replace('T', ' ')} UTC)`, '>');
        lines.push(...mentionsToText(p.body).split('\n').map((l) => `> ${l}`), '');
      }
    }
    res
      .type('text/markdown')
      .setHeader('Content-Disposition', `attachment; filename="${key}-postmortem.md"`)
      .send(lines.join('\n') + '\n');
  }),
);

// ---------- sheets ----------

const parseColumns = (s: SheetRow) => JSON.parse(s.columns) as Column[];

function saveColumns(sheetId: string, cols: Column[]) {
  q.run('UPDATE sheets SET columns = ? WHERE id = ?', JSON.stringify(cols), sheetId);
}

const COLUMN_TYPES = ['text', 'number', 'select', 'date', 'person', 'checkbox'];

function sanitizeColumn(input: any, existing?: Column): Column {
  const col: Column = existing ? { ...existing } : { id: newId().slice(0, 8), name: 'Column', type: 'text' };
  if (typeof input?.name === 'string' && input.name.trim()) col.name = input.name.trim().slice(0, 80);
  if (COLUMN_TYPES.includes(input?.type)) col.type = input.type;
  if (typeof input?.width === 'number') col.width = Math.max(60, Math.min(800, Math.round(input.width)));
  if (Array.isArray(input?.options)) {
    col.options = input.options
      .filter((o: any) => o && typeof o.value === 'string' && o.value.trim())
      .slice(0, 50)
      .map((o: any) => ({ value: o.value.trim().slice(0, 60), color: str(o.color, 20) || 'gray' }));
  }
  if (col.type === 'select' && !col.options) col.options = [];
  return col;
}

export const sheetRefresh = (s: SheetRow) => emitToIncident(s.incident_id, 'sheet:refresh', { sheetId: s.id });

api.post(
  '/incidents/:id/sheets',
  h((req) => {
    const inc = mustIncident(req.params.id);
    const id = createSheet(inc.id, req.user!.id, str(req.body?.template) || 'blank', str(req.body?.name, 80));
    const s = mustSheet(id);
    addTimeline(inc.id, req.user!.id, 'sheet', `Sheet “${s.name}” created`);
    refreshIncident(inc.id);
    return { id };
  }),
);

api.get(
  '/sheets/:id',
  h((req) => {
    const s = mustSheet(req.params.id);
    return {
      sheet: { id: s.id, incidentId: s.incident_id, name: s.name, columns: parseColumns(s) },
      rows: q.all<{ id: string; position: number }>('SELECT id, position FROM sheet_rows WHERE sheet_id = ? ORDER BY position', s.id),
      cells: q
        .all<{ row_id: string; col_id: string; value: string; updated_by: string | null; updated_at: string }>(
          'SELECT row_id, col_id, value, updated_by, updated_at FROM sheet_cells WHERE sheet_id = ?',
          s.id,
        )
        .map((c) => ({ rowId: c.row_id, colId: c.col_id, value: c.value, updatedBy: c.updated_by, updatedAt: c.updated_at })),
    };
  }),
);

api.patch(
  '/sheets/:id',
  h((req) => {
    const s = mustSheet(req.params.id);
    const name = str(req.body?.name, 80);
    if (name) q.run('UPDATE sheets SET name = ? WHERE id = ?', name, s.id);
    refreshIncident(s.incident_id);
    sheetRefresh(s);
    return { ok: true };
  }),
);

api.delete(
  '/sheets/:id',
  h((req) => {
    const s = mustSheet(req.params.id);
    q.run('DELETE FROM sheets WHERE id = ?', s.id);
    addTimeline(s.incident_id, req.user!.id, 'sheet', `Sheet “${s.name}” deleted`);
    refreshIncident(s.incident_id);
    return { ok: true };
  }),
);

api.post(
  '/sheets/:id/columns',
  h((req) => {
    const s = mustSheet(req.params.id);
    const cols = parseColumns(s);
    const col = sanitizeColumn(req.body);
    const after = str(req.body?.afterColId);
    const idx = after ? cols.findIndex((c) => c.id === after) : -1;
    if (idx >= 0) cols.splice(idx + 1, 0, col);
    else cols.push(col);
    saveColumns(s.id, cols);
    sheetRefresh(s);
    return { column: col };
  }),
);

api.patch(
  '/sheets/:id/columns/:colId',
  h((req) => {
    const s = mustSheet(req.params.id);
    const cols = parseColumns(s);
    const i = cols.findIndex((c) => c.id === req.params.colId);
    if (i < 0) throw new HttpError(404, 'column not found');
    cols[i] = sanitizeColumn(req.body, cols[i]);
    if (typeof req.body?.moveTo === 'number') {
      const [c] = cols.splice(i, 1);
      cols.splice(Math.max(0, Math.min(cols.length, req.body.moveTo)), 0, c);
    }
    saveColumns(s.id, cols);
    sheetRefresh(s);
    return { ok: true };
  }),
);

api.delete(
  '/sheets/:id/columns/:colId',
  h((req) => {
    const s = mustSheet(req.params.id);
    const cols = parseColumns(s).filter((c) => c.id !== req.params.colId);
    tx(() => {
      saveColumns(s.id, cols);
      q.run('DELETE FROM sheet_cells WHERE sheet_id = ? AND col_id = ?', s.id, req.params.colId);
    });
    sheetRefresh(s);
    return { ok: true };
  }),
);

api.post(
  '/sheets/:id/rows',
  h((req) => {
    const s = mustSheet(req.params.id);
    const count = Math.max(1, Math.min(100, Number(req.body?.count ?? 1) || 1));
    const after = str(req.body?.afterRowId);
    let start: number;
    let step: number;
    if (after) {
      const a = q.get<{ position: number }>('SELECT position FROM sheet_rows WHERE id = ? AND sheet_id = ?', after, s.id);
      if (!a) throw new HttpError(404, 'row not found');
      const next = q.get<{ position: number }>(
        'SELECT position FROM sheet_rows WHERE sheet_id = ? AND position > ? ORDER BY position LIMIT 1',
        s.id,
        a.position,
      );
      const end = next ? next.position : a.position + count + 1;
      step = (end - a.position) / (count + 1);
      start = a.position + step;
    } else {
      start = (q.get<{ p: number | null }>('SELECT MAX(position) AS p FROM sheet_rows WHERE sheet_id = ?', s.id)?.p ?? 0) + 1;
      step = 1;
    }
    const ids: string[] = [];
    tx(() => {
      for (let i = 0; i < count; i++) {
        const id = newId();
        ids.push(id);
        q.run(
          'INSERT INTO sheet_rows (id, sheet_id, position, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
          id,
          s.id,
          start + i * step,
          req.user!.id,
          now(),
        );
      }
    });
    sheetRefresh(s);
    return { ids };
  }),
);

api.delete(
  '/sheets/:id/rows/:rowId',
  h((req) => {
    const s = mustSheet(req.params.id);
    q.run('DELETE FROM sheet_rows WHERE id = ? AND sheet_id = ?', req.params.rowId, s.id);
    sheetRefresh(s);
    return { ok: true };
  }),
);

api.put(
  '/sheets/:id/cells',
  h((req) => {
    const s = mustSheet(req.params.id);
    const edits: { rowId: string; colId: string; value: string }[] = Array.isArray(req.body?.cells)
      ? req.body.cells
      : [{ rowId: req.body?.rowId, colId: req.body?.colId, value: req.body?.value }];
    const cols = new Set(parseColumns(s).map((c) => c.id));
    const ts = now();
    const applied: { rowId: string; colId: string; value: string; updatedBy: string; updatedAt: string }[] = [];
    tx(() => {
      for (const e of edits.slice(0, 5000)) {
        const rowId = String(e?.rowId ?? '');
        const colId = String(e?.colId ?? '');
        if (!cols.has(colId) || !q.get('SELECT 1 FROM sheet_rows WHERE id = ? AND sheet_id = ?', rowId, s.id)) continue;
        const value = typeof e.value === 'string' ? e.value.slice(0, 10000) : e.value == null ? '' : String(e.value);
        if (value === '') q.run('DELETE FROM sheet_cells WHERE row_id = ? AND col_id = ?', rowId, colId);
        else
          q.run(
            `INSERT INTO sheet_cells (sheet_id, row_id, col_id, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (row_id, col_id) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
            s.id,
            rowId,
            colId,
            value,
            req.user!.id,
            ts,
          );
        applied.push({ rowId, colId, value, updatedBy: req.user!.id, updatedAt: ts });
      }
    });
    if (applied.length) emitToIncident(s.incident_id, 'sheet:cells', { sheetId: s.id, cells: applied });
    return { applied: applied.length };
  }),
);

// ---------- admin ----------

function requireAdmin(req: Request) {
  if (!isAdmin(req.user!)) throw new HttpError(403, 'admins only');
}

function mustUser(id: string) {
  const u = getUser(id);
  if (!u || u.deleted) throw new HttpError(404, 'user not found');
  return u;
}

api.get(
  '/admin/directory',
  h((req) => {
    requireAdmin(req);
    const users = q.all<UserRow>('SELECT * FROM users WHERE deleted = 0 ORDER BY display_name');
    const groups = q.all<{ id: string; display_name: string; external_id: string | null; n: number }>(
      'SELECT g.id, g.display_name, g.external_id, COUNT(gm.user_id) AS n FROM groups g LEFT JOIN group_members gm ON gm.group_id = g.id GROUP BY g.id ORDER BY g.display_name',
    );
    const adminIds = adminGroupIds();
    return {
      users: users.map((u) => ({
        ...toPublic(u),
        adminSources: adminSources(u),
        scimManaged: Boolean(u.scim_managed),
        ssoLinked: Boolean(u.oidc_sub) || linkedProviders(u.id).length > 0,
        ssoProviders: linkedProviders(u.id).map(providerLabel),
        idpLabel: providerLabel(u.last_login_provider),
        createdAt: u.created_at,
        lastLoginAt: u.last_login_at,
      })),
      groups: groups.map((g) => ({
        id: g.id,
        displayName: g.display_name,
        members: g.n,
        isAdminGroup: [g.display_name, g.external_id ?? ''].some((v) => adminIds.includes(v.toLowerCase())),
      })),
      scimEnabled: Boolean(config.scim.token),
      adminGroup: config.oidc.adminGroup || null,
      adminGroups: ssoProviders()
        .filter((p) => p.adminGroup)
        .map((p) => ({ provider: providerLabel(p.id), group: p.adminGroup })),
      providers: ssoProviders().map((p) => providerLabel(p.id)),
    };
  }),
);

/** Grant or revoke in-app admin. Okta-derived admin can only be removed in Okta. */
api.put(
  '/admin/users/:id/admin',
  h((req) => {
    requireAdmin(req);
    const target = mustUser(req.params.id);
    const grant = req.body?.admin === true;
    if (grant) {
      if (!target.active) throw new HttpError(400, 'reactivate the user before making them an admin');
      if (target.is_admin) return { ok: true };
      updateUser(target.id, { is_admin: 1 });
      logAdminAction(req.user!.id, target.id, 'admin_granted');
    } else {
      if (!target.is_admin) {
        const s = adminSources(target);
        if (s.idpClaim || s.idpGroup) {
          throw new HttpError(400, `${target.display_name} is an admin through an admin group in ${providerLabel(target.last_login_provider)}; remove them from that group there`);
        }
        return { ok: true };
      }
      const s = adminSources(target);
      const stillAdmin = s.idpClaim || s.idpGroup;
      if (!stillAdmin && otherActiveAdmins(target.id) === 0) {
        throw new HttpError(400, 'cannot remove the last admin; make someone else an admin first');
      }
      updateUser(target.id, { is_admin: 0 });
      logAdminAction(req.user!.id, target.id, 'admin_revoked', stillAdmin ? 'Still an admin through Okta group' : '');
    }
    return { user: toPublic(getUser(target.id)!), adminSources: adminSources(getUser(target.id)!) };
  }),
);

/** Deactivate/reactivate accounts that War Room owns. Okta-provisioned users are managed in Okta. */
api.put(
  '/admin/users/:id/active',
  h((req) => {
    requireAdmin(req);
    const target = mustUser(req.params.id);
    const active = req.body?.active === true;
    if (target.scim_managed) throw new HttpError(400, 'this user is provisioned by Okta; assign or unassign them in Okta');
    if (target.id === req.user!.id && !active) throw new HttpError(400, 'you cannot deactivate yourself');
    if (!active && isAdmin(target) && otherActiveAdmins(target.id) === 0) {
      throw new HttpError(400, 'cannot deactivate the last admin');
    }
    if (Boolean(target.active) === active) return { ok: true };
    updateUser(target.id, { active: active ? 1 : 0 });
    logAdminAction(req.user!.id, target.id, active ? 'user_reactivated' : 'user_deactivated');
    return { ok: true };
  }),
);

api.get(
  '/admin/audit',
  h((req) => {
    requireAdmin(req);
    const rows = q.all<{ id: string; ts: string; action: string; detail: string; actor: string | null; target: string | null }>(
      `SELECT a.id, a.ts, a.action, a.detail, ua.display_name AS actor, ut.display_name AS target
       FROM admin_audit a LEFT JOIN users ua ON ua.id = a.actor_id LEFT JOIN users ut ON ut.id = a.target_id
       ORDER BY a.ts DESC LIMIT 200`,
    );
    return { entries: rows };
  }),
);
