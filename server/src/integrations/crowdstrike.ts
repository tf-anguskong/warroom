/**
 * CrowdStrike Falcon read-only client: find hosts, read their details and online state, and list
 * alerts. Uses an API client (Support and resources → API clients and keys) with the scopes
 * Hosts: Read and Alerts: Read. War Room never changes anything in Falcon.
 */
import { callApi, IntegrationError, MAX_ROWS, type TableResult } from './http.js';

export interface FalconCreds {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

export const FALCON_CLOUDS = [
  { key: 'us-1', label: 'US-1', url: 'https://api.crowdstrike.com' },
  { key: 'us-2', label: 'US-2', url: 'https://api.us-2.crowdstrike.com' },
  { key: 'eu-1', label: 'EU-1', url: 'https://api.eu-1.crowdstrike.com' },
  { key: 'us-gov-1', label: 'US-GOV-1', url: 'https://api.laggar.gcw.crowdstrike.com' },
  { key: 'us-gov-2', label: 'US-GOV-2', url: 'https://api.us-gov-2.crowdstrike.mil' },
];

// ---------- auth: OAuth2 client credentials, token cached until shortly before it expires ----------

const tokens = new Map<string, { token: string; expiresAt: number }>();
const tokenKey = (c: FalconCreds) => `${c.baseUrl}|${c.clientId}|${c.clientSecret.slice(-6)}`;

const inflight = new Map<string, Promise<string>>();

/** A cached token, or a new one. Concurrent callers share one request; `stale` is the token that just failed. */
async function token(c: FalconCreds, stale?: string): Promise<string> {
  const k = tokenKey(c);
  const cached = tokens.get(k);
  if (cached && cached.token !== stale && cached.expiresAt > Date.now() + 60_000) return cached.token;
  let p = inflight.get(k);
  if (!p) {
    p = newToken(c, k).finally(() => inflight.delete(k));
    inflight.set(k, p);
  }
  return p;
}

async function newToken(c: FalconCreds, k: string) {
  const res = await callApi(`${c.baseUrl}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret }).toString(),
  });
  const j = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new IntegrationError('CrowdStrike did not return an access token');
  tokens.set(k, { token: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 1799) * 1000 });
  return j.access_token;
}

interface FalconBody<T> {
  resources?: T[] | null;
  meta?: { pagination?: { total?: number; offset?: number | string; after?: string } };
  errors?: { code: number; message: string }[] | null;
}

async function falcon<T>(c: FalconCreds, path: string, init: { method?: string; body?: unknown } = {}): Promise<FalconBody<T>> {
  const send = (bearer: string) =>
    callApi(`${c.baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  const first = await token(c);
  let res: Response;
  try {
    res = await send(first);
  } catch (err) {
    // A revoked or expired token: get a new one once.
    if (err instanceof IntegrationError && /\(401\)/.test(err.message)) res = await send(await token(c, first));
    else throw err;
  }
  return (await res.json()) as FalconBody<T>;
}

/** FQL string literal. */
const fql = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const chunk = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

export async function testFalcon(c: FalconCreds) {
  tokens.delete(tokenKey(c));
  await token(c);
  const missing: string[] = [];
  await falcon(c, '/devices/queries/devices/v1?limit=1').catch(() => missing.push('Hosts: Read'));
  await falcon(c, '/alerts/queries/alerts/v2?limit=1').catch(() => missing.push('Alerts: Read'));
  if (missing.length === 2) throw new IntegrationError('Signed in, but the API client can’t read hosts or alerts. Give it Hosts: Read and Alerts: Read.', 400);
  if (missing.length) throw new IntegrationError(`Signed in, but the API client is missing ${missing[0]}.`, 400);
  return 'Connected: API client can read hosts and alerts';
}

// ---------- hosts ----------

export interface FalconHost {
  deviceId: string;
  hostname: string;
  platform: string;
  os: string;
  type: string;
  status: string; // normal | contained | containment_pending | lift_containment_pending
  online: string; // online | offline | unknown
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

const HEX32 = /^[0-9a-f]{32}$/i;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-f:]+:[0-9a-f:]*$/i;

/** Build an FQL filter from what a responder types: device ID, IP, or hostname (trailing * = prefix). */
export function hostFilter(query: string) {
  const s = query.trim();
  if (!s) throw new IntegrationError('Enter a hostname, IP address or device ID', 400);
  if (s.length > 253) throw new IntegrationError('That’s too long for a hostname', 400);
  if (HEX32.test(s)) return `device_id:${fql(s.toLowerCase())}`;
  if (IPV4.test(s) || IPV6.test(s)) return `local_ip:${fql(s)},external_ip:${fql(s)}`;
  if (!/^[\w.*-]+$/.test(s)) throw new IntegrationError('Hostnames can only have letters, numbers, dots, dashes and a trailing *', 400);
  if (s.endsWith('*')) return `hostname:*${fql(s)}`;
  // Exact match on the short name or the FQDN.
  return `hostname:${fql(s)},hostname:${fql(s.split('.')[0])}`;
}

function toHost(d: any, online?: string): FalconHost {
  return {
    deviceId: d.device_id,
    hostname: d.hostname ?? '(no hostname)',
    platform: d.platform_name ?? '',
    os: d.os_product_name ?? [d.platform_name, d.os_version].filter(Boolean).join(' '),
    type: d.product_type_desc ?? '',
    status: d.status ?? 'normal',
    online: online ?? 'unknown',
    lastSeen: d.last_seen ?? null,
    firstSeen: d.first_seen ?? null,
    localIp: d.local_ip ?? null,
    externalIp: d.external_ip ?? null,
    mac: d.mac_address ?? null,
    domain: d.machine_domain ?? null,
    ou: Array.isArray(d.ou) ? d.ou : [],
    site: d.site_name ?? null,
    lastUser: d.last_login_user ?? null,
    sensorVersion: d.agent_version ?? null,
    reducedFunctionality: d.reduced_functionality_mode === 'yes',
    model: [d.system_manufacturer, d.system_product_name].filter(Boolean).join(' ') || null,
    serial: d.serial_number ?? null,
    tags: Array.isArray(d.tags) ? d.tags : [],
  };
}

export async function getHosts(c: FalconCreds, ids: string[]): Promise<FalconHost[]> {
  const out: FalconHost[] = [];
  for (const part of chunk(ids, 100)) {
    const qs = part.map((id) => `ids=${encodeURIComponent(id)}`).join('&');
    const [details, states] = await Promise.all([
      falcon<any>(c, `/devices/entities/devices/v2?${qs}`),
      falcon<{ id: string; state: string }>(c, `/devices/entities/online-state/v1?${qs}`).catch(() => ({ resources: [] as { id: string; state: string }[] })),
    ]);
    const state = new Map((states.resources ?? []).map((s) => [s.id, s.state]));
    for (const d of details.resources ?? []) out.push(toHost(d, state.get(d.device_id)));
  }
  return out;
}

export async function findHosts(c: FalconCreds, query: string, limit = 25): Promise<FalconHost[]> {
  const ids = await falcon<string>(c, `/devices/queries/devices/v1?limit=${limit}&sort=last_seen.desc&filter=${encodeURIComponent(hostFilter(query))}`);
  const list = ids.resources ?? [];
  if (!list.length) return [];
  const hosts = await getHosts(c, list);
  const order = new Map(list.map((id, i) => [id, i]));
  return hosts.sort((a, b) => (order.get(a.deviceId) ?? 0) - (order.get(b.deviceId) ?? 0));
}

const when = (iso: string | null) => (iso ? iso.replace('T', ' ').slice(0, 19) : '');

export function hostsTable(hosts: FalconHost[]): TableResult {
  const columns = ['Hostname', 'Online', 'Containment', 'Last seen', 'OS', 'Type', 'Local IP', 'External IP', 'Last user', 'Sensor', 'Device ID'];
  return {
    columns,
    rows: hosts.map((h) => ({
      Hostname: h.hostname,
      Online: h.online,
      Containment: h.status,
      'Last seen': when(h.lastSeen),
      OS: h.os,
      Type: h.type,
      'Local IP': h.localIp ?? '',
      'External IP': h.externalIp ?? '',
      'Last user': h.lastUser ?? '',
      Sensor: h.sensorVersion ?? '',
      'Device ID': h.deviceId,
    })),
    total: hosts.length,
    truncated: false,
  };
}

// ---------- alerts ----------

export interface FalconAlert {
  id: string;
  deviceId: string | null;
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

export const SEVERITIES = ['Informational', 'Low', 'Medium', 'High', 'Critical'];
const sevFloor: Record<string, number> = { Informational: 0, Low: 20, Medium: 40, High: 60, Critical: 80 };

function toAlert(a: any): FalconAlert {
  return {
    id: a.composite_id ?? a.id,
    deviceId: a.device?.device_id ?? null,
    hostname: a.device?.hostname ?? a.hostname ?? null,
    createdAt: a.created_timestamp ?? a.timestamp,
    severity: Number(a.severity ?? 0),
    severityName: a.severity_name ?? (SEVERITIES.slice().reverse().find((s) => Number(a.severity ?? 0) >= sevFloor[s]) ?? 'Informational'),
    name: a.display_name ?? a.name ?? a.scenario ?? 'Alert',
    description: a.description ?? '',
    tactic: a.tactic ?? null,
    technique: a.technique ?? null,
    status: a.status ?? 'new',
    user: a.user_name ?? null,
    file: a.filename ?? a.filepath ?? null,
    cmdline: a.cmdline ?? null,
    sha256: a.sha256 ?? null,
    // Only real https links back to Falcon reach the browser.
    link: typeof a.falcon_host_link === 'string' && /^https:\/\/[^\s"<>]+$/.test(a.falcon_host_link) ? a.falcon_host_link : null,
  };
}

/** Alerts for some hosts (or matching a host filter), newest first unless `asc`. */
export async function listAlerts(
  c: FalconCreds,
  o: { deviceIds?: string[]; since: string; minSeverity?: string; asc?: boolean; limit?: number },
): Promise<{ alerts: FalconAlert[]; total: number }> {
  const parts = [`created_timestamp:>${fql(o.since)}`];
  if (o.deviceIds?.length) parts.push(`device.device_id:[${o.deviceIds.map(fql).join(',')}]`);
  if (o.minSeverity && sevFloor[o.minSeverity]) parts.push(`severity:>=${sevFloor[o.minSeverity]}`);
  const limit = Math.min(o.limit ?? MAX_ROWS, MAX_ROWS);
  const idsRes = await falcon<string>(
    c,
    `/alerts/queries/alerts/v2?limit=${limit}&sort=${encodeURIComponent(`created_timestamp|${o.asc ? 'asc' : 'desc'}`)}&filter=${encodeURIComponent(parts.join('+'))}`,
  );
  const ids = idsRes.resources ?? [];
  const total = Number(idsRes.meta?.pagination?.total ?? ids.length);
  const alerts: FalconAlert[] = [];
  for (const part of chunk(ids, 100)) {
    const r = await falcon<any>(c, '/alerts/entities/alerts/v2', { method: 'POST', body: { composite_ids: part } });
    alerts.push(...(r.resources ?? []).map(toAlert));
  }
  alerts.sort((a, b) => (o.asc ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt)));
  return { alerts, total };
}

export function alertsTable(alerts: FalconAlert[], total: number): TableResult {
  const columns = ['Time (UTC)', 'Severity', 'Host', 'Alert', 'Tactic / technique', 'User', 'File', 'Command line', 'Status'];
  return {
    columns,
    rows: alerts.map((a) => ({
      'Time (UTC)': when(a.createdAt),
      Severity: a.severityName,
      Host: a.hostname ?? '',
      Alert: a.name,
      'Tactic / technique': [a.tactic, a.technique].filter(Boolean).join(' / '),
      User: a.user ?? '',
      File: a.file ?? '',
      'Command line': a.cmdline ?? '',
      Status: a.status,
    })),
    total,
    truncated: total > alerts.length,
  };
}
