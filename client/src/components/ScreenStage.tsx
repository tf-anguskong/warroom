import { useEffect, useRef, useState } from 'react';
import type { Track } from 'livekit-client';
import { useVoice } from '../lib/voice';
import { Icons } from './ui';

function ShareTile({ track, name, isLocal }: { track: Track; name: string; isLocal: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  return (
    <div className="share-tile" ref={wrap}>
      <video ref={ref} autoPlay playsInline muted />
      <div className="share-label">
        {Icons.screen} {isLocal ? 'You are sharing' : `${name} is sharing`}
      </div>
      <button className="icon-btn share-full" title="Full screen" aria-label="Full screen" onClick={() => wrap.current?.requestFullscreen()}>
        {Icons.expand}
      </button>
    </div>
  );
}

export function ScreenStage() {
  const { screenShares } = useVoice();
  const [collapsed, setCollapsed] = useState(false);
  if (!screenShares.length) return null;
  return (
    <section className={`stage ${collapsed ? 'collapsed' : ''}`}>
      <div className="stage-head">
        <span>
          {Icons.screen} Screen share{screenShares.length > 1 ? `s (${screenShares.length})` : ''}
        </span>
        <button className="btn ghost sm" onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? 'Show' : 'Hide'}
        </button>
      </div>
      {!collapsed && (
        <div className={`stage-grid n${Math.min(screenShares.length, 4)}`}>
          {screenShares.map((s) => (
            <ShareTile key={s.identity + s.track.sid} track={s.track} name={s.name} isLocal={s.isLocal} />
          ))}
        </div>
      )}
    </section>
  );
}
