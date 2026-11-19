import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ConnectionQuality,
  Room,
  RoomEvent,
  Track,
  type Participant,
  type RemoteTrack,
} from 'livekit-client';
import { api } from './api';
import { getSocket } from './socket';

export interface VoiceParticipant {
  identity: string;
  name: string;
  speaking: boolean;
  micOn: boolean;
  sharing: boolean;
  isLocal: boolean;
  quality: ConnectionQuality;
}

export interface ScreenShare {
  identity: string;
  name: string;
  track: Track;
  isLocal: boolean;
}

type Status = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

interface VoiceContextValue {
  roomId: string | null;
  status: Status;
  error: string | null;
  participants: VoiceParticipant[];
  screenShares: ScreenShare[];
  muted: boolean;
  deafened: boolean;
  sharing: boolean;
  listenOnly: boolean;
  quality: ConnectionQuality;
  join: (voiceRoomId: string) => Promise<void>;
  leave: () => Promise<void>;
  toggleMute: () => Promise<void>;
  toggleDeafen: () => Promise<void>;
  toggleShare: () => Promise<void>;
}

const VoiceContext = createContext<VoiceContextValue | null>(null);

export function useVoice() {
  const ctx = useContext(VoiceContext);
  if (!ctx) throw new Error('useVoice outside VoiceProvider');
  return ctx;
}

const toParticipant = (p: Participant, isLocal: boolean): VoiceParticipant => ({
  identity: p.identity,
  name: p.name || p.identity,
  speaking: p.isSpeaking,
  micOn: p.isMicrophoneEnabled,
  sharing: p.isScreenShareEnabled,
  isLocal,
  quality: p.connectionQuality,
});

export function VoiceProvider({ children }: { children: ReactNode }) {
  const roomRef = useRef<Room | null>(null);
  const audioHost = useRef<HTMLDivElement>(null);
  const deafRef = useRef(false);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [deafened, setDeafened] = useState(false);
  const [listenOnly, setListenOnly] = useState(false);
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const reportPresence = useCallback(() => {
    const room = roomRef.current;
    const lp = room?.localParticipant;
    getSocket().emit('presence:update', {
      voiceRoomId: room ? roomIdRef.current : null,
      muted: lp ? !lp.isMicrophoneEnabled || deafRef.current : false,
      sharing: lp ? lp.isScreenShareEnabled : false,
    });
  }, []);
  const roomIdRef = useRef<string | null>(null);

  const leave = useCallback(async () => {
    const room = roomRef.current;
    roomRef.current = null;
    roomIdRef.current = null;
    setRoomId(null);
    setStatus('idle');
    setListenOnly(false);
    if (room) await room.disconnect();
    audioHost.current?.replaceChildren();
    reportPresence();
    bump();
  }, [bump, reportPresence]);

  const join = useCallback(
    async (voiceRoomId: string) => {
      if (roomIdRef.current === voiceRoomId && roomRef.current) return;
      if (roomRef.current) await leave();
      setStatus('connecting');
      setError(null);
      try {
        const { url, token } = await api.post<{ url: string; token: string }>(`/api/voice-rooms/${voiceRoomId}/token`);
        const room = new Room({
          adaptiveStream: true,
          dynacast: true,
          audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        room
          .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
            if (track.kind === Track.Kind.Audio) {
              const el = track.attach();
              el.muted = deafRef.current;
              audioHost.current?.appendChild(el);
            }
            bump();
          })
          .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
            track.detach().forEach((el) => el.remove());
            bump();
          })
          .on(RoomEvent.Reconnecting, () => setStatus('reconnecting'))
          .on(RoomEvent.Reconnected, () => setStatus('connected'))
          .on(RoomEvent.Disconnected, () => {
            if (roomRef.current === room) {
              roomRef.current = null;
              roomIdRef.current = null;
              setRoomId(null);
              setStatus('idle');
              audioHost.current?.replaceChildren();
              reportPresence();
            }
            bump();
          })
          // An admin can mute us from the server; keep presence (and the dock) in step.
          .on(RoomEvent.TrackMuted, () => reportPresence())
          .on(RoomEvent.TrackUnmuted, () => reportPresence())
          .on(RoomEvent.LocalTrackPublished, () => {
            reportPresence();
            bump();
          })
          .on(RoomEvent.LocalTrackUnpublished, () => {
            reportPresence();
            bump();
          });
        for (const ev of [
          RoomEvent.ParticipantConnected,
          RoomEvent.ParticipantDisconnected,
          RoomEvent.ActiveSpeakersChanged,
          RoomEvent.TrackMuted,
          RoomEvent.TrackUnmuted,
          RoomEvent.TrackPublished,
          RoomEvent.TrackUnpublished,
          RoomEvent.ConnectionQualityChanged,
        ]) {
          room.on(ev, bump);
        }

        await room.connect(url, token);
        roomRef.current = room;
        roomIdRef.current = voiceRoomId;
        setRoomId(voiceRoomId);
        setStatus('connected');
        await room.startAudio().catch(() => undefined);
        try {
          await room.localParticipant.setMicrophoneEnabled(true);
          setListenOnly(false);
        } catch {
          setListenOnly(true); // no mic or permission denied: still hear the room
        }
        reportPresence();
        bump();
      } catch (err) {
        console.error('[voice] join failed', err);
        roomRef.current = null;
        roomIdRef.current = null;
        setRoomId(null);
        setStatus('error');
        setError(err instanceof Error ? err.message : 'Could not connect to voice');
      }
    },
    [bump, leave, reportPresence],
  );

  const toggleMute = useCallback(async () => {
    const lp = roomRef.current?.localParticipant;
    if (!lp) return;
    if (deafRef.current && !lp.isMicrophoneEnabled) {
      // Unmuting while deafened: hear the room again too.
      deafRef.current = false;
      setDeafened(false);
      audioHost.current?.querySelectorAll('audio').forEach((el) => (el.muted = false));
    }
    try {
      await lp.setMicrophoneEnabled(!lp.isMicrophoneEnabled);
      setListenOnly(false);
    } catch {
      setListenOnly(true);
    }
    reportPresence();
    bump();
  }, [bump, reportPresence]);

  // Deafen also mutes the mic; un-deafen puts the mic back the way it was (like Discord/Zoom).
  const micBeforeDeafen = useRef(false);
  const toggleDeafen = useCallback(async () => {
    deafRef.current = !deafRef.current;
    setDeafened(deafRef.current);
    audioHost.current?.querySelectorAll('audio').forEach((el) => (el.muted = deafRef.current));
    const lp = roomRef.current?.localParticipant;
    if (lp) {
      if (deafRef.current) {
        micBeforeDeafen.current = lp.isMicrophoneEnabled;
        if (lp.isMicrophoneEnabled) await lp.setMicrophoneEnabled(false).catch(() => undefined);
      } else if (micBeforeDeafen.current) {
        try {
          await lp.setMicrophoneEnabled(true);
          setListenOnly(false);
        } catch {
          setListenOnly(true);
        }
      }
    }
    reportPresence();
    bump();
  }, [bump, reportPresence]);

  const toggleShare = useCallback(async () => {
    const lp = roomRef.current?.localParticipant;
    if (!lp) return;
    try {
      await lp.setScreenShareEnabled(!lp.isScreenShareEnabled, { audio: true, selfBrowserSurface: 'exclude' });
    } catch (err) {
      console.warn('[voice] screen share cancelled or failed', err);
    }
    reportPresence();
    bump();
  }, [bump, reportPresence]);

  // Ctrl/Cmd+Shift+M toggles mute.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        void toggleMute();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleMute]);

  useEffect(() => () => void roomRef.current?.disconnect(), []);

  const value = useMemo<VoiceContextValue>(() => {
    const room = roomRef.current;
    const participants: VoiceParticipant[] = [];
    const screenShares: ScreenShare[] = [];
    if (room) {
      const all: [Participant, boolean][] = [
        [room.localParticipant, true],
        ...[...room.remoteParticipants.values()].map((p) => [p, false] as [Participant, boolean]),
      ];
      for (const [p, isLocal] of all) {
        participants.push(toParticipant(p, isLocal));
        const pub = p.getTrackPublication(Track.Source.ScreenShare);
        if (pub?.track && !pub.isMuted) {
          screenShares.push({ identity: p.identity, name: p.name || p.identity, track: pub.track, isLocal });
        }
      }
    }
    const lp = room?.localParticipant;
    return {
      roomId,
      status,
      error,
      participants,
      screenShares,
      muted: lp ? !lp.isMicrophoneEnabled : true,
      deafened,
      sharing: lp ? lp.isScreenShareEnabled : false,
      listenOnly,
      quality: lp?.connectionQuality ?? ConnectionQuality.Unknown,
      join,
      leave,
      toggleMute,
      toggleDeafen,
      toggleShare,
    };
    // version drives recomputation from the mutable LiveKit room
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, roomId, status, error, deafened, listenOnly, join, leave, toggleMute, toggleDeafen, toggleShare]);

  return (
    <VoiceContext.Provider value={value}>
      {children}
      <div ref={audioHost} hidden aria-hidden />
    </VoiceContext.Provider>
  );
}
