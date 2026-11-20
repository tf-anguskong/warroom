import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';

interface ConnectRequest {
  id: string;
  clientName: string;
  returnsTo: string;
  scopes: ('read' | 'write' | 'investigate')[];
  days: number;
}
interface Incident {
  id: string;
  key: string;
  title: string;
  severity: string;
}

/**
 * OAuth consent: an AI agent app (an MCP client such as Claude) asks to work in War Room as the
 * signed-in person. They choose what it may do and where, or decline. Signing in first happens
 * through the normal sign-in page (the API sends us there and back).
 */
export function Connect() {
  const { id = '' } = useParams();
  const [req, setReq] = useState<ConnectRequest | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [write, setWrite] = useState(true);
  const [investigate, setInvestigate] = useState(false);
  const [where, setWhere] = useState<'all' | 'one'>('all');
  const [incidentId, setIncidentId] = useState('');
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ request: ConnectRequest; incidents: Incident[] }>(`/api/agents/requests/${id}`)
      .then((r) => {
        setReq(r.request);
        setIncidents(r.incidents);
        setIncidentId(r.incidents[0]?.id ?? '');
        setWrite(r.request.scopes.includes('write'));
      })
      .catch((e) => setErr(e instanceof ApiError && e.status < 500 ? e.message : 'Can’t reach War Room right now. Try again in a moment.'));
    api
      .get<{ user: { displayName: string; email: string | null } }>('/api/me')
      .then((r) => setMe(r.user.email ? `${r.user.displayName} (${r.user.email})` : r.user.displayName))
      .catch(() => undefined);
  }, [id]);

  const answer = async (approve: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const r = approve
        ? await api.post<{ redirect: string }>(`/api/agents/requests/${id}/approve`, {
            scopes: [...(write ? ['write'] : []), ...(investigate ? ['investigate'] : [])],
            incidentId: where === 'one' ? incidentId : null,
          })
        : await api.post<{ redirect: string }>(`/api/agents/requests/${id}/deny`, {});
      setLeaving(approve ? `Connected. Returning you to ${req?.clientName ?? 'the agent'}…` : `Declined. Returning you to ${req?.clientName ?? 'the agent'}…`);
      location.href = r.redirect;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
      setBusy(false);
    }
  };

  const switchAccount = async () => {
    await api.post('/auth/logout');
    location.href = `/login?returnTo=${encodeURIComponent(`/connect/${id}`)}`;
  };

  const offers = (s: 'write' | 'investigate') => Boolean(req?.scopes.includes(s));

  return (
    <div className="login-page">
      <div className="login-card connect-card">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <div>
            <h1>War Room</h1>
            <p className="muted">Connect an AI agent</p>
          </div>
        </div>

        {leaving ? (
          <div className="form">
            <div className="ask-waiting">
              <span className="spinner" aria-hidden />
              <div>
                <strong>{leaving}</strong>
                <div className="small muted">You can close this tab if nothing happens.</div>
              </div>
            </div>
          </div>
        ) : err && !req ? (
          <div className="alert error">
            <div>{err}</div>
          </div>
        ) : !req ? (
          <div className="skeleton" />
        ) : (
          <div className="form">
            <p>
              <strong>{req.clientName}</strong> wants to work in War Room as you.
            </p>
            <div className="alert warn">
              <div className="small">
                War Room hasn’t verified this app; the name is what it calls itself. It will send you back to <span className="mono">{req.returnsTo}</span>. Only
                continue if you just started connecting this agent yourself.
              </div>
            </div>
            {me && (
              <p className="small muted">
                Signed in as <strong>{me}</strong>.{' '}
                <button type="button" className="link-btn small" onClick={switchAccount}>
                  Use a different account
                </button>
              </p>
            )}

            <fieldset className="scope-group">
              <legend>It may</legend>
              <label className="check">
                <input type="checkbox" checked disabled /> Read war rooms: chat, the timeline, sheets, notes and files you can see
              </label>
              <label className={`check ${offers('write') ? '' : 'disabled'}`} title={offers('write') ? undefined : `${req.clientName} didn’t ask for this`}>
                <input type="checkbox" checked={write && offers('write')} disabled={!offers('write')} onChange={(e) => setWrite(e.target.checked)} /> Post messages,
                add timeline entries and fill in sheets and notes, as you, marked as {req.clientName}
              </label>
              <label className={`check ${offers('investigate') ? '' : 'disabled'}`} title={offers('investigate') ? undefined : `${req.clientName} didn’t ask for this`}>
                <input type="checkbox" checked={investigate && offers('investigate')} disabled={!offers('investigate')} onChange={(e) => setInvestigate(e.target.checked)} />{' '}
                Run Okta, Sumo Logic and CrowdStrike searches (each one goes on the timeline)
              </label>
            </fieldset>

            <fieldset className="scope-group">
              <legend>In</legend>
              <label className="check">
                <input type="radio" name="where" checked={where === 'all'} onChange={() => setWhere('all')} /> Every war room I can open
              </label>
              <label className={`check ${incidents.length ? '' : 'disabled'}`}>
                <input type="radio" name="where" checked={where === 'one'} disabled={!incidents.length} onChange={() => setWhere('one')} /> Only one war room
              </label>
              {where === 'one' && (
                <select value={incidentId} onChange={(e) => setIncidentId(e.target.value)}>
                  {incidents.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.key} · {i.severity} · {i.title}
                    </option>
                  ))}
                </select>
              )}
            </fieldset>

            <p className="small muted">
              It can never change roles, invite or remove people, moderate voice or change settings. Access lasts {req.days} days; disconnect it any time from{' '}
              <strong>AI agents</strong> on the incident list.
            </p>
            {err && (
              <div className="alert error">
                <div>{err}</div>
              </div>
            )}
            <div className="connect-actions">
              <button className="btn ghost" disabled={busy} onClick={() => answer(false)}>
                Don’t allow
              </button>
              <button className="btn primary" disabled={busy || (where === 'one' && !incidentId)} onClick={() => answer(true)}>
                Allow
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
