import { newId, now, q } from './db.js';
import { emitToIncident } from './realtime.js';
import { getUser } from './users.js';
import { currentAgent } from './agent-context.js';
import { timelineToWebhooks } from './webhooks.js';

/**
 * The incident timeline: anything that changes who does what lands here, so the export can answer
 * "who did what". New entries go out live and to webhooks.
 */

export function addTimeline(
  incidentId: string,
  userId: string | null,
  type: string,
  text: string,
  ref: Record<string, unknown> | null = null,
  ts = now(),
) {
  const id = newId();
  // Done by an AI agent for this person (only when it's that person's own entry).
  const agent = currentAgent();
  const agentName = agent && userId === agent.userId ? agent.name : null;
  q.run(
    'INSERT INTO timeline (id, incident_id, ts, user_id, type, text, ref, agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    incidentId,
    ts,
    userId,
    type,
    text,
    ref ? JSON.stringify(ref) : null,
    agentName,
  );
  const entry = {
    id,
    incidentId,
    ts,
    userId,
    displayName: userId ? getUser(userId)?.display_name ?? null : null,
    agent: agentName,
    type,
    text,
    ref,
  };
  emitToIncident(incidentId, 'timeline:new', entry);
  timelineToWebhooks(incidentId, type, text, ref, userId, agentName);
  return entry;
}
