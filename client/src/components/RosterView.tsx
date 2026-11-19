import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { useModeration } from '../lib/moderation';
import { useVoice } from '../lib/voice';
import type { Assignment, IncidentState, Presence } from '../types';
import { AssignDialog, targetLabel, type AssignTarget } from './AssignDialog';
import { Avatar, Icons } from './ui';
import { GuestTag } from './Guests';
import { shiftStatus } from './ScheduleView';
import { awayOf, awayText, isOverdue } from './Away';

const STALE_MIN = 30;

function ago(iso: string | null, now: number) {
  if (!iso) return '';
  const m = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

type Flag = { tone: 'warn' | 'info'; text: string; fix?: { label: string; run: () => void } };

/** One screen that answers "who is on what, where are they, and what are they doing right now". */
export function RosterView({ state, presence, onOpenChannel }: { state: IncidentState; presence: Presence[]; onOpenChannel: (id: string) => void }) {
  const { me, meta, userById } = useApp();
  const mod = useModeration(state);
  const voice = useVoice();
  const [assign, setAssign] = useState<AssignTarget | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const here = new Map(presence.map((p) => [p.userId, p]));
  const speaking = new Set(voice.participants.filter((p) => p.speaking).map((p) => p.identity));
  const roomName = (id: string | null) => state.voiceRooms.find((v) => v.id === id)?.name;
  const byTarget = (kind: string, id: string) => state.assignments.filter((a) => a.targetKind === kind && a.targetId === id);
  const byUser = (userId: string) => state.assignments.filter((a) => a.userId === userId);
  const member = (userId: string) => state.members.find((m) => m.userId === userId);
  const name = (id: string | null) => userById(id)?.displayName ?? 'someone';

  // Workstreams: every voice room, plus channels that have people assigned.
  const streams: (AssignTarget & { label: string; objective?: string; objectiveBy?: string | null; objectiveAt?: string | null; main?: boolean })[] = [
    ...state.voiceRooms.map((v) => ({ kind: 'voice' as const, id: v.id, label: v.name, objective: v.objective, objectiveBy: v.objectiveBy, objectiveAt: v.objectiveAt, main: v.kind === 'main' })),
    ...state.channels
      .filter((c) => byTarget('channel', c.id).length)
      .map((c) => ({ kind: 'channel' as const, id: c.id, label: `#${c.name}` })),
  ];

  // People: anyone present, assigned, holding a role, or who has joined this war room.
  const ids = new Set<string>([
    ...presence.map((p) => p.userId),
    ...state.assignments.map((a) => a.userId),
    ...state.roles.map((r) => r.userId),
    ...state.members.map((m) => m.userId),
  ]);
  const people = [...ids]
    .map((id) => ({ id, user: userById(id), p: here.get(id) }))
    .filter((x) => x.user)
    .sort((a, b) => Number(Boolean(b.p)) - Number(Boolean(a.p)) || a.user!.displayName.localeCompare(b.user!.displayName));

  const flagsFor = (userId: string): Flag[] => {
    const p = here.get(userId);
    const mine = byUser(userId);
    const voiceAsg = mine.filter((a) => a.targetKind === 'voice');
    const flags: Flag[] = [];
    const away = awayOf(state, userId);
    if (away && isOverdue(away, now)) flags.push({ tone: 'warn', text: `Overdue: was due back ${away.until!.slice(11, 16)}Z` });
    if (!p && mine.length && !away) flags.push({ tone: 'warn', text: 'Assigned but not in the war room' });
    if (p && voiceAsg.length && !voiceAsg.some((a) => a.targetId === p.voiceRoomId)) {
      const want = voiceAsg[0].targetId;
      flags.push({
        tone: 'warn',
        text: p.voiceRoomId ? `In ${roomName(p.voiceRoomId)}, assigned to ${roomName(want)}` : `Not in voice, assigned to ${roomName(want)}`,
        fix:
          mod.can && userId !== me.id
            ? { label: p.voiceRoomId ? 'Move' : 'Ask to join', run: () => void mod.move(userId, want) }
            : userId === me.id
              ? { label: 'Join', run: () => void voice.join(want) }
              : undefined,
      });
    }
    if (p && !mine.length && !state.roles.some((r) => r.userId === userId)) flags.push({ tone: 'info', text: 'No assignment' });
    const m = member(userId);
    if (p && m?.task && m.taskAt && now - new Date(m.taskAt).getTime() > STALE_MIN * 60_000) {
      flags.push({ tone: 'info', text: `Task not updated for ${ago(m.taskAt, now).replace(' ago', '')}` });
    }
    return flags;
  };

  const unassignedHere = presence.filter((p) => !byUser(p.userId).length && !state.roles.some((r) => r.userId === p.userId)).length;
  const mismatches = people.filter((x) => flagsFor(x.id).some((f) => f.tone === 'warn')).length;

  const chip = (a: Assignment) => (
    <button
      key={`${a.targetKind}:${a.targetId}`}
      className={`asg-chip ${a.lead ? 'lead' : ''}`}
      title={`Assigned by ${name(a.assignedBy)} ${ago(a.assignedAt, now)}`}
      onClick={() => (a.targetKind === 'channel' ? onOpenChannel(a.targetId) : mod.can ? setAssign({ kind: 'voice', id: a.targetId }) : undefined)}
    >
      {a.targetKind === 'voice' ? Icons.volume : Icons.hash}
      {targetLabel(state, { kind: a.targetKind, id: a.targetId }).replace(/^#/, '')}
      {a.lead && <span className="lead-tag">lead</span>}
    </button>
  );

  return (
    <div className="roster">
      <div className="view-head">
        <div>
          <h2>Who’s doing what</h2>
          <div className="muted small">
            Assignments, where people are right now, and what they’re working on. Every change is on the timeline with who made it.
          </div>
        </div>
        <div className="spacer" />
        <div className="roster-stats">
          <span>
            <strong>{presence.length}</strong> here
          </span>
          <span className={unassignedHere ? 'warn-text' : ''}>
            <strong>{unassignedHere}</strong> unassigned
          </span>
          <span className={mismatches ? 'warn-text' : ''}>
            <strong>{mismatches}</strong> need attention
          </span>
        </div>
      </div>

      <div className="roster-scroll">
        <section>
          <h3 className="roster-h">Workstreams</h3>
          <div className="streams">
            {streams.map((s) => {
              const asg = byTarget(s.kind, s.id);
              const lead = asg.find((a) => a.lead);
              const present = asg.filter((a) => (s.kind === 'voice' ? here.get(a.userId)?.voiceRoomId === s.id : here.has(a.userId)));
              const visitors = s.kind === 'voice' ? presence.filter((p) => p.voiceRoomId === s.id && !asg.some((a) => a.userId === p.userId)) : [];
              return (
                <div key={`${s.kind}:${s.id}`} className="stream">
                  <div className="stream-head">
                    <span className="stream-name">
                      {s.kind === 'voice' ? Icons.volume : Icons.hash} {s.label.replace(/^#/, '')}
                    </span>
                    {mod.can && (
                      <button className="btn ghost sm" onClick={() => setAssign({ kind: s.kind, id: s.id })}>
                        {Icons.users} Assign
                      </button>
                    )}
                  </div>
                  {s.kind === 'voice' && (
                    <div className={`stream-objective ${s.objective ? '' : s.main ? 'muted small' : 'gap'}`} title={s.objectiveBy ? `Set by ${name(s.objectiveBy)} ${ago(s.objectiveAt ?? null, now)}` : undefined}>
                      {s.objective || 'No objective set'}
                    </div>
                  )}
                  <div className={`stream-lead ${lead ? '' : s.main ? 'muted' : 'gap'}`}>
                    <span className="label">Lead</span>
                    {lead ? (
                      <>
                        <Avatar id={lead.userId} name={name(lead.userId)} size={20} speaking={speaking.has(lead.userId)} /> {name(lead.userId)}
                      </>
                    ) : (
                      'No lead'
                    )}
                  </div>
                  <div className="stream-people">
                    {asg.length === 0 && <span className="muted small">Nobody assigned</span>}
                    {asg.map((a) => {
                      const isHere = present.some((x) => x.userId === a.userId);
                      return (
                        <span key={a.userId} className={`stream-person ${isHere ? '' : 'away'}`} title={isHere ? `${name(a.userId)} is here` : `${name(a.userId)} is assigned but not here`}>
                          <Avatar id={a.userId} name={name(a.userId)} size={22} speaking={speaking.has(a.userId)} />
                        </span>
                      );
                    })}
                    {asg.length > 0 && (
                      <span className="muted small">
                        {present.length} of {asg.length} here
                      </span>
                    )}
                  </div>
                  {visitors.length > 0 && <div className="muted small">Also in the room: {visitors.map((v) => v.displayName).join(', ')}</div>}
                </div>
              );
            })}
          </div>
        </section>

        <section>
          <h3 className="roster-h">People</h3>
          <table className="table roster-table">
            <thead>
              <tr>
                <th>Person</th>
                <th>Assigned to</th>
                <th>Where now</th>
                <th>Working on</th>
                <th>Attention</th>
              </tr>
            </thead>
            <tbody>
              {people.map(({ id, user, p }) => {
                const roles = state.roles.filter((r) => r.userId === id).map((r) => meta.roles.find((m) => m.key === r.role)?.label);
                const m = member(id);
                const flags = flagsFor(id);
                const viewing = p?.view?.startsWith('channel:') ? `#${state.channels.find((c) => `channel:${c.id}` === p.view)?.name ?? ''}` : p?.view?.startsWith('sheet:') ? state.sheets.find((s) => `sheet:${s.id}` === p.view)?.name : p?.view;
                return (
                  <tr key={id} className={p ? '' : 'away'}>
                    <td>
                      <span className="person">
                        <Avatar id={id} name={user!.displayName} size={26} speaking={speaking.has(id)} muted={!!p?.voiceRoomId && p.muted} away={Boolean(awayOf(state, id))} />
                        <span>
                          {user!.displayName}
                          {id === me.id && <span className="muted"> (you)</span>}
                          <GuestTag user={user} />
                          <div className="muted small">
                            {[...roles, state.roomAdmins.includes(id) ? 'Room admin' : null].filter(Boolean).join(' · ') || 'Responder'}
                          </div>
                          {awayOf(state, id) && <div className={`away-line ${isOverdue(awayOf(state, id), now) ? 'late' : ''}`}>{awayText(awayOf(state, id)!, now)}</div>}
                          {(() => {
                            const sh = shiftStatus(state.shifts ?? [], id, new Date(now).toISOString());
                            return sh ? <div className={`small ${sh.on ? 'ok-text' : 'muted'}`}>{Icons.calendar} {sh.text}</div> : null;
                          })()}
                        </span>
                      </span>
                    </td>
                    <td>
                      <div className="asg-chips">
                        {byUser(id).map(chip)}
                        {byUser(id).length === 0 && <span className="muted small">—</span>}
                      </div>
                    </td>
                    <td className="small">
                      {p ? (
                        <>
                          {p.voiceRoomId ? (
                            <span className="where-voice">
                              {Icons.volume} {roomName(p.voiceRoomId)}
                            </span>
                          ) : (
                            <span className="muted">Not in voice</span>
                          )}
                          {viewing && <div className="muted">viewing {viewing}</div>}
                        </>
                      ) : (
                        <span className="muted">Not in the war room</span>
                      )}
                    </td>
                    <td>
                      <TaskCell
                        incidentId={state.incident.id}
                        userId={id}
                        task={m?.task ?? ''}
                        meta={m?.taskAt ? `${m.taskBy && m.taskBy !== id ? `set by ${name(m.taskBy)}, ` : ''}${ago(m.taskAt, now)}` : ''}
                        editable={id === me.id || mod.can}
                        self={id === me.id}
                      />
                    </td>
                    <td>
                      <div className="flags">
                        {flags.map((f, i) => (
                          <span key={i} className={`flag ${f.tone}`}>
                            {f.text}
                            {f.fix && (
                              <button className="btn ghost sm" onClick={f.fix.run}>
                                {f.fix.label}
                              </button>
                            )}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      </div>

      {assign && <AssignDialog state={state} presence={presence} target={assign} onClose={() => setAssign(null)} />}
    </div>
  );
}

function TaskCell({ incidentId, userId, task, meta, editable, self }: { incidentId: string; userId: string; task: string; meta: string; editable: boolean; self: boolean }) {
  const { toast } = useApp();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(task);
  useEffect(() => {
    if (!editing) setValue(task);
  }, [task, editing]);

  const save = async () => {
    setEditing(false);
    if (value.trim() === task) return;
    try {
      await api.put(`/api/incidents/${incidentId}/members/${userId}/task`, { task: value.trim() });
    } catch (e) {
      toast({ text: e instanceof Error ? e.message : 'Could not save', tone: 'error' });
      setValue(task);
    }
  };

  if (editing) {
    return (
      <input
        className="task-input"
        autoFocus
        value={value}
        maxLength={300}
        placeholder={self ? 'What are you working on?' : 'What are they working on?'}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
          if (e.key === 'Escape') {
            setValue(task);
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <div className="task-cell">
      {task ? <span>{task}</span> : <span className={`muted ${self ? 'warn-text' : ''}`}>{self ? 'Tell the room what you’re on' : 'Not set'}</span>}
      {meta && <div className="muted small">{meta}</div>}
      {editable && (
        <button className="btn ghost sm" onClick={() => setEditing(true)}>
          {task ? 'Update' : 'Set'}
        </button>
      )}
    </div>
  );
}
