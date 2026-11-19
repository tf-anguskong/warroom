import { q } from './db.js';
import { ROLES } from './templates.js';
import { getUser } from './users.js';
import { presenceFor } from './realtime.js';

/**
 * Mentions are stored in message bodies as tokens so they survive renames:
 *   <@userId>        a person
 *   <@role:commander> whoever holds that role in the incident the message was posted from
 *   <@here>          everyone currently in the war room
 */
export const MENTION_RE = /<@(here|role:[a-z]+|[0-9a-f-]{36})>/g;

/** Users a message notifies, resolved in the context of the incident it was posted from. */
export function resolveMentions(body: string, incidentId: string): string[] {
  const ids = new Set<string>();
  for (const [, token] of body.matchAll(MENTION_RE)) {
    if (token === 'here') {
      for (const p of presenceFor(incidentId)) ids.add(p.userId);
    } else if (token.startsWith('role:')) {
      const r = q.get<{ user_id: string }>(
        'SELECT user_id FROM incident_roles WHERE incident_id = ? AND role = ?',
        incidentId,
        token.slice(5),
      );
      if (r) ids.add(r.user_id);
    } else {
      const u = getUser(token);
      if (u && u.active && !u.deleted) ids.add(u.id);
    }
  }
  return [...ids];
}

/** Replace tokens with readable names, for exports and anything that leaves the chat UI. */
export function mentionsToText(body: string): string {
  return body.replace(MENTION_RE, (_m, token: string) => {
    if (token === 'here') return '@here';
    if (token.startsWith('role:')) return `@${ROLES.find((r) => r.key === token.slice(5))?.label ?? token.slice(5)}`;
    return `@${getUser(token)?.display_name ?? 'unknown'}`;
  });
}

export function mentionedUserIds(messageId: string): string[] {
  return q
    .all<{ user_id: string }>('SELECT user_id FROM message_mentions WHERE message_id = ?', messageId)
    .map((r) => r.user_id);
}
