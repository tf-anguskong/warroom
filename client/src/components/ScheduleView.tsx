import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { useApp } from '../lib/app';
import { userColor } from '../lib/format';
import type { IncidentState, Presence, Shift } from '../types';
import { Avatar, Icons, Modal } from './ui';

const RANGES = [
  { key: '24h', label: '24 hours', hours: 24, tick: 2 },
  { key: '3d', label: '3 days', hours: 72, tick: 6 },
  { key: '7d', label: '7 days', hours: 168, tick: 12 },
] as const;

const HOUR = 3600e3;
const z = (iso: string) => `${iso.slice(11, 16)}Z`;
const dayLabel = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
function relative(ms: number) {
  const m = Math.round(Math.abs(ms) / 60000);
  const t = m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60 ? `${m % 60}m` : ''}`.trim() : `${Math.round(m / 1440)}d`;
  return ms >= 0 ? `in ${t}` : `${t} ago`;
}
/** A shift's time span, with the date when it isn't today (UTC). */
function span(s: Shift, nowIso: string) {
  const day = (iso: string) => (iso.slice(0, 10) === nowIso.slice(0, 10) ? '' : `${dayLabel(new Date(iso))} `);
  return `${day(s.startsAt)}${z(s.startsAt)} – ${s.endsAt.slice(0, 10) === s.startsAt.slice(0, 10) ? '' : day(s.endsAt)}${z(s.endsAt)}`;
}

/** Shift schedule: who is expected to be on, and when, laid out on a UTC timeline. */
export function ScheduleView({ state, presence }: { state: IncidentState; presence: Presence[] }) {
  const { me, userById } = useApp();
  const [range, setRange] = useState<(typeof RANGES)[number]>(RANGES[0]);
  const [now, setNow] = useState(Date.now());
  const [editing, setEditing] = useState<Shift | 'new' | null>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const nowIso = new Date(now).toISOString();
  const shifts = state.shifts;
  const onNow = shifts.filter((s) => s.startsAt <= nowIso && s.endsAt > nowIso);
  const upcoming = shifts.filter((s) => s.startsAt > nowIso);
  const nextChange = [...upcoming.map((s) => ({ at: s.startsAt, text: `${s.userName} starts` })), ...onNow.map((s) => ({ at: s.endsAt, text: `${s.userName} ends` }))].sort((a, b) => a.at.localeCompare(b.at))[0];
  const here = new Set(presence.map((p) => p.userId));
  const canSchedule = state.canControl || me.isAdmin;

  // Window: from 2 hours ago (on the hour) for the chosen range.
  const from = Math.floor((now - 2 * HOUR) / HOUR) * HOUR;
  const to = from + range.hours * HOUR;
  const pct = (iso: string) => ((new Date(iso).getTime() - from) / (to - from)) * 100;
  const visible = shifts.filter((s) => new Date(s.endsAt).getTime() > from && new Date(s.startsAt).getTime() < to);

  // Rows: people on now first, then by their next shift.
  const rows = useMemo(() => {
    const ids = [...new Set(visible.map((s) => s.userId))];
    const key = (id: string) => (onNow.some((s) => s.userId === id) ? '0' : '1') + (visible.find((s) => s.userId === id)?.startsAt ?? '');
    return ids.sort((a, b) => key(a).localeCompare(key(b)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.map((s) => s.id).join(), onNow.length]);

  const ticks: { at: number; label: string; day: boolean }[] = [];
  for (let t = Math.ceil(from / (range.tick * HOUR)) * range.tick * HOUR; t <= to; t += range.tick * HOUR) {
    const d = new Date(t);
    const midnight = d.getUTCHours() === 0;
    ticks.push({ at: t, label: midnight ? dayLabel(d) : `${String(d.getUTCHours()).padStart(2, '0')}:00`, day: midnight });
  }

  return (
    <div className="schedule-view">
      <div className="view-head">
        <h2>{Icons.calendar} Schedule</h2>
        <span className="muted small">Who is expected on, and when. Times in UTC.</span>
        <div className="spacer" />
        <div className="seg">
          {RANGES.map((r) => (
            <button key={r.key} className={range.key === r.key ? 'on' : ''} onClick={() => setRange(r)}>
              {r.label}
            </button>
          ))}
        </div>
        <button className="btn primary sm" onClick={() => setEditing('new')} disabled={state.incident.status === 'resolved'}>
          {Icons.plus} Add shift
        </button>
      </div>

      <div className="schedule-body">
        <div className="schedule-summary">
          <div className="sched-card">
            <div className="muted small">On shift now</div>
            {onNow.length === 0 ? (
              <div className="warn-text">Nobody is scheduled right now</div>
            ) : (
              <div className="on-now">
                {onNow.map((s) => (
                  <span key={s.id} className="on-now-person" title={s.note || undefined}>
                    <Avatar id={s.userId} name={s.userName} size={24} />
                    <span>
                      {s.userName}
                      <span className="muted small"> until {z(s.endsAt)}</span>
                      {!here.has(s.userId) && <span className="tag warn" title="On shift but not in the war room">not in the room</span>}
                    </span>
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="sched-card">
            <div className="muted small">Next change</div>
            {nextChange ? (
              <div>
                <strong>{nextChange.text}</strong> at {z(nextChange.at)} <span className="muted">({relative(new Date(nextChange.at).getTime() - now)})</span>
              </div>
            ) : (
              <div className="muted">Nothing scheduled</div>
            )}
          </div>
        </div>

        <div className="gantt" style={{ ['--rows' as string]: Math.max(rows.length, 1) }}>
          <div className="gantt-head">
            <div className="gantt-name" />
            <div className="gantt-track">
              {ticks.map((t) => (
                <span key={t.at} className={`gantt-tick ${t.day ? 'day' : ''}`} style={{ left: `${((t.at - from) / (to - from)) * 100}%` }}>
                  {t.label}
                </span>
              ))}
            </div>
          </div>
          {rows.length === 0 && (
            <div className="gantt-row">
              <div className="gantt-name muted small">No shifts in this window</div>
              <div className="gantt-track" />
            </div>
          )}
          {rows.map((id) => {
            const user = userById(id);
            return (
              <div key={id} className="gantt-row">
                <div className="gantt-name">
                  <Avatar id={id} name={user?.displayName ?? '?'} size={22} />
                  <span className="gantt-person">{user?.displayName ?? visible.find((s) => s.userId === id)?.userName}</span>
                  {here.has(id) && <span className="online-dot online" title="In the war room now" />}
                </div>
                <div className="gantt-track">
                  {ticks.map((t) => (
                    <span key={t.at} className={`gantt-grid ${t.day ? 'day' : ''}`} style={{ left: `${((t.at - from) / (to - from)) * 100}%` }} />
                  ))}
                  {visible
                    .filter((s) => s.userId === id)
                    .map((s) => {
                      const left = Math.max(0, pct(s.startsAt));
                      const right = Math.min(100, pct(s.endsAt));
                      const live = s.startsAt <= nowIso && s.endsAt > nowIso;
                      const editable = s.userId === me.id || canSchedule;
                      return (
                        <button
                          key={s.id}
                          className={`gantt-bar ${live ? 'live' : ''} ${s.endsAt <= nowIso ? 'past' : ''}`}
                          style={{ left: `${left}%`, width: `${Math.max(0.6, right - left)}%`, ['--c' as string]: userColor(s.userId) }}
                          title={`${s.userName}: ${span(s, nowIso)}${s.note ? ` · ${s.note}` : ''}${editable ? ' (click to change)' : ''}`}
                          onClick={() => editable && setEditing(s)}
                          disabled={!editable}
                        >
                          <span>
                            {z(s.startsAt)}–{z(s.endsAt)}
                            {s.note ? ` · ${s.note}` : ''}
                          </span>
                        </button>
                      );
                    })}
                </div>
              </div>
            );
          })}
          <div className="gantt-now-wrap">
            <div className="gantt-name" />
            <div className="gantt-track">
              <span className="gantt-now" style={{ left: `${pct(nowIso)}%` }} title={`Now ${z(nowIso)}`} />
            </div>
          </div>
        </div>

        <h3 className="sched-list-head">Upcoming and current shifts</h3>
        {onNow.length + upcoming.length === 0 ? (
          <p className="muted small">No shifts yet. Add yours, or (as the IC or a room admin) schedule the team. Long incidents usually run 8 or 12 hour rotations; use “repeat daily”.</p>
        ) : (
          <table className="table sched-table">
            <thead>
              <tr>
                <th>Person</th>
                <th>When (UTC)</th>
                <th>Length</th>
                <th>Note</th>
                <th>Starts</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {[...onNow, ...upcoming].map((s) => {
                const live = s.startsAt <= nowIso;
                const editable = s.userId === me.id || canSchedule;
                return (
                  <tr key={s.id} className={live ? 'live' : ''}>
                    <td>
                      <span className="person">
                        <Avatar id={s.userId} name={s.userName} size={22} />
                        {s.userName}
                        {s.userId === me.id && <span className="muted"> (you)</span>}
                      </span>
                    </td>
                    <td className="mono small">{span(s, nowIso)}</td>
                    <td className="small">{((new Date(s.endsAt).getTime() - new Date(s.startsAt).getTime()) / HOUR).toFixed(1).replace(/\.0$/, '')} h</td>
                    <td className="small">{s.note || <span className="muted">—</span>}</td>
                    <td className="small">{live ? <span className="ok-text">On now</span> : relative(new Date(s.startsAt).getTime() - now)}</td>
                    <td className="row-actions">
                      {editable && (
                        <button className="btn ghost sm" onClick={() => setEditing(s)}>
                          Change
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {editing && <ShiftDialog state={state} shift={editing === 'new' ? null : editing} canSchedule={canSchedule} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** `datetime-local` value (local time) for an ISO instant, and back. */
const toLocalInput = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

function ShiftDialog({ state, shift, canSchedule, onClose }: { state: IncidentState; shift: Shift | null; canSchedule: boolean; onClose: () => void }) {
  const { me, users, toast } = useApp();
  const nextHour = Math.ceil(Date.now() / HOUR) * HOUR;
  const [userId, setUserId] = useState(shift?.userId ?? me.id);
  const [start, setStart] = useState(toLocalInput(shift ? new Date(shift.startsAt).getTime() : nextHour));
  const [hours, setHours] = useState(shift ? (new Date(shift.endsAt).getTime() - new Date(shift.startsAt).getTime()) / HOUR : 8);
  const [note, setNote] = useState(shift?.note ?? '');
  const [repeat, setRepeat] = useState(1);
  const [busy, setBusy] = useState(false);
  const members = useMemo(() => users.filter((u) => u.active && !u.isGuest).sort((a, b) => a.displayName.localeCompare(b.displayName)), [users]);

  const startMs = new Date(start).getTime();
  const endMs = startMs + hours * HOUR;
  const valid = !Number.isNaN(startMs) && hours > 0 && hours <= 24;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    try {
      const body = { userId, startsAt: new Date(startMs).toISOString(), endsAt: new Date(endMs).toISOString(), note, repeatDays: repeat };
      if (shift) await api.patch(`/api/shifts/${shift.id}`, body);
      else await api.post(`/api/incidents/${state.incident.id}/shifts`, body);
      onClose();
    } catch (err) {
      toast({ text: err instanceof ApiError ? err.message : 'Could not save the shift', tone: 'error' }, 7000);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!shift) return;
    try {
      await api.del(`/api/shifts/${shift.id}`);
      onClose();
    } catch (err) {
      toast({ text: err instanceof ApiError ? err.message : 'Could not remove the shift', tone: 'error' }, 7000);
    }
  };

  return (
    <Modal
      title={shift ? `${shift.userName}’s shift` : 'Add a shift'}
      onClose={onClose}
      footer={
        <>
          {shift && (
            <button className="btn ghost danger-text" onClick={remove} type="button">
              Remove shift
            </button>
          )}
          <div className="spacer" />
          <button className="btn ghost" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="btn primary" form="shift" disabled={!valid || busy}>
            {shift ? 'Save' : repeat > 1 ? `Add ${repeat} shifts` : 'Add shift'}
          </button>
        </>
      }
    >
      <form id="shift" className="form" onSubmit={submit}>
        <label>
          Who
          <select value={userId} onChange={(e) => setUserId(e.target.value)} disabled={Boolean(shift) || !canSchedule}>
            <option value={me.id}>Me ({me.displayName})</option>
            {canSchedule &&
              members
                .filter((u) => u.id !== me.id)
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.displayName}
                  </option>
                ))}
          </select>
          {!canSchedule && !shift && <span className="muted small">The Incident Commander or a room admin can schedule other people.</span>}
        </label>
        <div className="row">
          <label className="grow">
            Starts (your local time)
            <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} required />
          </label>
          <label>
            Length
            <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
              {[2, 4, 6, 8, 10, 12, 16, 24].concat([hours].filter((h) => ![2, 4, 6, 8, 10, 12, 16, 24].includes(h))).sort((a, b) => a - b).map((h) => (
                <option key={h} value={h}>
                  {Number.isInteger(h) ? h : h.toFixed(1)} hours
                </option>
              ))}
            </select>
          </label>
        </div>
        {valid && (
          <div className="muted small mono">
            = {new Date(startMs).toISOString().slice(0, 16).replace('T', ' ')}Z → {new Date(endMs).toISOString().slice(0, 16).replace('T', ' ')}Z (UTC)
          </div>
        )}
        <label>
          Note <span className="muted">(optional)</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} placeholder="Forensics lead · night shift · on call only" />
        </label>
        {!shift && (
          <label>
            Repeat daily
            <select value={repeat} onChange={(e) => setRepeat(Number(e.target.value))}>
              {[1, 2, 3, 5, 7, 10, 14, 21, 30].map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? 'Just once' : `For ${n} days`}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="hint">
          {shift ? 'Changes go on the timeline.' : 'The person gets a reminder 15 minutes before, and the room sees a notice when the shift starts and ends.'} Times are shown in UTC
          everywhere else; you’re entering them in your local time ({Intl.DateTimeFormat().resolvedOptions().timeZone}).
        </p>
      </form>
    </Modal>
  );
}

/** "On shift until 20:00Z" / "Next shift 14:00Z" for the roster. */
export function shiftStatus(shifts: Shift[], userId: string, nowIso: string) {
  const mine = shifts.filter((s) => s.userId === userId && s.endsAt > nowIso);
  const cur = mine.find((s) => s.startsAt <= nowIso);
  if (cur) return { on: true, text: `On shift until ${z(cur.endsAt)}` };
  const next = mine[0];
  if (next) return { on: false, text: `Next shift ${next.startsAt.slice(0, 10) === nowIso.slice(0, 10) ? '' : `${dayLabel(new Date(next.startsAt))} `}${z(next.startsAt)}` };
  return null;
}

