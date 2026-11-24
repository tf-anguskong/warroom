import { Router, type Request } from 'express';
import { newId, now, q, tx } from '../db.js';
import { emitToChannel, visibleChannelIds } from '../realtime.js';
import { mentionsToText } from '../mentions.js';
import { copyAttachments, eraseAttachments, moveAttachments } from '../files.js';
import { HttpError, mustChannel, type ChannelRow, type MessageRow } from '../model.js';
import { canControl } from '../permissions.js';
import { addTimeline } from '../timeline.js';
import { serializeMessage } from '../messages.js';
import { getUser, type UserRow } from '../users.js';
import { h, str } from './common.js';

/**
 * Changing messages after they're sent. Authors edit and delete their own; the Incident Commander,
 * room admins and admins can edit or delete anyone's, and copy or move messages to another channel
 * open in their war room to control who sees what. Every edit keeps the earlier version, which
 * anyone who can see the message can read. A deleted message leaves a placeholder; its text stays
 * readable for whoever runs the room, unless it was erased (for a pasted password or key). Deletes,
 * other people's edits, copies and moves go on the timeline.
 */

export const router = Router();

const withName = (id: string) =>
  serializeMessage(q.get<MessageRow>('SELECT m.*, u.display_name FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ?', id)!);

function load(id: string) {
  const m = q.get<MessageRow>('SELECT * FROM messages WHERE id = ?', id);
  if (!m) throw new HttpError(404, 'message not found');
  return { m, ch: mustChannel(m.channel_id) };
}

/** The war room someone is acting from: the one they say, if it shows this channel; otherwise the channel's own. */
function roomFor(req: Request, ch: ChannelRow) {
  const asked = str(req.body?.incidentId) || str(req.query.incidentId);
  const inc = asked || ch.incident_id;
  if (!visibleChannelIds(inc).includes(ch.id)) throw new HttpError(400, 'That channel isn’t open in that war room');
  return inc;
}

const authorName = (m: MessageRow) => (m.user_id ? getUser(m.user_id)?.display_name ?? 'someone' : 'System');
const whose = (m: MessageRow, user: UserRow) => (m.user_id === user.id ? 'their own' : `${authorName(m)}’s`);
const moderator = (user: UserRow, inc: string) => !user.is_guest && canControl(user, inc);

/** Keep the version being replaced, with who wrote it and when. */
function keepVersion(m: MessageRow, user: UserRow, reason: 'edit' | 'delete') {
  q.run(
    'INSERT INTO message_revisions (id, message_id, body, written_at, written_by, replaced_at, replaced_by, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    newId(),
    m.id,
    m.body,
    m.edited_at ?? m.created_at,
    m.edited_by ?? m.user_id,
    now(),
    user.id,
    reason,
  );
}

router.patch(
  '/messages/:id',
  h((req) => {
    const user = req.user!;
    const { m, ch } = load(req.params.id);
    const inc = roomFor(req, ch);
    const editing = typeof req.body?.body === 'string';
    const pinning = typeof req.body?.pinned === 'boolean';
    const own = m.user_id === user.id;
    // Check everything before changing anything.
    let body = '';
    if (editing) {
      if (m.kind !== 'msg') throw new HttpError(400, 'System messages can’t be edited');
      if (m.deleted_at) throw new HttpError(400, 'This message was deleted');
      if (!own && !moderator(user, inc)) throw new HttpError(403, 'You can edit only your own messages. The Incident Commander and room admins can edit anyone’s.');
      body = str(req.body.body, 20000);
      const files = q.get<{ n: number }>('SELECT COUNT(*) AS n FROM files WHERE message_id = ? AND deleted_at IS NULL', m.id)!.n;
      if (!body && !files) throw new HttpError(400, 'A message can’t be empty. Delete it instead.');
    }
    // Pins go on the timeline, which guests may not be able to see (and must not write to elsewhere).
    if (pinning && user.is_guest) throw new HttpError(403, 'Guests can’t pin messages');
    if (pinning && m.deleted_at && req.body.pinned) throw new HttpError(400, 'This message was deleted');
    tx(() => {
      if (editing && body !== m.body) {
        keepVersion(m, user, 'edit');
        q.run('UPDATE messages SET body = ?, edited_at = ?, edited_by = ? WHERE id = ?', body, now(), user.id, m.id);
      }
      if (pinning) q.run('UPDATE messages SET pinned = ? WHERE id = ?', req.body.pinned ? 1 : 0, m.id);
    });
    if (editing && body !== m.body && !own) {
      addTimeline(inc, user.id, 'moderation', `${user.display_name} edited ${authorName(m)}’s message in #${ch.name} (earlier version kept in its history)`, { messageId: m.id, channelId: ch.id });
    }
    if (pinning && req.body.pinned) {
      addTimeline(inc, user.id, 'pin', mentionsToText(editing ? body : m.body).slice(0, 500), { messageId: m.id, channelId: ch.id });
    }
    const updated = withName(m.id);
    emitToChannel(ch.id, 'message:updated', updated);
    return { message: updated };
  }),
);

/** Delete (?erase=1 also removes it from the history and deletes its attachments, for secrets pasted by mistake). */
router.delete(
  '/messages/:id',
  h((req) => {
    const user = req.user!;
    const { m, ch } = load(req.params.id);
    const inc = roomFor(req, ch);
    const erase = req.query.erase === '1' || req.query.erase === 'true';
    const own = m.user_id === user.id && m.kind === 'msg';
    if (!own && !moderator(user, inc)) {
      throw new HttpError(403, 'You can delete only your own messages. The Incident Commander and room admins can delete anyone’s.');
    }
    if (m.deleted_at && (!erase || m.erased)) return { message: withName(m.id) };
    let files = 0;
    tx(() => {
      if (!m.deleted_at) {
        keepVersion(m, user, 'delete');
        q.run('UPDATE messages SET body = ?, deleted_at = ?, deleted_by = ?, pinned = 0 WHERE id = ?', '', now(), user.id, m.id);
        q.run('DELETE FROM message_mentions WHERE message_id = ?', m.id);
      }
      if (erase) {
        q.run('DELETE FROM message_revisions WHERE message_id = ?', m.id);
        q.run('UPDATE messages SET erased = 1 WHERE id = ?', m.id);
        files = eraseAttachments(m.id, user.id);
      }
    });
    addTimeline(
      inc,
      user.id,
      'moderation',
      erase
        ? `${user.display_name} erased ${whose(m, user)} message in #${ch.name}, including its history${files ? ` and ${files} attachment${files > 1 ? 's' : ''}` : ''}`
        : `${user.display_name} deleted ${whose(m, user)} message in #${ch.name}`,
      { messageId: m.id, channelId: ch.id },
    );
    const updated = withName(m.id);
    emitToChannel(ch.id, 'message:updated', updated);
    return { message: updated };
  }),
);

/** Earlier versions. Anyone who can see the message sees its edits; deleted text only for whoever runs the room. */
router.get(
  '/messages/:id/history',
  h((req) => {
    const user = req.user!;
    const { m, ch } = load(req.params.id);
    const inc = roomFor(req, ch);
    const seeDeleted = moderator(user, inc);
    const name = (id: string | null) => (id ? getUser(id)?.display_name ?? 'someone' : 'System');
    const versions = q
      .all<{ body: string; written_at: string; written_by: string | null; replaced_at: string; replaced_by: string | null; reason: string }>(
        'SELECT * FROM message_revisions WHERE message_id = ? ORDER BY replaced_at, rowid',
        m.id,
      )
      .filter((r) => r.reason === 'edit' || seeDeleted)
      .map((r) => ({
        body: r.body,
        writtenAt: r.written_at,
        writtenBy: name(r.written_by),
        replacedAt: r.replaced_at,
        replacedBy: name(r.replaced_by),
        deleted: r.reason === 'delete',
      }));
    return {
      versions,
      current: m.deleted_at ? null : { body: m.body, writtenAt: m.edited_at ?? m.created_at, writtenBy: name(m.edited_by ?? m.user_id) },
      deleted: m.deleted_at ? { by: name(m.deleted_by ?? null), at: m.deleted_at, erased: Boolean(m.erased) } : null,
      canSeeDeleted: seeDeleted,
      channel: ch.name,
    };
  }),
);

/** Copy or move a message to another channel open in the same war room (whoever runs the room). */
router.post(
  '/messages/:id/:action(copy|move)',
  h((req) => {
    const user = req.user!;
    const action = req.params.action as 'copy' | 'move';
    const { m, ch } = load(req.params.id);
    const inc = roomFor(req, ch);
    if (!moderator(user, inc)) throw new HttpError(403, `Only the Incident Commander, room admins and admins can ${action} messages to another channel`);
    if (m.kind !== 'msg') throw new HttpError(400, `System messages can’t be ${action === 'copy' ? 'copied' : 'moved'}`);
    if (m.deleted_at) throw new HttpError(400, 'This message was deleted');
    const target = mustChannel(str(req.body?.channelId));
    if (target.id === ch.id) throw new HttpError(400, 'Choose a different channel');
    if (target.archived) throw new HttpError(400, 'That channel is archived');
    if (!visibleChannelIds(inc).includes(target.id)) throw new HttpError(400, 'That channel isn’t open in this war room');
    let id = m.id;
    tx(() => {
      if (action === 'copy') {
        id = newId();
        q.run(
          `INSERT INTO messages (id, channel_id, user_id, body, kind, created_at, agent, copied_from, copied_by, copied_original_at)
           VALUES (?, ?, ?, ?, 'msg', ?, ?, ?, ?, ?)`,
          id, target.id, m.user_id, m.body, now(), m.agent ?? null, `#${ch.name}`, user.id, m.created_at,
        );
        copyAttachments(m.id, id, target.id);
      } else {
        q.run('UPDATE messages SET channel_id = ?, moved_from = ?, moved_by = ?, moved_at = ? WHERE id = ?', target.id, `#${ch.name}`, user.id, now(), m.id);
        moveAttachments(m.id, target.id);
      }
    });
    const msg = withName(id);
    if (action === 'move') emitToChannel(ch.id, 'message:removed', { id: m.id, channelId: ch.id });
    emitToChannel(target.id, 'message:new', msg);
    addTimeline(
      inc,
      user.id,
      'moderation',
      `${user.display_name} ${action === 'copy' ? 'copied' : 'moved'} ${whose(m, user)} message from #${ch.name} to #${target.name}`,
      { messageId: id, channelId: target.id },
    );
    return { message: msg };
  }),
);
