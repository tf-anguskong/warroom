import { Router } from 'express';
import { now, q, tx } from '../db.js';
import { emitToChannel, joinIncidentToChannel, refreshIncident, removeIncidentFromChannel, visibleChannelIds } from '../realtime.js';
import { mentionsToText } from '../mentions.js';
import { pendingUploads } from '../files.js';
import { HttpError, incidentKey, mustChannel, mustIncident, type MessageRow } from '../model.js';
import { addTimeline } from '../timeline.js';
import { postMessage, serializeMessage } from '../messages.js';
import { channelName, createChannel } from '../rooms.js';
import { h, str } from './common.js';

export const router = Router();

// ---------- channels ----------

router.post(
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

router.patch(
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
router.put(
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

router.post(
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

router.delete(
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

router.get(
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

router.get(
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

router.post(
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
router.post(
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

router.patch(
  '/messages/:id',
  h((req) => {
    const m = q.get<MessageRow>('SELECT * FROM messages WHERE id = ?', req.params.id);
    if (!m) throw new HttpError(404, 'message not found');
    const ch = mustChannel(m.channel_id);
    const pinning = typeof req.body?.pinned === 'boolean';
    // Check everything before changing anything.
    if (typeof req.body?.body === 'string' && m.user_id !== req.user!.id) throw new HttpError(403, 'can only edit your own messages');
    // Pins go on the timeline, which guests may not be able to see (and must not write to elsewhere).
    if (pinning && req.user!.is_guest) throw new HttpError(403, 'Guests can’t pin messages');
    // A pin lands on the timeline of the war room it was pinned from: one where this channel is open.
    const pinIncident = str(req.body?.incidentId) || ch.incident_id;
    if (pinning && req.body.pinned && !visibleChannelIds(pinIncident).includes(ch.id)) {
      throw new HttpError(400, 'That channel isn’t open in that war room');
    }
    if (typeof req.body?.body === 'string') {
      q.run('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?', str(req.body.body, 20000), now(), m.id);
    }
    if (pinning) {
      q.run('UPDATE messages SET pinned = ? WHERE id = ?', req.body.pinned ? 1 : 0, m.id);
      if (req.body.pinned) {
        addTimeline(pinIncident, req.user!.id, 'pin', mentionsToText(m.body).slice(0, 500), { messageId: m.id, channelId: ch.id });
      }
    }
    const updated = serializeMessage(
      q.get<MessageRow>('SELECT m.*, u.display_name FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ?', m.id)!,
    );
    emitToChannel(ch.id, 'message:updated', updated);
    return { message: updated };
  }),
);
