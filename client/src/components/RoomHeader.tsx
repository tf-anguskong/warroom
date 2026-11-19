import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { duration, STATUS_LABEL, utcTime } from '../lib/format';
import type { IncidentState, Severity, Status } from '../types';
import { Icons, SeverityBadge } from './ui';
import { ExportRoomDialog } from './Archive';
import { AwayButton } from './Away';
import { SoundToggle } from './SoundToggle';
import { InviteDialog } from './Guests';

export function RoomHeader({ state }: { state: IncidentState }) {
  const { meta, toast, userById, me } = useApp();
  const inc = state.incident;
  const [now, setNow] = useState(Date.now());
  const [exporting, setExporting] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(inc.title);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => setTitle(inc.title), [inc.title]);

  const patch = (body: Partial<{ title: string; severity: Severity; status: Status }>) =>
    api.patch(`/api/incidents/${inc.id}`, body).catch((e) => toast({ text: e.message, tone: 'error' }));

  const saveTitle = () => {
    setEditing(false);
    if (title.trim() && title !== inc.title) patch({ title: title.trim() });
  };

  const ic = userById(state.roles.find((r) => r.role === 'commander')?.userId);
  const statusIdx = meta.statuses.indexOf(inc.status);

  const copyLink = () => {
    navigator.clipboard.writeText(location.origin + location.pathname);
    toast({ text: 'War room link copied' }, 2500);
  };

  return (
    <header className="room-header">
      <Link to="/" className="icon-btn" aria-label="All incidents" title="All incidents">
        {Icons.back}
      </Link>
      <span className="mono inc-key">{inc.key}</span>
      {editing ? (
        <input
          className="title-input"
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') saveTitle();
            if (e.key === 'Escape') {
              setTitle(inc.title);
              setEditing(false);
            }
          }}
        />
      ) : (
        <h1 className="inc-title" title="Click to rename" onClick={() => setEditing(true)}>
          {inc.title}
        </h1>
      )}

      <label
        className={`sev-select ${state.canControl ? '' : 'locked'}`}
        title={state.canControl ? 'Change severity' : 'Only the Incident Commander or a room admin can change severity'}
      >
        <SeverityBadge severity={inc.severity} />
        {!state.canControl && <span className="lock">{Icons.lock}</span>}
        <select
          value={inc.severity}
          disabled={!state.canControl}
          aria-label="Severity"
          onChange={(e) => {
            const next = e.target.value as Severity;
            if (next < inc.severity && !confirm(`Raise severity to ${next}?`)) return;
            patch({ severity: next });
          }}
        >
          {meta.severities.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>

      <div className="stepper" role="group" aria-label="Status">
        {meta.statuses.map((s, i) => (
          <button
            key={s}
            className={`step ${i < statusIdx ? 'done' : ''} ${i === statusIdx ? 'current' : ''} step-${s}`}
            disabled={!state.canControl && s !== inc.status}
            onClick={() => {
              if (s === inc.status) return;
              if (s === 'resolved' && !confirm('Mark this incident as resolved?')) return;
              patch({ status: s });
            }}
            title={state.canControl ? `Set status: ${STATUS_LABEL[s]}` : 'Only the Incident Commander or a room admin can change status'}
          >
            {STATUS_LABEL[s]}
          </button>
        ))}
      </div>

      <div className="spacer" />

      <div className="clock" title="Incident clock (UTC) and time since declared">
        <span className="mono">{utcTime(new Date(now).toISOString())} UTC</span>
        <span className="mono muted">
          T+{duration(inc.createdAt, inc.resolvedAt ? new Date(inc.resolvedAt).getTime() : now)}
        </span>
      </div>
      <SoundToggle />
      <AwayButton state={state} />
      <div className="ic-chip" title="Incident Commander">
        <span className="label">IC</span> {ic ? ic.displayName : <em className="warn-text">unassigned</em>}
      </div>
      <button className="icon-btn" onClick={copyLink} title="Copy war room link" aria-label="Copy war room link">
        {Icons.link}
      </button>
      {!me.isGuest && state.canControl && inc.status !== 'resolved' && (
        <button className="btn primary sm" onClick={() => setInviting(true)} title="Invite a responder or a guest with a single-use link">
          {Icons.plus} Invite
        </button>
      )}
      {inviting && <InviteDialog state={state} onClose={() => setInviting(false)} />}
      {!me.isGuest && (state.canControl || me.isAdmin) && (
        <button className="btn ghost sm" onClick={() => setExporting(true)} title="Export the whole room to an archive you can restore on any War Room">
          {Icons.download} Export room
        </button>
      )}
      {exporting && <ExportRoomDialog incidentId={inc.id} incidentKey={inc.key} onClose={() => setExporting(false)} />}
      {!me.isGuest && <a className="btn ghost sm" href={`/api/incidents/${inc.id}/export.md`} title="Download postmortem draft (Markdown)">
        {Icons.download} Postmortem
      </a>}
    </header>
  );
}
