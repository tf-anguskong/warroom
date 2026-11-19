import { Router, type Request, type Response } from 'express';
import { db, newId, now, q } from '../db.js';
import { requireAuth } from '../auth.js';
import { bus, getUser, isAdmin, logAdminAction, type UserRow } from '../users.js';
import { emitToIncident, joinIncidentToChannel, refreshIncident } from '../realtime.js';
import { addTimeline, createChannel, postMessage, systemNotice } from '../api.js';
import { decryptSecret, encryptSecret } from './secrets.js';
import { IntegrationError, normalizeBaseUrl, type TableResult } from './http.js';
import {
  describeEvent,
  lookupOktaUser,
  OKTA_QUICK_FILTERS,
  pollOktaEvents,
  searchOktaLogs,
  testOkta,
  type OktaCreds,
} from './okta.js';
import {
  DEFAULT_SUMO_TEMPLATES,
  fillTemplate,
  rangeToMs,
  runSumoSearch,
  SUMO_DEPLOYMENTS,
  templateVariables,
  testSumo,
  type QueryTemplate,
  type SumoCreds,
} from './sumo.js';
import {
  alertsTable,
  FALCON_CLOUDS,
  findHosts,
  getHosts,
  hostsTable,
  listAlerts,
  SEVERITIES,
  testFalcon,
  type FalconAlert,
  type FalconCreds,
  type FalconHost,
} from './crowdstrike.js';

db.exec(`
CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  secret_enc TEXT,
  settings TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_test_at TEXT,
  last_test_ok INTEGER,
  last_test_msg TEXT
);

CREATE TABLE IF NOT EXISTS investigation_runs (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  integration_id TEXT REFERENCES integrations(id) ON DELETE SET NULL,
  integration_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  request TEXT NOT NULL,
  status TEXT NOT NULL,
  progress TEXT,
  error TEXT,
  result TEXT,
  row_count INTEGER,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_incident ON investigation_runs(incident_id, created_at);

-- Endpoints a war room is tracking in an EDR (CrowdStrike). One row per incident + device.
CREATE TABLE IF NOT EXISTS tracked_endpoints (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  integration_id TEXT REFERENCES integrations(id) ON DELETE SET NULL,
  device_id TEXT NOT NULL,
  hostname TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  owner_id TEXT REFERENCES users(id),
  channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
  snapshot TEXT,
  alert_since TEXT NOT NULL,
  alert_count INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  last_polled_at TEXT,
  last_error TEXT,
  added_by TEXT REFERENCES users(id),
  added_at TEXT NOT NULL,
  removed_by TEXT REFERENCES users(id),
  removed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_endpoints_incident ON tracked_endpoints(incident_id, active);

CREATE TABLE IF NOT EXISTS endpoint_alerts (
  endpoint_id TEXT NOT NULL REFERENCES tracked_endpoints(id) ON DELETE CASCADE,
  alert_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  severity INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (endpoint_id, alert_id)
);

CREATE TABLE IF NOT EXISTS investigation_watches (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  login TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  since TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  event_count INTEGER NOT NULL DEFAULT 0,
  last_polled_at TEXT,
  last_error TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
`);

// Interrupted by a restart: don't leave runs spinning forever.
q.run("UPDATE investigation_runs SET status = 'error', error = 'Interrupted by a server restart', finished_at = ? WHERE status = 'running'", now());

type IntegrationType = 'okta' | 'sumo' | 'crowdstrike';
type Access = 'all' | 'roles' | 'admins';

interface Settings {
  access: Access;
  templates?: QueryTemplate[];
}

interface IntegrationRow {
  id: string;
  type: IntegrationType;
  name: string;
  base_url: string;
  secret_enc: string | null;
  settings: string;
  enabled: number;
  created_at: string;
  updated_at: string;
  last_test_at: string | null;
  last_test_ok: number | null;
  last_test_msg: string | null;
}

const TYPES: IntegrationType[] = ['okta', 'sumo', 'crowdstrike'];
const SECRET_FIELDS: Record<IntegrationType, string[]> = { okta: ['token'], sumo: ['accessId', 'accessKey'], crowdstrike: ['clientId', 'clientSecret'] };
const TYPE_LABEL: Record<IntegrationType, string> = { okta: 'Okta', sumo: 'Sumo Logic', crowdstrike: 'CrowdStrike' };

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const h =
  (fn: (req: Request, res: Response) => unknown) =>
  async (req: Request, res: Response) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      if (err instanceof HttpError || err instanceof IntegrationError) return res.status(err.status).json({ error: err.message });
      console.error('[integrations]', err);
      res.status(500).json({ error: 'internal error' });
    }
  };

const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const settingsOf = (r: IntegrationRow): Settings => ({ access: 'roles', ...JSON.parse(r.settings || '{}') });
const getIntegration = (id: string) => q.get<IntegrationRow>('SELECT * FROM integrations WHERE id = ?', id);

function mustIntegration(id: string) {
  const r = getIntegration(id);
  if (!r) throw new HttpError(404, 'integration not found');
  return r;
}

function creds(r: IntegrationRow): OktaCreds | SumoCreds | FalconCreds {
  const s = decryptSecret(r.secret_enc);
  if (r.type === 'crowdstrike') {
    if (!s.clientId || !s.clientSecret) throw new IntegrationError('CrowdStrike client ID/secret are not set', 400);
    return { baseUrl: r.base_url, clientId: s.clientId, clientSecret: s.clientSecret };
  }
  if (r.type === 'okta') {
    if (!s.token) throw new IntegrationError('Okta API token is not set', 400);
    return { baseUrl: r.base_url, token: s.token };
  }
  if (!s.accessId || !s.accessKey) throw new IntegrationError('Sumo Logic access ID/key are not set', 400);
  return { baseUrl: r.base_url, accessId: s.accessId, accessKey: s.accessKey };
}

function canRun(user: UserRow, r: IntegrationRow, incidentId: string) {
  if (!r.enabled) return false;
  if (isAdmin(user)) return true;
  const { access } = settingsOf(r);
  if (access === 'all') return true;
  if (access === 'roles') return Boolean(q.get('SELECT 1 FROM incident_roles WHERE incident_id = ? AND user_id = ?', incidentId, user.id));
  return false;
}

const ACCESS_LABEL: Record<Access, string> = {
  all: 'Everyone in the war room',
  roles: 'Incident role holders and admins',
  admins: 'Admins only',
};

function adminView(r: IntegrationRow) {
  const s = settingsOf(r);
  const secret = (() => {
    try {
      return decryptSecret(r.secret_enc);
    } catch {
      return {};
    }
  })();
  return {
    id: r.id,
    type: r.type,
    name: r.name,
    baseUrl: r.base_url,
    enabled: Boolean(r.enabled),
    settings: s,
    // Never send secrets back; only say which ones are set (and a short hint for IDs).
    credentials: Object.fromEntries(
      SECRET_FIELDS[r.type].map((f) => [f, secret[f] ? (f === 'accessId' || f === 'clientId' ? `${secret[f].slice(0, 4)}…` : 'saved') : null]),
    ),
    lastTest: r.last_test_at ? { at: r.last_test_at, ok: Boolean(r.last_test_ok), message: r.last_test_msg } : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function sanitizeTemplates(input: unknown): QueryTemplate[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 50).flatMap((t: any) => {
    const name = str(t?.name, 80);
    const query = str(t?.query, 8000);
    if (!name || !query) return [];
    return [
      {
        id: str(t?.id, 40) || newId().slice(0, 8),
        name,
        description: str(t?.description, 300),
        query,
        range: ['15m', '1h', '4h', '24h', '7d', '30d'].includes(t?.range) ? t.range : '24h',
        autoRun: Boolean(t?.autoRun) && templateVariables(query).length === 0,
      },
    ];
  });
}

function sanitizeSettings(type: IntegrationType, input: any, prev?: Settings): Settings {
  const access: Access = ['all', 'roles', 'admins'].includes(input?.access) ? input.access : prev?.access ?? 'roles';
  const out: Settings = { access };
  if (type === 'sumo') {
    out.templates =
      input?.templates !== undefined
        ? sanitizeTemplates(input.templates)
        : prev?.templates ?? DEFAULT_SUMO_TEMPLATES.map((t) => ({ ...t, id: newId().slice(0, 8) }));
  }
  return out;
}

// ---------- investigation runs ----------

interface RunRow {
  id: string;
  incident_id: string;
  integration_id: string | null;
  integration_name: string;
  kind: string;
  title: string;
  request: string;
  status: 'running' | 'done' | 'error';
  progress: string | null;
  error: string | null;
  result: string | null;
  row_count: number | null;
  created_by: string | null;
  created_at: string;
  finished_at: string | null;
}

function runSummary(r: RunRow) {
  return {
    id: r.id,
    incidentId: r.incident_id,
    integrationId: r.integration_id,
    integrationName: r.integration_name,
    kind: r.kind,
    title: r.title,
    request: JSON.parse(r.request),
    status: r.status,
    progress: r.progress,
    error: r.error,
    rowCount: r.row_count,
    createdBy: r.created_by,
    createdByName: r.created_by ? getUser(r.created_by)?.display_name ?? null : 'Automation',
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}

const getRun = (id: string) => q.get<RunRow>('SELECT * FROM investigation_runs WHERE id = ?', id);
const emitRun = (id: string) => {
  const r = getRun(id);
  if (r) emitToIncident(r.incident_id, 'investigation:update', runSummary(r));
};

interface RunRequest {
  kind: 'okta_user' | 'okta_logs' | 'sumo_search' | 'cs_hosts' | 'cs_alerts';
  params: Record<string, any>;
}

function sinceFor(range: string) {
  return new Date(Date.now() - rangeToMs(range)).toISOString();
}

/** Validate a request and produce a human title, before anything runs. */
function planRun(r: IntegrationRow, req: RunRequest): { title: string; request: Record<string, unknown> } {
  const p = req.params ?? {};
  if (r.type === 'okta' && req.kind === 'okta_user') {
    const login = str(p.login, 200);
    if (!login) throw new HttpError(400, 'enter a username or email');
    return { title: `Okta profile: ${login}`, request: { login } };
  }
  if (r.type === 'okta' && req.kind === 'okta_logs') {
    const login = str(p.login, 200);
    const range = str(p.range) || '24h';
    const quick = OKTA_QUICK_FILTERS.find((f) => f.key === p.quickFilter) ?? OKTA_QUICK_FILTERS[0];
    const filter = str(p.filter, 1000);
    if (!login && !filter && quick.key === 'all') throw new HttpError(400, 'enter a person, pick a filter, or write a filter expression');
    const title = `Okta logs${login ? ` for ${login}` : ''} · ${quick.label} · ${range}`;
    return { title, request: { login, mode: p.mode === 'keyword' ? 'keyword' : 'actor', quickFilter: quick.key, filter, range } };
  }
  if (r.type === 'sumo' && req.kind === 'sumo_search') {
    const range = str(p.range) || '24h';
    const tpl = settingsOf(r).templates?.find((t) => t.id === p.templateId);
    const vars: Record<string, string> = typeof p.vars === 'object' && p.vars ? p.vars : {};
    const raw = str(p.query, 8000) || tpl?.query || '';
    if (!raw) throw new HttpError(400, 'enter a query');
    const query = fillTemplate(raw, vars);
    const label = tpl ? tpl.name : 'Custom query';
    const varText = Object.values(vars).filter(Boolean).join(', ');
    return { title: `Sumo: ${label}${varText ? ` (${varText})` : ''} · ${range}`, request: { templateId: tpl?.id ?? null, query, vars, range } };
  }
  if (r.type === 'crowdstrike' && req.kind === 'cs_hosts') {
    const query = str(p.query, 253);
    if (!query) throw new HttpError(400, 'enter a hostname, IP address or device ID');
    return { title: `CrowdStrike hosts: ${query}`, request: { query } };
  }
  if (r.type === 'crowdstrike' && req.kind === 'cs_alerts') {
    const query = str(p.query, 253);
    const range = ['15m', '1h', '4h', '24h', '7d', '30d'].includes(p.range) ? p.range : '24h';
    const minSeverity = SEVERITIES.includes(p.minSeverity) ? p.minSeverity : 'Informational';
    const sev = minSeverity === 'Informational' ? '' : ` · ${minSeverity}+`;
    return { title: `CrowdStrike alerts${query ? ` on ${query}` : ''}${sev} · ${range}`, request: { query, range, minSeverity } };
  }
  throw new HttpError(400, `unsupported action for ${r.type}`);
}

async function executeRun(runId: string) {
  const run = getRun(runId)!;
  const integ = run.integration_id ? getIntegration(run.integration_id) : undefined;
  const req = JSON.parse(run.request);
  const finish = (fields: { status: 'done' | 'error'; result?: unknown; rowCount?: number; error?: string }) => {
    q.run(
      'UPDATE investigation_runs SET status = ?, result = ?, row_count = ?, error = ?, progress = NULL, finished_at = ? WHERE id = ?',
      fields.status,
      fields.result === undefined ? null : JSON.stringify(fields.result),
      fields.rowCount ?? null,
      fields.error ?? null,
      now(),
      runId,
    );
    emitRun(runId);
  };
  try {
    if (!integ || !integ.enabled) throw new IntegrationError('Integration is disabled or was removed', 400);
    const c = creds(integ);
    if (run.kind === 'okta_user') {
      const user = await lookupOktaUser(c as OktaCreds, req.login);
      finish({ status: 'done', result: { type: 'profile', profile: user }, rowCount: 1 });
    } else if (run.kind === 'okta_logs') {
      const table = await searchOktaLogs(c as OktaCreds, { ...req, since: sinceFor(req.range) });
      finish({ status: 'done', result: { type: 'table', ...table }, rowCount: table.total });
    } else if (run.kind === 'cs_hosts') {
      const hosts = await findHosts(c as FalconCreds, req.query);
      finish({ status: 'done', result: { type: 'table', ...hostsTable(hosts) }, rowCount: hosts.length });
    } else if (run.kind === 'cs_alerts') {
      let deviceIds: string[] | undefined;
      if (req.query) {
        deviceIds = (await findHosts(c as FalconCreds, req.query)).map((h) => h.deviceId);
        if (!deviceIds.length) throw new IntegrationError(`No host in CrowdStrike matches “${req.query}”`, 404);
      }
      const { alerts, total } = await listAlerts(c as FalconCreds, { deviceIds, since: sinceFor(req.range), minSeverity: req.minSeverity });
      finish({ status: 'done', result: { type: 'table', ...alertsTable(alerts, total) }, rowCount: total });
    } else if (run.kind === 'sumo_search') {
      const to = Date.now();
      const table = await runSumoSearch(c as SumoCreds, req.query, to - rangeToMs(req.range), to, (msg) => {
        q.run('UPDATE investigation_runs SET progress = ? WHERE id = ?', msg, runId);
        emitRun(runId);
      });
      finish({ status: 'done', result: { type: 'table', ...table }, rowCount: table.total });
    }
  } catch (err) {
    finish({ status: 'error', error: err instanceof Error ? err.message : String(err) });
  }
}

function startRun(incidentId: string, integ: IntegrationRow, userId: string | null, req: RunRequest) {
  const plan = planRun(integ, req);
  const id = newId();
  q.run(
    `INSERT INTO investigation_runs (id, incident_id, integration_id, integration_name, kind, title, request, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
    id,
    incidentId,
    integ.id,
    integ.name,
    req.kind,
    plan.title,
    JSON.stringify(plan.request),
    userId,
    now(),
  );
  addTimeline(incidentId, userId, 'investigation', plan.title, { runId: id });
  emitRun(id);
  void executeRun(id);
  return id;
}

// ---------- live watches (Okta) ----------

const WATCH_INTERVAL_MS = 30_000;
const MAX_ACTIVE_WATCHES = 25;
const MAX_POSTS_PER_POLL = 15;

function watchChannel(incidentId: string, userId: string) {
  const existing = q.get<{ id: string }>("SELECT id FROM channels WHERE incident_id = ? AND name = 'okta-watch' AND archived = 0", incidentId);
  if (existing) return existing.id;
  const id = createChannel(incidentId, userId, 'okta-watch', 'Live Okta activity for watched people', []);
  joinIncidentToChannel(incidentId, id);
  refreshIncident(incidentId);
  return id;
}

interface WatchRow {
  id: string;
  incident_id: string;
  integration_id: string;
  login: string;
  channel_id: string;
  since: string;
  active: number;
  event_count: number;
  last_polled_at: string | null;
  last_error: string | null;
  created_by: string | null;
  created_at: string;
}

const watchView = (w: WatchRow) => ({
  id: w.id,
  incidentId: w.incident_id,
  integrationId: w.integration_id,
  login: w.login,
  channelId: w.channel_id,
  active: Boolean(w.active),
  eventCount: w.event_count,
  lastPolledAt: w.last_polled_at,
  lastError: w.last_error,
  createdByName: w.created_by ? getUser(w.created_by)?.display_name ?? null : null,
  createdAt: w.created_at,
});

const emitWatches = (incidentId: string) =>
  emitToIncident(incidentId, 'watches:update', {
    incidentId,
    watches: q.all<WatchRow>('SELECT * FROM investigation_watches WHERE incident_id = ? ORDER BY created_at DESC', incidentId).map(watchView),
  });

let polling = false;
async function pollWatches() {
  if (polling) return;
  polling = true;
  try {
    const watches = q.all<WatchRow>('SELECT * FROM investigation_watches WHERE active = 1');
    for (const w of watches) {
      const integ = getIntegration(w.integration_id);
      const inc = q.get<{ status: string }>('SELECT status FROM incidents WHERE id = ?', w.incident_id);
      if (!integ?.enabled || !inc || inc.status === 'resolved') {
        q.run('UPDATE investigation_watches SET active = 0, last_error = ? WHERE id = ?', inc?.status === 'resolved' ? 'Stopped: incident resolved' : 'Stopped: integration disabled', w.id);
        emitWatches(w.incident_id);
        continue;
      }
      try {
        const events = await pollOktaEvents(creds(integ) as OktaCreds, w.login, w.since);
        const shown = events.slice(-MAX_POSTS_PER_POLL);
        if (events.length > shown.length) {
          postMessage(w.channel_id, null, `**Okta** · ${events.length - shown.length} earlier events for \`${w.login}\` not shown — search Okta logs in Investigate for the full list`, 'system');
        }
        for (const e of shown) postMessage(w.channel_id, null, describeEvent(e), 'system');
        const since = events.length ? events[events.length - 1].published : w.since;
        q.run(
          'UPDATE investigation_watches SET since = ?, event_count = event_count + ?, last_polled_at = ?, last_error = NULL WHERE id = ?',
          since,
          events.length,
          now(),
          w.id,
        );
      } catch (err) {
        q.run('UPDATE investigation_watches SET last_polled_at = ?, last_error = ? WHERE id = ?', now(), err instanceof Error ? err.message : String(err), w.id);
      }
      emitWatches(w.incident_id);
    }
  } finally {
    polling = false;
  }
}
setInterval(() => void pollWatches(), WATCH_INTERVAL_MS).unref();

// ---------- indicators: pre-fill query variables from the incident's sheets ----------

const RE = {
  ip: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
  hash: /\b(?:[a-f0-9]{64}|[a-f0-9]{40}|[a-f0-9]{32})\b/gi,
  email: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g,
  domain: /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,24})\b/gi,
};

function indicatorsFor(incidentId: string) {
  const sets = { ip: new Set<string>(), hash: new Set<string>(), user: new Set<string>(), domain: new Set<string>(), host: new Set<string>() };
  const sheets = q.all<{ id: string; columns: string }>('SELECT id, columns FROM sheets WHERE incident_id = ?', incidentId);
  for (const s of sheets) {
    const cols = new Map((JSON.parse(s.columns) as { id: string; name: string; type: string }[]).map((c) => [c.id, c]));
    for (const cell of q.all<{ col_id: string; value: string }>('SELECT col_id, value FROM sheet_cells WHERE sheet_id = ?', s.id)) {
      const col = cols.get(cell.col_id);
      const v = cell.value;
      if (!col || v.startsWith('=')) continue;
      if (col.type === 'person') {
        const u = getUser(v);
        if (u?.email) sets.user.add(u.email);
        continue;
      }
      if (col.type !== 'text') continue;
      if (/host|asset|machine|device|server/i.test(col.name) && /^[\w.-]{2,253}$/.test(v.trim()) && !RE.ip.test(v)) sets.host.add(v.trim());
      RE.ip.lastIndex = 0;
      for (const m of v.match(RE.ip) ?? []) sets.ip.add(m);
      for (const m of v.match(RE.hash) ?? []) sets.hash.add(m.toLowerCase());
      const emails = v.match(RE.email) ?? [];
      for (const m of emails) sets.user.add(m.toLowerCase());
      const withoutEmails = emails.reduce((acc, e) => acc.replace(e, ' '), v);
      for (const m of withoutEmails.match(RE.domain) ?? []) {
        if (!/^\d+(\.\d+)+$/.test(m) && !sets.host.has(m)) sets.domain.add(m.toLowerCase());
      }
    }
  }
  const out: Record<string, string[]> = {};
  for (const [k, set] of Object.entries(sets)) out[k] = [...set].slice(0, 50);
  return out;
}

// ---------- auto-run starter queries when an incident is declared ----------

bus.on('incident:declared', ({ incidentId }: { incidentId: string; userId: string }) => {
  const sumos = q.all<IntegrationRow>("SELECT * FROM integrations WHERE type = 'sumo' AND enabled = 1");
  let started = 0;
  for (const integ of sumos) {
    for (const t of settingsOf(integ).templates ?? []) {
      if (!t.autoRun) continue;
      try {
        startRun(incidentId, integ, null, { kind: 'sumo_search', params: { templateId: t.id, range: t.range } });
        started++;
      } catch (err) {
        console.warn('[integrations] auto-run failed', err);
      }
    }
  }
  if (started) systemNotice(incidentId, `Started ${started} starter ${started === 1 ? 'query' : 'queries'} in Sumo Logic. Results are in **Investigate**.`);
});

// ---------- routes ----------

export const integrationsRouter = Router();
integrationsRouter.use(requireAuth);

const requireAdmin = (req: Request) => {
  if (!isAdmin(req.user!)) throw new HttpError(403, 'admins only');
};

integrationsRouter.get(
  '/admin/integrations',
  h((req) => {
    requireAdmin(req);
    return {
      integrations: q.all<IntegrationRow>('SELECT * FROM integrations ORDER BY created_at').map(adminView),
      catalog: {
        types: [
          { type: 'okta', label: 'Okta', description: 'Look up people and search or live-watch the Okta System Log.' },
          { type: 'sumo', label: 'Sumo Logic', description: 'Run log searches and starter queries from the war room.' },
          { type: 'crowdstrike', label: 'CrowdStrike', description: 'Find hosts, read their alerts, and track specific endpoints during an incident.' },
        ],
        falconClouds: FALCON_CLOUDS,
        sumoDeployments: SUMO_DEPLOYMENTS,
        defaultSumoTemplates: DEFAULT_SUMO_TEMPLATES,
        access: ACCESS_LABEL,
      },
    };
  }),
);

function credentialUpdate(type: IntegrationType, input: any, prev: Record<string, string>) {
  const next = { ...prev };
  for (const f of SECRET_FIELDS[type]) {
    const v = str(input?.[f], 4000);
    if (v) next[f] = v; // blank keeps the saved value
  }
  return next;
}

integrationsRouter.post(
  '/admin/integrations',
  h((req) => {
    requireAdmin(req);
    const type = req.body?.type as IntegrationType;
    if (!TYPES.includes(type)) throw new HttpError(400, 'unknown integration type');
    const name = str(req.body?.name, 80) || TYPE_LABEL[type];
    const baseUrl = normalizeBaseUrl(str(req.body?.baseUrl, 300));
    const secret = credentialUpdate(type, req.body?.credentials, {});
    const settings = sanitizeSettings(type, req.body?.settings);
    const id = newId();
    const ts = now();
    q.run(
      `INSERT INTO integrations (id, type, name, base_url, secret_enc, settings, enabled, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      id,
      type,
      name,
      baseUrl,
      encryptSecret(secret),
      JSON.stringify(settings),
      req.user!.id,
      ts,
      ts,
    );
    logAdminAction(req.user!.id, null, 'integration_added', `${name} (${type})`);
    return { integration: adminView(getIntegration(id)!) };
  }),
);

integrationsRouter.patch(
  '/admin/integrations/:id',
  h((req) => {
    requireAdmin(req);
    const r = mustIntegration(req.params.id);
    const name = str(req.body?.name, 80) || r.name;
    const baseUrl = req.body?.baseUrl !== undefined ? normalizeBaseUrl(str(req.body.baseUrl, 300)) : r.base_url;
    const secret = credentialUpdate(r.type, req.body?.credentials, decryptSecret(r.secret_enc));
    const settings = req.body?.settings !== undefined ? sanitizeSettings(r.type, req.body.settings, settingsOf(r)) : settingsOf(r);
    const enabled = req.body?.enabled === undefined ? r.enabled : req.body.enabled ? 1 : 0;
    q.run(
      'UPDATE integrations SET name = ?, base_url = ?, secret_enc = ?, settings = ?, enabled = ?, updated_at = ? WHERE id = ?',
      name,
      baseUrl,
      encryptSecret(secret),
      JSON.stringify(settings),
      enabled,
      now(),
      r.id,
    );
    const changed = [
      name !== r.name && 'name',
      baseUrl !== r.base_url && 'URL',
      SECRET_FIELDS[r.type].some((f) => str(req.body?.credentials?.[f])) && 'credentials',
      req.body?.settings !== undefined && 'settings',
      enabled !== r.enabled && (enabled ? 'enabled' : 'disabled'),
    ].filter(Boolean);
    if (changed.length) logAdminAction(req.user!.id, null, 'integration_updated', `${name}: ${changed.join(', ')}`);
    return { integration: adminView(getIntegration(r.id)!) };
  }),
);

integrationsRouter.delete(
  '/admin/integrations/:id',
  h((req) => {
    requireAdmin(req);
    const r = mustIntegration(req.params.id);
    const incidents = q.all<{ incident_id: string }>('SELECT DISTINCT incident_id FROM investigation_watches WHERE integration_id = ?', r.id);
    const tracking = q.all<{ incident_id: string }>('SELECT DISTINCT incident_id FROM tracked_endpoints WHERE integration_id = ? AND active = 1', r.id);
    q.run("UPDATE tracked_endpoints SET active = 0, last_error = 'Stopped: integration removed' WHERE integration_id = ? AND active = 1", r.id);
    q.run('DELETE FROM integrations WHERE id = ?', r.id);
    incidents.forEach((i) => emitWatches(i.incident_id));
    tracking.forEach((i) => emitEndpoints(i.incident_id));
    logAdminAction(req.user!.id, null, 'integration_removed', `${r.name} (${r.type})`);
    return { ok: true };
  }),
);

integrationsRouter.post(
  '/admin/integrations/:id/test',
  h(async (req) => {
    requireAdmin(req);
    const r = mustIntegration(req.params.id);
    let ok = false;
    let message: string;
    try {
      message =
        r.type === 'okta'
          ? await testOkta(creds(r) as OktaCreds)
          : r.type === 'crowdstrike'
            ? await testFalcon(creds(r) as FalconCreds)
            : await testSumo(creds(r) as SumoCreds);
      ok = true;
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    q.run('UPDATE integrations SET last_test_at = ?, last_test_ok = ?, last_test_msg = ? WHERE id = ?', now(), ok ? 1 : 0, message, r.id);
    return { ok, message };
  }),
);

/** What the war room can use. No URLs or credentials. */
integrationsRouter.get(
  '/incidents/:id/integrations',
  h((req) => {
    const incidentId = req.params.id;
    const rows = q.all<IntegrationRow>('SELECT * FROM integrations WHERE enabled = 1 ORDER BY created_at');
    return {
      integrations: rows.map((r) => {
        const s = settingsOf(r);
        return {
          id: r.id,
          type: r.type,
          name: r.name,
          canRun: canRun(req.user!, r, incidentId),
          accessLabel: ACCESS_LABEL[s.access],
          templates: r.type === 'sumo' ? (s.templates ?? []).map((t) => ({ ...t, variables: templateVariables(t.query) })) : undefined,
        };
      }),
      oktaQuickFilters: OKTA_QUICK_FILTERS.map(({ key, label }) => ({ key, label })),
      severities: SEVERITIES,
    };
  }),
);

integrationsRouter.get('/incidents/:id/indicators', h((req) => ({ indicators: indicatorsFor(req.params.id) })));

integrationsRouter.get(
  '/incidents/:id/investigations',
  h((req) => ({
    runs: q
      .all<RunRow>('SELECT * FROM investigation_runs WHERE incident_id = ? ORDER BY created_at DESC LIMIT 100', req.params.id)
      .map(runSummary),
    watches: q.all<WatchRow>('SELECT * FROM investigation_watches WHERE incident_id = ? ORDER BY created_at DESC', req.params.id).map(watchView),
  })),
);

integrationsRouter.post(
  '/incidents/:id/investigations',
  h((req) => {
    const inc = q.get<{ id: string }>('SELECT id FROM incidents WHERE id = ?', req.params.id);
    if (!inc) throw new HttpError(404, 'incident not found');
    const integ = mustIntegration(str(req.body?.integrationId));
    if (!canRun(req.user!, integ, inc.id)) throw new HttpError(403, `you don't have access to run ${integ.name} searches here (${ACCESS_LABEL[settingsOf(integ).access]})`);
    const running = q.get<{ n: number }>("SELECT COUNT(*) AS n FROM investigation_runs WHERE created_by = ? AND status = 'running'", req.user!.id)!.n;
    if (running >= 5) throw new HttpError(429, 'you already have 5 searches running; wait for one to finish');
    const id = startRun(inc.id, integ, req.user!.id, { kind: req.body?.kind, params: req.body?.params ?? {} });
    return { run: runSummary(getRun(id)!) };
  }),
);

integrationsRouter.get(
  '/investigations/:id',
  h((req) => {
    const r = getRun(req.params.id);
    if (!r) throw new HttpError(404, 'not found');
    return { run: runSummary(r), result: r.result ? JSON.parse(r.result) : null };
  }),
);

/** Copy a table result into a new sheet in the incident. */
integrationsRouter.post(
  '/investigations/:id/to-sheet',
  h((req) => {
    const r = getRun(req.params.id);
    if (!r || !r.result) throw new HttpError(404, 'no results to copy');
    const result = JSON.parse(r.result) as { type: string } & TableResult;
    if (result.type !== 'table' || !result.rows.length) throw new HttpError(400, 'this result has no rows');
    const columns = result.columns.map((name) => ({ id: newId().slice(0, 8), name, type: 'text', width: name === '_raw' || name === 'Message' ? 360 : 170 }));
    const sheetId = newId();
    const ts = now();
    const name = str(req.body?.name, 80) || r.title.slice(0, 80);
    const pos = (q.get<{ p: number | null }>('SELECT MAX(position) AS p FROM sheets WHERE incident_id = ?', r.incident_id)?.p ?? -1) + 1;
    db.exec('BEGIN');
    try {
      q.run(
        'INSERT INTO sheets (id, incident_id, name, columns, position, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        sheetId,
        r.incident_id,
        name,
        JSON.stringify(columns),
        pos,
        req.user!.id,
        ts,
      );
      result.rows.forEach((row, i) => {
        const rowId = newId();
        q.run('INSERT INTO sheet_rows (id, sheet_id, position, created_by, created_at) VALUES (?, ?, ?, ?, ?)', rowId, sheetId, i + 1, req.user!.id, ts);
        columns.forEach((c, ci) => {
          const v = row[result.columns[ci]];
          if (v) q.run('INSERT INTO sheet_cells (sheet_id, row_id, col_id, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)', sheetId, rowId, c.id, String(v).slice(0, 10000), req.user!.id, ts);
        });
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    addTimeline(r.incident_id, req.user!.id, 'sheet', `Sheet “${name}” created from ${r.integration_name} results (${result.rows.length} rows)`);
    refreshIncident(r.incident_id);
    return { sheetId };
  }),
);

integrationsRouter.post(
  '/investigations/:id/share',
  h((req) => {
    const r = getRun(req.params.id);
    if (!r) throw new HttpError(404, 'not found');
    const channelId = str(req.body?.channelId);
    if (!q.get('SELECT 1 FROM channels WHERE id = ?', channelId)) throw new HttpError(400, 'pick a channel');
    const result = r.result ? JSON.parse(r.result) : null;
    let body = `🔎 **${r.title}** — ${r.status === 'error' ? `failed: ${r.error}` : `${r.row_count ?? 0} results`}`;
    if (result?.type === 'table' && result.rows.length) {
      const cols: string[] = result.columns.filter((c: string) => c !== '_raw' && c !== 'Message').slice(0, 5);
      const lines = result.rows.slice(0, 10).map((row: Record<string, string>) => cols.map((c) => row[c] ?? '').join(' | '));
      body += `\n\`\`\`\n${cols.join(' | ')}\n${lines.join('\n')}${result.rows.length > 10 ? `\n… ${result.rows.length - 10} more` : ''}\n\`\`\``;
    } else if (result?.type === 'profile') {
      const p = result.profile;
      body += `\n${p.name} (${p.login}) · status **${p.status}** · last login ${p.lastLogin ?? 'never'} · MFA: ${p.factors.map((f: { type: string }) => f.type).join(', ') || 'none'}`;
    }
    if (str(req.body?.note, 1000)) body = `${str(req.body.note, 1000)}\n${body}`;
    postMessage(channelId, req.user!.id, body);
    return { ok: true };
  }),
);

integrationsRouter.post(
  '/incidents/:id/watches',
  h((req) => {
    const inc = q.get<{ id: string; number: number; status: string }>('SELECT id, number, status FROM incidents WHERE id = ?', req.params.id);
    if (!inc) throw new HttpError(404, 'incident not found');
    if (inc.status === 'resolved') throw new HttpError(400, 'incident is resolved');
    const integ = mustIntegration(str(req.body?.integrationId));
    if (integ.type !== 'okta') throw new HttpError(400, 'live watch is available for Okta');
    if (!canRun(req.user!, integ, inc.id)) throw new HttpError(403, `you don't have access to ${integ.name} here`);
    const login = str(req.body?.login, 200);
    if (!login) throw new HttpError(400, 'enter a username or email');
    if (q.get('SELECT 1 FROM investigation_watches WHERE incident_id = ? AND integration_id = ? AND login = ? AND active = 1', inc.id, integ.id, login)) {
      throw new HttpError(409, `already watching ${login}`);
    }
    if (q.get<{ n: number }>('SELECT COUNT(*) AS n FROM investigation_watches WHERE active = 1')!.n >= MAX_ACTIVE_WATCHES) {
      throw new HttpError(429, `at most ${MAX_ACTIVE_WATCHES} live watches can run at once`);
    }
    const channelId = watchChannel(inc.id, req.user!.id);
    const id = newId();
    // Start 15 minutes back so the channel opens with recent context.
    const since = new Date(Date.now() - 15 * 60e3).toISOString();
    q.run(
      'INSERT INTO investigation_watches (id, incident_id, integration_id, login, channel_id, since, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      inc.id,
      integ.id,
      login,
      channelId,
      since,
      req.user!.id,
      now(),
    );
    postMessage(channelId, null, `${req.user!.display_name} started watching **${login}** in ${integ.name}. New events appear here about every 30 seconds.`, 'system');
    addTimeline(inc.id, req.user!.id, 'investigation', `Live Okta watch started for ${login}`);
    emitWatches(inc.id);
    void pollWatches();
    return { id, channelId };
  }),
);

integrationsRouter.delete(
  '/watches/:id',
  h((req) => {
    const w = q.get<WatchRow>('SELECT * FROM investigation_watches WHERE id = ?', req.params.id);
    if (!w) throw new HttpError(404, 'not found');
    const integ = getIntegration(w.integration_id);
    if (integ && !canRun(req.user!, integ, w.incident_id)) throw new HttpError(403, 'not allowed');
    q.run('UPDATE investigation_watches SET active = 0 WHERE id = ?', w.id);
    postMessage(w.channel_id, null, `${req.user!.display_name} stopped watching **${w.login}** (${w.event_count} events seen).`, 'system');
    addTimeline(w.incident_id, req.user!.id, 'investigation', `Live Okta watch stopped for ${w.login}`);
    emitWatches(w.incident_id);
    return { ok: true };
  }),
);


// ---------- tracked endpoints (CrowdStrike) ----------
//
// A war room can track specific endpoints. Every minute War Room reads each one's state from
// Falcon and its new alerts, posts changes and alerts to #crowdstrike-watch, and keeps the alerts
// with the endpoint so the room has the history after the incident. Each endpoint can have an
// owner (who's handling it) and a note (why it's tracked).

const ENDPOINT_INTERVAL_MS = 60_000;
const MAX_TRACKED_PER_INCIDENT = 50;
const MAX_ALERT_POSTS_PER_POLL = 15;
const BACKFILL_HOURS = 24;

interface EndpointRow {
  id: string;
  incident_id: string;
  integration_id: string | null;
  device_id: string;
  hostname: string;
  note: string;
  owner_id: string | null;
  channel_id: string | null;
  snapshot: string | null;
  alert_since: string;
  alert_count: number;
  active: number;
  last_polled_at: string | null;
  last_error: string | null;
  added_by: string | null;
  added_at: string;
  removed_by: string | null;
  removed_at: string | null;
}

const getEndpoint = (id: string) => q.get<EndpointRow>('SELECT * FROM tracked_endpoints WHERE id = ?', id);
const userName = (id: string | null) => (id ? getUser(id)?.display_name ?? null : null);

function endpointView(e: EndpointRow) {
  const recent = q
    .all<{ data: string }>('SELECT data FROM endpoint_alerts WHERE endpoint_id = ? ORDER BY created_at DESC LIMIT 5', e.id)
    .map((r) => JSON.parse(r.data) as FalconAlert);
  const severe = q.get<{ n: number }>('SELECT COUNT(*) AS n FROM endpoint_alerts WHERE endpoint_id = ? AND severity >= 60', e.id)!.n;
  return {
    id: e.id,
    incidentId: e.incident_id,
    integrationId: e.integration_id,
    integrationName: e.integration_id ? getIntegration(e.integration_id)?.name ?? null : null,
    deviceId: e.device_id,
    hostname: e.hostname,
    note: e.note,
    owner: e.owner_id ? { id: e.owner_id, name: userName(e.owner_id) } : null,
    channelId: e.channel_id,
    host: e.snapshot ? (JSON.parse(e.snapshot) as FalconHost) : null,
    alertCount: e.alert_count,
    severeCount: severe,
    recentAlerts: recent,
    active: Boolean(e.active),
    lastPolledAt: e.last_polled_at,
    lastError: e.last_error,
    addedByName: userName(e.added_by),
    addedAt: e.added_at,
    removedByName: userName(e.removed_by),
    removedAt: e.removed_at,
  };
}

const endpointsOf = (incidentId: string) =>
  q.all<EndpointRow>('SELECT * FROM tracked_endpoints WHERE incident_id = ? ORDER BY active DESC, added_at', incidentId).map(endpointView);

function emitEndpoints(incidentId: string) {
  emitToIncident(incidentId, 'endpoints:update', { incidentId, endpoints: endpointsOf(incidentId) });
}

function edrChannel(incidentId: string, userId: string) {
  const existing = q.get<{ id: string }>("SELECT id FROM channels WHERE incident_id = ? AND name = 'crowdstrike-watch' AND archived = 0", incidentId);
  if (existing) return existing.id;
  const id = createChannel(incidentId, userId, 'crowdstrike-watch', 'Tracked endpoints: state changes and new CrowdStrike alerts', []);
  joinIncidentToChannel(incidentId, id);
  refreshIncident(incidentId);
  return id;
}

const SEV_ICON: Record<string, string> = { Critical: '🟥', High: '🟧', Medium: '🟨', Low: '🟦', Informational: '⬜' };

function describeAlert(a: FalconAlert, e: EndpointRow) {
  const bits = [[a.tactic, a.technique].filter(Boolean).join(' / '), a.user && `user \`${a.user}\``, a.file && `file \`${a.file}\``].filter(Boolean);
  const owner = e.owner_id ? ` · owner ${userName(e.owner_id)}` : '';
  let text = `${SEV_ICON[a.severityName] ?? '⬜'} **${a.severityName}** on **${e.hostname}** · ${a.name}${bits.length ? ` · ${bits.join(' · ')}` : ''}${owner}`;
  if (a.cmdline) text += '\n```\n' + a.cmdline.slice(0, 500) + '\n```';
  return text;
}

/** What changed on a host since we last looked, in plain words. */
function hostChanges(prev: FalconHost | null, next: FalconHost): string[] {
  if (!prev) return [];
  const out: string[] = [];
  if (prev.online !== next.online && next.online !== 'unknown') out.push(next.online === 'online' ? 'came **online**' : 'went **offline**');
  if (prev.status !== next.status) {
    const label: Record<string, string> = {
      contained: 'is now **network contained**',
      containment_pending: 'containment was **requested** (pending)',
      lift_containment_pending: 'containment lift was **requested** (pending)',
      normal: 'is **no longer contained**',
    };
    out.push(label[next.status] ?? `containment status is now ${next.status}`);
  }
  if (prev.lastUser !== next.lastUser && next.lastUser) out.push(`last signed-in user changed to \`${next.lastUser}\``);
  if (prev.localIp !== next.localIp && next.localIp) out.push(`local IP changed to \`${next.localIp}\``);
  if (prev.externalIp !== next.externalIp && next.externalIp) out.push(`external IP changed to \`${next.externalIp}\``);
  if (!prev.reducedFunctionality && next.reducedFunctionality) out.push('sensor entered **reduced functionality mode**');
  return out;
}

async function pollEndpointGroup(integ: IntegrationRow, rows: EndpointRow[]) {
  const c = creds(integ) as FalconCreds;
  const touched = new Set<string>();
  const ids = [...new Set(rows.map((r) => r.device_id))];
  let hosts: Map<string, FalconHost>;
  try {
    hosts = new Map((await getHosts(c, ids)).map((h) => [h.deviceId, h]));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    for (const r of rows) {
      q.run('UPDATE tracked_endpoints SET last_polled_at = ?, last_error = ? WHERE id = ?', now(), msg, r.id);
      touched.add(r.incident_id);
    }
    touched.forEach(emitEndpoints);
    return;
  }

  for (const r of rows) {
    const h = hosts.get(r.device_id);
    touched.add(r.incident_id);
    if (!h) {
      q.run("UPDATE tracked_endpoints SET last_error = 'Not found in CrowdStrike (removed or hidden)' WHERE id = ?", r.id);
      continue;
    }
    const changes = hostChanges(r.snapshot ? JSON.parse(r.snapshot) : null, h);
    if (changes.length && r.channel_id) postMessage(r.channel_id, null, `🖥️ **${h.hostname}** ${changes.join('; ')}`, 'system');
    const containment = changes.filter((x) => /contain/.test(x));
    if (containment.length) addTimeline(r.incident_id, null, 'investigation', `${h.hostname}: ${containment.join('; ').replace(/\*\*/g, '')}`, { endpointId: r.id });
    q.run('UPDATE tracked_endpoints SET snapshot = ?, hostname = ?, last_error = NULL WHERE id = ?', JSON.stringify(h), h.hostname, r.id);
  }

  // New alerts for every tracked device in this integration, oldest first.
  const since = rows.map((r) => r.alert_since).sort()[0];
  let alerts: FalconAlert[] = [];
  let alertError: string | null = null;
  try {
    alerts = (await listAlerts(c, { deviceIds: ids, since, asc: true, limit: 200 })).alerts;
  } catch (err) {
    alertError = `Alerts: ${err instanceof Error ? err.message : String(err)}`;
  }
  for (const r of rows) {
    const firstLook = !r.last_polled_at;
    q.run('UPDATE tracked_endpoints SET last_polled_at = ?, last_error = COALESCE(?, last_error) WHERE id = ?', now(), alertError, r.id);
    if (alertError) continue;
    const mine = alerts.filter((a) => a.deviceId === r.device_id && a.createdAt > r.alert_since);
    const fresh = mine.filter(
      (a) =>
        q.run('INSERT OR IGNORE INTO endpoint_alerts (endpoint_id, alert_id, created_at, severity, data) VALUES (?, ?, ?, ?, ?)', r.id, a.id, a.createdAt, a.severity, JSON.stringify(a))
          .changes === 1,
    );
    const latest = mine.at(-1)?.createdAt ?? r.alert_since;
    q.run('UPDATE tracked_endpoints SET alert_since = ?, alert_count = alert_count + ? WHERE id = ?', latest, fresh.length, r.id);
    if (!fresh.length || !r.channel_id) continue;
    if (firstLook) {
      // First look: summarise the backfill instead of posting each alert.
      const severe = fresh.filter((a) => a.severity >= 60).length;
      postMessage(
        r.channel_id,
        null,
        `🛡️ **${r.hostname}** had ${fresh.length} alert${fresh.length === 1 ? '' : 's'} in the last ${BACKFILL_HOURS} hours${severe ? `, **${severe} high or critical**` : ''}. They're listed on the endpoint in **Investigate**.`,
        'system',
      );
      continue;
    }
    const shown = fresh.slice(-MAX_ALERT_POSTS_PER_POLL);
    if (fresh.length > shown.length) postMessage(r.channel_id, null, `🛡️ ${fresh.length - shown.length} earlier alerts on **${r.hostname}** not shown here; see the endpoint in **Investigate**.`, 'system');
    for (const a of shown) postMessage(r.channel_id, null, describeAlert(a, r), 'system');
    for (const a of fresh.filter((x) => x.severity >= 60)) {
      addTimeline(r.incident_id, null, 'investigation', `CrowdStrike ${a.severityName} alert on ${r.hostname}: ${a.name}`, { endpointId: r.id, alertId: a.id }, a.createdAt);
    }
  }
  touched.forEach(emitEndpoints);
}

async function pollEndpoints(onlyId?: string) {
  const rows = onlyId
    ? q.all<EndpointRow>('SELECT * FROM tracked_endpoints WHERE id = ? AND active = 1', onlyId)
    : q.all<EndpointRow>('SELECT * FROM tracked_endpoints WHERE active = 1');
  const groups = new Map<string, EndpointRow[]>();
  for (const r of rows) {
    const inc = q.get<{ status: string }>('SELECT status FROM incidents WHERE id = ?', r.incident_id);
    const integ = r.integration_id ? getIntegration(r.integration_id) : undefined;
    if (!inc || inc.status === 'resolved' || !integ?.enabled) {
      const why = !inc || inc.status === 'resolved' ? 'Stopped: incident resolved' : 'Stopped: integration disabled';
      q.run('UPDATE tracked_endpoints SET active = 0, last_error = ? WHERE id = ?', why, r.id);
      emitEndpoints(r.incident_id);
      continue;
    }
    groups.set(integ.id, [...(groups.get(integ.id) ?? []), r]);
  }
  for (const [integId, list] of groups) {
    try {
      await pollEndpointGroup(getIntegration(integId)!, list);
    } catch (err) {
      console.error('[integrations] endpoint poll failed', err);
    }
  }
}

/** One poll at a time: a refresh asked for during a poll runs right after it. */
let endpointPolling: Promise<void> = Promise.resolve();
function runEndpointPoll(onlyId?: string) {
  endpointPolling = endpointPolling.catch(() => undefined).then(() => pollEndpoints(onlyId));
  return endpointPolling;
}
setInterval(() => void runEndpointPoll(), ENDPOINT_INTERVAL_MS).unref();

const hostSummary = (h: FalconHost) => ({
  deviceId: h.deviceId,
  hostname: h.hostname,
  os: h.os,
  online: h.online,
  status: h.status,
  lastSeen: h.lastSeen,
  localIp: h.localIp,
  lastUser: h.lastUser,
});

function mustTrackable(incidentId: string, integrationId: string, user: UserRow) {
  const inc = q.get<{ id: string; status: string }>('SELECT id, status FROM incidents WHERE id = ?', incidentId);
  if (!inc) throw new HttpError(404, 'incident not found');
  if (inc.status === 'resolved') throw new HttpError(400, 'incident is resolved');
  const integ = mustIntegration(integrationId);
  if (integ.type !== 'crowdstrike') throw new HttpError(400, 'endpoint tracking is available for CrowdStrike');
  if (!integ.enabled) throw new HttpError(400, `${integ.name} is disabled`);
  if (!canRun(user, integ, inc.id)) throw new HttpError(403, `you don't have access to ${integ.name} here (${ACCESS_LABEL[settingsOf(integ).access]})`);
  return { inc, integ };
}

function validOwner(ownerId: unknown) {
  if (!ownerId) return null;
  const u = getUser(String(ownerId));
  if (!u || !u.active || u.is_guest) throw new HttpError(400, 'pick an active member as the owner');
  return u.id;
}

integrationsRouter.get('/incidents/:id/endpoints', h((req) => ({ endpoints: endpointsOf(req.params.id) })));

/**
 * Track an endpoint. Pass `deviceId`, or a `query` (hostname, IP or device ID). If the query
 * matches several hosts, nothing is tracked and the matches come back so the person can pick one.
 */
integrationsRouter.post(
  '/incidents/:id/endpoints',
  h(async (req) => {
    const { inc, integ } = mustTrackable(req.params.id, str(req.body?.integrationId), req.user!);
    const ownerId = validOwner(req.body?.ownerId);
    const note = str(req.body?.note, 300);
    const c = creds(integ) as FalconCreds;
    const deviceId = str(req.body?.deviceId, 64).toLowerCase();
    let host: FalconHost | undefined;
    if (deviceId) {
      if (!/^[0-9a-f]{32}$/.test(deviceId)) throw new HttpError(400, 'that is not a CrowdStrike device ID');
      host = (await getHosts(c, [deviceId]))[0];
      if (!host) throw new HttpError(404, 'No host with that device ID in CrowdStrike');
    } else {
      const query = str(req.body?.query, 253);
      const matches = await findHosts(c, query, 10);
      if (!matches.length) throw new HttpError(404, `No host in CrowdStrike matches “${query}”`);
      if (matches.length > 1) return { needsChoice: true, matches: matches.map(hostSummary) };
      host = matches[0];
    }
    if (q.get('SELECT 1 FROM tracked_endpoints WHERE incident_id = ? AND device_id = ? AND active = 1', inc.id, host.deviceId)) {
      throw new HttpError(409, `${host.hostname} is already tracked in this incident`);
    }
    if (q.get<{ n: number }>('SELECT COUNT(*) AS n FROM tracked_endpoints WHERE incident_id = ? AND active = 1', inc.id)!.n >= MAX_TRACKED_PER_INCIDENT) {
      throw new HttpError(429, `at most ${MAX_TRACKED_PER_INCIDENT} endpoints can be tracked per incident`);
    }
    const channelId = edrChannel(inc.id, req.user!.id);
    const id = newId();
    q.run(
      `INSERT INTO tracked_endpoints (id, incident_id, integration_id, device_id, hostname, note, owner_id, channel_id, snapshot, alert_since, added_by, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      inc.id,
      integ.id,
      host.deviceId,
      host.hostname,
      note,
      ownerId,
      channelId,
      JSON.stringify(host),
      new Date(Date.now() - BACKFILL_HOURS * 3600e3).toISOString(),
      req.user!.id,
      now(),
    );
    const owner = ownerId ? `, owner ${userName(ownerId)}` : '';
    const state = `${host.os || host.platform}, ${host.online}, ${host.status === 'normal' ? 'not contained' : host.status.replace(/_/g, ' ')}`;
    postMessage(
      channelId,
      null,
      `${req.user!.display_name} started tracking **${host.hostname}** (${state})${owner}${note ? ` · ${note}` : ''}. State changes and new alerts appear here about every minute.`,
      'system',
    );
    addTimeline(inc.id, req.user!.id, 'investigation', `Started tracking endpoint ${host.hostname}${note ? `: ${note}` : ''}${owner}`, { endpointId: id });
    emitEndpoints(inc.id);
    void runEndpointPoll(id);
    return { endpoint: endpointView(getEndpoint(id)!), channelId };
  }),
);

function mustEndpointAccess(id: string, user: UserRow) {
  const e = getEndpoint(id);
  if (!e) throw new HttpError(404, 'not found');
  const integ = e.integration_id ? getIntegration(e.integration_id) : undefined;
  if (!integ || !canRun(user, integ, e.incident_id)) throw new HttpError(403, 'not allowed');
  return e;
}

/** Change the note or owner. */
integrationsRouter.patch(
  '/endpoints/:id',
  h((req) => {
    const e = mustEndpointAccess(req.params.id, req.user!);
    const note = req.body?.note !== undefined ? str(req.body.note, 300) : e.note;
    const ownerId = req.body?.ownerId !== undefined ? validOwner(req.body.ownerId) : e.owner_id;
    q.run('UPDATE tracked_endpoints SET note = ?, owner_id = ? WHERE id = ?', note, ownerId, e.id);
    if (ownerId !== e.owner_id) {
      const text = ownerId ? `${userName(ownerId)} now owns endpoint ${e.hostname}` : `${e.hostname} no longer has an owner`;
      addTimeline(e.incident_id, req.user!.id, 'assign', `${text} (set by ${req.user!.display_name})`, { endpointId: e.id });
      if (e.channel_id) postMessage(e.channel_id, null, `🖥️ ${text} (set by ${req.user!.display_name})`, 'system');
    }
    emitEndpoints(e.incident_id);
    return { endpoint: endpointView(getEndpoint(e.id)!) };
  }),
);

integrationsRouter.delete(
  '/endpoints/:id',
  h((req) => {
    const e = mustEndpointAccess(req.params.id, req.user!);
    if (!e.active) return { ok: true };
    q.run('UPDATE tracked_endpoints SET active = 0, removed_by = ?, removed_at = ? WHERE id = ?', req.user!.id, now(), e.id);
    if (e.channel_id) postMessage(e.channel_id, null, `${req.user!.display_name} stopped tracking **${e.hostname}** (${e.alert_count} alerts seen).`, 'system');
    addTimeline(e.incident_id, req.user!.id, 'investigation', `Stopped tracking endpoint ${e.hostname}`, { endpointId: e.id });
    emitEndpoints(e.incident_id);
    return { ok: true };
  }),
);

integrationsRouter.post(
  '/endpoints/:id/refresh',
  h(async (req) => {
    const e = mustEndpointAccess(req.params.id, req.user!);
    if (!e.active) throw new HttpError(400, 'this endpoint is no longer tracked');
    await runEndpointPoll(e.id);
    return { endpoint: endpointView(getEndpoint(e.id)!) };
  }),
);

integrationsRouter.get(
  '/endpoints/:id/alerts',
  h((req) => {
    const e = getEndpoint(req.params.id);
    if (!e) throw new HttpError(404, 'not found');
    return {
      alerts: q
        .all<{ data: string }>('SELECT data FROM endpoint_alerts WHERE endpoint_id = ? ORDER BY created_at DESC LIMIT 500', e.id)
        .map((r) => JSON.parse(r.data) as FalconAlert),
    };
  }),
);
