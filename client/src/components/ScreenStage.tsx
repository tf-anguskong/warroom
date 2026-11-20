import { useEffect, useRef, useState } from 'react';
import type { Track } from 'livekit-client';
import { useVoice, type CameraFeed } from '../lib/voice';
import { Avatar, Icons } from './ui';

/** Most camera tiles shown at once; the rest are listed by name (speakers and you come first). */
const MAX_CAMERAS = 12;

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

function CameraTile({ feed }: { feed: CameraFeed }) {
  const ref = useRef<HTMLVideoElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    feed.track.attach(el);
    return () => {
      feed.track.detach(el);
    };
  }, [feed.track]);
  return (
    <div className={`cam-tile ${feed.speaking ? 'speaking' : ''} ${feed.isLocal ? 'local' : ''}`} ref={wrap}>
      {/* Audio plays separately; the video element is always muted. Your own view is mirrored, like a mirror. */}
      <video ref={ref} autoPlay playsInline muted />
      <div className="cam-label">
        {!feed.micOn && <span className="cam-muted" title="Microphone off">{Icons.micOff}</span>}
        {feed.isLocal ? `${feed.name} (you)` : feed.name}
      </div>
      <button className="icon-btn share-full" title="Full screen" aria-label={`Show ${feed.name} full screen`} onClick={() => wrap.current?.requestFullscreen()}>
        {Icons.expand}
      </button>
    </div>
  );
}

export function ScreenStage() {
  const { screenShares, cameras } = useVoice();
  const [collapsed, setCollapsed] = useState(false);
  if (!screenShares.length && !cameras.length) return null;
  // You first, then whoever is talking, then everyone else in a stable order.
  const sorted = [...cameras].sort((a, b) => Number(b.isLocal) - Number(a.isLocal) || Number(b.speaking) - Number(a.speaking) || a.name.localeCompare(b.name));
  const shown = sorted.slice(0, MAX_CAMERAS);
  const hidden = sorted.slice(MAX_CAMERAS);
  const title = [
    screenShares.length ? `Screen share${screenShares.length > 1 ? `s (${screenShares.length})` : ''}` : null,
    cameras.length ? `${cameras.length} camera${cameras.length > 1 ? 's' : ''}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <section className={`stage ${collapsed ? 'collapsed' : ''} ${screenShares.length ? 'has-share' : 'cams-only'}`}>
      <div className="stage-head">
        <span>
          {screenShares.length ? Icons.screen : Icons.camera} {title}
        </span>
        <button className="btn ghost sm" onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? 'Show' : 'Hide'}
        </button>
      </div>
      {!collapsed && (
        <>
          {screenShares.length > 0 && (
            <div className={`stage-grid n${Math.min(screenShares.length, 4)}`}>
              {screenShares.map((s) => (
                <ShareTile key={s.identity + s.track.sid} track={s.track} name={s.name} isLocal={s.isLocal} />
              ))}
            </div>
          )}
          {shown.length > 0 && (
            <div className={`cam-grid ${screenShares.length ? 'strip' : `n${Math.min(shown.length, 6)}`}`}>
              {shown.map((f) => (
                <CameraTile key={f.identity + f.track.sid} feed={f} />
              ))}
              {hidden.length > 0 && (
                <div className="cam-more" title={hidden.map((h) => h.name).join(', ')}>
                  <div className="cam-more-avatars">
                    {hidden.slice(0, 3).map((h) => (
                      <Avatar key={h.identity} id={h.identity} name={h.name} size={24} />
                    ))}
                  </div>
                  +{hidden.length} more
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
