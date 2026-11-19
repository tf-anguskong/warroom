import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { useApp } from '../lib/app';
import { useVoice } from '../lib/voice';
import type { Away, IncidentState } from '../types';
import { Icons } from './ui';

const z = (iso: string) => `${iso.slice(11, 16)}Z`;

/** This person's away status in this room, if they've stepped away. */
export const awayOf = (state: IncidentState, userId: string): Away | null => state.members.find((m) => m.userId === userId)?.away ?? null;

/** "Away · back ~10:30Z", "Away since 10:12Z", "Away · due back 10:30Z (12m ago)". */
export function awayText(a: Away, now = Date.now()) {
  const note = a.note ? ` · ${a.note}` : '';
  if (a.until) {
    const late = now - new Date(a.until).getTime();
    if (late > 60_000) return `Away${note} · was due back ${z(a.until)} (${Math.round(late / 60_000)}m ago)`;
    return `Away${note} · back ~${z(a.until)}`;
  }
  return `Away${note} · since ${z(a.since)}`;
}

export const isOverdue = (a: Away | null, now = Date.now()) => Boolean(a?.until && now - new Date(a.until).getTime() > 60_000);

const PRESETS = [
  { label: '5 min', minutes: 5 },
  { label: '15 min', minutes: 15 },
  { label: '30 min', minutes: 30 },
  { label: '1 hour', minutes: 60 },
  { label: 'Until I’m back', minutes: 0 },
];

async function setAway(incidentId: string, body: { away: boolean; note?: string; minutes?: number }) {
  await api.put(`/api/incidents/${incidentId}/away`, body);
}

/**
 * Top-bar "Step away" button. Going away mutes your microphone (if you're in voice); coming back
 * leaves it muted, so you never come back live by accident.
 */
export function AwayButton({ state }: { state: IncidentState }) {
  const { me, toast } = useApp();
  const voice = useVoice();
  const mine = awayOf(state, me.id);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [minutes, setMinutes] = useState(15);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const goAway = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    try {
      if (voice.roomId && !voice.muted) await voice.toggleMute();
      await setAway(state.incident.id, { away: true, note: note.trim(), minutes });
      setOpen(false);
      setNote('');
    } catch (x) {
      toast({ text: x instanceof ApiError ? x.message : 'Couldn’t set your status', tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const back = async () => {
    setBusy(true);
    try {
      await setAway(state.incident.id, { away: false });
      if (voice.roomId && voice.muted) toast({ text: 'Welcome back. Your microphone is still muted; unmute when you’re ready.' }, 6000);
    } finally {
      setBusy(false);
    }
  };

  if (mine) {
    return (
      <button className="btn sm away-on" onClick={back} disabled={busy} title={awayText(mine)}>
        {Icons.clock} I’m back
      </button>
    );
  }

  return (
    <div className="away-wrap" ref={box}>
      <button className="btn ghost sm" onClick={() => setOpen((o) => !o)} aria-expanded={open} title="Let the room know you’re away from your keyboard">
        {Icons.clock} Step away
      </button>
      {open && (
        <form className="away-pop" onSubmit={goAway}>
          <div className="small muted">Back in</div>
          <div className="away-presets">
            {PRESETS.map((p) => (
              <button type="button" key={p.label} className={`chip-btn ${minutes === p.minutes ? 'on' : ''}`} onClick={() => setMinutes(p.minutes)}>
                {p.label}
              </button>
            ))}
          </div>
          <label>
            <span className="small muted">Note (optional)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} placeholder="On a call with legal" autoFocus />
          </label>
          {voice.roomId && !voice.muted && <div className="small muted">Your microphone will be muted.</div>}
          <button className="btn primary sm" disabled={busy}>
            Step away
          </button>
        </form>
      )}
    </div>
  );
}

/** Shown to you while you're away, with a big "I'm back". */
export function AwayBanner({ state }: { state: IncidentState }) {
  const { me } = useApp();
  const mine = awayOf(state, me.id);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!mine) return null;
  return (
    <div className={`away-banner ${isOverdue(mine) ? 'late' : ''}`}>
      <span>
        {Icons.clock} <strong>You’re marked away.</strong> {awayText(mine).replace(/^Away( · )?/, '')}
      </span>
      <button className="btn primary sm" onClick={() => void setAway(state.incident.id, { away: false })}>
        I’m back
      </button>
    </div>
  );
}
