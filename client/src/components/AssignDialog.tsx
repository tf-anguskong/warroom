import { useMemo, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { useModeration } from '../lib/moderation';
import type { IncidentState, Presence } from '../types';
import { Avatar, Modal } from './ui';
import { GuestTag } from './Guests';

export type AssignTarget = { kind: 'voice' | 'channel'; id: string };

export function targetLabel(state: IncidentState, t: AssignTarget) {
  if (t.kind === 'voice') return state.voiceRooms.find((v) => v.id === t.id)?.name ?? 'voice room';
  return `#${state.channels.find((c) => c.id === t.id)?.name ?? 'channel'}`;
}

/** Pick who works a voice room or channel, who leads it, and (voice) its objective. */
export function AssignDialog({
  state,
  presence,
  target,
  onClose,
}: {
  state: IncidentState;
  presence: Presence[];
  target: AssignTarget;
  onClose: () => void;
}) {
  const { users, me, toast } = useApp();
  const mod = useModeration(state);
  const current = state.assignments.filter((a) => a.targetKind === target.kind && a.targetId === target.id);
  const room = target.kind === 'voice' ? state.voiceRooms.find((v) => v.id === target.id) : undefined;
  const [picked, setPicked] = useState<string[]>(current.map((a) => a.userId));
  const [lead, setLead] = useState<string | null>(current.find((a) => a.lead)?.userId ?? null);
  const [objective, setObjective] = useState(room?.objective ?? '');
  const [moveNow, setMoveNow] = useState(true);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const label = targetLabel(state, target);

  const here = useMemo(() => new Map(presence.map((p) => [p.userId, p])), [presence]);
  const elsewhere = (userId: string) =>
    state.assignments
      .filter((a) => a.userId === userId && !(a.targetKind === target.kind && a.targetId === target.id))
      .map((a) => targetLabel(state, { kind: a.targetKind, id: a.targetId }));

  const list = users
    .filter((u) => !u.isGuest || u.guestIncidentId === state.incident.id)
    .filter((u) => !search.trim() || u.displayName.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => Number(picked.includes(b.id)) - Number(picked.includes(a.id)) || Number(here.has(b.id)) - Number(here.has(a.id)) || a.displayName.localeCompare(b.displayName));

  const toggle = (id: string) => {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
    if (lead === id) setLead(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.put(`/api/incidents/${state.incident.id}/assignments`, {
        targetKind: target.kind,
        targetId: target.id,
        userIds: picked,
        leadId: lead,
        ...(target.kind === 'voice' ? { objective } : {}),
      });
      if (target.kind === 'voice' && moveNow) {
        // Pull newly assigned people who are already in another voice room; others get an invite with the assignment.
        for (const id of picked) {
          const p = here.get(id);
          if (id !== me.id && p?.voiceRoomId && p.voiceRoomId !== target.id) await mod.move(id, target.id);
        }
      }
      toast({ text: `Assignments for ${label} saved` }, 2500);
      onClose();
    } catch (err) {
      toast({ text: err instanceof Error ? err.message : 'Could not save', tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Assign people to ${label}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" form="assign" disabled={busy}>
            Save assignments
          </button>
        </>
      }
    >
      <form id="assign" className="form assign-form" onSubmit={submit}>
        {target.kind === 'voice' && (
          <label>
            Objective
            <input
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              placeholder="e.g. Image the affected laptop and confirm initial access vector"
              maxLength={300}
            />
          </label>
        )}
        <div className="assign-head">
          <span>
            People <span className="muted">· {picked.length} assigned</span>
          </span>
          <input className="assign-search" placeholder="Find someone" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <ul className="assign-list">
          {list.map((u) => {
            const on = picked.includes(u.id);
            const p = here.get(u.id);
            const where = p ? (p.voiceRoomId ? `in ${state.voiceRooms.find((v) => v.id === p.voiceRoomId)?.name ?? 'voice'}` : 'in the war room') : 'not here';
            const other = elsewhere(u.id);
            return (
              <li key={u.id} className={on ? 'on' : ''}>
                <label className="assign-person">
                  <input type="checkbox" checked={on} onChange={() => toggle(u.id)} />
                  <Avatar id={u.id} name={u.displayName} size={24} />
                  <span>
                    {u.displayName}
                    {u.id === me.id && <span className="muted"> (you)</span>}
                    <GuestTag user={u} />
                    <div className="muted small">
                      {where}
                      {other.length > 0 && ` · also on ${other.join(', ')}`}
                    </div>
                  </span>
                </label>
                <label className={`lead-pick ${on ? '' : 'hidden'}`} title="The person accountable for this workstream">
                  <input type="radio" name="lead" checked={lead === u.id} disabled={!on} onChange={() => setLead(u.id)} /> Lead
                </label>
              </li>
            );
          })}
        </ul>
        {lead && (
          <button type="button" className="btn ghost sm" onClick={() => setLead(null)}>
            Clear lead
          </button>
        )}
        {target.kind === 'voice' && (
          <label className="check">
            <input type="checkbox" checked={moveNow} onChange={(e) => setMoveNow(e.target.checked)} /> Move assigned people who are in another voice room now
            (others get an invite)
          </label>
        )}
      </form>
    </Modal>
  );
}
