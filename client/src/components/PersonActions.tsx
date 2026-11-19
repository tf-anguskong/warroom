import { useEffect, useRef, useState } from 'react';
import { useModeration } from '../lib/moderation';
import type { IncidentState } from '../types';
import { useSignInCode } from './SignInCode';
import { Icons } from './ui';

type Person = { userId: string; displayName: string; voiceRoomId?: string | null; muted?: boolean };

/**
 * "⋯" menu on a person for the IC / room admins: move to a voice room, mute, remove from voice,
 * and a new sign-in code for someone who dropped off. `online` = connected to the room right now.
 */
export function PersonActions({ state, person, online = true }: { state: IncidentState; person: Person; online?: boolean }) {
  const mod = useModeration(state);
  const signIn = useSignInCode(state.incident.id);
  const codeBlock = state.members.find((m) => m.userId === person.userId)?.codeBlock;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (!mod.can) return null;
  const inVoice = Boolean(person.voiceRoomId);
  const rooms = online ? state.voiceRooms.filter((v) => v.id !== person.voiceRoomId) : [];
  const run = (fn: () => Promise<void>) => {
    setOpen(false);
    void fn();
  };

  return (
    <div className="menu-wrap person-actions" ref={ref}>
      <button
        className="icon-btn sm"
        title={`Actions for ${person.displayName}`}
        aria-label={`Actions for ${person.displayName}`}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        {Icons.more}
      </button>
      {open && (
        <div className="menu" role="menu">
          {rooms.length > 0 && <div className="menu-label">{inVoice ? 'Move to' : 'Ask to join'}</div>}
          {rooms.map((v) => (
            <button key={v.id} role="menuitem" onClick={() => run(() => mod.move(person.userId, v.id))}>
              {Icons.volume} {v.name}
            </button>
          ))}
          {inVoice && (
            <>
              <div className="menu-sep" />
              <button role="menuitem" disabled={person.muted} onClick={() => run(() => mod.mute(person.userId))}>
                {Icons.micOff} {person.muted ? 'Muted' : 'Mute microphone'}
              </button>
              <button role="menuitem" className="danger-text" onClick={() => run(() => mod.remove(person.userId))}>
                {Icons.phoneOff} Remove from voice
              </button>
            </>
          )}
          {codeBlock !== undefined && (
            <>
              {rooms.length > 0 && <div className="menu-sep" />}
              <button
                role="menuitem"
                disabled={codeBlock !== null}
                title={codeBlock ?? 'For someone who dropped off or is on a new device: a one-time code (and for a guest, a new link) you pass on to them'}
                onClick={() => run(async () => signIn.request(person.userId, person.displayName))}
              >
                {Icons.lock} New sign-in code
              </button>
              {codeBlock && <div className="menu-note">{codeBlock}</div>}
            </>
          )}
        </div>
      )}
      {signIn.dialog}
    </div>
  );
}
