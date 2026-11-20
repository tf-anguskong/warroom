import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { play } from '../lib/sounds';
import type { IncidentState } from '../types';
import { responderBlock, ScopePicker, type Scope } from './Guests';
import { Modal } from './ui';

type Req = NonNullable<IncidentState['joinRequests']>[number];

const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 1 ? 'just now' : `${m}m ago`;
};

/**
 * People asking to join from the war room link. Only the IC, room admins and admins see these;
 * they let each person in as a responder or a guest, or turn them down. All of it goes on the timeline.
 */
export function JoinRequests({ state }: { state: IncidentState }) {
  const { toast, me, meta } = useApp();
  const noResponders = responderBlock(me.isAdmin, meta);
  const requests = state.joinRequests ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const [asGuest, setAsGuest] = useState<Req | null>(null);
  const seen = useRef<Set<string> | null>(null);

  // A new request: a sound and a toast, so nobody has to watch the panel.
  useEffect(() => {
    const ids = new Set(requests.map((r) => r.id));
    if (seen.current) {
      const fresh = requests.filter((r) => !seen.current!.has(r.id));
      if (fresh.length) {
        play('summon');
        toast({ text: `${fresh.map((r) => r.name).join(', ')} ${fresh.length === 1 ? 'is' : 'are'} asking to join` }, 6000);
      }
    }
    seen.current = ids;
  }, [requests, toast]);

  if (!state.canControl || !requests.length) return null;

  const answer = async (r: Req, path: 'admit' | 'deny', body: object, done: string) => {
    setBusy(r.id);
    try {
      await api.post(`/api/incidents/${state.incident.id}/join-requests/${r.id}/${path}`, body);
      toast({ text: done }, 4000);
      return true;
    } catch (e) {
      toast({ text: e instanceof Error ? e.message : 'That didn’t work', tone: 'error' }, 6000);
      return false;
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="join-requests">
      <h3>Asking to join</h3>
      <ul className="command-requests">
        {requests.map((r) => (
          <li key={r.id}>
            <span className="grow">
              <strong>{r.name}</strong>
              {r.org && <span className="muted"> · {r.org}</span>} <span className="muted small">{ago(r.createdAt)}</span>
              <div className="small mono">{r.email}</div>
              {r.note && <div className="small">“{r.note}”</div>}
            </span>
            <span className="row gap-sm wrap">
              <button className="btn primary sm" disabled={busy === r.id || Boolean(noResponders)} title={noResponders ?? undefined} onClick={() => answer(r, 'admit', { kind: 'member' }, `Letting ${r.name} in as a responder`)}>
                Let in as responder
              </button>
              <button className="btn secondary sm" disabled={busy === r.id} onClick={() => setAsGuest(r)}>
                As guest…
              </button>
              <button className="btn ghost sm" disabled={busy === r.id} onClick={() => answer(r, 'deny', {}, `Turned down ${r.name}`)}>
                Turn down
              </button>
            </span>
          </li>
        ))}
      </ul>
      {noResponders && <p className="muted small">{noResponders}</p>}
      <p className="muted small">
        Not sure who they are? Check with them another way before letting them in. Responders see the whole room; guests see only what you tick.
      </p>
      {asGuest && (
        <GuestDialog
          state={state}
          req={asGuest}
          busy={busy === asGuest.id}
          onClose={() => setAsGuest(null)}
          onAdmit={async (scope, accessHours) => {
            if (await answer(asGuest, 'admit', { kind: 'guest', scope, accessHours }, `Letting ${asGuest.name} in as a guest`)) setAsGuest(null);
          }}
        />
      )}
    </section>
  );
}

function GuestDialog({ state, req, busy, onClose, onAdmit }: { state: IncidentState; req: Req; busy: boolean; onClose: () => void; onAdmit: (s: Scope, h: number) => void }) {
  const main = state.voiceRooms.find((v) => v.kind === 'main');
  const general = state.channels.find((c) => c.name === 'general') ?? state.channels[0];
  const [scope, setScope] = useState<Scope>({ channels: general ? [general.id] : [], voiceRooms: main ? [main.id] : [], sheets: [], notes: [], timeline: false, agents: false });
  const [hours, setHours] = useState(12);
  const nothing = !scope.channels.length && !scope.voiceRooms.length && !scope.sheets.length && !scope.notes.length;
  return (
    <Modal
      title={`Let ${req.name} in as a guest`}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || nothing} onClick={() => onAdmit(scope, hours)}>
            Let in as guest
          </button>
        </>
      }
    >
      <div className="form">
        <p className="muted small">
          {req.name}
          {req.org ? ` (${req.org})` : ''} sees only what you tick, and everyone in the room sees they’re a guest.
        </p>
        <ScopePicker state={state} scope={scope} onChange={setScope} />
        <label>
          Access lasts
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            {[2, 4, 8, 12, 24, 72].map((h) => (
              <option key={h} value={h}>
                {h} hours after joining
              </option>
            ))}
          </select>
        </label>
        {nothing && <div className="warn-text small">Tick at least one channel, voice room, sheet or note.</div>}
      </div>
    </Modal>
  );
}
