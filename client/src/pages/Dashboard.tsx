import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { getSocket } from '../lib/socket';
import { duration } from '../lib/format';
import { Icons, Modal, SeverityBadge, StatusPill } from '../components/ui';
import type { IncidentListItem, Severity } from '../types';

export function Dashboard() {
  const guestHome = useApp().me;
  if (guestHome.isGuest && guestHome.guestIncidentId) return <Navigate to={`/incidents/${guestHome.guestIncidentId}`} replace />;
  return <DashboardInner />;
}

function DashboardInner() {
  const { me, meta } = useApp();
  const [filter, setFilter] = useState<'active' | 'resolved' | 'all'>('active');
  const [incidents, setIncidents] = useState<IncidentListItem[] | null>(null);
  const [declaring, setDeclaring] = useState(false);
  const [, setTick] = useState(0);

  const load = useCallback(() => {
    api.get<{ incidents: IncidentListItem[] }>(`/api/incidents?filter=${filter}`).then((r) => setIncidents(r.incidents));
  }, [filter]);

  useEffect(() => {
    load();
    const s = getSocket();
    s.on('dashboard:refresh', load);
    const poll = setInterval(load, 15000); // presence counts
    const clock = setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      s.off('dashboard:refresh', load);
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [load]);

  const logout = async () => {
    await api.post('/auth/logout');
    location.href = '/login';
  };

  return (
    <div className="dash">
      <header className="dash-head">
        <div className="brand sm">
          <span className="brand-mark" aria-hidden />
          <strong>War Room</strong>
        </div>
        <div className="spacer" />
        {me.isAdmin && (
          <Link className="btn ghost sm" to="/admin">
            {Icons.settings} Admin
          </Link>
        )}
        <span className="muted">{me.displayName}</span>
        <button className="btn ghost sm" onClick={logout}>
          Sign out
        </button>
      </header>

      <main className="dash-main">
        <div className="dash-toolbar">
          <h1>Incidents</h1>
          <div className="seg">
            {(['active', 'resolved', 'all'] as const).map((f) => (
              <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
                {f[0].toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
          <div className="spacer" />
          <button className="btn danger" onClick={() => setDeclaring(true)}>
            {Icons.flag} Declare incident
          </button>
        </div>

        {incidents === null ? (
          <div className="skeleton-list">
            <div className="skeleton" />
            <div className="skeleton" />
          </div>
        ) : incidents.length === 0 ? (
          <div className="empty calm">
            <div className="empty-mark" aria-hidden />
            <h2>{filter === 'active' ? 'All quiet' : 'Nothing here'}</h2>
            <p className="muted">
              {filter === 'active' ? 'No active incidents. Declare one when something breaks.' : 'No incidents match this filter.'}
            </p>
          </div>
        ) : (
          <div className="incident-list">
            {incidents.map((i) => (
              <Link key={i.id} to={`/incidents/${i.id}`} className={`incident-row sev-edge-${i.severity.toLowerCase()} ${i.status === 'resolved' ? 'resolved' : ''}`}>
                <div className="ir-main">
                  <div className="ir-top">
                    <span className="mono muted">{i.key}</span>
                    <SeverityBadge severity={i.severity} />
                    <StatusPill status={i.status} />
                  </div>
                  <div className="ir-title">{i.title}</div>
                </div>
                <div className="ir-meta">
                  <div>
                    <span className="label">IC</span> {i.commander ?? <em className="warn-text">unassigned</em>}
                  </div>
                  <div className="mono">{i.status === 'resolved' && i.resolvedAt ? `resolved after ${duration(i.createdAt, new Date(i.resolvedAt).getTime())}` : duration(i.createdAt)}</div>
                </div>
                <div className="ir-live">
                  {i.mentions > 0 && (
                    <span className="ir-mentions" title={`${i.mentions} unread mention${i.mentions > 1 ? 's' : ''} of you`}>
                      @{i.mentions}
                    </span>
                  )}
                  {i.inVoice > 0 && (
                    <span className="live-dot" title="People in voice">
                      {Icons.volume} {i.inVoice}
                    </span>
                  )}
                  <span className="muted" title="People in the room now">
                    {Icons.users} {i.present}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>

      {declaring && <DeclareModal templates={meta.templates} onClose={() => setDeclaring(false)} />}
    </div>
  );
}

function DeclareModal({ templates, onClose }: { templates: { key: string; name: string; description: string }[]; onClose: () => void }) {
  const nav = useNavigate();
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState<Severity>('SEV2');
  const [summary, setSummary] = useState('');
  const [chosen, setChosen] = useState<string[]>(['ioc', 'actions']);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.post<{ id: string }>('/api/incidents', { title, severity, summary, templates: chosen });
      nav(`/incidents/${r.id}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Declare incident"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="btn danger" form="declare" type="submit" disabled={busy || !title.trim()}>
            Declare and open war room
          </button>
        </>
      }
    >
      <form id="declare" className="form" onSubmit={submit}>
        <label>
          What is happening?
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Ransomware detected on file servers" required />
        </label>
        <fieldset>
          <legend>Severity</legend>
          <div className="sev-picker">
            {(['SEV1', 'SEV2', 'SEV3', 'SEV4'] as Severity[]).map((s) => (
              <button type="button" key={s} className={`sev-option ${severity === s ? 'on' : ''}`} onClick={() => setSeverity(s)}>
                <SeverityBadge severity={s} long />
              </button>
            ))}
          </div>
        </fieldset>
        <label>
          Summary <span className="muted">(optional)</span>
          <textarea rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="What we know so far, impact, how it was detected" />
        </label>
        <fieldset>
          <legend>Starting sheets</legend>
          <div className="template-grid">
            {templates
              .filter((t) => t.key !== 'blank')
              .map((t) => (
                <label key={t.key} className={`template ${chosen.includes(t.key) ? 'on' : ''}`}>
                  <input
                    type="checkbox"
                    checked={chosen.includes(t.key)}
                    onChange={(e) => setChosen((c) => (e.target.checked ? [...c, t.key] : c.filter((k) => k !== t.key)))}
                  />
                  <span>
                    <strong>{t.name}</strong>
                    <small className="muted">{t.description}</small>
                  </span>
                </label>
              ))}
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}
