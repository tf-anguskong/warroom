import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { userFromCookieHeader } from './auth.js';
import { q } from './db.js';
import { bus, getUser, type UserRow } from './users.js';
import { canSee } from './guests.js';

export interface Away {
  since: string;
  until: string | null;
  note: string;
}

export interface PresenceEntry {
  userId: string;
  displayName: string;
  voiceRoomId: string | null;
  muted: boolean;
  sharing: boolean;
  /** Camera on in their voice room. */
  camera?: boolean;
  view: string | null;
  away?: Away | null;
}

/** Who has marked themselves away in this war room. */
export function awayIn(incidentId: string): Map<string, Away> {
  return new Map(
    q
      .all<{ user_id: string; away_since: string; away_until: string | null; away_note: string }>(
        'SELECT user_id, away_since, away_until, away_note FROM incident_members WHERE incident_id = ? AND away_since IS NOT NULL',
        incidentId,
      )
      .map((r) => [r.user_id, { since: r.away_since, until: r.away_until, note: r.away_note }]),
  );
}

interface SocketData {
  user: UserRow;
  incidentId: string | null;
  presence: PresenceEntry | null;
}

let io: Server;

/** Channels visible inside an incident: its own plus those shared into it. */
export function visibleChannelIds(incidentId: string): string[] {
  return q
    .all<{ id: string }>(
      `SELECT id FROM channels WHERE incident_id = ?
       UNION SELECT channel_id AS id FROM channel_shares WHERE incident_id = ?`,
      incidentId,
      incidentId,
    )
    .map((r) => r.id);
}

export function presenceFor(incidentId: string): PresenceEntry[] {
  const room = io.sockets.adapter.rooms.get(`incident:${incidentId}`);
  const byUser = new Map<string, PresenceEntry>();
  for (const sid of room ?? []) {
    const s = io.sockets.sockets.get(sid) as Socket<any, any, any, SocketData> | undefined;
    const p = s?.data.presence;
    if (!p) continue;
    const prev = byUser.get(p.userId);
    // A user with two tabs open: prefer the tab that is in voice.
    if (!prev || (!prev.voiceRoomId && p.voiceRoomId)) byUser.set(p.userId, { ...p });
  }
  const away = awayIn(incidentId);
  return [...byUser.values()].map((p) => ({ ...p, away: away.get(p.userId) ?? null }));
}

export function broadcastPresence(incidentId: string) {
  const users = presenceFor(incidentId);
  io.to(`incident:${incidentId}`).emit('presence', { incidentId, users });
  trackPresence(incidentId, users);
}

// ---------- comings and goings on the timeline ----------
// Who came into or left the room and its voice rooms, so the record shows who was there when.
// A change is written only once it has lasted PRESENCE_GRACE_MS, so a page reload or a blip of a
// few seconds isn't logged; a real drop is, at the time it happened. The last written state is kept
// on incident_members so a server restart doesn't log everyone again.

const PRESENCE_GRACE_MS = 20_000;
const pendingPresence = new Map<string, { since: string; timer: NodeJS.Timeout }>();

interface Seen {
  present: number;
  present_voice: string | null;
}

function trackPresence(incidentId: string, users = presenceFor(incidentId)) {
  const live = new Map(users.map((p) => [p.userId, p.voiceRoomId ?? null]));
  const stored = new Map(
    q
      .all<Seen & { user_id: string }>('SELECT user_id, present, present_voice FROM incident_members WHERE incident_id = ? AND present = 1', incidentId)
      .map((r) => [r.user_id, r.present_voice ?? null]),
  );
  for (const userId of new Set([...live.keys(), ...stored.keys()])) {
    const same = live.has(userId) === stored.has(userId) && (live.get(userId) ?? null) === (stored.get(userId) ?? null);
    const key = `${incidentId}:${userId}`;
    if (same || pendingPresence.has(key)) continue;
    const since = new Date().toISOString();
    pendingPresence.set(key, { since, timer: setTimeout(() => void commitPresence(incidentId, userId), PRESENCE_GRACE_MS).unref() });
  }
}

async function commitPresence(incidentId: string, userId: string) {
  const key = `${incidentId}:${userId}`;
  const pending = pendingPresence.get(key);
  pendingPresence.delete(key);
  if (!pending) return;
  try {
    const row = q.get<Seen>('SELECT present, present_voice FROM incident_members WHERE incident_id = ? AND user_id = ?', incidentId, userId);
    if (!row) return;
    const p = presenceFor(incidentId).find((x) => x.userId === userId);
    const was = { in: Boolean(row.present), voice: row.present ? row.present_voice ?? null : null };
    const is = { in: Boolean(p), voice: p?.voiceRoomId ?? null };
    if (was.in === is.in && was.voice === is.voice) return;
    q.run('UPDATE incident_members SET present = ?, present_voice = ? WHERE incident_id = ? AND user_id = ?', is.in ? 1 : 0, is.voice, incidentId, userId);
    const name = getUser(userId)?.display_name ?? 'Someone';
    const room = (id: string | null) => (id && q.get<{ name: string }>('SELECT name FROM voice_rooms WHERE id = ?', id)?.name) || 'a voice room';
    let text: string;
    if (!was.in) text = is.voice ? `${name} came into the room and joined ${room(is.voice)}` : `${name} came into the room`;
    else if (!is.in) text = was.voice ? `${name} left the room (was in ${room(was.voice)})` : `${name} left the room`;
    else if (!was.voice) text = `${name} joined ${room(is.voice)}`;
    else if (!is.voice) text = `${name} left ${room(was.voice)}`;
    else text = `${name} moved from ${room(was.voice)} to ${room(is.voice)}`;
    const { addTimeline } = await import('./api.js');
    addTimeline(incidentId, userId, 'presence', text, null, pending.since);
  } catch (err) {
    console.error('[presence]', err instanceof Error ? err.message : err);
  }
}

/** After a restart: people marked present who don't reconnect are logged as having left. */
function recheckPresenceAfterStart() {
  setTimeout(() => {
    for (const { incident_id } of q.all<{ incident_id: string }>('SELECT DISTINCT incident_id FROM incident_members WHERE present = 1')) trackPresence(incident_id);
  }, 30_000).unref();
}

/** Count of users currently in each incident (for the dashboard). */
export function activeCounts(): Record<string, { present: number; inVoice: number }> {
  const out: Record<string, { present: number; inVoice: number }> = {};
  for (const [name] of io.sockets.adapter.rooms) {
    if (!name.startsWith('incident:')) continue;
    const id = name.slice('incident:'.length);
    const users = presenceFor(id);
    out[id] = { present: users.length, inVoice: users.filter((u) => u.voiceRoomId).length };
  }
  return out;
}

export function initRealtime(server: HttpServer) {
  io = new Server(server, { path: '/socket.io', serveClient: false });
  recheckPresenceAfterStart();

  io.use(async (socket, next) => {
    const user = await userFromCookieHeader(socket.handshake.headers.cookie);
    if (!user) return next(new Error('unauthenticated'));
    socket.data = { user, incidentId: null, presence: null } satisfies SocketData;
    socket.join(`user:${user.id}`);
    next();
  });

  io.on('connection', (socket: Socket<any, any, any, SocketData>) => {
    const leaveIncident = () => {
      const prev = socket.data.incidentId;
      if (!prev) return;
      for (const room of socket.rooms) {
        if (room.startsWith('incident:') || room.startsWith('channel:') || room.startsWith('guests:')) socket.leave(room);
      }
      socket.data.incidentId = null;
      socket.data.presence = null;
      broadcastPresence(prev);
    };

    socket.on('incident:join', ({ incidentId }: { incidentId: string }) => {
      if (!q.get('SELECT 1 FROM incidents WHERE id = ?', incidentId)) return;
      const fresh = getUser(socket.data.user.id);
      if (!fresh || (fresh.is_guest && fresh.guest_incident_id !== incidentId)) return;
      socket.data.user = fresh;
      leaveIncident();
      socket.data.incidentId = incidentId;
      socket.data.presence = {
        userId: socket.data.user.id,
        displayName: socket.data.user.display_name,
        voiceRoomId: null,
        muted: false,
        sharing: false,
        camera: false,
        view: null,
      };
      socket.join(`incident:${incidentId}`);
      if (fresh.is_guest) socket.join(`guests:${incidentId}`);
      for (const cid of visibleChannelIds(incidentId)) if (canSee(fresh, incidentId, 'channel', cid)) socket.join(`channel:${cid}`);
      broadcastPresence(incidentId);
    });

    socket.on('incident:leave', leaveIncident);

    socket.on(
      'presence:update',
      (patch: Partial<Pick<PresenceEntry, 'voiceRoomId' | 'muted' | 'sharing' | 'camera' | 'view'>>) => {
        const p = socket.data.presence;
        if (!p || !socket.data.incidentId) return;
        if (patch.voiceRoomId !== undefined) p.voiceRoomId = patch.voiceRoomId;
        if (patch.muted !== undefined) p.muted = Boolean(patch.muted);
        if (patch.sharing !== undefined) p.sharing = Boolean(patch.sharing);
        if (patch.camera !== undefined) p.camera = Boolean(patch.camera);
        if (patch.view !== undefined) p.view = patch.view;
        broadcastPresence(socket.data.incidentId);
      },
    );

    socket.on('sheet:cursor', (c: { sheetId: string; rowId: string | null; colId: string | null }) => {
      if (!socket.data.incidentId) return;
      socket.to(`incident:${socket.data.incidentId}`).except(`guests:${socket.data.incidentId}`).emit('sheet:cursor', {
        ...c,
        userId: socket.data.user.id,
        displayName: socket.data.user.display_name,
      });
    });

    socket.on('disconnecting', leaveIncident);
  });

  // Admin rights changed: the affected browser refetches /api/me so menus update without a reload.
  bus.on('user:changed', (userId: string) => io.to(`user:${userId}`).emit('me:changed'));
  bus.on('groups:changed', () => io.emit('me:changed'));

  const endSessions = (userId: string) => {
    io.to(`user:${userId}`).emit('session:revoked');
    io.in(`user:${userId}`).disconnectSockets(true);
  };
  bus.on('user:deactivated', endSessions);
  // SSO linked an existing account: sockets opened before then belong to earlier sessions.
  bus.on('user:sessions-ended', endSessions);
}

/** Events guests may receive; everything else sent to an incident goes to organization members only. */
const GUEST_EVENTS = new Set(['incident:refresh', 'presence', 'voice:summon']);

/**
 * Send to everyone in an incident's war room. Guests only get events on GUEST_EVENTS, plus
 * timeline, sheet and note events for what their invite lets them see.
 */
export function emitToIncident(incidentId: string, event: string, data: unknown) {
  if (GUEST_EVENTS.has(event)) return void io.to(`incident:${incidentId}`).emit(event, data);
  io.to(`incident:${incidentId}`).except(`guests:${incidentId}`).emit(event, data);
  const kind = event.startsWith('timeline:') ? 'timeline' : event.startsWith('sheet:') ? 'sheet' : event.startsWith('note:') ? 'note' : null;
  if (!kind) return;
  const d = data as { sheetId?: string; noteId?: string };
  const thingId = (kind === 'note' ? d?.noteId : d?.sheetId) ?? '';
  for (const sid of io.sockets.adapter.rooms.get(`guests:${incidentId}`) ?? []) {
    const sock = io.sockets.sockets.get(sid) as Socket<any, any, any, SocketData> | undefined;
    const u = sock && getUser(sock.data.user.id);
    if (u && canSee(u, incidentId, kind, thingId)) sock!.emit(event, data);
  }
}

/** After a guest's access changes, put their sockets in exactly the channel rooms they may see. */
export function resyncUserChannels(userId: string) {
  const u = getUser(userId);
  for (const sid of io.sockets.adapter.rooms.get(`user:${userId}`) ?? []) {
    const sock = io.sockets.sockets.get(sid) as Socket<any, any, any, SocketData> | undefined;
    const inc = sock?.data.incidentId;
    if (!sock || !inc || !u) continue;
    sock.data.user = u;
    for (const room of [...sock.rooms]) if (room.startsWith('channel:')) sock.leave(room);
    for (const cid of visibleChannelIds(inc)) if (canSee(u, inc, 'channel', cid)) sock.join(`channel:${cid}`);
  }
}

export const emitToUser = (userId: string, event: string, data: unknown) => io.to(`user:${userId}`).emit(event, data);

export const emitToChannel = (channelId: string, event: string, data: unknown) =>
  io.to(`channel:${channelId}`).emit(event, data);

/** Ask every client in an incident to refetch its structural state. */
export const refreshIncident = (incidentId: string) => emitToIncident(incidentId, 'incident:refresh', { incidentId });

export const emitDashboard = () => io.emit('dashboard:refresh');

/** A channel became visible in an incident (created or shared in): members join it; guests only if allowed. */
export function joinIncidentToChannel(incidentId: string, channelId: string) {
  io.in(`incident:${incidentId}`).except(`guests:${incidentId}`).socketsJoin(`channel:${channelId}`);
  for (const sid of io.sockets.adapter.rooms.get(`guests:${incidentId}`) ?? []) {
    const sock = io.sockets.sockets.get(sid) as Socket<any, any, any, SocketData> | undefined;
    const u = sock && getUser(sock.data.user.id);
    if (u && canSee(u, incidentId, 'channel', channelId)) sock!.join(`channel:${channelId}`);
  }
}

export function removeIncidentFromChannel(incidentId: string, channelId: string) {
  io.in(`incident:${incidentId}`).socketsLeave(`channel:${channelId}`);
}
