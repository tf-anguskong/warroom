import { db, newId, now, q } from './db.js';
import { emitToChannel, emitToUser, visibleChannelIds } from './realtime.js';
import { getUser } from './users.js';
import { mentionedUserIds, mentionsToText, resolveMentions } from './mentions.js';
import { canSee } from './guests.js';
import { attachmentsOf, attachToMessage } from './files.js';
import { currentAgent } from './agent-context.js';
import { incidentKey, type ChannelRow, type IncidentRow, type MessageRow } from './model.js';

/** Chat messages: posting (people, agents and system notices), mentions, and the shape sent to browsers. */

// Moderation and history: who edited or deleted a message, where it was moved or copied from, and
// every earlier version (message_revisions holds each version that was replaced, with who wrote it).
{
  const cols = new Set((db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map((c) => c.name));
  for (const [name, type] of [
    ['edited_by', 'TEXT'],
    ['deleted_at', 'TEXT'],
    ['deleted_by', 'TEXT'],
    ['erased', 'INTEGER'],
    ['moved_from', 'TEXT'],
    ['moved_by', 'TEXT'],
    ['moved_at', 'TEXT'],
    ['copied_from', 'TEXT'],
    ['copied_by', 'TEXT'],
    ['copied_original_at', 'TEXT'],
  ]) {
    if (!cols.has(name)) db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
  }
  db.exec(`
CREATE TABLE IF NOT EXISTS message_revisions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  body TEXT NOT NULL,
  written_at TEXT NOT NULL,
  written_by TEXT,
  replaced_at TEXT NOT NULL,
  replaced_by TEXT,
  reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_revisions ON message_revisions(message_id, replaced_at);
`);
}

const nameOf = (id: string | null | undefined) => (id ? getUser(id)?.display_name ?? 'someone' : null);

export function serializeMessage(m: MessageRow) {
  return {
    id: m.id,
    channelId: m.channel_id,
    userId: m.user_id,
    displayName: m.display_name ?? (m.user_id ? getUser(m.user_id)?.display_name : null) ?? 'System',
    /** Set when an AI agent posted this for the person. */
    agent: m.agent ?? null,
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
    /** Set when someone other than the author made the last edit. */
    editedBy: m.edited_by && m.edited_by !== m.user_id ? nameOf(m.edited_by) : null,
    /** Earlier versions anyone can look at (deleted originals are only for whoever runs the room). */
    revisions: q.get<{ n: number }>("SELECT COUNT(*) AS n FROM message_revisions WHERE message_id = ? AND reason = 'edit'", m.id)!.n,
    deleted: m.deleted_at ? { by: nameOf(m.deleted_by), at: m.deleted_at, erased: Boolean(m.erased) } : null,
    movedFrom: m.moved_from ? { channel: m.moved_from, by: nameOf(m.moved_by), at: m.moved_at } : null,
    copiedFrom: m.copied_from ? { channel: m.copied_from, by: nameOf(m.copied_by), originalAt: m.copied_original_at } : null,
    attachments: attachmentsOf(m.id),
  };
}

/**
 * Post a message. For people's messages, `incidentId` is the war room it was sent from; it decides
 * who `@here` and role mentions reach (a shared channel can be open in several war rooms).
 */
export function postMessage(channelId: string, userId: string | null, body: string, kind = 'msg', incidentId?: string, attachments: string[] = []) {
  const id = newId();
  const agent = currentAgent();
  q.run(
    'INSERT INTO messages (id, channel_id, user_id, body, kind, created_at, agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id,
    channelId,
    userId,
    body,
    kind,
    now(),
    agent && userId === agent.userId ? agent.name : null,
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
      // An agent's message notifies as "Alice's AI agent (Claude)", never as Alice herself.
      by: currentAgent() ? `${author?.display_name ?? 'Someone'}’s AI agent (${currentAgent()!.name})` : author?.display_name ?? 'Someone',
      preview,
    });
  }
}

/** Unread mentions for a user, per channel, among the given channels. */
export function unreadMentions(userId: string, channelIds: string[]): Record<string, number> {
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
