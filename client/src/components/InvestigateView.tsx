import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useApp } from '../lib/app';
import { getSocket } from '../lib/socket';
import { utcTime } from '../lib/format';
import type { IncidentState } from '../types';
import { Icons } from './ui';

interface Template {
  id: string;
  name: string;
  description: string;
  query: string;
  range: string;
  autoRun: boolean;
  variables: string[];
}

interface Integration {
  id: string;
  type: 'okta' | 'sumo';
  name: string;
  canRun: boolean;
  accessLabel: string;
  templates?: Template[];
}

interface Run {
  id: string;
  integrationId: string | null;
  integrationName: string;
  kind: string;
  title: string;
  status: 'running' | 'done' | 'error';
  progress: string | null;
  error: string | null;
  rowCount: number | null;
  createdByName: string | null;
  createdAt: string;
  finishedAt: string | null;
}

interface Watch {
  id: string;
  integrationId: string;
  login: string;
  channelId: string;
  active: boolean;
  eventCount: number;
  lastPolledAt: string | null;
  lastError: string | null;
  createdByName: string | null;
}

interface Profile {
  login: string;
  name: string;
  email: string;
  title: string | null;
  department: string | null;
  status: string;
  created: string;
  lastLogin: string | null;
  passwordChanged: string | null;
  factors: { type: string; provider: string; status: string; enrolled: string }[];
  groups: string[];
}

type Result =
  | { type: 'table'; columns: string[]; rows: Record<string, string>[]; total: number; truncated: boolean; warnings?: string[] }
  | { type: 'profile'; profile: Profile };

const RANGES = ['15m', '1h', '4h', '24h', '7d', '30d'];
/** Which indicator list fills which template variable. */
const VAR_SOURCE: Record<string, string> = { ip: 'ip', hash: 'hash', user: 'user', domain: 'domain', host: 'host', email: 'user' };

export function InvestigateView({
  state,
  onOpenChannel,
  onOpenSheet,
}: {
  state: IncidentState;
  onOpenChannel: (id: string) => void;
  onOpenSheet: (id: string) => void;
}) {
  const { me, toast, users } = useApp();
  const incidentId = state.incident.id;
  const [integrations, setIntegrations] = useState<Integration[] | null>(null);
  const [quickFilters, setQuickFilters] = useState<{ key: string; label: string }[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [watches, setWatches] = useState<Watch[]>([]);
  const [indicators, setIndicators] = useState<Record<string, string[]>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const load = useCallback(() => {
    api.get<{ integrations: Integration[]; oktaQuickFilters: { key: string; label: string }[] }>(`/api/incidents/${incidentId}/integrations`).then((r) => {
      setIntegrations(r.integrations);
      setQuickFilters(r.oktaQuickFilters);
      setActive((a) => a ?? r.integrations[0]?.id ?? null);
    });
    api.get<{ runs: Run[]; watches: Watch[] }>(`/api/incidents/${incidentId}/investigations`).then((r) => {
      setRuns(r.runs);
      setWatches(r.watches);
      setSelected((s) => s ?? r.runs[0]?.id ?? null);
    });
    api.get<{ indicators: Record<string, string[]> }>(`/api/incidents/${incidentId}/indicators`).then((r) => setIndicators(r.indicators));
  }, [incidentId]);

  useEffect(() => {
    load();
    const s = getSocket();
    const onRun = (r: Run & { incidentId: string }) => {
      if (r.incidentId !== incidentId) return;
      setRuns((rs) => [r, ...rs.filter((x) => x.id !== r.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    };
    const onWatches = (e: { incidentId: string; watches: Watch[] }) => e.incidentId === incidentId && setWatches(e.watches);
    s.on('investigation:update', onRun);
    s.on('watches:update', onWatches);
    return () => {
      s.off('investigation:update', onRun);
      s.off('watches:update', onWatches);
    };
  }, [incidentId, load]);

  const selectedRun = runs.find((r) => r.id === selected) ?? null;
  const selectedStatus = selectedRun?.status;
  useEffect(() => {
    setResult(null);
    if (!selected || selectedStatus !== 'done') return;
    api.get<{ result: Result | null }>(`/api/investigations/${selected}`).then((r) => setResult(r.result));
  }, [selected, selectedStatus]);

  const start = async (integrationId: string, kind: string, params: Record<string, unknown>) => {
    try {
      const r = await api.post<{ run: Run }>(`/api/incidents/${incidentId}/investigations`, { integrationId, kind, params });
      setRuns((rs) => [r.run, ...rs.filter((x) => x.id !== r.run.id)]);
      setSelected(r.run.id);
    } catch (e) {
      toast({ text: e instanceof ApiError ? e.message : 'Search failed to start', tone: 'error' }, 6000);
    }
  };

  const integ = integrations?.find((i) => i.id === active) ?? null;
  const peopleSuggestions = useMemo(
    () => [...new Set([...(indicators.user ?? []), ...users.map((u) => u.email).filter(Boolean)] as string[])],
    [indicators.user, users],
  );

  if (integrations === null) return <div className="skeleton tall" />;

  if (integrations.length === 0) {
    return (
      <div className="investigate">
        <div className="view-head">
          <h2>{Icons.search} Investigate</h2>
        </div>
        <div className="empty">
          <h2>No integrations connected</h2>
          <p className="muted">
            {me.isAdmin ? (
              <>
                Connect Okta or Sumo Logic in <a href="/admin?tab=integrations">Admin → Integrations</a> to search logs from the war room.
              </>
            ) : (
              'Ask a War Room admin to connect Okta or Sumo Logic.'
            )}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="investigate">
      <div className="view-head">
        <h2>{Icons.search} Investigate</h2>
        <div className="seg">
          {integrations.map((i) => (
            <button key={i.id} className={active === i.id ? 'on' : ''} onClick={() => setActive(i.id)}>
              {i.name}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <span className="muted small">Every search is visible to the room and logged on the timeline.</span>
      </div>

      <div className="inv-body">
        <aside className="inv-form">
          {integ && !integ.canRun && (
            <div className="alert warn">
              Searching {integ.name} here is limited to: {integ.accessLabel}. Ask the Incident Commander for a role.
            </div>
          )}
          {integ?.type === 'okta' && (
            <OktaForm
              integ={integ}
              quickFilters={quickFilters}
              people={peopleSuggestions}
              watches={watches.filter((w) => w.integrationId === integ.id)}
              onRun={(kind, params) => start(integ.id, kind, params)}
              onWatch={async (login) => {
                try {
                  const r = await api.post<{ channelId: string }>(`/api/incidents/${incidentId}/watches`, { integrationId: integ.id, login });
                  toast({ text: `Watching ${login} — events stream into #okta-watch`, action: { label: 'Open', run: () => onOpenChannel(r.channelId) } }, 6000);
                } catch (e) {
                  toast({ text: e instanceof ApiError ? e.message : 'Could not start watch', tone: 'error' }, 6000);
                }
              }}
              onStopWatch={(id) => api.del(`/api/watches/${id}`).catch((e) => toast({ text: e.message, tone: 'error' }))}
              onOpenChannel={onOpenChannel}
            />
          )}
          {integ?.type === 'sumo' && (
            <SumoForm key={integ.id} integ={integ} indicators={indicators} onRun={(params) => start(integ.id, 'sumo_search', params)} />
          )}
        </aside>

        <section className="inv-results">
          <div className="inv-runs">
            <div className="inv-runs-head">
              <strong>Searches in this incident</strong> <span className="count">{runs.length}</span>
            </div>
            {runs.length === 0 ? (
              <div className="muted small inv-runs-empty">No searches yet.</div>
            ) : (
              <ul>
                {runs.map((r) => (
                  <li key={r.id} className={`${selected === r.id ? 'on' : ''} st-${r.status}`}>
                    <button onClick={() => setSelected(r.id)}>
                      <span className={`run-dot ${r.status}`} aria-label={r.status} />
                      <span className="run-title">{r.title}</span>
                      <span className="muted small run-meta">
                        {r.status === 'running' ? (r.progress ?? 'running…') : r.status === 'error' ? 'failed' : `${r.rowCount ?? 0} results`} · {r.createdByName ?? '—'} ·{' '}
                        <span className="mono">{utcTime(r.createdAt)}Z</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="inv-result">
            {selectedRun ? (
              <ResultPanel
                run={selectedRun}
                result={result}
                state={state}
                onOpenSheet={onOpenSheet}
              />
            ) : (
              <div className="empty sm">Run a search to see results here.</div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function OktaForm({
  integ,
  quickFilters,
  people,
  watches,
  onRun,
  onWatch,
  onStopWatch,
  onOpenChannel,
}: {
  integ: Integration;
  quickFilters: { key: string; label: string }[];
  people: string[];
  watches: Watch[];
  onRun: (kind: string, params: Record<string, unknown>) => void;
  onWatch: (login: string) => void;
  onStopWatch: (id: string) => void;
  onOpenChannel: (id: string) => void;
}) {
  const [login, setLogin] = useState('');
  const [range, setRange] = useState('24h');
  const [quick, setQuick] = useState('all');
  const [mode, setMode] = useState<'actor' | 'keyword'>('actor');
  const [filter, setFilter] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const disabled = !integ.canRun;
  const activeWatches = watches.filter((w) => w.active);

  return (
    <div className="form">
      <label>
        Person (Okta username or email)
        <input list="okta-people" value={login} onChange={(e) => setLogin(e.target.value)} placeholder="jane.doe@company.com" />
        <datalist id="okta-people">
          {people.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
      </label>
      <div className="row">
        <label className="grow">
          Show
          <select value={quick} onChange={(e) => setQuick(e.target.value)}>
            {quickFilters.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
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
      <div className="seg small-seg" role="radiogroup" aria-label="Match person as">
        <button type="button" className={mode === 'actor' ? 'on' : ''} onClick={() => setMode('actor')} title="Events this person performed">
          Performed by them
        </button>
        <button type="button" className={mode === 'keyword' ? 'on' : ''} onClick={() => setMode('keyword')} title="Any event mentioning them, including as a target">
          Mentions them
        </button>
      </div>
      <button type="button" className="link-btn small left" onClick={() => setAdvanced((a) => !a)}>
        {advanced ? 'Hide' : 'Add'} filter expression
      </button>
      {advanced && (
        <label>
          Okta filter expression
          <input className="mono" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder='client.ipAddress eq "203.0.113.7"' />
        </label>
      )}
      <div className="btn-col">
        <button className="btn primary" disabled={disabled} onClick={() => onRun('okta_logs', { login, range, quickFilter: quick, mode, filter })}>
          {Icons.search} Search System Log
        </button>
        <div className="row">
          <button className="btn secondary grow" disabled={disabled || !login.trim()} onClick={() => onRun('okta_user', { login })}>
            Look up profile
          </button>
          <button className="btn secondary grow" disabled={disabled || !login.trim()} onClick={() => onWatch(login.trim())} title="Stream this person's new Okta events into #okta-watch">
            {Icons.eye} Watch live
          </button>
        </div>
      </div>

      <fieldset>
        <legend>Live watches {activeWatches.length > 0 && <span className="count">{activeWatches.length}</span>}</legend>
        {watches.length === 0 && <p className="hint">Watch a person to stream their new Okta events into #okta-watch every 30 seconds.</p>}
        {watches.map((w) => (
          <div key={w.id} className={`watch ${w.active ? 'on' : ''}`}>
            <span className={`run-dot ${w.active ? 'running' : 'done'}`} />
            <div className="grow">
              <div className="mono small">{w.login}</div>
              <div className="muted small">
                {w.active ? 'live' : 'stopped'} · {w.eventCount} events{w.lastError ? ` · ⚠ ${w.lastError}` : ''}
              </div>
            </div>
            <button className="btn ghost sm" onClick={() => onOpenChannel(w.channelId)}>
              Open
            </button>
            {w.active && (
              <button className="btn ghost sm danger-text" onClick={() => onStopWatch(w.id)}>
                Stop
              </button>
            )}
          </div>
        ))}
      </fieldset>
    </div>
  );
}

function SumoForm({ integ, indicators, onRun }: { integ: Integration; indicators: Record<string, string[]>; onRun: (params: Record<string, unknown>) => void }) {
  const templates = integ.templates ?? [];
  const [tplId, setTplId] = useState<string | null>(templates[0]?.id ?? null);
  const tpl = templates.find((t) => t.id === tplId) ?? null;
  const [query, setQuery] = useState(tpl?.query ?? '');
  const [range, setRange] = useState(tpl?.range ?? '24h');
  const [vars, setVars] = useState<Record<string, string>>({});
  const variables = useMemo(() => [...new Set([...query.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]))], [query]);

  const pick = (t: Template | null) => {
    setTplId(t?.id ?? null);
    setQuery(t?.query ?? '');
    setRange(t?.range ?? '24h');
  };

  return (
    <div className="form">
      <fieldset>
        <legend>Starter queries</legend>
        <div className="tpl-list">
          {templates.map((t) => (
            <button key={t.id} type="button" className={`tpl ${tplId === t.id ? 'on' : ''}`} onClick={() => pick(t)}>
              <strong>{t.name}</strong>
              <small className="muted">{t.description}</small>
              {t.autoRun && <span className="tag">auto-runs</span>}
            </button>
          ))}
          <button type="button" className={`tpl ${tplId === null ? 'on' : ''}`} onClick={() => pick(null)}>
            <strong>Custom query</strong>
            <small className="muted">Write your own Sumo Logic search.</small>
          </button>
        </div>
      </fieldset>

      {variables.map((v) => {
        const suggestions = indicators[VAR_SOURCE[v] ?? ''] ?? [];
        return (
          <label key={v}>
            {v}
            <input value={vars[v] ?? ''} onChange={(e) => setVars({ ...vars, [v]: e.target.value })} placeholder={`Value for {{${v}}}`} />
            {suggestions.length > 0 && (
              <div className="chips" aria-label={`Suggestions from this incident's sheets`}>
                {suggestions.slice(0, 8).map((s) => (
                  <button type="button" key={s} className={`chip-btn ${vars[v] === s ? 'on' : ''}`} onClick={() => setVars({ ...vars, [v]: s })}>
                    {s}
                  </button>
                ))}
              </div>
            )}
          </label>
        );
      })}

      <label>
        Query
        <textarea className="mono" rows={6} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="_sourceCategory=prod/firewall* 203.0.113.7 | count by src_ip" />
      </label>
      <div className="row">
        <label>
          Last
          <select value={range} onChange={(e) => setRange(e.target.value)}>
            {RANGES.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <div className="spacer" />
        <button
          className="btn primary"
          disabled={!integ.canRun || !query.trim()}
          onClick={() => onRun({ templateId: tpl && query === tpl.query ? tpl.id : null, query, vars, range })}
        >
          {Icons.search} Run search
        </button>
      </div>
      {indicators && Object.values(indicators).some((l) => l.length) && (
        <p className="hint">Suggestions come from indicators in this incident's sheets (IPs, hashes, domains, people, hosts).</p>
      )}
    </div>
  );
}

function ResultPanel({ run, result, state, onOpenSheet }: { run: Run; result: Result | null; state: IncidentState; onOpenSheet: (id: string) => void }) {
  const { toast } = useApp();
  const [filter, setFilter] = useState('');
  const [shareTo, setShareTo] = useState('');

  const rows = useMemo(() => {
    if (result?.type !== 'table') return [];
    const f = filter.trim().toLowerCase();
    return f ? result.rows.filter((r) => Object.values(r).some((v) => v.toLowerCase().includes(f))) : result.rows;
  }, [result, filter]);

  const toSheet = async () => {
    try {
      const r = await api.post<{ sheetId: string }>(`/api/investigations/${run.id}/to-sheet`, {});
      toast({ text: 'Results copied to a new sheet', action: { label: 'Open', run: () => onOpenSheet(r.sheetId) } }, 6000);
    } catch (e) {
      toast({ text: e instanceof ApiError ? e.message : 'Copy failed', tone: 'error' });
    }
  };
  const share = async () => {
    if (!shareTo) return;
    await api.post(`/api/investigations/${run.id}/share`, { channelId: shareTo });
    toast({ text: 'Posted to channel' }, 2500);
    setShareTo('');
  };
  const toTimeline = async () => {
    await api.post(`/api/incidents/${state.incident.id}/timeline`, {
      type: 'finding',
      text: `${run.title}: ${run.status === 'error' ? `failed (${run.error})` : `${run.rowCount ?? 0} results`}`,
    });
    toast({ text: 'Added to timeline as a finding' }, 2500);
  };

  return (
    <div className="result">
      <div className="result-head">
        <div className="grow">
          <strong>{run.title}</strong>
          <div className="muted small">
            {run.integrationName} · {run.createdByName ?? 'Automation'} · <span className="mono">{utcTime(run.createdAt, true)}Z</span>
          </div>
        </div>
        {run.status === 'done' && (
          <div className="result-actions">
            {result?.type === 'table' && (
              <button className="btn ghost sm" onClick={toSheet}>
                {Icons.grid} To sheet
              </button>
            )}
            <button className="btn ghost sm" onClick={toTimeline}>
              {Icons.clock} To timeline
            </button>
            <select value={shareTo} onChange={(e) => setShareTo(e.target.value)} aria-label="Share to channel">
              <option value="">Share to…</option>
              {state.channels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </select>
            {shareTo && (
              <button className="btn secondary sm" onClick={share}>
                Post
              </button>
            )}
          </div>
        )}
      </div>

      {run.status === 'running' && (
        <div className="empty sm">
          <div className="spinner" aria-hidden />
          {run.progress ?? 'Running…'}
        </div>
      )}
      {run.status === 'error' && <div className="alert error">{run.error}</div>}
      {run.status === 'done' && !result && <div className="skeleton" />}

      {result?.type === 'profile' && <ProfileCard p={result.profile} />}

      {result?.type === 'table' && (
        <>
          <div className="result-toolbar">
            <input placeholder="Filter results" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <span className="muted small">
              {rows.length} shown{result.truncated ? ` · first ${result.rows.length} of ${result.total}` : ''}
            </span>
            {result.warnings?.map((w) => (
              <span key={w} className="warn-text small">
                ⚠ {w}
              </span>
            ))}
          </div>
          {result.rows.length === 0 ? (
            <div className="empty sm">No results in this time range.</div>
          ) : (
            <div className="result-table-wrap">
              <table className="table result-table">
                <thead>
                  <tr>
                    {result.columns.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className={r.Outcome?.startsWith('FAILURE') || r.Outcome?.startsWith('DENY') ? 'fail' : ''}>
                      {result.columns.map((c) => (
                        <td key={c} className={c === '_raw' || c === 'Message' ? 'wide' : ''} title={r[c]}>
                          {r[c]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ProfileCard({ p }: { p: Profile }) {
  const recent = (iso: string | null, hours: number) => (iso ? Date.now() - new Date(iso).getTime() < hours * 3600e3 : false);
  return (
    <div className="profile-card">
      <div className="profile-top">
        <div>
          <h3>{p.name}</h3>
          <div className="mono small muted">{p.login}</div>
          {(p.title || p.department) && <div className="small muted">{[p.title, p.department].filter(Boolean).join(' · ')}</div>}
        </div>
        <span className={`status ${p.status === 'ACTIVE' ? 'status-monitoring' : 'status-investigating'}`}>{p.status}</span>
      </div>
      <dl className="kv">
        <dt>Last sign-in</dt>
        <dd className="mono">{p.lastLogin ? `${utcTime(p.lastLogin, true)}Z` : 'never'}</dd>
        <dt>Password changed</dt>
        <dd className="mono">
          {p.passwordChanged ? `${utcTime(p.passwordChanged, true)}Z` : '—'}
          {recent(p.passwordChanged, 24) && <span className="warn-text"> · within 24h</span>}
        </dd>
        <dt>Account created</dt>
        <dd className="mono">{utcTime(p.created, true)}Z</dd>
        <dt>MFA factors</dt>
        <dd>
          {p.factors.length === 0 ? (
            <span className="warn-text">none enrolled</span>
          ) : (
            p.factors.map((f) => (
              <div key={f.type + f.enrolled}>
                {f.type} ({f.provider}) · {f.status.toLowerCase()} · enrolled <span className="mono">{utcTime(f.enrolled, true).slice(0, 10)}</span>
                {recent(f.enrolled, 72) && <span className="warn-text"> · new</span>}
              </div>
            ))
          )}
        </dd>
        <dt>Groups</dt>
        <dd>{p.groups.join(', ') || '—'}</dd>
      </dl>
    </div>
  );
}
