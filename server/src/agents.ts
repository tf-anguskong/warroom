import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { config } from './config.js';
import { db, newId, now, q } from './db.js';
import { getUser, isAdmin, logAdminAction, type UserRow } from './users.js';
import { visibleChannelIds } from './realtime.js';
import { addTimeline, canControl, incidentKey } from './api.js';
import { guestAllowed, guestSessionValid, parseScope } from './guests.js';
import type { AgentContext, AgentScope } from './agent-context.js';

/**
 * AI agents (MCP clients such as Claude) act in War Room for one person, never with more access
 * than that person and never with room control. There are two ways in:
 *
 *  - OAuth 2.1 (permanent installs and anything with a browser): War Room is its own authorization
 *    server for its MCP endpoint. The client registers itself, the person signs in the usual way
 *    (Okta, Entra, emailed code), approves what the agent may do, and the client gets short-lived
 *    access tokens and rotating refresh tokens.
 *  - Room agent keys (temporary War Rooms, command-line agents): whoever runs the room issues a key
 *    for that one war room, for a few hours. It acts as the person who issued it.
 *
 * Either way a request carries `Authorization: Bearer …`, requireAuth resolves it to a grant, and
 * only the routes in AGENT_RULES are open: deny by default, like guests. Only hashes of keys, codes
 * and tokens are stored.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS agent_grants (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT,
  name TEXT NOT NULL,
  incident_id TEXT,
  scope TEXT NOT NULL,
  key_hash TEXT,
  key_hint TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  last_used_ip TEXT,
  revoked_at TEXT,
  revoked_by TEXT,
  revoked_reason TEXT
);
CREATE INDEX IF NOT EXISTS agent_grants_key ON agent_grants(key_hash);
CREATE INDEX IF NOT EXISTS agent_grants_user ON agent_grants(user_id);
CREATE INDEX IF NOT EXISTS agent_grants_incident ON agent_grants(incident_id);
CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  auth_method TEXT NOT NULL,
  secret_hash TEXT,
  created_at TEXT NOT NULL,
  created_ip TEXT
);
CREATE TABLE IF NOT EXISTS oauth_requests (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  state TEXT,
  code_challenge TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  user_id TEXT,
  grant_id TEXT,
  code_hash TEXT,
  code_expires_at TEXT
);
CREATE INDEX IF NOT EXISTS oauth_requests_code ON oauth_requests(code_hash);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS oauth_tokens_grant ON oauth_tokens(grant_id);
`);

interface GrantRow {
  id: string;
  kind: 'key' | 'oauth';
  user_id: string;
  client_id: string | null;
  name: string;
  incident_id: string | null;
  scope: string;
  key_hash: string | null;
  key_hint: string | null;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  last_used_ip: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  revoked_reason: string | null;
}

interface ClientRow {
  id: string;
  name: string;
  redirect_uris: string;
  auth_method: 'none' | 'client_secret_post' | 'client_secret_basic';
  secret_hash: string | null;
  created_at: string;
}

interface RequestRow {
  id: string;
  client_id: string;
  redirect_uri: string;
  state: string | null;
  code_challenge: string;
  scope: string;
  created_at: string;
  expires_at: string;
  status: 'pending' | 'approved' | 'used' | 'denied';
  user_id: string | null;
  grant_id: string | null;
  code_hash: string | null;
  code_expires_at: string | null;
}

interface TokenRow {
  hash: string;
  grant_id: string;
  type: 'access' | 'refresh';
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

// ---------- helpers ----------

const ACCESS_TOKEN_SECONDS = 3600;
const CODE_SECONDS = 300;
const REQUEST_MINUTES = 10;
export const KEY_HOURS = [2, 4, 8, 12, 24, 72];
export const SCOPES: AgentScope[] = ['read', 'write', 'investigate'];
const SCOPE_PREFIX = 'warroom:';

const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');
const newSecret = (prefix: string) => `${prefix}_${randomBytes(32).toString('base64url')}`;
const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const past = (iso: string | null | undefined) => !iso || new Date(iso).getTime() <= Date.now();
const plus = (ms: number) => new Date(Date.now() + ms).toISOString();
const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export const parseScopes = (s: string): AgentScope[] => {
  const set = new Set(s.split(/\s+/).map((x) => x.replace(SCOPE_PREFIX, '')));
  // Read is always part of a grant: an agent that can write but not read would be working blind.
  return SCOPES.filter((x) => x === 'read' || set.has(x));
};
const scopeText = (scopes: AgentScope[]) =>
  scopes.includes('write') && scopes.includes('investigate')
    ? 'read, write and run searches'
    : scopes.includes('write')
      ? 'read and write'
      : scopes.includes('investigate')
        ? 'read and run searches'
        : 'read only';

export const mcpUrl = () => `${config.publicUrl}/mcp`;
export const resourceMetadataUrl = () => `${config.publicUrl}/.well-known/oauth-protected-resource/mcp`;
const resourceMatches = (r: string) => [mcpUrl(), config.publicUrl].includes(r.replace(/\/+$/, ''));

/** Calls the MCP server makes to this server's own API carry this, so they aren't counted twice. */
export const INTERNAL_SECRET = randomBytes(24).toString('hex');
const isInternal = (req: Request) => {
  const h = req.headers['x-warroom-internal'];
  return typeof h === 'string' && safeEqual(h, INTERNAL_SECRET);
};

const getGrant = (id: string | null) => (id ? q.get<GrantRow>('SELECT * FROM agent_grants WHERE id = ?', id) : undefined);
const getClient = (id: string) => (id ? q.get<ClientRow>('SELECT * FROM oauth_clients WHERE id = ?', id) : undefined);

/** Why a grant can't be used right now, or null if it can. */
function grantProblem(g: GrantRow): string | null {
  if (!config.agents.enabled) return 'AI agents are turned off on this War Room';
  if (g.revoked_at) return 'This agent’s access was ended';
  if (past(g.expires_at)) return 'This agent’s access has expired';
  if (g.kind === 'key' && !config.agents.roomKeys) return 'Room agent keys are turned off on this War Room';
  if (g.incident_id) {
    const inc = q.get<{ status: string }>('SELECT status FROM incidents WHERE id = ?', g.incident_id);
    if (!inc) return 'That incident no longer exists';
    if (g.kind === 'key' && inc.status === 'resolved') return 'The incident is resolved, so its agent keys have stopped working';
  }
  return null;
}

/** A guest's agent works only while the guest may connect one: same war room, access still good, still allowed. */
function guestMayUseAgents(user: UserRow, incidentId: string | null) {
  return (
    config.agents.selfKeys === 'everyone' &&
    Boolean(incidentId) &&
    user.guest_incident_id === incidentId &&
    guestSessionValid(user) &&
    parseScope(user.guest_scope).agents
  );
}

function userProblem(g: GrantRow): UserRow | null {
  const user = getUser(g.user_id);
  if (!user || !user.active || user.deleted) return null;
  if (user.is_guest && (g.kind !== 'key' || !guestMayUseAgents(user, g.incident_id))) return null;
  // Sessions ended for this account (for example when SSO first linked it) end its agents too.
  if (user.sessions_valid_after && new Date(g.created_at).getTime() / 1000 < user.sessions_valid_after) return null;
  return user;
}

export function contextFor(g: GrantRow, user: UserRow): AgentContext {
  return { grantId: g.id, name: g.name, userId: user.id, incidentId: g.incident_id, scopes: parseScopes(g.scope) };
}

/** Resolve a bearer token (room key or OAuth access token) to its grant and person. */
export function agentFromToken(token: string): { grant: GrantRow; user: UserRow } | { error: string } {
  const fail = { error: 'This agent key or token isn’t valid. Connect the agent again.' };
  if (!config.agents.enabled) return { error: 'AI agents are turned off on this War Room' };
  let grant: GrantRow | undefined;
  if (token.startsWith('wrk_')) {
    grant = q.get<GrantRow>("SELECT * FROM agent_grants WHERE key_hash = ? AND kind = 'key'", sha256(token));
  } else if (token.startsWith('wra_')) {
    const t = q.get<TokenRow>("SELECT * FROM oauth_tokens WHERE hash = ? AND type = 'access'", sha256(token));
    if (!t || past(t.expires_at)) return fail;
    grant = getGrant(t.grant_id);
  }
  if (!grant) return fail;
  const problem = grantProblem(grant);
  if (problem) return { error: problem };
  const user = userProblem(grant);
  if (!user) return { error: 'The person this agent works for no longer has access' };
  return { grant, user };
}

const lastTouch = new Map<string, number>();
function touchGrant(g: GrantRow, ip: string | undefined) {
  const t = Date.now();
  if ((lastTouch.get(g.id) ?? 0) > t - 60_000) return;
  lastTouch.set(g.id, t);
  q.run('UPDATE agent_grants SET last_used_at = ?, last_used_ip = ? WHERE id = ?', now(), ip ?? null, g.id);
}

/** Simple per-agent limit: generous for a busy agent, stops a runaway loop. */
const windows = new Map<string, { start: number; n: number }>();
export function agentRateOk(key: string, perMinute: number) {
  const t = Date.now();
  const w = windows.get(key);
  if (!w || t - w.start > 60_000) {
    windows.set(key, { start: t, n: 1 });
    return true;
  }
  w.n++;
  return w.n <= perMinute;
}

// ---------- the agent gate: deny by default ----------

const ID = '([0-9a-f-]{36})';
const incidentOf = {
  sheet: (id: string) => q.get<{ incident_id: string }>('SELECT incident_id FROM sheets WHERE id = ?', id)?.incident_id ?? '',
  note: (id: string) => q.get<{ incident_id: string }>('SELECT incident_id FROM notes WHERE id = ?', id)?.incident_id ?? '',
  file: (id: string) => q.get<{ incident_id: string }>('SELECT incident_id FROM files WHERE id = ?', id)?.incident_id ?? '',
  run: (id: string) => q.get<{ incident_id: string }>('SELECT incident_id FROM investigation_runs WHERE id = ?', id)?.incident_id ?? '',
};
const within = (a: AgentContext, incidentId: string) => Boolean(incidentId) && (!a.incidentId || a.incidentId === incidentId);
const channelOk = (a: AgentContext, channelId: string) => {
  const owner = q.get<{ incident_id: string }>('SELECT incident_id FROM channels WHERE id = ?', channelId)?.incident_id;
  if (!owner) return false;
  return a.incidentId ? visibleChannelIds(a.incidentId).includes(channelId) : true;
};

type AgentRule = [method: string, pattern: RegExp, scope: AgentScope, check: (a: AgentContext, m: RegExpMatchArray) => boolean];
const AGENT_RULES: AgentRule[] = [
  ['GET', /^\/api\/me$/, 'read', () => true],
  ['GET', /^\/api\/meta$/, 'read', () => true],
  ['GET', /^\/api\/users$/, 'read', () => true],
  ['GET', /^\/api\/incidents$/, 'read', () => true], // filtered to the grant's incident in the route
  ['GET', new RegExp(`^/api/incidents/${ID}$`), 'read', (a, m) => within(a, m[1])],
  ['GET', new RegExp(`^/api/incidents/${ID}/timeline$`), 'read', (a, m) => within(a, m[1])],
  ['GET', new RegExp(`^/api/incidents/${ID}/export\\.md$`), 'read', (a, m) => within(a, m[1])],
  ['GET', new RegExp(`^/api/incidents/${ID}/files$`), 'read', (a, m) => within(a, m[1])],
  ['GET', new RegExp(`^/api/incidents/${ID}/shifts$`), 'read', (a, m) => within(a, m[1])],
  ['GET', new RegExp(`^/api/channels/${ID}/(messages|pins)$`), 'read', (a, m) => channelOk(a, m[1])],
  ['GET', new RegExp(`^/api/notes/${ID}$`), 'read', (a, m) => within(a, incidentOf.note(m[1]))],
  ['GET', new RegExp(`^/api/sheets/${ID}$`), 'read', (a, m) => within(a, incidentOf.sheet(m[1]))],
  ['GET', new RegExp(`^/api/files/${ID}$`), 'read', (a, m) => within(a, incidentOf.file(m[1]))],

  ['POST', new RegExp(`^/api/channels/${ID}/messages$`), 'write', (a, m) => channelOk(a, m[1])],
  ['POST', new RegExp(`^/api/incidents/${ID}/timeline$`), 'write', (a, m) => within(a, m[1])],
  ['POST', new RegExp(`^/api/incidents/${ID}/notes$`), 'write', (a, m) => within(a, m[1])],
  ['PUT', new RegExp(`^/api/notes/${ID}/body$`), 'write', (a, m) => within(a, incidentOf.note(m[1]))],
  ['POST', new RegExp(`^/api/sheets/${ID}/rows$`), 'write', (a, m) => within(a, incidentOf.sheet(m[1]))],
  ['PUT', new RegExp(`^/api/sheets/${ID}/cells$`), 'write', (a, m) => within(a, incidentOf.sheet(m[1]))],

  // Searches can expose people's activity: their own scope, and each integration's "who can search" still applies.
  ['GET', new RegExp(`^/api/incidents/${ID}/integrations$`), 'investigate', (a, m) => within(a, m[1])],
  ['GET', new RegExp(`^/api/incidents/${ID}/investigations$`), 'investigate', (a, m) => within(a, m[1])],
  ['POST', new RegExp(`^/api/incidents/${ID}/investigations$`), 'investigate', (a, m) => within(a, m[1])],
  ['GET', new RegExp(`^/api/investigations/${ID}$`), 'investigate', (a, m) => within(a, incidentOf.run(m[1]))],
];

/** Null if an agent may make this request, otherwise why not. Anything not listed is refused. */
export function agentRefusal(req: Request, a: AgentContext): string | null {
  const path = req.originalUrl.split('?')[0].replace(/\/+$/, '');
  for (const [method, re, scope, check] of AGENT_RULES) {
    if (method !== req.method) continue;
    const m = path.match(re);
    if (!m) continue;
    if (!a.scopes.includes(scope)) {
      return scope === 'write'
        ? 'This agent was approved to read only'
        : scope === 'investigate'
          ? 'This agent wasn’t approved to run integration searches'
          : 'This agent can’t do that';
    }
    return check(a, m) ? null : a.incidentId ? 'This agent only has access to one war room' : 'Not found';
  }
  return 'AI agents can’t do that in War Room';
}

/** Used by requireAuth for `Authorization: Bearer`. Returns false if it already answered. */
export function authenticateAgent(req: Request, res: Response, token: string): AgentContext | false {
  // requireAuth runs once per router a request passes through; check and count it once.
  const seen = (req as Request & { agentContext?: AgentContext }).agentContext;
  if (seen) return seen;
  const found = agentFromToken(token);
  if ('error' in found) {
    res.setHeader('WWW-Authenticate', `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl()}"`);
    res.status(401).json({ error: found.error });
    return false;
  }
  const ctx = contextFor(found.grant, found.user);
  // A guest's agent gets no more than the guest: their invite's allowlist applies on top.
  const refusal = agentRefusal(req, ctx) ?? (found.user.is_guest && !guestAllowed(req, found.user) ? 'This agent works for a guest, who doesn’t have access to that' : null);
  if (refusal) {
    res.status(403).json({ error: refusal });
    return false;
  }
  if (!isInternal(req)) {
    // Calls through /mcp are limited there; this is for direct REST use of the same token.
    if (!agentRateOk(`rest:${ctx.grantId}`, 300)) {
      res.status(429).json({ error: 'Too many requests from this agent; slow down' });
      return false;
    }
    touchGrant(found.grant, req.ip);
  }
  req.user = found.user;
  (req as Request & { agentContext?: AgentContext }).agentContext = ctx;
  return ctx;
}

/** Record use from the MCP endpoint (the real client address). */
export function noteAgentUse(grantId: string, ip: string | undefined) {
  const g = getGrant(grantId);
  if (g) touchGrant(g, ip);
}

// ---------- grants ----------

function grantView(g: GrantRow, viewer?: UserRow) {
  const owner = getUser(g.user_id);
  const inc = g.incident_id ? q.get<{ number: number; title: string }>('SELECT number, title FROM incidents WHERE id = ?', g.incident_id) : undefined;
  const problem = grantProblem(g) ?? (userProblem(g) ? null : 'The person it acts for no longer has access');
  return {
    id: g.id,
    kind: g.kind,
    name: g.name,
    scopes: parseScopes(g.scope),
    scopeText: scopeText(parseScopes(g.scope)),
    userId: g.user_id,
    userName: owner?.display_name ?? 'unknown',
    userIsGuest: Boolean(owner?.is_guest),
    incidentId: g.incident_id,
    incidentKey: inc ? incidentKey(inc.number) : null,
    incidentTitle: inc?.title ?? null,
    keyHint: g.key_hint,
    createdAt: g.created_at,
    expiresAt: g.expires_at,
    lastUsedAt: g.last_used_at,
    active: !problem,
    status: problem,
    canRevoke: viewer ? canRevoke(viewer, g) : false,
  };
}

function canRevoke(viewer: UserRow, g: GrantRow) {
  if (viewer.is_guest) return g.user_id === viewer.id;
  return g.user_id === viewer.id || isAdmin(viewer) || Boolean(g.incident_id && canControl(viewer, g.incident_id));
}

export function revokeGrant(id: string | null, actor: UserRow | null, reason: string) {
  const g = getGrant(id);
  if (!g || g.revoked_at) return false;
  q.run('UPDATE agent_grants SET revoked_at = ?, revoked_by = ?, revoked_reason = ? WHERE id = ?', now(), actor?.id ?? null, reason, g.id);
  q.run('DELETE FROM oauth_tokens WHERE grant_id = ?', g.id);
  const what = g.kind === 'key' ? `Agent key “${g.name}”` : `Agent “${g.name}” (for ${getUser(g.user_id)?.display_name ?? 'someone'})`;
  if (g.incident_id) addTimeline(g.incident_id, actor?.id ?? null, 'access', `${what} disconnected: ${reason}`);
  logAdminAction(actor?.id ?? null, g.user_id, 'agent_revoked', `${g.name}: ${reason}`);
  return true;
}

const activeGrants = (where: string, ...params: (string | null)[]) =>
  q
    .all<GrantRow>(`SELECT * FROM agent_grants WHERE revoked_at IS NULL AND expires_at > ? ${where} ORDER BY created_at DESC`, now(), ...params)
    .filter((g) => getUser(g.user_id)?.active);

// ---------- OAuth: metadata, registration, authorize, token, revoke ----------

/** MCP clients call these from anywhere (and the MCP Inspector from a browser); no cookies are involved. */
export function openCors(req: Request, res: Response, next: NextFunction) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

export const oauthRouter = Router();
oauthRouter.use(['/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server', '/oauth/register', '/oauth/token', '/oauth/revoke'], openCors);

const agentsOff = (res: Response) => res.status(404).json({ error: 'AI agents are turned off on this War Room' });

oauthRouter.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (_req, res) => {
  if (!config.agents.enabled) return agentsOff(res);
  res.json({
    resource: mcpUrl(),
    authorization_servers: [config.publicUrl],
    scopes_supported: SCOPES.map((s) => SCOPE_PREFIX + s),
    bearer_methods_supported: ['header'],
    resource_name: 'War Room',
  });
});

oauthRouter.get('/.well-known/oauth-authorization-server', (_req, res) => {
  if (!config.agents.enabled) return agentsOff(res);
  const base = config.publicUrl;
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    revocation_endpoint: `${base}/oauth/revoke`,
    ...(config.agents.dynamicClients ? { registration_endpoint: `${base}/oauth/register` } : {}),
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: SCOPES.map((s) => SCOPE_PREFIX + s),
    authorization_response_iss_parameter_supported: true,
  });
});

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
const BLOCKED_SCHEMES = ['javascript:', 'data:', 'file:', 'vbscript:', 'about:', 'blob:', 'ws:', 'wss:', 'ftp:'];

/** https anywhere, http only to this computer, or an app's own scheme (RFC 8252). */
function redirectAllowed(u: string) {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.hash || u.length > 2000) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return LOOPBACK.includes(url.hostname);
  return !BLOCKED_SCHEMES.includes(url.protocol) && /^[a-z][a-z0-9+.-]*:$/.test(url.protocol);
}

/** Exact match, except a loopback address may use any port (RFC 8252 §7.3). */
function matchRedirect(client: ClientRow, asked: string): string | null {
  const registered = JSON.parse(client.redirect_uris) as string[];
  if (!asked) return registered.length === 1 ? registered[0] : null;
  if (registered.includes(asked)) return asked;
  let a: URL;
  try {
    a = new URL(asked);
  } catch {
    return null;
  }
  if (a.protocol !== 'http:' || !LOOPBACK.includes(a.hostname)) return null;
  const ok = registered.some((r) => {
    const u = new URL(r);
    return u.protocol === 'http:' && u.hostname === a.hostname && u.pathname === a.pathname && u.search === a.search;
  });
  return ok ? asked : null;
}

oauthRouter.post('/oauth/register', express.json({ limit: '64kb' }), (req, res) => {
  if (!config.agents.enabled || !config.agents.dynamicClients) {
    return res.status(403).json({ error: 'access_denied', error_description: 'This War Room doesn’t let agent apps register themselves' });
  }
  if (!agentRateOk(`register:${req.ip}`, 10)) {
    return res.status(429).json({ error: 'slow_down', error_description: 'Too many registrations from this address' });
  }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String) : [];
  if (!uris.length || uris.length > 10 || !uris.every(redirectAllowed)) {
    return res.status(400).json({
      error: 'invalid_redirect_uri',
      error_description: 'Redirect URIs must be https, http to localhost, or an app’s own scheme',
    });
  }
  if (Array.isArray(b.grant_types) && !b.grant_types.includes('authorization_code')) {
    return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'Only the authorization_code grant is supported' });
  }
  const methods = ['none', 'client_secret_post', 'client_secret_basic'];
  const method = (methods.includes(String(b.token_endpoint_auth_method)) ? b.token_endpoint_auth_method : 'client_secret_basic') as ClientRow['auth_method'];
  const id = newId();
  const secret = method === 'none' ? null : newSecret('wrs');
  const name = str(b.client_name, 60) || 'An AI agent';
  q.run(
    'INSERT INTO oauth_clients (id, name, redirect_uris, auth_method, secret_hash, created_at, created_ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id,
    name,
    JSON.stringify(uris),
    method,
    secret ? sha256(secret) : null,
    now(),
    req.ip ?? null,
  );
  res.status(201).json({
    client_id: id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: method,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
  });
});

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** For errors where sending the browser back to the app would be unsafe (unknown app or address). */
function errorPage(res: Response, status: number, title: string, text: string) {
  res
    .status(status)
    .type('html')
    .send(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · War Room</title>` +
        `<style>body{font:15px/1.5 system-ui,sans-serif;background:#0f1115;color:#e6e8ee;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}` +
        `main{max-width:440px;background:#171a21;border:1px solid #2a2f3a;border-radius:10px;padding:24px}h1{font-size:18px;margin:0 0 8px}a{color:#7aa2ff}</style>` +
        `<main><h1>${esc(title)}</h1><p>${esc(text)}</p><p><a href="/">Go to War Room</a></p></main>`,
    );
}

function withParams(uri: string, params: Record<string, string | undefined | null>) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return u.toString();
}

oauthRouter.get('/oauth/authorize', (req, res) => {
  const p = req.query as Record<string, unknown>;
  const s = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '');
  if (!config.agents.enabled) return errorPage(res, 403, 'AI agents are turned off', 'An admin can turn them on in Admin → Settings → AI agents (MCP).');
  const client = getClient(s('client_id'));
  if (!client) return errorPage(res, 400, 'Unknown agent app', 'This app isn’t registered with War Room. Remove War Room from the agent and add it again.');
  const redirect = matchRedirect(client, s('redirect_uri'));
  if (!redirect) return errorPage(res, 400, 'Unexpected return address', 'The agent asked to come back to an address it didn’t register. Remove War Room from the agent and add it again.');
  const fail = (error: string, description: string) =>
    res.redirect(withParams(redirect, { error, error_description: description, state: s('state'), iss: config.publicUrl }));
  if (s('response_type') !== 'code') return fail('unsupported_response_type', 'Only the authorization code flow is supported');
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(s('code_challenge')) || s('code_challenge_method') !== 'S256') return fail('invalid_request', 'PKCE with S256 is required');
  if (s('resource') && !resourceMatches(s('resource'))) return fail('invalid_target', 'War Room only issues tokens for its own MCP server');
  const asked = s('scope').split(/\s+/).filter((x) => x.startsWith(SCOPE_PREFIX));
  // No War Room scopes asked for: offer read and write, and let the person choose.
  const scopes = asked.length ? parseScopes(asked.join(' ')) : (['read', 'write'] as AgentScope[]);
  const id = newId();
  q.run(
    'INSERT INTO oauth_requests (id, client_id, redirect_uri, state, code_challenge, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    client.id,
    redirect,
    s('state').slice(0, 2000) || null,
    s('code_challenge'),
    scopes.join(' '),
    now(),
    plus(REQUEST_MINUTES * 60_000),
  );
  res.redirect(`/connect/${id}`);
});

function issueTokens(g: GrantRow) {
  const access = newSecret('wra');
  const refresh = newSecret('wrr');
  const ts = now();
  const accessExpires = new Date(Math.min(Date.now() + ACCESS_TOKEN_SECONDS * 1000, new Date(g.expires_at).getTime())).toISOString();
  q.run('INSERT INTO oauth_tokens (hash, grant_id, type, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', sha256(access), g.id, 'access', ts, accessExpires);
  q.run('INSERT INTO oauth_tokens (hash, grant_id, type, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', sha256(refresh), g.id, 'refresh', ts, g.expires_at);
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: Math.max(1, Math.round((new Date(accessExpires).getTime() - Date.now()) / 1000)),
    refresh_token: refresh,
    scope: parseScopes(g.scope).map((x) => SCOPE_PREFIX + x).join(' '),
  };
}

/** Client authentication for the token and revocation endpoints. */
function authClient(req: Request): ClientRow | null {
  const b = (req.body ?? {}) as Record<string, unknown>;
  let id = str(b.client_id, 100);
  let secret = str(b.client_secret, 200);
  const basic = req.headers.authorization?.match(/^Basic\s+(.+)$/i);
  if (basic) {
    const [u, pw = ''] = Buffer.from(basic[1], 'base64').toString().split(':');
    try {
      id = decodeURIComponent(u);
      secret = decodeURIComponent(pw);
    } catch {
      return null;
    }
  }
  const client = getClient(id);
  if (!client) return null;
  if (client.auth_method === 'none') return client;
  return secret && client.secret_hash && safeEqual(sha256(secret), client.secret_hash) ? client : null;
}

const formOrJson = [express.urlencoded({ extended: false, limit: '64kb' }), express.json({ limit: '64kb' })];

oauthRouter.post('/oauth/token', ...formOrJson, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  const err = (status: number, error: string, description: string) => res.status(status).json({ error, error_description: description });
  if (!config.agents.enabled) return err(400, 'invalid_grant', 'AI agents are turned off on this War Room');
  if (!agentRateOk(`token:${req.ip}`, 60)) return err(429, 'slow_down', 'Too many token requests');
  const client = authClient(req);
  if (!client) return err(401, 'invalid_client', 'Unknown agent app, or its secret is wrong');
  const b = (req.body ?? {}) as Record<string, unknown>;

  if (b.grant_type === 'authorization_code') {
    const r = q.get<RequestRow>('SELECT * FROM oauth_requests WHERE code_hash = ?', sha256(str(b.code, 200)));
    if (!r || r.client_id !== client.id) return err(400, 'invalid_grant', 'That code isn’t valid');
    if (r.status === 'used') {
      // A code used twice may have been stolen: end what it gave.
      revokeGrant(r.grant_id, null, 'its sign-in code was used twice');
      return err(400, 'invalid_grant', 'That code was already used');
    }
    if (r.status !== 'approved' || past(r.code_expires_at)) return err(400, 'invalid_grant', 'That code has expired');
    if (b.redirect_uri !== undefined && b.redirect_uri !== r.redirect_uri) return err(400, 'invalid_grant', 'redirect_uri doesn’t match');
    const verifier = str(b.code_verifier, 200);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    if (!verifier || !safeEqual(challenge, r.code_challenge)) return err(400, 'invalid_grant', 'PKCE check failed');
    if (typeof b.resource === 'string' && !resourceMatches(b.resource)) return err(400, 'invalid_target', 'War Room only issues tokens for its own MCP server');
    if (q.run("UPDATE oauth_requests SET status = 'used' WHERE id = ? AND status = 'approved'", r.id).changes !== 1) {
      return err(400, 'invalid_grant', 'That code was already used');
    }
    const g = getGrant(r.grant_id);
    if (!g || grantProblem(g) || !userProblem(g)) return err(400, 'invalid_grant', 'This agent’s access has ended');
    return res.json(issueTokens(g));
  }

  if (b.grant_type === 'refresh_token') {
    const t = q.get<TokenRow>("SELECT * FROM oauth_tokens WHERE hash = ? AND type = 'refresh'", sha256(str(b.refresh_token, 200)));
    const g = t ? getGrant(t.grant_id) : undefined;
    if (!t || !g || g.client_id !== client.id) return err(400, 'invalid_grant', 'That refresh token isn’t valid');
    if (t.used_at) {
      // Clients sometimes refresh twice at once; only treat an old token coming back as theft.
      if (Date.now() - new Date(t.used_at).getTime() > 60_000) revokeGrant(g.id, null, 'an old refresh token was used again');
      return err(400, 'invalid_grant', 'That refresh token was already used');
    }
    if (past(t.expires_at) || grantProblem(g) || !userProblem(g)) return err(400, 'invalid_grant', 'This agent’s access has ended; connect it again');
    if (q.run('UPDATE oauth_tokens SET used_at = ? WHERE hash = ? AND used_at IS NULL', now(), t.hash).changes !== 1) {
      return err(400, 'invalid_grant', 'That refresh token was already used');
    }
    return res.json(issueTokens(g));
  }

  return err(400, 'unsupported_grant_type', 'Use authorization_code or refresh_token');
});

oauthRouter.post('/oauth/revoke', ...formOrJson, (req, res) => {
  const client = authClient(req);
  const token = str((req.body ?? {}).token, 200);
  const t = token ? q.get<TokenRow>('SELECT * FROM oauth_tokens WHERE hash = ?', sha256(token)) : undefined;
  const g = t ? getGrant(t.grant_id) : undefined;
  if (client && t && g && g.client_id === client.id) {
    if (t.type === 'refresh') revokeGrant(g.id, getUser(g.user_id) ?? null, 'disconnected by the agent app');
    else q.run('DELETE FROM oauth_tokens WHERE hash = ?', t.hash);
  }
  // RFC 7009: the answer is the same whether or not the token existed.
  res.status(200).json({});
});

// ---------- signed-in routes: approving agents, room keys, lists ----------

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
    } catch (e) {
      if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
      console.error('[agents]', e);
      res.status(500).json({ error: 'internal error' });
    }
  };

export const agentsRouter = Router();

function mustRequest(id: string, user: UserRow) {
  const r = q.get<RequestRow>('SELECT * FROM oauth_requests WHERE id = ?', id);
  if (!r || past(r.expires_at)) throw new HttpError(404, 'This request has expired. Go back to the agent and connect again.');
  if (r.status !== 'pending') throw new HttpError(409, 'This request was already answered. Go back to the agent and connect again if you need to.');
  if (user.is_guest) throw new HttpError(403, 'Guests can’t connect AI agents');
  if (!config.agents.enabled) throw new HttpError(403, 'AI agents are turned off on this War Room');
  return r;
}

agentsRouter.get(
  '/agents/requests/:id',
  h((req) => {
    const r = mustRequest(req.params.id, req.user!);
    const client = getClient(r.client_id)!;
    const redirect = new URL(r.redirect_uri);
    const incidents = q
      .all<{ id: string; number: number; title: string; severity: string }>(
        "SELECT id, number, title, severity FROM incidents WHERE status <> 'resolved' ORDER BY created_at DESC",
      )
      .map((i) => ({ id: i.id, key: incidentKey(i.number), title: i.title, severity: i.severity }));
    return {
      request: {
        id: r.id,
        clientName: client.name,
        returnsTo: redirect.protocol === 'http:' || redirect.protocol === 'https:' ? redirect.host : `${redirect.protocol}//`,
        scopes: parseScopes(r.scope),
        days: config.agents.grantDays,
      },
      incidents,
    };
  }),
);

agentsRouter.post(
  '/agents/requests/:id/approve',
  h((req) => {
    const user = req.user!;
    const r = mustRequest(req.params.id, user);
    const client = getClient(r.client_id);
    if (!client) throw new HttpError(404, 'This agent app is no longer registered');
    const offered = parseScopes(r.scope);
    const chosen = Array.isArray(req.body?.scopes) ? req.body.scopes.map(String) : [];
    const scopes = offered.filter((s) => s === 'read' || chosen.includes(s));
    let incidentId: string | null = null;
    if (req.body?.incidentId) {
      const inc = q.get<{ id: string; status: string }>('SELECT id, status FROM incidents WHERE id = ?', String(req.body.incidentId));
      if (!inc) throw new HttpError(404, 'incident not found');
      incidentId = inc.id;
    }
    const grantId = newId();
    const code = newSecret('wrc');
    const ts = now();
    q.run(
      `INSERT INTO agent_grants (id, kind, user_id, client_id, name, incident_id, scope, created_at, expires_at)
       VALUES (?, 'oauth', ?, ?, ?, ?, ?, ?, ?)`,
      grantId,
      user.id,
      client.id,
      client.name,
      incidentId,
      scopes.join(' '),
      ts,
      plus(config.agents.grantDays * 86_400_000),
    );
    const done = q.run(
      "UPDATE oauth_requests SET status = 'approved', user_id = ?, grant_id = ?, code_hash = ?, code_expires_at = ? WHERE id = ? AND status = 'pending'",
      user.id,
      grantId,
      sha256(code),
      plus(CODE_SECONDS * 1000),
      r.id,
    );
    if (done.changes !== 1) {
      q.run('DELETE FROM agent_grants WHERE id = ?', grantId);
      throw new HttpError(409, 'This request was already answered');
    }
    const where = incidentId ? 'this war room' : 'every war room they can open';
    if (incidentId) addTimeline(incidentId, user.id, 'access', `${user.display_name} connected the AI agent “${client.name}” to ${where} (${scopeText(scopes)})`);
    logAdminAction(user.id, user.id, 'agent_connected', `${client.name}: ${scopeText(scopes)}, ${incidentId ? 'one incident' : 'all incidents'}`);
    return { redirect: withParams(r.redirect_uri, { code, state: r.state, iss: config.publicUrl }) };
  }),
);

agentsRouter.post(
  '/agents/requests/:id/deny',
  h((req) => {
    const r = mustRequest(req.params.id, req.user!);
    q.run("UPDATE oauth_requests SET status = 'denied', user_id = ? WHERE id = ?", req.user!.id, r.id);
    return { redirect: withParams(r.redirect_uri, { error: 'access_denied', error_description: 'The person declined', state: r.state, iss: config.publicUrl }) };
  }),
);

/** Why this person can't issue a room key here, or null. */
function keyBlock(user: UserRow, incidentId: string): string | null {
  if (!config.agents.enabled) return 'AI agents are turned off. An admin can turn them on in Admin → Settings.';
  if (!config.agents.roomKeys) return 'Room agent keys are turned off. An admin can turn them on in Admin → Settings → AI agents.';
  const inc = q.get<{ status: string }>('SELECT status FROM incidents WHERE id = ?', incidentId);
  if (!inc) return 'incident not found';
  if (inc.status === 'resolved') return 'This incident is resolved.';
  if (user.is_guest) {
    if (user.guest_incident_id !== incidentId) return 'incident not found';
    if (config.agents.selfKeys !== 'everyone') return 'Guests can’t connect AI agents on this War Room.';
    if (!parseScope(user.guest_scope).agents) {
      return 'The Incident Commander or a room admin hasn’t allowed you to connect an AI agent. Ask them to turn it on in your guest access.';
    }
    return null;
  }
  if (config.agents.selfKeys === 'controllers' && !canControl(user, incidentId)) {
    return 'On this War Room only the Incident Commander, room admins and admins can create room agent keys.';
  }
  return null;
}

/** End every agent of one person in one war room (guest access ended or agents no longer allowed). */
export function revokeGrantsOf(userId: string, incidentId: string, actor: UserRow | null, reason: string) {
  for (const g of q.all<{ id: string }>('SELECT id FROM agent_grants WHERE user_id = ? AND incident_id = ? AND revoked_at IS NULL', userId, incidentId)) {
    revokeGrant(g.id, actor, reason);
  }
}

const MAX_KEYS_PER_PERSON = 5;

agentsRouter.get(
  '/incidents/:id/agents',
  h((req) => {
    const user = req.user!;
    const inc = q.get<{ id: string }>('SELECT id FROM incidents WHERE id = ?', req.params.id);
    if (!inc) throw new HttpError(404, 'incident not found');
    const control = canControl(user, inc.id);
    const grants = activeGrants('AND incident_id = ?', inc.id).filter((g) => control || g.user_id === user.id);
    return {
      enabled: config.agents.enabled,
      mcpUrl: mcpUrl(),
      oauth: config.agents.enabled && config.agents.dynamicClients && !user.is_guest,
      keyBlock: keyBlock(user, inc.id),
      canInvestigate: !user.is_guest,
      canDisconnectAll: !user.is_guest && canControl(user, inc.id),
      keyHours: KEY_HOURS,
      grants: grants.map((g) => grantView(g, user)),
    };
  }),
);

agentsRouter.post(
  '/incidents/:id/agent-keys',
  h((req) => {
    const user = req.user!;
    const inc = q.get<{ id: string; number: number }>('SELECT id, number FROM incidents WHERE id = ?', req.params.id);
    if (!inc) throw new HttpError(404, 'incident not found');
    const block = keyBlock(user, inc.id);
    if (block) throw new HttpError(403, block);
    const name = str(req.body?.name, 60) || 'AI agent';
    const hours = KEY_HOURS.includes(Number(req.body?.hours)) ? Number(req.body.hours) : 12;
    const chosen = Array.isArray(req.body?.scopes) ? req.body.scopes.map(String) : [];
    // Guests' agents can't run integration searches (guests can't either).
    const scopes = SCOPES.filter((s) => s === 'read' || (chosen.includes(s) && !(user.is_guest && s === 'investigate')));
    const mine = q.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM agent_grants WHERE user_id = ? AND incident_id = ? AND revoked_at IS NULL AND expires_at > ?',
      user.id,
      inc.id,
      now(),
    )!.n;
    if (mine >= MAX_KEYS_PER_PERSON) throw new HttpError(409, `You already have ${MAX_KEYS_PER_PERSON} agent keys here. Disconnect one first.`);
    // A guest's key never outlives the guest's access.
    const until = Math.min(Date.now() + hours * 3_600_000, user.is_guest && user.guest_expires_at ? new Date(user.guest_expires_at).getTime() : Infinity);
    const key = newSecret('wrk');
    const id = newId();
    q.run(
      `INSERT INTO agent_grants (id, kind, user_id, name, incident_id, scope, key_hash, key_hint, created_at, expires_at)
       VALUES (?, 'key', ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      user.id,
      name,
      inc.id,
      scopes.join(' '),
      sha256(key),
      key.slice(-4),
      now(),
      new Date(until).toISOString(),
    );
    addTimeline(inc.id, user.id, 'access', `${user.display_name} created an agent key for their AI agent “${name}” (${scopeText(scopes)}, ${hours} h)`);
    logAdminAction(user.id, user.id, 'agent_key_issued', `${incidentKey(inc.number)}: ${name} (${scopeText(scopes)}, ${hours} h)`);
    return { key, mcpUrl: mcpUrl(), grant: grantView(getGrant(id)!, user) };
  }),
);

/** Room control: disconnect every agent connected to this war room at once. */
agentsRouter.delete(
  '/incidents/:id/agent-grants',
  h((req) => {
    const user = req.user!;
    const inc = q.get<{ id: string }>('SELECT id FROM incidents WHERE id = ?', req.params.id);
    if (!inc) throw new HttpError(404, 'incident not found');
    if (user.is_guest || !canControl(user, inc.id)) throw new HttpError(403, 'Only the Incident Commander, room admins and admins can disconnect everyone’s agents');
    const ids = q.all<{ id: string }>('SELECT id FROM agent_grants WHERE incident_id = ? AND revoked_at IS NULL', inc.id);
    for (const g of ids) revokeGrant(g.id, user, `all agents disconnected by ${user.display_name}`);
    return { disconnected: ids.length };
  }),
);

agentsRouter.get(
  '/agent-grants',
  h((req) => ({ enabled: config.agents.enabled, mcpUrl: mcpUrl(), grants: activeGrants('AND user_id = ?', req.user!.id).map((g) => grantView(g, req.user!)) })),
);

agentsRouter.get(
  '/admin/agent-grants',
  h((req) => {
    if (!isAdmin(req.user!)) throw new HttpError(403, 'admins only');
    return { enabled: config.agents.enabled, mcpUrl: mcpUrl(), grants: activeGrants('').map((g) => grantView(g, req.user!)) };
  }),
);

agentsRouter.delete(
  '/agent-grants/:id',
  h((req) => {
    const g = getGrant(req.params.id);
    if (!g || !canRevoke(req.user!, g)) throw new HttpError(404, 'not found');
    revokeGrant(g.id, req.user!, `ended by ${req.user!.display_name}`);
    return { ok: true };
  }),
);

/** Drop finished OAuth requests and dead tokens now and then. */
export function startAgentSweeper() {
  const sweep = () => {
    const ts = now();
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
    q.run('DELETE FROM oauth_requests WHERE expires_at < ?', dayAgo);
    q.run('DELETE FROM oauth_tokens WHERE expires_at < ?', ts);
    q.run('DELETE FROM oauth_tokens WHERE used_at IS NOT NULL AND used_at < ?', dayAgo);
  };
  sweep();
  setInterval(sweep, 15 * 60_000).unref();
}
