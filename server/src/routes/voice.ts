import { Router } from 'express';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import { config } from '../config.js';
import { q } from '../db.js';
import { emitToIncident, emitToUser, presenceFor, refreshIncident } from '../realtime.js';
import { getUser } from '../users.js';
import { canSee } from '../guests.js';
import { HttpError, mustIncident } from '../model.js';
import { requireControl } from '../permissions.js';
import { addTimeline } from '../timeline.js';
import { channelName, createChannel, createVoiceRoom } from '../rooms.js';
import { h, str } from './common.js';

/** Voice rooms (LiveKit): breakouts, tokens, calling everyone back, and moving, muting or removing people. */

export const router = Router();

const livekit = () => new RoomServiceClient(config.livekit.apiUrl, config.livekit.apiKey, config.livekit.apiSecret);

/** Where someone is in voice right now, if anywhere, for this incident. */
function voiceTarget(incidentId: string, userId: string) {
  const p = presenceFor(incidentId).find((x) => x.userId === userId);
  const room = p?.voiceRoomId
    ? q.get<{ id: string; name: string }>('SELECT id, name FROM voice_rooms WHERE id = ? AND incident_id = ?', p.voiceRoomId, incidentId)
    : undefined;
  return { present: Boolean(p), room };
}

// ---------- voice rooms ----------

router.post(
  '/incidents/:id/voice-rooms',
  h((req) => {
    const inc = mustIncident(req.params.id);
    const name = str(req.body?.name, 60);
    if (!name) throw new HttpError(400, 'name required');
    const id = createVoiceRoom(inc.id, req.user!.id, name, 'breakout');
    if (req.body?.withChannel !== false) {
      createChannel(inc.id, req.user!.id, channelName(name) || 'breakout', `Breakout: ${name}`, [id]);
    }
    addTimeline(inc.id, req.user!.id, 'voice', `Breakout room “${name}” opened`);
    refreshIncident(inc.id);
    return { id };
  }),
);

router.patch(
  '/voice-rooms/:id',
  h((req) => {
    const vr = q.get<{ id: string; incident_id: string; name: string; kind: string }>(
      'SELECT * FROM voice_rooms WHERE id = ?',
      req.params.id,
    );
    if (!vr) throw new HttpError(404, 'voice room not found');
    if (typeof req.body?.name === 'string' && str(req.body.name, 60)) {
      q.run('UPDATE voice_rooms SET name = ? WHERE id = ?', str(req.body.name, 60), vr.id);
    }
    if (req.body?.archived === true) {
      requireControl(req, vr.incident_id, 'close breakout rooms');
      if (vr.kind === 'main') throw new HttpError(400, 'cannot close the main bridge');
      q.run('UPDATE voice_rooms SET archived = 1 WHERE id = ?', vr.id);
      addTimeline(vr.incident_id, req.user!.id, 'voice', `Breakout room “${vr.name}” closed`);
    }
    refreshIncident(vr.incident_id);
    return { ok: true };
  }),
);

router.post(
  '/voice-rooms/:id/token',
  h(async (req) => {
    const vr = q.get<{ id: string; incident_id: string; name: string }>(
      'SELECT * FROM voice_rooms WHERE id = ? AND archived = 0',
      req.params.id,
    );
    if (!vr) throw new HttpError(404, 'voice room not found');
    const user = req.user!;
    const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
      identity: user.id,
      name: user.display_name,
      ttl: user.is_guest && user.guest_expires_at
        ? Math.max(60, Math.floor((new Date(user.guest_expires_at).getTime() - Date.now()) / 1000))
        : '6h',
      metadata: JSON.stringify({ incidentId: vr.incident_id, guest: Boolean(user.is_guest) }),
    });
    at.addGrant({
      room: `warroom-${vr.id}`,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    return { url: config.livekit.url, token: await at.toJwt(), roomName: vr.name };
  }),
);

/** IC can call everyone back to a room (e.g. the main bridge). */
router.post(
  '/voice-rooms/:id/summon',
  h((req) => {
    const vr = q.get<{ id: string; incident_id: string; name: string }>('SELECT * FROM voice_rooms WHERE id = ?', req.params.id);
    if (!vr) throw new HttpError(404, 'voice room not found');
    requireControl(req, vr.incident_id, 'call everyone to a room');
    emitToIncident(vr.incident_id, 'voice:summon', {
      voiceRoomId: vr.id,
      name: vr.name,
      by: req.user!.display_name,
    });
    addTimeline(vr.incident_id, req.user!.id, 'voice', `${req.user!.display_name} called everyone to ${vr.name}`);
    return { ok: true };
  }),
);

/** Move someone to a voice room. If they aren't in voice, they get an invitation instead. */
router.post(
  '/incidents/:id/voice/move',
  h((req) => {
    const inc = mustIncident(req.params.id);
    requireControl(req, inc.id, 'move people between voice rooms');
    const userId = str(req.body?.userId);
    const to = q.get<{ id: string; name: string }>(
      'SELECT id, name FROM voice_rooms WHERE id = ? AND incident_id = ? AND archived = 0',
      str(req.body?.voiceRoomId),
      inc.id,
    );
    if (!to) throw new HttpError(404, 'voice room not found');
    const target = getUser(userId);
    if (!target) throw new HttpError(404, 'user not found');
    const where = voiceTarget(inc.id, userId);
    if (!where.present) throw new HttpError(409, `${target.display_name} isn't in the war room right now`);
    if (!canSee(target, inc.id, 'voice', to.id)) {
      throw new HttpError(400, `${target.display_name} is a guest without access to ${to.name}; change their guest access first`);
    }
    if (where.room?.id === to.id) return { ok: true, moved: false, invited: false };
    emitToUser(userId, 'voice:moved', {
      incidentId: inc.id,
      voiceRoomId: to.id,
      name: to.name,
      by: req.user!.display_name,
      invite: !where.room,
    });
    return { ok: true, moved: Boolean(where.room), invited: !where.room };
  }),
);

/** Mute someone's microphone, turn off their camera (they can turn either back on) or remove them from voice. */
router.post(
  '/incidents/:id/voice/:action(mute|camera|remove)',
  h(async (req) => {
    const inc = mustIncident(req.params.id);
    const action = req.params.action as 'mute' | 'camera' | 'remove';
    requireControl(req, inc.id, action === 'mute' ? 'mute people' : action === 'camera' ? 'turn off people’s cameras' : 'remove people from voice');
    const userId = str(req.body?.userId);
    const target = getUser(userId);
    if (!target) throw new HttpError(404, 'user not found');
    const { room } = voiceTarget(inc.id, userId);
    if (!room) throw new HttpError(409, `${target.display_name} isn't in voice`);
    const lkRoom = `warroom-${room.id}`;
    try {
      if (action === 'remove') {
        await livekit().removeParticipant(lkRoom, userId);
      } else {
        const info = await livekit().getParticipant(lkRoom, userId);
        const source = action === 'camera' ? TrackSource.CAMERA : TrackSource.MICROPHONE;
        const track = info.tracks.find((t) => t.source === source && !t.muted);
        if (!track) return { ok: true, alreadyMuted: true };
        await livekit().mutePublishedTrack(lkRoom, userId, track.sid, true);
      }
    } catch (err) {
      console.error(`[voice] ${action} failed`, err);
      throw new HttpError(502, `Couldn't reach the voice server to ${action} ${target.display_name}`);
    }
    emitToUser(userId, action === 'mute' ? 'voice:muted' : action === 'camera' ? 'voice:camera-off' : 'voice:removed', {
      incidentId: inc.id,
      name: room.name,
      by: req.user!.display_name,
    });
    if (action === 'remove') {
      addTimeline(inc.id, req.user!.id, 'voice', `${target.display_name} was removed from ${room.name}`);
    }
    return { ok: true };
  }),
);
