import type { Request } from 'express';
import { q } from './db.js';
import { isAdmin, type UserRow } from './users.js';
import { currentAgent } from './agent-context.js';
import { HttpError } from './model.js';

/** Who runs a war room: the Incident Commander, room admins and app admins. */

export const roomAdminIds = (incidentId: string) =>
  q
    .all<{ user_id: string }>('SELECT user_id FROM incident_room_admins WHERE incident_id = ? ORDER BY granted_at', incidentId)
    .map((r) => r.user_id);

export const commanderOf = (incidentId: string) =>
  q.get<{ user_id: string }>("SELECT user_id FROM incident_roles WHERE incident_id = ? AND role = 'commander'", incidentId)?.user_id ?? null;

/**
 * Who runs the room: the Incident Commander, room admins, and app admins. If nobody holds either
 * (IC unassigned, no room admins), anyone in the room can act so the room is never locked.
 */
export function canControl(user: UserRow, incidentId: string) {
  // AI agents never run the room, whoever they work for.
  if (user.is_guest || currentAgent()) return false;
  if (isAdmin(user)) return true;
  const ic = commanderOf(incidentId);
  const admins = roomAdminIds(incidentId);
  if (user.id === ic || admins.includes(user.id)) return true;
  return !ic && admins.length === 0;
}

export function requireControl(req: Request, incidentId: string, what: string) {
  if (!canControl(req.user!, incidentId)) {
    throw new HttpError(403, `Only the Incident Commander or a room admin can ${what}`);
  }
}

export function requireAdmin(req: Request) {
  if (!isAdmin(req.user!)) throw new HttpError(403, 'admins only');
}
