import { Router } from 'express';
import { now, q } from '../db.js';
import { emitToIncident } from '../realtime.js';
import { ROLES } from '../templates.js';
import { getUser, isAdmin } from '../users.js';
import { mentionsToText } from '../mentions.js';
import { notesForExport } from '../notes.js';
import { filesForExport } from '../files.js';
import { shiftsForExport } from '../shifts.js';
import { HttpError, STATUS_LABEL, incidentKey, mustIncident, type MessageRow } from '../model.js';
import { addTimeline } from '../timeline.js';
import { h, str } from './common.js';

/** The timeline (read, add, remove your own entries) and the Markdown post-mortem export built from it. */

export const router = Router();

// ---------- timeline ----------

const HUMAN_TYPES = ['note', 'decision', 'action', 'finding'];

router.get(
  '/incidents/:id/timeline',
  h((req) => {
    const inc = mustIncident(req.params.id);
    const rows = q.all<{ id: string; ts: string; user_id: string | null; type: string; text: string; ref: string | null; display_name: string | null; agent: string | null }>(
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
        agent: r.agent,
        type: r.type,
        text: r.text,
        ref: r.ref ? JSON.parse(r.ref) : null,
      })),
    };
  }),
);

router.post(
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

router.delete(
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

router.get(
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
    const rows = q.all<{ ts: string; type: string; text: string; display_name: string | null; agent: string | null }>(
      'SELECT t.ts, t.type, t.text, t.agent, u.display_name FROM timeline t LEFT JOIN users u ON u.id = t.user_id WHERE t.incident_id = ? ORDER BY t.ts',
      inc.id,
    );
    const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
    for (const r of rows) {
      lines.push(`| ${r.ts.replace("T", " ").slice(0, 19)} | ${r.type} | ${cell(mentionsToText(r.text))} | ${r.display_name ?? ''}${r.agent ? ` (via ${cell(r.agent)})` : ''} |`);
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
        lines.push(`> **${p.display_name ?? 'System'}**${p.agent ? ` via ${p.agent}` : ''} (${p.created_at.slice(0, 19).replace('T', ' ')} UTC)`, '>');
        lines.push(...mentionsToText(p.body).split('\n').map((l) => `> ${l}`), '');
      }
    }
    res
      .type('text/markdown')
      .setHeader('Content-Disposition', `attachment; filename="${key}-postmortem.md"`)
      .send(lines.join('\n') + '\n');
  }),
);
