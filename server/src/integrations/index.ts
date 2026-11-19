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

type IntegrationType = 'okta' | 'sumo';
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

const TYPES: IntegrationType[] = ['okta', 'sumo'];
const SECRET_FIELDS: Record<IntegrationType, string[]> = { okta: ['token'], sumo: ['accessId', 'accessKey'] };

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

function creds(r: IntegrationRow): OktaCreds | SumoCreds {
  const s = decryptSecret(r.secret_enc);
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
      SECRET_FIELDS[r.type].map((f) => [f, secret[f] ? (f === 'accessId' ? `${secret[f].slice(0, 4)}…` : 'saved') : null]),
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
  kind: 'okta_user' | 'okta_logs' | 'sumo_search';
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
        ],
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
    const name = str(req.body?.name, 80) || (type === 'okta' ? 'Okta' : 'Sumo Logic');
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
    q.run('DELETE FROM integrations WHERE id = ?', r.id);
    incidents.forEach((i) => emitWatches(i.incident_id));
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
      message = r.type === 'okta' ? await testOkta(creds(r) as OktaCreds) : await testSumo(creds(r) as SumoCreds);
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

