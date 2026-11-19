import { useEffect, useState, type DragEvent } from 'react';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { useVoice } from '../lib/voice';
import { PERSON_DRAG } from '../lib/moderation';
import { PersonActions } from './PersonActions';
import type { IncidentState, Presence } from '../types';
import { Avatar, Icons, Modal } from './ui';
import { GuestsSection, GuestTag } from './Guests';
import { awayText } from './Away';

export function DetailsPanel({ state, presence }: { state: IncidentState; presence: Presence[] }) {
  const { meta, users, me, toast, userById } = useApp();
  const voice = useVoice();
  const [summary, setSummary] = useState(state.incident.summary);
  const [editing, setEditing] = useState(false);
  const [handoff, setHandoff] = useState(false);
  useEffect(() => {
    if (!editing) setSummary(state.incident.summary);
  }, [state.incident.summary, editing]);

  const speaking = new Set(voice.participants.filter((p) => p.speaking).map((p) => p.identity));
  const roomName = (id: string | null) => state.voiceRooms.find((v) => v.id === id)?.name;

  const assign = (role: string, userId: string) =>
    api.put(`/api/incidents/${state.incident.id}/roles/${role}`, { userId: userId || null }).catch((e) => toast({ text: e.message, tone: 'error' }));

  const setRoomAdmin = (userId: string, admin: boolean) =>
    api.put(`/api/incidents/${state.incident.id}/room-admins/${userId}`, { admin }).catch((e) => toast({ text: e.message, tone: 'error' }));
  const ic = state.roles.find((r) => r.role === 'commander')?.userId ?? null;
  const lockedHint = 'Only the Incident Commander or a room admin can change this';

  const groups = new Map<string, Presence[]>();
  for (const p of presence) {
    const k = p.voiceRoomId ?? '';
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }

  return (
    <div className="details">
      <section>
        <div className="section-head">
          <h3>Summary</h3>
          {!editing && !me.isGuest && (
            <button className="btn ghost sm" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
        </div>
        {editing ? (
          <div className="form">
            <textarea rows={6} autoFocus value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Impact, scope, current hypothesis, next update time" />
            <div className="row end">
              <button className="btn ghost sm" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button
                className="btn primary sm"
                onClick={async () => {
                  await api.patch(`/api/incidents/${state.incident.id}`, { summary });
                  setEditing(false);
                }}
              >
                Save
              </button>
            </div>
          </div>
        ) : state.incident.summary ? (
          <p className="summary-text">{state.incident.summary}</p>
        ) : (
          <p className="muted">No summary yet. Capture impact, scope and the current hypothesis.</p>
        )}
      </section>

      <section>
        <h3>Incident Command</h3>
        <div className={`command-card ${ic ? '' : 'gap'}`}>
          {ic ? (
            <>
              <Avatar id={ic} name={userById(ic)?.displayName ?? '?'} size={28} speaking={speaking.has(ic)} />
              <span className="command-name">
                {userById(ic)?.displayName}
                {ic === me.id && <span className="muted"> (you)</span>}
                <div className="muted small">Incident Commander</div>
              </span>
            </>
          ) : (
            <span className="warn-text">No Incident Commander</span>
          )}
          {!me.isGuest && state.canControl && (
            <button className={`btn ${ic ? 'secondary' : 'primary'} sm`} onClick={() => setHandoff(true)}>
              {ic === me.id ? 'Hand off' : ic ? 'Reassign' : 'Assign'}
            </button>
          )}
          {!me.isGuest && !state.canControl && !ic && (
            <button className="btn primary sm" onClick={() => setHandoff(true)}>
              Take command
            </button>
          )}
        </div>
        <CommandRequests state={state} />
      </section>

      <section>
        <h3>Roles</h3>
        <div className="roles">
          {meta.roles
            .filter((r) => r.key !== 'commander')
            .map((r) => {
            const assigned = state.roles.find((x) => x.role === r.key)?.userId ?? '';
            return (
              <label key={r.key} className={`role ${assigned ? '' : 'gap'}`} title={state.canControl ? undefined : lockedHint}>
                <span className="role-name">{r.label}</span>
                <select value={assigned} disabled={!state.canControl} onChange={(e) => assign(r.key, e.target.value)}>
                  <option value="">— unassigned —</option>
                  {users.filter((u) => !u.isGuest || u.guestIncidentId === state.incident.id).map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.displayName}
                      {u.id === me.id ? ' (you)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
        </div>
      </section>

      <section>
        <div className="section-head">
          <h3>Room admins</h3>
          {!state.canControl && <span className="muted small">{Icons.shield} view only</span>}
        </div>
        <p className="muted small hint-text">
          The Incident Commander and room admins run the room: assign roles, change severity and status, move people between voice rooms,
          mute or remove them from voice, and call everyone back.
        </p>
        <ul className="room-admins">
          {ic && (
            <li>
              <Avatar id={ic} name={userById(ic)?.displayName ?? '?'} size={20} />
              <span>{userById(ic)?.displayName}</span>
              <span className="tag">IC</span>
            </li>
          )}
          {state.roomAdmins
            .filter((id) => id !== ic)
            .map((id) => (
              <li key={id}>
                <Avatar id={id} name={userById(id)?.displayName ?? '?'} size={20} />
                <span>
                  {userById(id)?.displayName ?? 'Unknown'}
                  {id === me.id && <span className="muted"> (you)</span>}
                </span>
                {state.canControl && (
                  <button className="icon-btn sm" title="Remove room admin" aria-label={`Remove ${userById(id)?.displayName} as room admin`} onClick={() => setRoomAdmin(id, false)}>
                    ×
                  </button>
                )}
              </li>
            ))}
          {!ic && state.roomAdmins.length === 0 && <li className="muted small">Nobody yet, so anyone here can run the room. Assign an IC.</li>}
        </ul>
        {state.canControl && (
          <select className="add-room-admin" value="" onChange={(e) => e.target.value && setRoomAdmin(e.target.value, true)} aria-label="Add room admin">
            <option value="">+ Add room admin…</option>
            {users
              .filter((u) => u.id !== ic && !state.roomAdmins.includes(u.id) && !u.isGuest)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName}
                  {u.id === me.id ? ' (you)' : ''}
                </option>
              ))}
          </select>
        )}
      </section>

      <GuestsSection state={state} />

      <section>
        <h3>
          In the room <span className="count">{presence.length}</span>
        </h3>
        {[...groups.entries()]
          .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : 0))
          .map(([roomId, people]) => (
            <div key={roomId} className="people-group">
              <div className="people-group-head">
                {roomId ? (
                  <>
                    {Icons.volume} {roomName(roomId) ?? 'Voice'}
                  </>
                ) : (
                  'Not in voice'
                )}
              </div>
              <ul className="people">
                {people.map((p) => {
                  const roles = state.roles.filter((r) => r.userId === p.userId).map((r) => meta.roles.find((m) => m.key === r.role)?.label);
                  return (
                    <li
                      key={p.userId}
                      className={state.canControl && p.userId !== me.id ? 'movable' : ''}
                      draggable={state.canControl && p.userId !== me.id}
                      onDragStart={(e: DragEvent) => e.dataTransfer.setData(PERSON_DRAG, p.userId)}
                    >
                      <Avatar id={p.userId} name={p.displayName} size={24} speaking={speaking.has(p.userId)} muted={!!p.voiceRoomId && p.muted} away={Boolean(p.away)} />
                      <span>
                        {p.displayName}
                        {p.away && <div className="away-line">{awayText(p.away)}</div>}
                        {roles.length > 0 && <small className="muted"> · {roles.join(', ')}</small>}
                        <GuestTag user={userById(p.userId)} />
                        {state.roomAdmins.includes(p.userId) && <small className="muted"> · room admin</small>}
                        {state.members.find((m) => m.userId === p.userId)?.task && (
                          <div className="person-task">{state.members.find((m) => m.userId === p.userId)!.task}</div>
                        )}
                      </span>
                      {p.userId !== me.id && <PersonActions state={state} person={p} />}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
      </section>
      {handoff && <CommandDialog state={state} presence={presence} current={ic} onClose={() => setHandoff(false)} />}
    </div>
  );
}

/** Hand Incident Command to someone (or take it). Loud on purpose: announced, notified, on the timeline. */
/**
 * Asking for command, and answering those asks. Only the IC, room admins and admins can hand command
 * to someone; everyone else asks, and the IC sees the request here with Hand over / Decline.
 */
function CommandRequests({ state }: { state: IncidentState }) {
  const { me, userById, toast } = useApp();
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const ic = state.roles.find((r) => r.role === 'commander')?.userId ?? null;
  const requests = state.commandRequests ?? [];
  const mine = requests.find((r) => r.userId === me.id);
  const ago = (iso: string) => {
    const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`;
  };
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast({ text: done }, 4000);
    } catch (e) {
      toast({ text: e instanceof Error ? e.message : 'That didn’t work', tone: 'error' }, 6000);
    } finally {
      setBusy(false);
    }
  };

  if (me.isGuest) return null;

  // People who run the room see who's asking.
  if (state.canControl) {
    if (!requests.length) return null;
    return (
      <ul className="command-requests">
        {requests.map((r) => (
          <li key={r.userId}>
            <span className="grow">
              <strong>{userById(r.userId)?.displayName ?? 'Someone'}</strong> asked for command <span className="muted small">{ago(r.requestedAt)}</span>
              {r.note && <div className="small">“{r.note}”</div>}
            </span>
            <span className="row gap-sm">
              <button
                className="btn primary sm"
                disabled={busy}
                onClick={() => run(() => api.put(`/api/incidents/${state.incident.id}/roles/commander`, { userId: r.userId, note: 'Handed over on request' }), `${userById(r.userId)?.displayName} is now Incident Commander`)}
              >
                Hand over
              </button>
              <button className="btn ghost sm" disabled={busy} onClick={() => run(() => api.post(`/api/incidents/${state.incident.id}/command/decline`, { userId: r.userId }), 'Request declined')}>
                Decline
              </button>
            </span>
          </li>
        ))}
      </ul>
    );
  }

  // Everyone else can ask (when there is an IC to ask).
  if (!ic || ic === me.id) return null;
  if (mine) {
    return (
      <div className="command-ask muted small">
        You asked for command {ago(mine.requestedAt)}. Waiting for {userById(ic)?.displayName ?? 'the Incident Commander'}.
      </div>
    );
  }
  return asking ? (
    <form
      className="command-ask form"
      onSubmit={(e) => {
        e.preventDefault();
        void run(() => api.post(`/api/incidents/${state.incident.id}/command/request`, { note: note.trim() }), `Asked ${userById(ic)?.displayName ?? 'the Incident Commander'} for command`).then(() => {
          setAsking(false);
          setNote('');
        });
      }}
    >
      <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Why (optional): e.g. Sam’s shift is ending" autoFocus />
      <span className="row gap-sm">
        <button className="btn primary sm" disabled={busy}>
          Send request
        </button>
        <button type="button" className="btn ghost sm" onClick={() => setAsking(false)}>
          Cancel
        </button>
      </span>
    </form>
  ) : (
    <button className="btn ghost sm take-command" onClick={() => setAsking(true)} title={`Ask ${userById(ic)?.displayName ?? 'the Incident Commander'} to hand command to you`}>
      Request command
    </button>
  );
}

function CommandDialog({ state, presence, current, onClose }: { state: IncidentState; presence: Presence[]; current: string | null; onClose: () => void }) {
  const { users, me, toast, userById } = useApp();
  const [to, setTo] = useState(current === me.id ? '' : me.id);
  const [note, setNote] = useState('');
  const here = new Set(presence.map((p) => p.userId));
  const people = users
    .filter((u) => !u.isGuest && u.id !== current && (state.canControl || u.id === me.id))
    .sort((a, b) => Number(here.has(b.id)) - Number(here.has(a.id)) || a.displayName.localeCompare(b.displayName));
  const save = async () => {
    try {
      await api.put(`/api/incidents/${state.incident.id}/roles/commander`, { userId: to || null, note });
      toast({ text: to === me.id ? 'You are now Incident Commander' : `${userById(to)?.displayName} is now Incident Commander` }, 4000);
      onClose();
    } catch (e) {
      toast({ text: e instanceof Error ? e.message : 'Could not change command', tone: 'error' });
    }
  };
  return (
    <Modal
      title={current ? `Hand off Incident Command from ${current === me.id ? 'you' : userById(current)?.displayName}` : 'Assign Incident Command'}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={!to}>
            {to === me.id ? 'Take command' : 'Hand off command'}
          </button>
        </>
      }
    >
      <div className="form">
        <label>
          New Incident Commander
          <select value={to} onChange={(e) => setTo(e.target.value)} autoFocus>
            <option value="">Choose someone…</option>
            {people.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName}
                {u.id === me.id ? ' (you)' : ''}
                {here.has(u.id) ? ' · in the room' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          Handoff note
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Where things stand, open decisions, next update due…" />
        </label>
        <p className="muted small">
          Everyone in the room is told, the previous and new commander get a notification, and the handoff is recorded on the timeline with who made it.
        </p>
      </div>
    </Modal>
  );
}
