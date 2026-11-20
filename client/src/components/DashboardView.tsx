import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { getSocket } from '../lib/socket';
import { utcTime } from '../lib/format';
import { Icons, SeverityBadge, StatusPill } from './ui';
import { AgentTag } from './Agents';

/** War room dashboard: status board + people and coverage. Used in the room and in wall mode. */

interface Dist {
  total: number;
  byValue: { value: string; color: string; count: number }[];
}
interface ActionItem {
  action: string;
  owner: string | null;
  priority: string;
  status: string;
  due: string | null;
  overdue: boolean;
  sheet: string;
}
interface Person {
  userId: string;
  name: string;
  title: string;
  guest: boolean;
  roles: string[];
  inRoom: boolean;
  voice: string | null;
  camera: boolean;
  away: { until: string | null; note: string } | null;
  onShift: { until: string; note: string } | null;
  nextShift: { start: string; end: string } | null;
  task: string;
  load: { actions: number; iocs: number; assets: number; assignments: number };
}
export interface Dashboard {
  incident: { id: string; key: string; title: string; summary: string; severity: string; status: string; statusLabel: string; createdAt: string; resolvedAt: string | null; commander: string | null };
  phases: { status: string; label: string; start: string; end: string | null; minutes: number }[];
  iocs: Dist | null;
  assets: Dist | null;
  impact: Dist | null;
  actions: { total: number; open: number; overdue: number; blocked: number; byPriority: { priority: string; open: number }[]; list: ActionItem[] } | null;
  comms: {
    intervalMinutes: number;
    audience: string | null;
    last: { at: string; by: string | null; summary: string } | null;
    dueAt: string | null;
    overdue: boolean;
    byAudience: { audience: string; last: string | null; by: string | null }[];
  } | null;
  latest: { ts: string; type: string; text: string; by: string | null; agent: string | null }[] | null;
  people: {
    counts: { total: number; inRoom: number; inVoice: number; away: number; onShift: number };
    list: Person[];
    coverage: { start: string; people: string[] }[] | null;
    gaps: { start: string; end: string }[];
  } | null;
  generatedAt: string;
}

const ROLE_LABEL: Record<string, string> = { commander: 'IC', scribe: 'Scribe', comms: 'Comms', tech: 'Tech', security: 'Security' };

/** "2h 05m", "3d 4h", "12m" */
export function span(min: number) {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ${String(min % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
const since = (iso: string, now: number) => span(Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000)));
const until = (iso: string, now: number) => span(Math.max(0, Math.round((new Date(iso).getTime() - now) / 60_000)));
const hhmm = (iso: string) => `${utcTime(iso).slice(0, 5)}Z`;

/** Load the dashboard and keep it fresh: on room events (debounced) and every 20 seconds. */
export function useDashboard(incidentId: string, live: boolean) {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api
      .get<Dashboard>(`/api/incidents/${incidentId}/dashboard`)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the dashboard'));
  }, [incidentId]);
  useEffect(() => {
    load();
    const poll = setInterval(load, 20_000);
    let t: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(t);
      t = setTimeout(load, 800);
    };
    const s = getSocket();
    const events = ['timeline:new', 'sheet:cells', 'sheet:refresh', 'presence', 'incident:refresh', 'shifts:update'];
    if (live) events.forEach((e) => s.on(e, soon));
    return () => {
      clearInterval(poll);
      clearTimeout(t);
      if (live) events.forEach((e) => s.off(e, soon));
    };
  }, [load, live]);
  return { data, error, reload: load };
}

function Bar({ dist, empty }: { dist: Dist; empty: string }) {
  if (!dist.total) return <div className="muted small">{empty}</div>;
  const parts = dist.byValue.filter((v) => v.count > 0);
  return (
    <div className="dash-dist">
      <div className="dash-bar" role="img" aria-label={parts.map((p) => `${p.value}: ${p.count}`).join(', ')}>
        {parts.map((p) => (
          <span key={p.value} style={{ flexGrow: p.count, background: `var(--c-${p.color}, var(--c-gray))` }} title={`${p.value}: ${p.count}`} />
        ))}
      </div>
      <ul className="dash-legend">
        {dist.byValue.map((p) => (
          <li key={p.value} className={p.count ? '' : 'zero'}>
            <i style={{ background: `var(--c-${p.color}, var(--c-gray))` }} />
            {p.value} <strong>{p.count}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Card({ title, icon, children, tone, wide }: { title: string; icon?: ReactNode; children: ReactNode; tone?: 'warn' | 'bad' | 'ok'; wide?: boolean }) {
  return (
    <section className={`dash-card ${tone ? `tone-${tone}` : ''} ${wide ? 'wide' : ''}`}>
      <h3>
        {icon} {title}
      </h3>
      {children}
    </section>
  );
}

const notTracked = (what: string, columns: string) => (
  <div className="muted small">
    Not tracked here. Add a sheet with {what} (columns {columns}), for example from the template.
  </div>
);

export function DashboardPanels({ data, wall, now }: { data: Dashboard; wall?: boolean; now: number }) {
  const inc = data.incident;
  const totalMin = data.phases.reduce((a, p) => a + p.minutes, 0) || 1;
  const c = data.comms;
  return (
    <div className={`dash-board ${wall ? 'wall' : ''}`}>
      <header className="dash-hero">
        <div className="dash-title">
          <span className="mono muted">{inc.key}</span>
          <h2>{inc.title}</h2>
        </div>
        <div className="dash-facts">
          <SeverityBadge severity={inc.severity} />
          <StatusPill status={inc.status} />
          <span title="Time since the incident was declared">
            <span className="muted">Open</span> <strong className="mono">{inc.resolvedAt ? span(Math.round((new Date(inc.resolvedAt).getTime() - new Date(inc.createdAt).getTime()) / 60_000)) : since(inc.createdAt, now)}</strong>
          </span>
          <span>
            <span className="muted">IC</span> <strong>{inc.commander ?? <em className="warn-text">unassigned</em>}</strong>
          </span>
          {wall && <span className="mono muted">{utcTime(new Date(now).toISOString()).slice(0, 5)} UTC</span>}
        </div>
      </header>

      <section className="dash-phases" aria-label="Time in each status">
        <div className="dash-phase-bar">
          {data.phases.map((p, i) => (
            <span key={i} className={`ph ph-${p.status} ${p.end ? '' : 'now'}`} style={{ flexGrow: Math.max(p.minutes, totalMin * 0.03) }} title={`${p.label}: ${span(p.minutes)}`} />
          ))}
        </div>
        <ol className="dash-phase-list">
          {data.phases.map((p, i) => (
            <li key={i} className={p.end ? '' : 'now'}>
              <i className={`ph-${p.status}`} />
              {p.label} <span className="mono">{p.status === 'resolved' ? hhmm(p.start) : span(p.minutes)}</span>
            </li>
          ))}
        </ol>
      </section>

      <div className="dash-grid">
        <Card
          title="Status updates"
          icon={Icons.megaphone}
          tone={c?.overdue ? 'bad' : c?.dueAt && new Date(c.dueAt).getTime() - now < 10 * 60_000 ? 'warn' : undefined}
        >
          {!c ? (
            notTracked('a comms log', 'Audience and Sent (UTC)')
          ) : (
            <>
              <div className="dash-big">
                {c.last ? (
                  <>
                    <strong>{since(c.last.at, now)}</strong> <span className="muted">since the last update{c.audience ? ` to ${c.audience.toLowerCase()}` : ''}</span>
                  </>
                ) : (
                  <span className="muted">No update sent{c.audience ? ` to ${c.audience.toLowerCase()}` : ''} yet</span>
                )}
              </div>
              {c.dueAt ? (
                <div className={c.overdue ? 'bad-text' : 'small'}>
                  {c.overdue ? `Overdue by ${since(c.dueAt, now)}` : `Next due in ${until(c.dueAt, now)}`} <span className="muted small">(every {span(c.intervalMinutes)} at {inc.severity})</span>
                </div>
              ) : (
                <div className="muted small">{inc.status === 'resolved' ? 'Incident resolved.' : `No update cadence set for ${inc.severity}.`}</div>
              )}
              {c.last?.summary && <div className="small dash-quote">“{c.last.summary}”{c.last.by ? ` — ${c.last.by}` : ''}</div>}
              <ul className="dash-audiences">
                {c.byAudience.map((a) => (
                  <li key={a.audience}>
                    <span>{a.audience}</span>
                    <span className="mono muted">{a.last ? `${since(a.last, now)} ago` : '—'}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>

        <Card title="Actions" icon={Icons.flag} tone={data.actions?.overdue ? 'warn' : undefined}>
          {!data.actions ? (
            notTracked('action items', 'Action and Status')
          ) : (
            <>
              <div className="dash-stats">
                <div>
                  <strong>{data.actions.open}</strong>
                  <span>open</span>
                </div>
                <div className={data.actions.overdue ? 'bad' : ''}>
                  <strong>{data.actions.overdue}</strong>
                  <span>overdue</span>
                </div>
                <div className={data.actions.blocked ? 'warn' : ''}>
                  <strong>{data.actions.blocked}</strong>
                  <span>blocked</span>
                </div>
                <div>
                  <strong>{data.actions.total - data.actions.open}</strong>
                  <span>done</span>
                </div>
              </div>
              {data.actions.byPriority.length > 0 && (
                <div className="dash-chips">
                  {data.actions.byPriority.map((p) => (
                    <span key={p.priority} className="dash-chip">
                      {p.priority} <strong>{p.open}</strong>
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
        </Card>

        <Card title="Containment" icon={Icons.shield}>
          {!data.assets ? notTracked('affected assets', 'Asset and Containment') : <Bar dist={data.assets} empty="No affected assets listed yet." />}
          {data.impact && data.impact.total > 0 && (
            <div className="dash-sub">
              <div className="muted small">By impact</div>
              <Bar dist={data.impact} empty="" />
            </div>
          )}
        </Card>

        <Card title="Indicators" icon={Icons.search}>
          {!data.iocs ? notTracked('an IOC tracker', 'Indicator and Status') : <Bar dist={data.iocs} empty="No indicators listed yet." />}
        </Card>

        {data.actions && data.actions.list.length > 0 && (
          <Card title="Open actions" icon={Icons.flag} wide>
            <table className="dash-table">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Owner</th>
                  <th>Priority</th>
                  <th>Status</th>
                  <th>Due</th>
                </tr>
              </thead>
              <tbody>
                {data.actions.list.map((a, i) => (
                  <tr key={i} className={a.overdue ? 'overdue' : ''}>
                    <td>{a.action}</td>
                    <td>{a.owner ?? <span className="muted">—</span>}</td>
                    <td>{a.priority || '—'}</td>
                    <td>{a.status}</td>
                    <td className="mono">{a.due ? (a.overdue ? `${since(a.due, now)} late` : `in ${until(a.due, now)}`) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        {data.latest && (
          <Card title="Latest decisions and findings" icon={Icons.note} wide>
            {data.latest.length === 0 ? (
              <div className="muted small">Nothing recorded yet. Add decisions and findings on the timeline.</div>
            ) : (
              <ul className="dash-latest">
                {data.latest.map((e, i) => (
                  <li key={i}>
                    <span className={`tl-type t-${e.type}`}>{e.type}</span>
                    <span className="mono muted">{hhmm(e.ts)}</span>
                    <span className="dash-latest-text">
                      {e.text}
                      {e.by && <span className="muted"> — {e.by}</span>}
                      {e.agent && <AgentTag name={e.agent} person={e.by} />}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>

      {data.people && <PeoplePanel people={data.people} now={now} wall={wall} />}

      <div className="muted small dash-foot">Updated {hhmm(data.generatedAt)} · refreshes on its own</div>
    </div>
  );
}

function PeoplePanel({ people, now, wall }: { people: NonNullable<Dashboard['people']>; now: number; wall?: boolean }) {
  const order = (p: Person) => (p.roles.includes('commander') ? 0 : p.voice ? 1 : p.inRoom ? 2 : p.onShift ? 3 : 4);
  const list = [...people.list].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
  const maxLoad = Math.max(1, ...list.map((p) => p.load.actions + p.load.iocs + p.load.assets));
  return (
    <section className="dash-people">
      <h3>
        {Icons.users} People and coverage
      </h3>
      <div className="dash-chips counts">
        <span className="dash-chip">
          In the room <strong>{people.counts.inRoom}</strong>
        </span>
        <span className="dash-chip">
          In voice <strong>{people.counts.inVoice}</strong>
        </span>
        <span className="dash-chip">
          On shift <strong>{people.counts.onShift}</strong>
        </span>
        <span className={`dash-chip ${people.counts.away ? 'warn' : ''}`}>
          Away <strong>{people.counts.away}</strong>
        </span>
        <span className="dash-chip">
          Involved <strong>{people.counts.total}</strong>
        </span>
      </div>

      {people.coverage ? (
        <div className="dash-coverage">
          <div className="muted small">Shift coverage, next 24 hours (UTC)</div>
          <div className="cov-strip">
            {people.coverage.map((h) => (
              <span key={h.start} className={`cov ${h.people.length ? '' : 'gap'}`} title={`${hhmm(h.start)}: ${h.people.join(', ') || 'nobody on shift'}`}>
                <b>{h.people.length || ''}</b>
              </span>
            ))}
          </div>
          <div className="cov-axis mono muted small">
            {people.coverage.filter((_, i) => i % 6 === 0).map((h) => (
              <span key={h.start}>{hhmm(h.start)}</span>
            ))}
          </div>
          {people.gaps.length > 0 && (
            <div className="bad-text small">
              Nobody on shift {people.gaps.map((g) => `${hhmm(g.start)}–${hhmm(g.end)}`).join(', ')}
            </div>
          )}
        </div>
      ) : (
        <div className="muted small">No shifts scheduled in the next 24 hours. Plan them in Schedule.</div>
      )}

      <table className="dash-table people">
        <thead>
          <tr>
            <th>Person</th>
            <th>Where</th>
            <th>Shift</th>
            {!wall && <th>Working on</th>}
            <th title="Open actions, live indicators and uncontained assets they own">Load</th>
          </tr>
        </thead>
        <tbody>
          {list.map((p) => {
            const total = p.load.actions + p.load.iocs + p.load.assets;
            return (
              <tr key={p.userId}>
                <td>
                  <strong>{p.name}</strong>
                  {p.roles.map((r) => (
                    <span key={r} className="role-chip">
                      {ROLE_LABEL[r] ?? r}
                    </span>
                  ))}
                  {p.guest && <span className="guest-tag">guest</span>}
                  {p.title && !wall && <div className="muted small">{p.title}</div>}
                </td>
                <td>
                  {p.away ? (
                    <span className="warn-text">Away{p.away.until ? ` until ${hhmm(p.away.until)}` : ''}</span>
                  ) : p.voice ? (
                    <span className="ok-text">
                      {Icons.volume} {p.voice}
                      {p.camera ? ' · camera' : ''}
                    </span>
                  ) : p.inRoom ? (
                    'In the room'
                  ) : (
                    <span className="muted">Not here</span>
                  )}
                </td>
                <td className="small">
                  {p.onShift ? (
                    <span className="ok-text">On until {hhmm(p.onShift.until)}</span>
                  ) : p.nextShift ? (
                    <span className="muted">Next {hhmm(p.nextShift.start)}</span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                {!wall && <td className="small">{p.task || <span className="muted">—</span>}</td>}
                <td>
                  <div className="load" title={`${p.load.actions} open actions, ${p.load.iocs} live indicators, ${p.load.assets} uncontained assets, ${p.load.assignments} assignments`}>
                    <span className="load-bar">
                      <i style={{ width: `${(total / maxLoad) * 100}%` }} />
                    </span>
                    <span className="mono small">{total}</span>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/** The Dashboard view inside a war room. */
export function DashboardView({ incidentId }: { incidentId: string }) {
  const { data, error } = useDashboard(incidentId, true);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="dashboard-view">
      <div className="view-head">
        <h2>{Icons.grid} Dashboard</h2>
        <div className="spacer" />
        <a className="btn ghost sm" href={`/incidents/${incidentId}/wall`} target="_blank" rel="noopener" title="Full-screen status board for a TV or a second screen">
          {Icons.expand} Wall mode
        </a>
      </div>
      <div className="dash-scroll">
        {error && !data ? <div className="alert error">{error}</div> : !data ? <div className="skeleton" /> : <DashboardPanels data={data} now={now} />}
      </div>
    </div>
  );
}
