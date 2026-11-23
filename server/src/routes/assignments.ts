import { Router } from 'express';
import { now, q, tx } from '../db.js';
import { broadcastPresence, emitToUser, refreshIncident, visibleChannelIds } from '../realtime.js';
import { getUser } from '../users.js';
import { canSee } from '../guests.js';
import { HttpError, incidentKey, mustChannel, mustIncident } from '../model.js';
import { requireControl } from '../permissions.js';
import { addTimeline } from '../timeline.js';
import { postMessage } from '../messages.js';
import { h, str } from './common.js';

export const router = Router();

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
router.put(
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
router.put(
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
router.put(
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
