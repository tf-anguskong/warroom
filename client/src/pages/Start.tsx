import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useApp } from '../lib/app';
import { ImportRoom } from '../components/Archive';
import { Icons } from '../components/ui';

/** First stop on a new (quick) War Room: start a room, or restore one from an archive. */
export function Start() {
  const { me, meta } = useApp();
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState('SEV2');
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!me.isAdmin) return <Navigate to="/" replace />;

  const start = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const inc = await api.post<{ id: string }>('/api/incidents', { title: title.trim(), severity, summary: summary.trim(), templates: ['ioc', 'actions'] });
      location.href = `/incidents/${inc.id}`;
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : 'Could not start the room');
      setBusy(false);
    }
  };

  return (
    <div className="start-page">
      <div className="start-head">
        <span className="brand-mark" aria-hidden />
        <div>
          <h1>War Room is ready</h1>
          <p className="muted">You’re the admin. Start a room for this incident, or pick up a room you exported from another War Room.</p>
        </div>
      </div>
      {meta.mode === 'now' && !meta.guestEmail.enabled && (
        <div className="alert warn">
          Email isn’t set up, so invites are link-only and people can’t sign back in with a code. Set it up in{' '}
          <a href="/admin?tab=settings&section=email">Admin → Settings → Email</a>.
        </div>
      )}
      <div className="start-grid">
        <section className="start-card">
          <h2>{Icons.flag} Start a new room</h2>
          <form className="form" onSubmit={start}>
            <label>
              What’s happening?
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ransomware on finance file servers" required autoFocus maxLength={200} />
            </label>
            <label>
              Severity
              <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
                {meta.severities.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label>
              Summary <span className="muted">(optional)</span>
              <textarea rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} />
            </label>
            {err && <div className="alert error">{err}</div>}
            <button className="btn primary lg" disabled={busy || !title.trim()}>
              Open the war room
            </button>
            <p className="hint">Then invite people from the room: Invite → Responder (full access, verified by email) or Guest (only what you pick).</p>
          </form>
        </section>
        <section className="start-card">
          <h2>{Icons.download} Restore a room</h2>
          <p className="small muted">Upload a <code>.warroom</code> archive exported from any War Room. Everything comes back: chat, timeline, sheets, notes, files, schedule.</p>
          <ImportRoom onImported={(r) => (location.href = `/incidents/${r.incidentId}`)} />
        </section>
      </div>
      <a className="btn ghost sm" href="/">
        Skip to the dashboard
      </a>
    </div>
  );
}
