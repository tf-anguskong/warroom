import { Router } from 'express';
import type { Request } from 'express';
import { config } from '../config.js';
import { newId, now, q, tx } from '../db.js';
import { activeCounts, emitDashboard, emitToUser, refreshIncident, visibleChannelIds } from '../realtime.js';
import { ROLES, SEVERITIES, SHEET_TEMPLATES, STATUSES } from '../templates.js';
import { bus, getUser, toPublic, type UserRow } from '../users.js';
import { mailStatus } from '../mail.js';
import { canSee, guestsOf, signInCodeBlock } from '../guests.js';
import { pendingJoinRequests } from '../join-requests.js';
import { notesFor } from '../notes.js';
import { shiftsOf } from '../shifts.js';
import { currentAgent } from '../agent-context.js';
import { HttpError, STATUS_LABEL, incidentKey, mustChannel, mustIncident, serializeIncident, type IncidentRow, type SheetRow } from '../model.js';
import { canControl, commanderOf, requireControl, roomAdminIds } from '../permissions.js';
import { addTimeline } from '../timeline.js';
import { systemNotice, unreadMentions } from '../messages.js';
import { createChannel, createSheet, createVoiceRoom } from '../rooms.js';
import { h, str } from './common.js';

/** Incidents: list, declare, the war room snapshot, severity and status, roles, command and room admins. */

export const router = Router();

function markMember(incidentId: string, user: UserRow) {
  // An agent reading the room isn't the person joining it.
  if (currentAgent()) return;
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

router.get(
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

router.get(
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

router.get(
  '/incidents',
  h((req) => {
    const filter = str(req.query.filter) || 'active';
    const where =
      filter === 'resolved' ? "WHERE status = 'resolved'" : filter === 'all' ? '' : "WHERE status <> 'resolved'";
    const rows = q
      .all<IncidentRow>(
        `SELECT * FROM incidents ${where} ORDER BY CASE WHEN status = 'resolved' THEN 1 ELSE 0 END, severity, created_at DESC`,
      )
      .filter((i) => !req.user!.is_guest || i.id === req.user!.guest_incident_id)
      // An agent given one war room doesn't see the others.
      .filter((i) => !currentAgent()?.incidentId || i.id === currentAgent()!.incidentId);
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

router.post(
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
    addTimeline(id, user.id, 'role', `${user.display_name} is Incident Commander`, { role: 'commander' });
    emitDashboard();
    bus.emit("incident:declared", { incidentId: id, userId: user.id });
    return { id, key: incidentKey(number) };
  }),
);

router.get(
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
                        return t ? signInCodeBlock(viewer, inc.id, t, commanderOf(inc.id)) : 'Account not found';
                      })(),
              }
            : {}),
        })),
      guests: guestsOf(inc.id, viewer, manageGuests),
      // People asking to join from the room link: only for whoever can let them in.
      ...(manageGuests && inc.status !== 'resolved' ? { joinRequests: pendingJoinRequests(inc.id) } : {}),
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

router.patch(
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
      addTimeline(inc.id, user.id, 'status', `Status: ${STATUS_LABEL[inc.status]} → ${STATUS_LABEL[b.status]}`, { from: inc.status, to: b.status });
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

router.put(
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
      const takingEmptySeat = !commanderOf(inc.id) && String(req.body?.userId ?? '') === actor.id;
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
      addTimeline(inc.id, req.user!.id, 'role', `${target.display_name} assigned as ${role.label}`, { role: role.key });
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
  const prevId = commanderOf(inc.id);
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
  addTimeline(inc.id, actor.id, 'role', note ? `${text}. Handoff note: ${note}` : text, { role: 'commander' });
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
router.post(
  '/incidents/:id/command/request',
  h((req) => {
    const inc = mustIncident(req.params.id);
    const user = req.user!;
    if (user.is_guest) throw new HttpError(403, 'Guests can’t be Incident Commander');
    const ic = commanderOf(inc.id);
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
router.post(
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

/** Grant or revoke room admin for this incident. */
router.put(
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
