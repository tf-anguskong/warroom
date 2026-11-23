import { createHmac, randomBytes } from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Router, type Request, type Response } from 'express';
import { config } from './config.js';
import { db, newId, now, q } from './db.js';
import { getUser, isAdmin, logAdminAction, type UserRow } from './users.js';
import { decryptSecret, encryptSecret } from './integrations/secrets.js';
import { canControl } from './permissions.js';
import { addTimeline } from './timeline.js';
import { SEVERITIES } from './templates.js';

/**
 * Outbound webhooks: War Room posts incident updates to Slack, Discord, Mattermost, Microsoft Teams
 * or any endpoint that takes JSON. Admins define global webhooks (every incident, filtered by event
 * and severity); the IC and room admins define webhooks for their own war room.
 *
 * Webhook URLs carry their own credential, so they are encrypted at rest and never sent back to the
 * browser. Requests only go to https (to the provider's own hosts for Slack, Discord and Teams), never
 * to internal addresses unless an admin allows it, and never follow redirects. Content can't ping
 * @everyone / @channel. "Headline only" sends no titles or details, for sensitive incidents.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  incident_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  url_hint TEXT NOT NULL,
  events TEXT NOT NULL,
  min_severity TEXT NOT NULL DEFAULT 'SEV4',
  detail TEXT NOT NULL DEFAULT 'full',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  last_sent_at TEXT,
  last_ok INTEGER,
  last_error TEXT,
  failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS webhooks_scope ON webhooks(scope, incident_id);
`);

interface HookRow {
  id: string;
  scope: 'global' | 'room';
  incident_id: string | null;
  name: string;
  kind: Kind;
  secret_enc: string;
  url_hint: string;
  events: string;
  min_severity: string;
  detail: 'full' | 'brief';
  enabled: number;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
  last_sent_at: string | null;
  last_ok: number | null;
  last_error: string | null;
  failures: number;
}

// ---------- kinds and events ----------

export type Kind = 'slack' | 'discord' | 'mattermost' | 'teams' | 'generic';

const KINDS: Record<Kind, { label: string; hosts?: string[]; suffixes?: string[]; help: string }> = {
  slack: { label: 'Slack', hosts: ['hooks.slack.com'], help: 'Slack → Apps → Incoming Webhooks → Add to a channel. URL starts with https://hooks.slack.com/services/' },
  discord: { label: 'Discord', hosts: ['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'], help: 'Channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.' },
  mattermost: { label: 'Mattermost', help: 'Integrations → Incoming Webhooks → Add. Self-hosted: if it’s on your internal network, an admin must allow internal addresses.' },
  teams: {
    label: 'Microsoft Teams',
    suffixes: ['.logic.azure.com', '.webhook.office.com', '.powerplatform.com', '.powerautomate.com'],
    help: 'In the channel: ⋯ → Workflows → “Post to a channel when a webhook request is received”. Copy the URL it gives you.',
  },
  generic: { label: 'Generic JSON (signed)', help: 'POSTs JSON. Each request is signed: X-WarRoom-Signature = sha256 HMAC of “timestamp.body” with the signing secret shown once.' },
};

export const EVENTS = [
  { key: 'incident.declared', label: 'Incident declared', globalOnly: true },
  { key: 'incident.severity', label: 'Severity changed' },
  { key: 'incident.status', label: 'Status changed (including resolved)' },
  { key: 'incident.commander', label: 'Incident Commander changed' },
  { key: 'timeline.decision', label: 'Decisions' },
  { key: 'timeline.finding', label: 'Findings' },
  { key: 'timeline.action', label: 'Actions recorded on the timeline' },
  { key: 'message.pinned', label: 'Pinned messages' },
  { key: 'evidence.added', label: 'Evidence added' },
  { key: 'update.posted', label: 'Updates posted from the war room' },
] as const;
type EventKey = (typeof EVENTS)[number]['key'];
const EVENT_KEYS = EVENTS.map((e) => e.key) as string[];
const DEFAULT_EVENTS: Record<'global' | 'room', EventKey[]> = {
  global: ['incident.declared', 'incident.severity', 'incident.status', 'incident.commander'],
  room: ['incident.severity', 'incident.status', 'incident.commander', 'timeline.decision', 'update.posted'],
};

const SEV_COLOR: Record<string, string> = { SEV1: '#d64545', SEV2: '#d9732c', SEV3: '#c49a1c', SEV4: '#3d7fd9' };
const sevRank = (s: string) => Math.max(0, SEVERITIES.indexOf(s as never));
const incidentKey = (n: number) => `INC-${String(n).padStart(4, '0')}`;

// ---------- the message and its formats ----------

export interface Message {
  event: EventKey | 'test';
  incident: { id: string; key: string; title: string; severity: string; status: string; url: string } | null;
  headline: string;
  text: string;
  actor: string | null;
  agent: string | null;
  color: string;
  at: string;
}

/** Stop content from pinging everyone (@channel, @here, @everyone, @all, Slack's <!channel>). */
const defuse = (s: string) => s.replace(/@(channel|here|everyone|all)\b/gi, '@​$1');
const slackEscape = (s: string) => defuse(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function fields(m: Message) {
  const f: { name: string; value: string }[] = [];
  if (m.incident) {
    f.push({ name: 'Severity', value: m.incident.severity });
    f.push({ name: 'Status', value: m.incident.status[0].toUpperCase() + m.incident.status.slice(1) });
  }
  if (m.actor) f.push({ name: 'By', value: m.agent ? `${m.actor} (AI agent · ${m.agent})` : m.actor });
  return f;
}

/** Exported for tests. */
export function format(kind: Kind, m: Message): unknown {
  const link = m.incident?.url;
  if (kind === 'slack' || kind === 'mattermost') {
    const esc = kind === 'slack' ? slackEscape : defuse;
    return {
      ...(kind === 'mattermost' ? { username: 'War Room' } : {}),
      text: esc(cut(m.headline, 300)),
      attachments: [
        {
          color: m.color,
          fallback: esc(cut(m.headline, 300)),
          title: m.incident ? esc(cut(`${m.incident.key}${m.incident.title ? `: ${m.incident.title}` : ''}`, 250)) : 'War Room',
          ...(link ? { title_link: link } : {}),
          ...(m.text ? { text: esc(cut(m.text, 3000)) } : {}),
          fields: fields(m).map((x) => ({ title: x.name, value: esc(x.value), short: true })),
          footer: 'War Room',
          ts: Math.floor(new Date(m.at).getTime() / 1000),
        },
      ],
    };
  }
  if (kind === 'discord') {
    return {
      username: 'War Room',
      allowed_mentions: { parse: [] },
      content: cut(defuse(m.headline), 1900),
      embeds: [
        {
          title: cut(m.incident ? `${m.incident.key}${m.incident.title ? `: ${m.incident.title}` : ''}` : 'War Room', 256),
          ...(link ? { url: link } : {}),
          ...(m.text ? { description: cut(defuse(m.text), 4000) } : {}),
          color: parseInt(m.color.slice(1), 16),
          fields: fields(m).map((x) => ({ name: x.name, value: cut(x.value, 1000), inline: true })),
          footer: { text: 'War Room' },
          timestamp: m.at,
        },
      ],
    };
  }
  if (kind === 'teams') {
    return {
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.4',
            body: [
              { type: 'TextBlock', text: cut(m.headline, 300), weight: 'Bolder', size: 'Medium', wrap: true },
              ...(m.incident?.title ? [{ type: 'TextBlock', text: cut(`${m.incident.key}: ${m.incident.title}`, 250), isSubtle: true, wrap: true }] : []),
              ...(m.text ? [{ type: 'TextBlock', text: cut(m.text, 3000), wrap: true }] : []),
              { type: 'FactSet', facts: fields(m).map((x) => ({ title: x.name, value: x.value })) },
            ],
            ...(link ? { actions: [{ type: 'Action.OpenUrl', title: 'Open war room', url: link }] } : {}),
          },
        },
      ],
    };
  }
  return {
    event: m.event,
    at: m.at,
    headline: m.headline,
    text: m.text || null,
    actor: m.actor,
    agent: m.agent,
    incident: m.incident,
  };
}

// ---------- safe delivery ----------

/** Loopback, private, link-local, carrier-grade NAT, multicast and other non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (ip.startsWith('::ffff:')) return isPrivateAddress(ip.slice(7));
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
}

/** Why this URL can't be used for this kind of webhook, or null. */
export function urlProblem(kind: Kind, raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'That isn’t a valid URL';
  }
  if (raw.length > 2000) return 'That URL is too long';
  if (u.username || u.password) return 'The URL can’t contain a username or password';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && config.webhooks.allowPrivate)) return 'The URL must start with https://';
  const host = u.hostname.toLowerCase();
  const k = KINDS[kind];
  if (k.hosts && !k.hosts.includes(host)) return `A ${k.label} webhook URL must be on ${k.hosts[0]}`;
  if (k.suffixes && !k.suffixes.some((s) => host.endsWith(s))) return `A ${k.label} webhook URL must be a Teams Workflows or Power Automate address`;
  if (kind === 'discord' && !u.pathname.startsWith('/api/webhooks/')) return 'A Discord webhook URL looks like https://discord.com/api/webhooks/…';
  const literal = host.replace(/^\[|\]$/g, '');
  if (isIP(literal) && isPrivateAddress(literal) && !config.webhooks.allowPrivate) return 'That address is on an internal network. An admin can allow internal addresses in Settings → Webhooks.';
  if ((host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) && !config.webhooks.allowPrivate) {
    return 'That address is on an internal network. An admin can allow internal addresses in Settings → Webhooks.';
  }
  return null;
}

/** DNS lookup that refuses internal addresses, so a public name can't be pointed at one. */
function guardedLookup(hostname: string, options: object, cb: (err: Error | null, address?: string | LookupAddress[], family?: number) => void) {
  dnsLookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = config.webhooks.allowPrivate ? addrs : addrs.filter((a) => !isPrivateAddress(a.address));
    if (!ok.length) return cb(new Error(`${hostname} resolves to an internal address`));
    if ((options as { all?: boolean }).all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}

function post(url: string, body: string, headers: Record<string, string>): Promise<{ status: number; retryAfter: number | null; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(
      u,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body).toString(), 'user-agent': 'WarRoom-Webhook/1.0', ...headers },
        timeout: 10_000,
        lookup: guardedLookup as never,
      },
      (res: IncomingMessage) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          if (text.length < 500) text += c;
        });
        res.on('end', () => {
          const ra = Number(res.headers['retry-after']);
          resolve({ status: res.statusCode ?? 0, retryAfter: Number.isFinite(ra) ? ra : null, text: text.slice(0, 300) });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timed out after 10 s')));
    req.on('error', reject);
    req.end(body);
  });
}

const getHook = (id: string) => q.get<HookRow>('SELECT * FROM webhooks WHERE id = ?', id);

/** Send one message to one webhook, with retries. Records the outcome on the row; never throws. */
async function deliver(hook: HookRow, m: Message): Promise<{ ok: boolean; error: string | null }> {
  let secret: { url?: string; signing?: string };
  try {
    secret = decryptSecret(hook.secret_enc);
  } catch {
    return record(hook.id, false, 'Can’t read the stored URL (the server key changed). Edit the webhook and enter the URL again.');
  }
  const url = secret.url ?? '';
  const problem = urlProblem(hook.kind, url);
  if (problem) return record(hook.id, false, problem);
  const body = JSON.stringify(format(hook.kind, m));
  const headers: Record<string, string> = {};
  if (hook.kind === 'generic' && secret.signing) {
    const ts = Math.floor(Date.now() / 1000).toString();
    headers['x-warroom-event'] = m.event;
    headers['x-warroom-timestamp'] = ts;
    headers['x-warroom-signature'] = `sha256=${createHmac('sha256', secret.signing).update(`${ts}.${body}`).digest('hex')}`;
  }
  let last = 'no attempt';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await post(url, body, headers);
      if (r.status >= 200 && r.status < 300) return record(hook.id, true, null);
      last = `HTTP ${r.status}${r.text ? `: ${r.text.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`;
      if (r.status >= 300 && r.status < 400) return record(hook.id, false, `${last} (redirects aren’t followed; check the URL)`);
      if (r.status !== 429 && r.status < 500) return record(hook.id, false, last);
      await new Promise((res) => setTimeout(res, Math.min(30, r.retryAfter ?? [2, 10][attempt] ?? 10) * 1000));
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
      if (/internal address/.test(last)) return record(hook.id, false, last);
      await new Promise((res) => setTimeout(res, ([2, 10][attempt] ?? 10) * 1000));
    }
  }
  return record(hook.id, false, last);
}

function record(id: string, ok: boolean, error: string | null) {
  q.run(
    `UPDATE webhooks SET last_sent_at = ?, last_ok = ?, last_error = ?, failures = CASE WHEN ? THEN 0 ELSE failures + 1 END WHERE id = ?`,
    now(),
    ok ? 1 : 0,
    error ? error.slice(0, 300) : null,
    ok ? 1 : 0,
    id,
  );
  if (!ok) console.warn(`[webhooks] ${id} failed: ${error}`);
  return { ok, error };
}

// One queue per webhook keeps messages in order; a per-minute cap stops floods.
const queues = new Map<string, Promise<unknown>>();
const minute = new Map<string, { start: number; n: number; dropped: number }>();
const PER_MINUTE = 30;

function enqueue(hook: HookRow, m: Message) {
  const t = Date.now();
  let w = minute.get(hook.id);
  if (!w || t - w.start > 60_000) {
    if (w?.dropped) record(hook.id, false, `${w.dropped} message(s) skipped: more than ${PER_MINUTE} in a minute`);
    w = { start: t, n: 0, dropped: 0 };
    minute.set(hook.id, w);
  }
  if (++w.n > PER_MINUTE) {
    w.dropped++;
    return;
  }
  const prev = queues.get(hook.id) ?? Promise.resolve();
  const next = prev.then(() => deliver(hook, m)).catch(() => undefined);
  queues.set(hook.id, next);
  void next.finally(() => queues.get(hook.id) === next && queues.delete(hook.id));
}

// ---------- events ----------

interface IncidentRow {
  id: string;
  number: number;
  title: string;
  summary: string;
  severity: string;
  status: string;
}

function messageFor(event: EventKey, inc: IncidentRow, detail: 'full' | 'brief', text: string, actor: string | null, agent: string | null): Message {
  const key = incidentKey(inc.number);
  const brief = detail === 'brief';
  const H: Record<EventKey, string> = {
    'incident.declared': `Incident declared: ${key} (${inc.severity})`,
    'incident.severity': `${key}: ${text}`,
    'incident.status': `${key}: ${text.replace(/^Status: /, 'status ')}`,
    'incident.commander': `${key}: ${brief ? 'Incident Commander changed' : text}`,
    'timeline.decision': `Decision in ${key}`,
    'timeline.finding': `Finding in ${key}`,
    'timeline.action': `Action in ${key}`,
    'message.pinned': `Message pinned in ${key}`,
    'evidence.added': `Evidence added in ${key}`,
    'update.posted': `Update on ${key}`,
  };
  const body = event === 'incident.declared' ? inc.summary : ['incident.severity', 'incident.status', 'incident.commander'].includes(event) ? '' : text;
  return {
    event,
    incident: { id: inc.id, key, title: brief ? '' : inc.title, severity: inc.severity, status: inc.status, url: `${config.publicUrl}/incidents/${inc.id}` },
    headline: H[event],
    text: brief ? '' : body,
    actor: brief ? null : actor,
    agent: brief ? null : agent,
    color: inc.status === 'resolved' ? '#2f9e63' : SEV_COLOR[inc.severity] ?? '#5d6b7e',
    at: now(),
  };
}

function hooksFor(event: EventKey, inc: IncidentRow, only?: string[]) {
  return q
    .all<HookRow>("SELECT * FROM webhooks WHERE enabled = 1 AND (scope = 'global' OR (scope = 'room' AND incident_id = ?))", inc.id)
    .filter((h) => (h.scope === 'global' || config.webhooks.room) && (JSON.parse(h.events) as string[]).includes(event))
    .filter((h) => h.scope === 'room' || sevRank(inc.severity) <= sevRank(h.min_severity))
    .filter((h) => !only || only.includes(h.id));
}

function send(event: EventKey, incidentId: string, text: string, userId: string | null, agent: string | null, only?: string[]) {
  const inc = q.get<IncidentRow>('SELECT id, number, title, summary, severity, status FROM incidents WHERE id = ?', incidentId);
  if (!inc) return [];
  const actor = userId ? getUser(userId)?.display_name ?? null : null;
  const hooks = hooksFor(event, inc, only);
  for (const h of hooks) enqueue(h, messageFor(event, inc, h.detail, text, actor, agent));
  return hooks;
}

/** Called from addTimeline for every new entry; turns the ones webhooks care about into events. Never throws. */
export function timelineToWebhooks(incidentId: string, type: string, text: string, ref: Record<string, unknown> | null, userId: string | null, agent: string | null) {
  const event: EventKey | null =
    type === 'declared' ? 'incident.declared'
    : type === 'severity' ? 'incident.severity'
    : type === 'status' ? 'incident.status'
    : type === 'role' && ref?.role === 'commander' ? 'incident.commander'
    : type === 'decision' ? 'timeline.decision'
    : type === 'finding' ? 'timeline.finding'
    : type === 'action' ? 'timeline.action'
    : type === 'pin' ? 'message.pinned'
    : type === 'evidence' ? 'evidence.added'
    : null;
  if (!event) return;
  setImmediate(() => {
    try {
      send(event, incidentId, text, userId, agent);
    } catch (err) {
      console.error('[webhooks]', err);
    }
  });
}

// ---------- routes ----------

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
      console.error('[webhooks]', e);
      res.status(500).json({ error: 'internal error' });
    }
  };
const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function view(hk: HookRow) {
  return {
    id: hk.id,
    scope: hk.scope,
    incidentId: hk.incident_id,
    name: hk.name,
    kind: hk.kind,
    kindLabel: KINDS[hk.kind].label,
    urlHint: hk.url_hint,
    events: JSON.parse(hk.events) as string[],
    minSeverity: hk.min_severity,
    detail: hk.detail,
    enabled: Boolean(hk.enabled),
    createdBy: hk.created_by ? getUser(hk.created_by)?.display_name ?? null : null,
    updatedAt: hk.updated_at,
    lastSentAt: hk.last_sent_at,
    lastOk: hk.last_ok === null ? null : Boolean(hk.last_ok),
    lastError: hk.last_error,
    failures: hk.failures,
  };
}

const hint = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.host}/…${url.replace(/\/+$/, '').slice(-4)}`;
  } catch {
    return '…';
  }
};

function meta(scope: 'global' | 'room') {
  return {
    kinds: Object.entries(KINDS).map(([id, k]) => ({ id, label: k.label, help: k.help })),
    events: EVENTS.filter((e) => scope === 'global' || !('globalOnly' in e)).map((e) => ({ key: e.key, label: e.label })),
    defaults: DEFAULT_EVENTS[scope],
    severities: SEVERITIES,
    allowPrivate: config.webhooks.allowPrivate,
  };
}

/** Create or update from a request body. Returns the signing secret once for new generic webhooks. */
function save(req: Request, existing: HookRow | null, scope: 'global' | 'room', incidentId: string | null) {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const kind = (existing?.kind ?? (Object.keys(KINDS).includes(String(b.kind)) ? b.kind : null)) as Kind | null;
  if (!kind) throw new HttpError(400, 'Choose where it posts (Slack, Discord, Mattermost, Teams or generic)');
  const name = str(b.name, 80) || existing?.name || '';
  if (!name) throw new HttpError(400, 'Give it a name, for example the channel it posts to');
  let secret = existing ? (decryptSecret(existing.secret_enc) as { url?: string; signing?: string }) : {};
  const url = str(b.url, 2000);
  let signing: string | null = null;
  if (url || !existing) {
    const problem = urlProblem(kind, url);
    if (problem) throw new HttpError(400, problem);
    secret = { ...secret, url };
  }
  if (kind === 'generic' && (!secret.signing || b.newSigningSecret === true)) {
    signing = randomBytes(24).toString('base64url');
    secret = { ...secret, signing };
  }
  const allowed = meta(scope).events.map((e) => e.key) as string[];
  const events = Array.isArray(b.events) ? [...new Set(b.events.map(String))].filter((e) => allowed.includes(e)) : existing ? JSON.parse(existing.events) : DEFAULT_EVENTS[scope];
  if (!events.length) throw new HttpError(400, 'Choose at least one event');
  const minSeverity = SEVERITIES.includes(b.minSeverity as never) ? String(b.minSeverity) : existing?.min_severity ?? 'SEV4';
  const detail = b.detail === 'brief' || b.detail === 'full' ? b.detail : existing?.detail ?? 'full';
  const enabled = typeof b.enabled === 'boolean' ? b.enabled : existing ? Boolean(existing.enabled) : true;
  const ts = now();
  const id = existing?.id ?? newId();
  if (existing) {
    q.run(
      'UPDATE webhooks SET name = ?, secret_enc = ?, url_hint = ?, events = ?, min_severity = ?, detail = ?, enabled = ?, updated_by = ?, updated_at = ?, failures = CASE WHEN ? THEN 0 ELSE failures END WHERE id = ?',
      name, encryptSecret(secret as Record<string, string>), url ? hint(url) : existing.url_hint, JSON.stringify(events), minSeverity, detail, enabled ? 1 : 0, req.user!.id, ts, url ? 1 : 0, id,
    );
  } else {
    q.run(
      `INSERT INTO webhooks (id, scope, incident_id, name, kind, secret_enc, url_hint, events, min_severity, detail, enabled, created_by, created_at, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, scope, incidentId, name, kind, encryptSecret(secret as Record<string, string>), hint(url), JSON.stringify(events), minSeverity, detail, enabled ? 1 : 0, req.user!.id, ts, req.user!.id, ts,
    );
  }
  return { hook: getHook(id)!, signing, urlChanged: Boolean(url) };
}

const describe = (hk: HookRow) =>
  `${KINDS[hk.kind].label} webhook “${hk.name}” (${(JSON.parse(hk.events) as string[]).map((e) => EVENTS.find((x) => x.key === e)?.label.toLowerCase() ?? e).join(', ')}${hk.detail === 'brief' ? '; headline only' : ''}${hk.enabled ? '' : '; paused'})`;

/** Why this person can't manage this war room's webhooks, or null. */
function roomBlock(user: UserRow, incidentId: string): string | null {
  if (!config.webhooks.room) return 'Room webhooks are turned off. An admin can turn them on in Admin → Settings → Webhooks.';
  if (user.is_guest || !canControl(user, incidentId)) return 'Only the Incident Commander, room admins and admins can change this war room’s webhooks.';
  return null;
}
/** Posting an update outside War Room: whoever runs the room, and the Comms Lead. */
function postBlock(user: UserRow, incidentId: string): string | null {
  if (user.is_guest) return 'Guests can’t post updates';
  if (canControl(user, incidentId)) return null;
  const comms = q.get('SELECT 1 FROM incident_roles WHERE incident_id = ? AND role = ? AND user_id = ?', incidentId, 'comms', user.id);
  return comms ? null : 'Only the Incident Commander, room admins and the Comms Lead can post updates.';
}

function mustHookFor(req: Request) {
  const hk = getHook(req.params.id);
  if (!hk) throw new HttpError(404, 'webhook not found');
  const user = req.user!;
  if (hk.scope === 'global') {
    if (!isAdmin(user)) throw new HttpError(403, 'Only admins can change global webhooks');
  } else {
    const why = roomBlock(user, hk.incident_id!);
    if (why) throw new HttpError(403, why);
  }
  return hk;
}

function mustIncident(id: string) {
  const inc = q.get<IncidentRow>('SELECT id, number, title, summary, severity, status FROM incidents WHERE id = ?', id);
  if (!inc) throw new HttpError(404, 'incident not found');
  return inc;
}

function logChange(req: Request, hk: HookRow, what: string) {
  if (hk.scope === 'global') logAdminAction(req.user!.id, null, 'webhook_changed', `${what}: ${describe(hk)}`);
  else addTimeline(hk.incident_id!, req.user!.id, 'webhook', `${req.user!.display_name} ${what} the ${describe(hk)}`);
}

export const webhooksRouter = Router();

webhooksRouter.get(
  '/admin/webhooks',
  h((req) => {
    if (!isAdmin(req.user!)) throw new HttpError(403, 'admins only');
    return { hooks: q.all<HookRow>("SELECT * FROM webhooks WHERE scope = 'global' ORDER BY created_at").map(view), ...meta('global') };
  }),
);

webhooksRouter.post(
  '/admin/webhooks',
  h((req) => {
    if (!isAdmin(req.user!)) throw new HttpError(403, 'admins only');
    const { hook, signing } = save(req, null, 'global', null);
    logChange(req, hook, 'added');
    return { hook: view(hook), signingSecret: signing };
  }),
);

webhooksRouter.get(
  '/incidents/:id/webhooks',
  h((req) => {
    const inc = mustIncident(req.params.id);
    const user = req.user!;
    if (user.is_guest) throw new HttpError(403, 'Guests don’t have access to that');
    const globals = q
      .all<HookRow>("SELECT * FROM webhooks WHERE scope = 'global' AND enabled = 1")
      .filter((g) => sevRank(inc.severity) <= sevRank(g.min_severity));
    return {
      hooks: q.all<HookRow>("SELECT * FROM webhooks WHERE scope = 'room' AND incident_id = ? ORDER BY created_at", inc.id).map(view),
      // Only names and events of the organization-wide ones; their settings are for admins.
      global: globals.map((g) => ({ id: g.id, name: g.name, kindLabel: KINDS[g.kind].label, events: JSON.parse(g.events) as string[], detail: g.detail })),
      manageBlock: roomBlock(user, inc.id),
      postBlock: postBlock(user, inc.id),
      ...meta('room'),
    };
  }),
);

webhooksRouter.post(
  '/incidents/:id/webhooks',
  h((req) => {
    const inc = mustIncident(req.params.id);
    const why = roomBlock(req.user!, inc.id);
    if (why) throw new HttpError(403, why);
    const { hook, signing } = save(req, null, 'room', inc.id);
    logChange(req, hook, 'added');
    return { hook: view(hook), signingSecret: signing };
  }),
);

webhooksRouter.patch(
  '/webhooks/:id',
  h((req) => {
    const existing = mustHookFor(req);
    const { hook, signing, urlChanged } = save(req, existing, existing.scope, existing.incident_id);
    logChange(req, hook, urlChanged ? 'changed (with a new URL)' : 'changed');
    return { hook: view(hook), signingSecret: signing };
  }),
);

webhooksRouter.delete(
  '/webhooks/:id',
  h((req) => {
    const hk = mustHookFor(req);
    q.run('DELETE FROM webhooks WHERE id = ?', hk.id);
    logChange(req, hk, 'removed');
    return { ok: true };
  }),
);

webhooksRouter.post(
  '/webhooks/:id/test',
  h(async (req) => {
    const hk = mustHookFor(req);
    const inc = hk.incident_id ? mustIncident(hk.incident_id) : null;
    const m: Message = {
      event: 'test',
      incident: inc ? { id: inc.id, key: incidentKey(inc.number), title: hk.detail === 'brief' ? '' : inc.title, severity: inc.severity, status: inc.status, url: `${config.publicUrl}/incidents/${inc.id}` } : null,
      headline: `Test from War Room: “${hk.name}” is connected`,
      text: `${req.user!.display_name} sent this test. Incident updates will appear here.`,
      actor: req.user!.display_name,
      agent: null,
      color: '#1fa5a0',
      at: now(),
    };
    const r = await deliver(hk, m);
    return { ok: r.ok, error: r.error, hook: view(getHook(hk.id)!) };
  }),
);

webhooksRouter.post(
  '/incidents/:id/webhooks/post',
  h((req) => {
    const inc = mustIncident(req.params.id);
    const why = postBlock(req.user!, inc.id);
    if (why) throw new HttpError(403, why);
    const text = str(req.body?.text, 3000);
    if (!text) throw new HttpError(400, 'Write the update first');
    const only = Array.isArray(req.body?.hookIds) ? req.body.hookIds.map(String) : undefined;
    const hooks = send('update.posted', inc.id, text, req.user!.id, null, only);
    if (!hooks.length) throw new HttpError(400, 'No webhook takes updates from this war room. Add one, or tick “Updates posted from the war room” on an existing one.');
    addTimeline(inc.id, req.user!.id, 'webhook', `${req.user!.display_name} posted an update to ${hooks.map((x) => `${KINDS[x.kind].label} “${x.name}”`).join(', ')}: ${text}`);
    return { sentTo: hooks.map((x) => x.name) };
  }),
);
