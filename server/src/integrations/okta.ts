/**
 * Okta read-only client: user lookup and System Log search.
 * Needs an API token from a Read-Only Administrator (Security > API > Tokens).
 */
import { callApi, IntegrationError, MAX_ROWS, type TableResult } from './http.js';

export interface OktaCreds {
  baseUrl: string;
  token: string;
}

const headers = (c: OktaCreds) => ({ Authorization: `SSWS ${c.token}`, Accept: 'application/json' });

async function getJson<T>(c: OktaCreds, path: string): Promise<{ data: T; next: string | null }> {
  const res = await callApi(path.startsWith('http') ? path : `${c.baseUrl}${path}`, { headers: headers(c) });
  const link = res.headers.get('link') ?? '';
  const next = link.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
  return { data: (await res.json()) as T, next };
}

export async function testOkta(c: OktaCreds) {
  await getJson(c, '/api/v1/users?limit=1');
  return 'Connected: token can read users and logs';
}

/** Quick filters offered in the war room, as Okta System Log filter expressions. */
export const OKTA_QUICK_FILTERS = [
  { key: 'all', label: 'All activity', filter: '' },
  { key: 'signins', label: 'Sign-ins', filter: 'eventType eq "user.session.start"' },
  { key: 'failures', label: 'Failures only', filter: 'outcome.result eq "FAILURE"' },
  { key: 'mfa', label: 'MFA factor changes', filter: 'eventType sw "user.mfa.factor"' },
  {
    key: 'credentials',
    label: 'Password changes & resets',
    filter: '(eventType eq "user.account.update_password" or eventType eq "user.account.reset_password" or eventType eq "user.lifecycle.reset_password")',
  },
  { key: 'privilege', label: 'Admin privilege changes', filter: 'eventType sw "user.account.privilege"' },
  { key: 'apps', label: 'App access (SSO)', filter: 'eventType eq "user.authentication.sso"' },
  { key: 'sessions', label: 'Session clears / revocations', filter: '(eventType eq "user.session.clear" or eventType eq "user.session.end")' },
] as const;

interface OktaUser {
  id: string;
  status: string;
  created: string;
  activated: string | null;
  lastLogin: string | null;
  lastUpdated: string;
  passwordChanged: string | null;
  profile: Record<string, string | null>;
}

const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export async function findOktaUser(c: OktaCreds, login: string): Promise<OktaUser | null> {
  const exact = await getJson<OktaUser[]>(
    c,
    `/api/v1/users?search=${encodeURIComponent(`profile.login eq "${q(login)}" or profile.email eq "${q(login)}"`)}&limit=2`,
  );
  if (exact.data[0]) return exact.data[0];
  const fuzzy = await getJson<OktaUser[]>(c, `/api/v1/users?q=${encodeURIComponent(login)}&limit=2`);
  return fuzzy.data[0] ?? null;
}

/** Profile card for a person: account state, factors and groups. */
export async function lookupOktaUser(c: OktaCreds, login: string) {
  const user = await findOktaUser(c, login);
  if (!user) throw new IntegrationError(`No Okta user matches “${login}”`, 404);
  const [factors, groups] = await Promise.all([
    getJson<{ factorType: string; provider: string; status: string; created: string; lastUpdated: string }[]>(c, `/api/v1/users/${user.id}/factors`).catch(() => ({ data: [] })),
    getJson<{ profile: { name: string } }[]>(c, `/api/v1/users/${user.id}/groups?limit=100`).catch(() => ({ data: [] })),
  ]);
  return {
    id: user.id,
    login: user.profile.login,
    name: [user.profile.firstName, user.profile.lastName].filter(Boolean).join(' ') || user.profile.displayName || user.profile.login,
    email: user.profile.email,
    title: user.profile.title ?? null,
    department: user.profile.department ?? null,
    manager: user.profile.manager ?? null,
    status: user.status,
    created: user.created,
    lastLogin: user.lastLogin,
    passwordChanged: user.passwordChanged,
    lastUpdated: user.lastUpdated,
    factors: factors.data.map((f) => ({ type: f.factorType, provider: f.provider, status: f.status, enrolled: f.created, updated: f.lastUpdated })),
    groups: groups.data.map((g) => g.profile.name),
  };
}

interface OktaEvent {
  uuid: string;
  published: string;
  eventType: string;
  displayMessage: string;
  severity: string;
  outcome?: { result: string; reason?: string | null };
  actor?: { alternateId?: string; displayName?: string; type?: string };
  client?: {
    ipAddress?: string | null;
    userAgent?: { browser?: string; os?: string; rawUserAgent?: string } | null;
    geographicalContext?: { city?: string | null; country?: string | null } | null;
  };
  target?: { alternateId?: string; displayName?: string; type?: string }[] | null;
  debugContext?: { debugData?: Record<string, string> };
}

export const OKTA_COLUMNS = ['Time (UTC)', 'Event', 'Outcome', 'Actor', 'IP', 'Location', 'Client', 'Target', 'Message'];

export function eventRow(e: OktaEvent): Record<string, string> {
  const geo = e.client?.geographicalContext;
  const ua = e.client?.userAgent;
  return {
    'Time (UTC)': e.published.replace('T', ' ').slice(0, 19),
    Event: e.eventType,
    Outcome: [e.outcome?.result, e.outcome?.reason].filter(Boolean).join(': '),
    Actor: e.actor?.alternateId ?? e.actor?.displayName ?? '',
    IP: e.client?.ipAddress ?? '',
    Location: [geo?.city, geo?.country].filter(Boolean).join(', '),
    Client: [ua?.browser, ua?.os].filter((v) => v && v !== 'UNKNOWN').join(' / '),
    Target: (e.target ?? []).map((t) => t.alternateId || t.displayName).filter(Boolean).join(', '),
    Message: e.displayMessage ?? '',
  };
}

export interface OktaLogQuery {
  login?: string;
  mode?: 'actor' | 'keyword';
  quickFilter?: string;
  filter?: string;
  since: string;
  until?: string;
}

export function buildLogFilter(p: OktaLogQuery): { filter: string; q: string } {
  const parts: string[] = [];
  let keyword = '';
  if (p.login) {
    if (p.mode === 'keyword') keyword = p.login;
    else parts.push(`actor.alternateId eq "${q(p.login)}"`);
  }
  const quick = OKTA_QUICK_FILTERS.find((f) => f.key === p.quickFilter);
  if (quick?.filter) parts.push(quick.filter);
  if (p.filter?.trim()) parts.push(`(${p.filter.trim()})`);
  return { filter: parts.join(' and '), q: keyword };
}

export async function searchOktaLogs(c: OktaCreds, p: OktaLogQuery): Promise<TableResult> {
  const { filter, q: keyword } = buildLogFilter(p);
  const params = new URLSearchParams({ since: p.since, sortOrder: 'DESCENDING', limit: '200' });
  if (p.until) params.set('until', p.until);
  if (filter) params.set('filter', filter);
  if (keyword) params.set('q', keyword);
  const rows: Record<string, string>[] = [];
  let url: string | null = `/api/v1/logs?${params}`;
  let pages = 0;
  while (url && rows.length < MAX_ROWS && pages < 5) {
    const page: { data: OktaEvent[]; next: string | null } = await getJson<OktaEvent[]>(c, url);
    rows.push(...page.data.map(eventRow));
    // An empty page means we've reached "now"; Okta keeps returning a next link for polling.
    url = page.data.length ? page.next : null;
    pages++;
  }
  return { columns: OKTA_COLUMNS, rows: rows.slice(0, MAX_ROWS), total: rows.length, truncated: rows.length >= MAX_ROWS || Boolean(url) };
}

/** New events for a live watch, oldest first, strictly after `since`. */
export async function pollOktaEvents(c: OktaCreds, login: string, since: string): Promise<OktaEvent[]> {
  const params = new URLSearchParams({
    since,
    sortOrder: 'ASCENDING',
    limit: '100',
    filter: `actor.alternateId eq "${q(login)}"`,
  });
  const { data } = await getJson<OktaEvent[]>(c, `/api/v1/logs?${params}`);
  return data.filter((e) => e.published > since);
}

export function describeEvent(e: OktaEvent): string {
  const row = eventRow(e);
  const outcome = e.outcome?.result ?? '';
  const flag = outcome === 'FAILURE' || outcome === 'DENY' ? '⚠ ' : '';
  const where = [row.IP && `\`${row.IP}\``, row.Location && `(${row.Location})`].filter(Boolean).join(' ');
  return `${flag}**Okta** · \`${e.eventType}\` ${outcome} — ${row.Actor}${where ? ` from ${where}` : ''}${row.Target ? ` → ${row.Target}` : ''}\n${e.displayMessage}`;
}
