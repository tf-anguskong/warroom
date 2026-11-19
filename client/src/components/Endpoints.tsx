import { Fragment, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useApp } from '../lib/app';
import { utcTime } from '../lib/format';
import { Icons, Modal } from './ui';

export interface FalconHost {
  deviceId: string;
  hostname: string;
  platform: string;
  os: string;
  type: string;
  status: string;
  online: string;
  lastSeen: string | null;
  firstSeen: string | null;
  localIp: string | null;
  externalIp: string | null;
  mac: string | null;
  domain: string | null;
  ou: string[];
  site: string | null;
  lastUser: string | null;
  sensorVersion: string | null;
  reducedFunctionality: boolean;
  model: string | null;
  serial: string | null;
  tags: string[];
}

export interface FalconAlert {
  id: string;
  hostname: string | null;
  createdAt: string;
  severity: number;
  severityName: string;
  name: string;
  description: string;
  tactic: string | null;
  technique: string | null;
  status: string;
  user: string | null;
  file: string | null;
  cmdline: string | null;
  sha256: string | null;
  link: string | null;
}

export interface TrackedEndpoint {
  id: string;
  integrationId: string | null;
  integrationName: string | null;
  deviceId: string;
  hostname: string;
  note: string;
  owner: { id: string; name: string | null } | null;
  channelId: string | null;
  host: FalconHost | null;
  alertCount: number;
  severeCount: number;
  recentAlerts: FalconAlert[];
  active: boolean;
  lastPolledAt: string | null;
  lastError: string | null;
  addedByName: string | null;
  addedAt: string;
  removedByName: string | null;
  removedAt: string | null;
}

interface HostMatch {
  deviceId: string;
  hostname: string;
  os: string;
  online: string;
  status: string;
  lastSeen: string | null;
  localIp: string | null;
  lastUser: string | null;
}

const RANGES = ['15m', '1h', '4h', '24h', '7d', '30d'];
const ts = (iso: string | null) => (iso ? `${utcTime(iso, true).slice(0, 16)}Z` : '—');

export const containmentLabel = (s: string) =>
  ({ normal: 'Not contained', contained: 'Contained', containment_pending: 'Containment pending', lift_containment_pending: 'Lift pending' })[s] ?? s;

export function OnlineDot({ state }: { state: string | undefined }) {
  return <span className={`online-dot ${state ?? 'unknown'}`} title={state === 'online' ? 'Online' : state === 'offline' ? 'Offline' : 'Online state unknown'} />;
}

/** CrowdStrike: search hosts and alerts, and track specific endpoints for this incident. */
export function CrowdStrikeForm({
  integ,
  incidentId,
  severities,
  suggestions,
  endpoints,
  selectedEndpoint,
  onRun,
  onSelectEndpoint,
  onOpenChannel,
}: {
  integ: { id: string; name: string; canRun: boolean };
  incidentId: string;
  severities: string[];
  suggestions: string[];
  endpoints: TrackedEndpoint[];
  selectedEndpoint: string | null;
  onRun: (kind: string, params: Record<string, unknown>) => void;
  onSelectEndpoint: (id: string) => void;
  onOpenChannel: (id: string) => void;
}) {
  const { toast, users, me } = useApp();
  const [host, setHost] = useState('');
  const [range, setRange] = useState('24h');
  const [minSeverity, setMinSeverity] = useState('Informational');
  const [note, setNote] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [matches, setMatches] = useState<HostMatch[] | null>(null);
  const disabled = !integ.canRun;
  const members = useMemo(() => users.filter((u) => u.active && !u.isGuest).sort((a, b) => a.displayName.localeCompare(b.displayName)), [users]);
  const mine = endpoints.filter((e) => e.integrationId === integ.id || !e.integrationId);
  const active = mine.filter((e) => e.active);
  const past = mine.filter((e) => !e.active);

  const track = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const r = await api.post<{ needsChoice?: boolean; matches?: HostMatch[]; endpoint?: TrackedEndpoint; channelId?: string }>(
        `/api/incidents/${incidentId}/endpoints`,
        { integrationId: integ.id, note: note.trim(), ownerId: ownerId || null, ...body },
      );
      if (r.needsChoice) {
        setMatches(r.matches ?? []);
        return;
      }
      setMatches(null);
      setHost('');
      setNote('');
      setOwnerId('');
      if (r.endpoint) onSelectEndpoint(r.endpoint.id);
      toast(
        {
          text: `Tracking ${r.endpoint?.hostname}. Changes and new alerts go to #crowdstrike-watch.`,
          action: r.channelId ? { label: 'Open', run: () => onOpenChannel(r.channelId!) } : undefined,
        },
        6000,
      );
    } catch (e) {
      toast({ text: e instanceof ApiError ? e.message : 'Could not track that endpoint', tone: 'error' }, 7000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form">
      <label>
        Host (hostname, IP address or device ID)
        <input list="cs-hosts" value={host} onChange={(e) => (setHost(e.target.value), setMatches(null))} placeholder="WS-FIN-0142 or 10.20.4.17" spellCheck={false} />
        <datalist id="cs-hosts">
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </label>
      {suggestions.length > 0 && (
        <div className="chips" aria-label="Hosts and IPs from this incident's sheets">
          {suggestions.slice(0, 8).map((s) => (
            <button type="button" key={s} className={`chip-btn ${host === s ? 'on' : ''}`} onClick={() => (setHost(s), setMatches(null))}>
              {s}
            </button>
          ))}
        </div>
      )}
      <div className="row">
        <button className="btn secondary grow" disabled={disabled || !host.trim()} onClick={() => onRun('cs_hosts', { query: host })}>
          {Icons.search} Find hosts
        </button>
      </div>

      <fieldset>
        <legend>Alerts</legend>
        <div className="row">
          <label className="grow">
            At least
            <select value={minSeverity} onChange={(e) => setMinSeverity(e.target.value)}>
              {severities.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label>
            Last
            <select value={range} onChange={(e) => setRange(e.target.value)}>
              {RANGES.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
        </div>
        <button className="btn secondary" disabled={disabled} onClick={() => onRun('cs_alerts', { query: host, range, minSeverity })}>
          {host.trim() ? `Alerts on ${host.trim()}` : 'All alerts'}
        </button>
      </fieldset>

      <fieldset>
        <legend>Track an endpoint</legend>
        <label>
          Why (optional)
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Patient zero; beaconing to 203.0.113.7" />
        </label>
        <label>
          Owner (optional)
          <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            <option value="">No owner</option>
            <option value={me.id}>Me ({me.displayName})</option>
            {members
              .filter((u) => u.id !== me.id)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName}
                </option>
              ))}
          </select>
        </label>
        <button className="btn primary" disabled={disabled || busy || !host.trim()} onClick={() => track({ query: host.trim() })}>
          {Icons.eye} {busy ? 'Looking up…' : 'Track endpoint'}
        </button>
        {matches && (
          <div className="host-matches">
            <div className="small">
              {matches.length} hosts match “{host}”. Pick the one to track:
            </div>
            {matches.map((m) => (
              <div key={m.deviceId} className="host-match">
                <OnlineDot state={m.online} />
                <div className="grow">
                  <div>
                    <strong>{m.hostname}</strong> <span className="muted small">{m.os}</span>
                  </div>
                  <div className="muted small mono">
                    {m.localIp ?? '—'} · last seen {ts(m.lastSeen)}
                    {m.lastUser ? ` · ${m.lastUser}` : ''}
                  </div>
                </div>
                <button className="btn secondary sm" disabled={busy} onClick={() => track({ deviceId: m.deviceId })}>
                  Track
                </button>
              </div>
            ))}
          </div>
        )}
        <p className="hint">Tracked endpoints are checked every minute. State changes (online, containment, user, IP) and new alerts go to #crowdstrike-watch; high and critical alerts also go on the timeline.</p>
      </fieldset>

      <fieldset>
        <legend>
          Tracked endpoints {active.length > 0 && <span className="count">{active.length}</span>}
        </legend>
        {mine.length === 0 && <p className="hint">Nothing tracked yet.</p>}
        {[...active, ...past].map((e) => (
          <button key={e.id} type="button" className={`endpoint-row ${selectedEndpoint === e.id ? 'on' : ''} ${e.active ? '' : 'stopped'}`} onClick={() => onSelectEndpoint(e.id)}>
            <OnlineDot state={e.active ? e.host?.online : undefined} />
            <span className="grow">
              <span className="endpoint-name">
                <strong>{e.hostname}</strong>
                {e.host && e.host.status !== 'normal' && <span className="tag contained">{containmentLabel(e.host.status)}</span>}
              </span>
              <span className="muted small">
                {e.active ? (e.owner ? `owner ${e.owner.name}` : 'no owner') : 'stopped'} · {e.alertCount} alert{e.alertCount === 1 ? '' : 's'}
                {e.severeCount > 0 && <span className="danger-text"> · {e.severeCount} high/critical</span>}
                {e.lastError && e.active && <span className="warn-text"> · ⚠</span>}
              </span>
            </span>
          </button>
        ))}
      </fieldset>
    </div>
  );
}

/** Details for one tracked endpoint: state, who owns it, its alerts. */
export function EndpointPanel({ endpoint: e, onOpenChannel }: { endpoint: TrackedEndpoint; onOpenChannel: (id: string) => void }) {
  const { toast, users, me } = useApp();
  const [alerts, setAlerts] = useState<FalconAlert[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [editNote, setEditNote] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const h = e.host;
  const members = useMemo(() => users.filter((u) => u.active && !u.isGuest).sort((a, b) => a.displayName.localeCompare(b.displayName)), [users]);

  useEffect(() => {
    api.get<{ alerts: FalconAlert[] }>(`/api/endpoints/${e.id}/alerts`).then((r) => setAlerts(r.alerts));
  }, [e.id, e.alertCount]);

  const patch = async (body: Record<string, unknown>) => {
    try {
      await api.patch(`/api/endpoints/${e.id}`, body);
    } catch (err) {
      toast({ text: err instanceof ApiError ? err.message : 'Could not save', tone: 'error' }, 6000);
    }
  };
  const refresh = async () => {
    setRefreshing(true);
    try {
      await api.post(`/api/endpoints/${e.id}/refresh`);
    } catch (err) {
      toast({ text: err instanceof ApiError ? err.message : 'Refresh failed', tone: 'error' }, 6000);
    } finally {
      setRefreshing(false);
    }
  };
  const stop = async () => {
    await api.del(`/api/endpoints/${e.id}`);
    setConfirmStop(false);
  };

  return (
    <div className="result endpoint-panel">
      <div className="result-head">
        <div className="grow">
          <div className="endpoint-title">
            <OnlineDot state={e.active ? h?.online : undefined} />
            <strong>{e.hostname}</strong>
            {h && <span className={`tag ${h.online === 'online' ? 'ok' : ''}`}>{h.online}</span>}
            {h && <span className={`tag ${h.status === 'normal' ? '' : 'contained'}`}>{containmentLabel(h.status)}</span>}
            {h?.reducedFunctionality && <span className="tag contained">Reduced functionality</span>}
            {!e.active && <span className="tag">not tracked</span>}
          </div>
          <div className="muted small">
            {e.integrationName ?? 'CrowdStrike'} · tracked by {e.addedByName ?? '—'} since {ts(e.addedAt)}
            {e.active ? ` · checked ${e.lastPolledAt ? ts(e.lastPolledAt) : 'not yet'}` : ` · stopped${e.removedByName ? ` by ${e.removedByName}` : ''} ${ts(e.removedAt)}`}
          </div>
        </div>
        <div className="result-actions">
          {e.channelId && (
            <button className="btn ghost sm" onClick={() => onOpenChannel(e.channelId!)}>
              {Icons.hash} crowdstrike-watch
            </button>
          )}
          {e.active && (
            <>
              <button className="btn ghost sm" onClick={refresh} disabled={refreshing}>
                {refreshing ? 'Checking…' : 'Check now'}
              </button>
              <button className="btn ghost sm danger-text" onClick={() => setConfirmStop(true)}>
                Stop tracking
              </button>
            </>
          )}
        </div>
      </div>

      {e.lastError && <div className="alert warn">{e.lastError}</div>}

      <div className="endpoint-owner">
        <label>
          Owner
          <select value={e.owner?.id ?? ''} disabled={!e.active} onChange={(ev) => patch({ ownerId: ev.target.value || null })}>
            <option value="">No owner</option>
            {members.map((u) => (
              <option key={u.id} value={u.id}>
                {u.id === me.id ? `Me (${u.displayName})` : u.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="grow">
          Why it's tracked
          {editNote === null ? (
            <div className="endpoint-note">
              <span className={e.note ? '' : 'muted'}>{e.note || 'No note'}</span>
              {e.active && (
                <button className="btn ghost sm" onClick={() => setEditNote(e.note)}>
                  Edit
                </button>
              )}
            </div>
          ) : (
            <div className="row">
              <input value={editNote} maxLength={300} autoFocus onChange={(ev) => setEditNote(ev.target.value)} />
              <button
                className="btn secondary sm"
                onClick={() => {
                  void patch({ note: editNote });
                  setEditNote(null);
                }}
              >
                Save
              </button>
            </div>
          )}
        </label>
      </div>

      {h && (
        <dl className="kv endpoint-kv">
          <dt>OS</dt>
          <dd>
            {h.os}
            {h.type ? ` · ${h.type}` : ''}
          </dd>
          <dt>Last seen</dt>
          <dd className="mono">{ts(h.lastSeen)}</dd>
          <dt>Last user</dt>
          <dd className="mono">{h.lastUser ?? '—'}</dd>
          <dt>Local IP</dt>
          <dd className="mono">{h.localIp ?? '—'}</dd>
          <dt>External IP</dt>
          <dd className="mono">{h.externalIp ?? '—'}</dd>
          <dt>MAC</dt>
          <dd className="mono">{h.mac ?? '—'}</dd>
          <dt>Domain / OU</dt>
          <dd>{[h.domain, h.ou.join(' / ')].filter(Boolean).join(' · ') || '—'}</dd>
          <dt>Site</dt>
          <dd>{h.site ?? '—'}</dd>
          <dt>Hardware</dt>
          <dd>{[h.model, h.serial && `S/N ${h.serial}`].filter(Boolean).join(' · ') || '—'}</dd>
          <dt>Sensor</dt>
          <dd className="mono">{h.sensorVersion ?? '—'}</dd>
          <dt>Device ID</dt>
          <dd className="mono small">{h.deviceId}</dd>
          {h.tags.length > 0 && (
            <>
              <dt>Tags</dt>
              <dd>{h.tags.join(', ')}</dd>
            </>
          )}
        </dl>
      )}

      <h3 className="endpoint-alerts-head">
        Alerts <span className="count">{e.alertCount}</span>
        <span className="muted small"> since {ts(new Date(new Date(e.addedAt).getTime() - 24 * 3600e3).toISOString())}</span>
      </h3>
      {alerts === null ? (
        <div className="skeleton" />
      ) : alerts.length === 0 ? (
        <div className="empty sm">No alerts on this endpoint{e.active ? ' yet. New ones show up here and in #crowdstrike-watch.' : '.'}</div>
      ) : (
        <div className="result-table-wrap">
          <table className="table result-table">
            <thead>
              <tr>
                <th>Time (UTC)</th>
                <th>Severity</th>
                <th>Alert</th>
                <th>Tactic / technique</th>
                <th>User</th>
                <th>File</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <Fragment key={a.id}>
                  <tr className={`clickable sev-${a.severityName.toLowerCase()}`} onClick={() => setOpen(open === a.id ? null : a.id)}>
                    <td className="mono">{utcTime(a.createdAt, true).slice(0, 19)}</td>
                    <td>
                      <span className={`sev-pill sev-${a.severityName.toLowerCase()}`}>{a.severityName}</span>
                    </td>
                    <td>{a.name}</td>
                    <td>{[a.tactic, a.technique].filter(Boolean).join(' / ')}</td>
                    <td className="mono">{a.user ?? ''}</td>
                    <td className="mono" title={a.file ?? ''}>
                      {a.file ?? ''}
                    </td>
                    <td>{a.status}</td>
                  </tr>
                  {open === a.id && (
                    <tr className="alert-detail">
                      <td colSpan={7}>
                        {a.description && <p>{a.description}</p>}
                        {a.cmdline && <pre className="codeblock">{a.cmdline}</pre>}
                        <div className="muted small mono">
                          {a.sha256 && <>SHA256 {a.sha256} · </>}
                          {a.link && (
                            <a href={a.link} target="_blank" rel="noreferrer noopener">
                              Open in Falcon
                            </a>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirmStop && (
        <Modal
          title={`Stop tracking ${e.hostname}?`}
          onClose={() => setConfirmStop(false)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setConfirmStop(false)}>
                Cancel
              </button>
              <button className="btn danger" onClick={stop}>
                Stop tracking
              </button>
            </>
          }
        >
          <p>War Room stops checking this endpoint. Its alerts so far stay here, and the change is recorded on the timeline.</p>
        </Modal>
      )}
    </div>
  );
}
