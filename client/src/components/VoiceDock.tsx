import { ConnectionQuality } from 'livekit-client';
import { useVoice } from '../lib/voice';
import type { IncidentState } from '../types';
import { Icons } from './ui';

const QUALITY: Record<string, { label: string; bars: number }> = {
  [ConnectionQuality.Excellent]: { label: 'Excellent connection', bars: 3 },
  [ConnectionQuality.Good]: { label: 'Good connection', bars: 2 },
  [ConnectionQuality.Poor]: { label: 'Poor connection', bars: 1 },
  [ConnectionQuality.Lost]: { label: 'Connection lost', bars: 0 },
  [ConnectionQuality.Unknown]: { label: 'Measuring connection', bars: 3 },
};

export function VoiceDock({ state, onJoin }: { state: IncidentState; onJoin: (voiceRoomId: string) => void }) {
  const v = useVoice();
  const joinMain = () => state.voiceRooms[0] && onJoin(state.voiceRooms[0].id);
  const room = state.voiceRooms.find((r) => r.id === v.roomId);

  if (v.status === 'error') {
    return (
      <div className="voice-dock error">
        <div>
          <strong>Voice unavailable</strong>
          <div className="muted small">{v.error}</div>
        </div>
        <button className="btn secondary sm" onClick={joinMain}>
          Retry
        </button>
      </div>
    );
  }

  if (!v.roomId) {
    return (
      <div className="voice-dock idle">
        {v.status === 'connecting' ? (
          <span className="muted">Connecting to voice…</span>
        ) : (
          <button className="btn primary block" onClick={joinMain}>
            {Icons.volume} Join {state.voiceRooms[0]?.name ?? 'voice'}
          </button>
        )}
      </div>
    );
  }

  const q = QUALITY[v.quality] ?? QUALITY[ConnectionQuality.Unknown];
  const micOff = v.muted || v.deafened;

  return (
    <div className={`voice-dock live ${micOff ? 'is-muted' : ''}`}>
      <div className="vd-top">
        <span className={`bars b${q.bars}`} title={q.label} aria-label={q.label}>
          <i />
          <i />
          <i />
        </span>
        <div className="vd-room">
          <strong>{v.status === 'reconnecting' ? 'Reconnecting…' : 'Voice connected'}</strong>
          <span className="muted small">{room?.name}</span>
        </div>
      </div>
      {v.listenOnly && <div className="vd-note">Listen-only: no microphone available</div>}
      <div className="vd-controls">
        <button
          className={`vd-btn ${micOff ? 'off' : ''}`}
          onClick={v.toggleMute}
          aria-pressed={micOff}
          title={micOff ? 'Unmute (Ctrl+Shift+M)' : 'Mute (Ctrl+Shift+M)'}
          disabled={v.deafened}
        >
          {micOff ? Icons.micOff : Icons.mic}
          <span>{micOff ? 'Muted' : 'Mic on'}</span>
        </button>
        <button className={`vd-btn ${v.deafened ? 'off' : ''}`} onClick={v.toggleDeafen} aria-pressed={v.deafened} title={v.deafened ? 'Undeafen' : 'Deafen'}>
          {v.deafened ? Icons.headphonesOff : Icons.headphones}
          <span>{v.deafened ? 'Deaf' : 'Audio'}</span>
        </button>
        <button className={`vd-btn ${v.sharing ? 'on' : ''}`} onClick={v.toggleShare} aria-pressed={v.sharing} title={v.sharing ? 'Stop sharing' : 'Share screen'}>
          {Icons.screen}
          <span>{v.sharing ? 'Sharing' : 'Share'}</span>
        </button>
        <button className="vd-btn leave" onClick={v.leave} title="Leave voice">
          {Icons.phoneOff}
          <span>Leave</span>
        </button>
      </div>
    </div>
  );
}
