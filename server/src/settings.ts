import { X509Certificate, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Router } from 'express';
import nodemailer from 'nodemailer';
import * as oidc from 'openid-client';
import { RoomServiceClient } from 'livekit-server-sdk';
import { config, envDefaults } from './config.js';
import { db, now, q } from './db.js';
import { decryptSecret, encryptSecret } from './integrations/secrets.js';
import { isAdmin, logAdminAction } from './users.js';

/**
 * Server settings, edited in Admin → Settings and stored in the database.
 *
 * Each value comes from, in order: what an admin saved here, then the environment (for installs
 * that already use one), then a built-in default. Secrets are encrypted at rest and never sent
 * back to the browser. Saving applies the change at once; there's no restart.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);
`);

export type SectionId = 'general' | 'incidents' | 'okta' | 'entra' | 'scim' | 'email' | 'voice' | 'webhooks' | 'agents';
type Kind = 'string' | 'url' | 'number' | 'bool' | 'enum' | 'list' | 'text' | 'secret';

interface Field {
  key: string;
  section: SectionId;
  kind: Kind;
  label: string;
  help?: string;
  placeholder?: string;
  env?: string[];
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  /** Only shown when another field in the section has one of these values. */
  showIf?: { key: string; in: string[] };
  /** Read the starting value (environment or default) from the env-derived config. */
  base: () => unknown;
  /** Put the value into the live config. */
  apply: (v: any) => void;
  /** URL schemes allowed for kind 'url'. */
  schemes?: string[];
  readOnly?: () => string | null;
}

const LIVEKIT_KEY_FILE = process.env.LIVEKIT_KEY_FILE ?? '';
const bundledLiveKit = () => Boolean(LIVEKIT_KEY_FILE);

const smtpTlsBase = () => (envDefaults.smtp.secure ? 'implicit' : envDefaults.smtp.allowPlain ? 'none' : 'starttls');

export const FIELDS: Field[] = [
  // ---- General
  {
    key: 'publicUrl', section: 'general', kind: 'url', schemes: ['https:', 'http:'], env: ['PUBLIC_URL'],
    label: 'Public address',
    help: 'The address people use to reach War Room. Sign-in callbacks, guest links and SCIM use it.',
    placeholder: 'https://warroom.example.com',
    base: () => envDefaults.publicUrl, apply: (v) => (config.publicUrl = String(v).replace(/\/+$/, '')),
  },
  {
    key: 'sessionHours', section: 'general', kind: 'number', min: 1, max: 168, env: ['SESSION_HOURS'],
    label: 'Sign-in lasts (hours)', help: 'How long before people have to sign in again.',
    base: () => envDefaults.sessionHours, apply: (v) => (config.sessionHours = v),
  },
  {
    key: 'bootstrapAdmins', section: 'general', kind: 'list', env: ['BOOTSTRAP_ADMINS'],
    label: 'Make admin on sign-in',
    help: 'Usernames or emails that become admins the next time they sign in. Useful before those people have an account.',
    placeholder: 'alex@company.com',
    base: () => envDefaults.bootstrapAdmins, apply: (v) => (config.bootstrapAdmins = (v as string[]).map((s) => s.toLowerCase())),
  },
  {
    key: 'emailLogin', section: 'general', kind: 'bool', env: ['EMAIL_LOGIN'],
    label: 'Sign in with an emailed code',
    help: 'People with a War Room account that isn’t linked to Okta or Entra (for example responders invited by email) sign in with a one-time code sent to their email. Needs email set up.',
    base: () => envDefaults.emailLogin, apply: (v) => (config.emailLogin = Boolean(v)),
  },
  {
    key: 'files.maxMb', section: 'general', kind: 'number', min: 1, max: 4096, env: ['MAX_UPLOAD_MB'],
    label: 'Largest file upload (MB)', help: 'Screenshots, logs and evidence attached in a war room. Files are stored in the data directory.',
    base: () => envDefaults.files.maxMb, apply: (v) => (config.files.maxMb = v),
  },
  {
    key: 'devAuth', section: 'general', kind: 'bool', env: ['DEV_AUTH'],
    label: 'Development sign-in (name and email, no password)',
    help: 'For trying War Room locally. Never available in production.',
    base: () => envDefaults.devAuth, apply: (v) => (config.devAuth = Boolean(v) && !config.production),
    readOnly: () => (config.production ? 'Always off in production.' : null),
  },

  // ---- Incidents: status update cadence for the dashboard
  ...(['SEV1', 'SEV2', 'SEV3', 'SEV4'] as const).map((sev): Field => ({
    key: `comms.${sev}`, section: 'incidents', kind: 'number', min: 0, max: 1440, env: [`COMMS_${sev}_MINUTES`],
    label: `${sev}: status update every (minutes)`,
    help: sev === 'SEV1' ? 'Measured from the last update to executives in the Comms Log (or any update if there is no executive audience). 0 = no expectation.' : undefined,
    base: () => envDefaults.comms[sev], apply: (v) => (config.comms[sev] = v),
  })),

  // ---- Okta
  {
    key: 'okta.issuer', section: 'okta', kind: 'url', schemes: ['https:'], env: ['OIDC_ISSUER'],
    label: 'Issuer URL', placeholder: 'https://your-org.okta.com/oauth2/default',
    help: 'Your Okta authorization server. Leave empty to turn Okta sign-in off.',
    base: () => envDefaults.oidc.issuer, apply: (v) => (config.oidc.issuer = v),
  },
  { key: 'okta.clientId', section: 'okta', kind: 'string', env: ['OIDC_CLIENT_ID'], label: 'Client ID', base: () => envDefaults.oidc.clientId, apply: (v) => (config.oidc.clientId = v) },
  { key: 'okta.clientSecret', section: 'okta', kind: 'secret', env: ['OIDC_CLIENT_SECRET'], label: 'Client secret', base: () => envDefaults.oidc.clientSecret, apply: (v) => (config.oidc.clientSecret = v) },
  { key: 'okta.scopes', section: 'okta', kind: 'string', env: ['OIDC_SCOPES'], label: 'Scopes', base: () => envDefaults.oidc.scopes, apply: (v) => (config.oidc.scopes = v || 'openid profile email groups') },
  {
    key: 'okta.adminGroup', section: 'okta', kind: 'string', env: ['OIDC_ADMIN_GROUP'],
    label: 'Admin group', placeholder: 'WarRoom-Admins', help: 'Members of this Okta group are War Room admins.',
    base: () => envDefaults.oidc.adminGroup, apply: (v) => (config.oidc.adminGroup = v),
  },
  {
    key: 'okta.jit', section: 'okta', kind: 'bool', env: ['OIDC_JIT_PROVISIONING'],
    label: 'Create accounts on first sign-in', help: 'Leave off when Okta provisions people over SCIM.',
    base: () => envDefaults.oidc.jitProvisioning, apply: (v) => (config.oidc.jitProvisioning = Boolean(v)),
  },

  // ---- Microsoft Entra ID
  {
    key: 'entra.tenantId', section: 'entra', kind: 'string', env: ['ENTRA_TENANT_ID'],
    label: 'Tenant ID', placeholder: '00000000-0000-0000-0000-000000000000', help: 'Directory (tenant) ID. Leave empty to turn Microsoft sign-in off.',
    base: () => envDefaults.entra.tenantId, apply: (v) => (config.entra.tenantId = v),
  },
  {
    key: 'entra.protocol', section: 'entra', kind: 'enum', env: ['ENTRA_PROTOCOL'], label: 'Protocol',
    options: [{ value: 'oidc', label: 'OpenID Connect (recommended)' }, { value: 'saml', label: 'SAML 2.0' }],
    base: () => envDefaults.entra.protocol, apply: (v) => (config.entra.protocol = v),
  },
  { key: 'entra.clientId', section: 'entra', kind: 'string', env: ['ENTRA_CLIENT_ID'], label: 'Application (client) ID', showIf: { key: 'entra.protocol', in: ['oidc'] }, base: () => envDefaults.entra.clientId, apply: (v) => (config.entra.clientId = v) },
  { key: 'entra.clientSecret', section: 'entra', kind: 'secret', env: ['ENTRA_CLIENT_SECRET'], label: 'Client secret', showIf: { key: 'entra.protocol', in: ['oidc'] }, base: () => envDefaults.entra.clientSecret, apply: (v) => (config.entra.clientSecret = v) },
  { key: 'entra.scopes', section: 'entra', kind: 'string', env: ['ENTRA_SCOPES'], label: 'Scopes', showIf: { key: 'entra.protocol', in: ['oidc'] }, base: () => envDefaults.entra.scopes, apply: (v) => (config.entra.scopes = v || 'openid profile email') },
  {
    key: 'entra.samlCert', section: 'entra', kind: 'text', env: ['ENTRA_SAML_CERT', 'ENTRA_SAML_CERT_FILE'], showIf: { key: 'entra.protocol', in: ['saml'] },
    label: 'Token-signing certificate', help: 'Paste the certificate from Entra (Certificate (Base64) download, or PEM).',
    placeholder: '-----BEGIN CERTIFICATE-----',
    base: () => envDefaults.entra.samlCert, apply: (v) => (config.entra.samlCert = v),
  },
  {
    key: 'entra.samlLoginUrl', section: 'entra', kind: 'url', schemes: ['https:'], env: ['ENTRA_SAML_LOGIN_URL'], showIf: { key: 'entra.protocol', in: ['saml'] },
    label: 'Login URL (optional)', help: 'Leave empty to use the standard Entra address for your tenant.',
    base: () => envDefaults.entra.samlLoginUrl, apply: (v) => (config.entra.samlLoginUrl = v),
  },
  {
    key: 'entra.samlEntityId', section: 'entra', kind: 'string', env: ['ENTRA_SAML_ENTITY_ID'], showIf: { key: 'entra.protocol', in: ['saml'] },
    label: 'Identifier (Entity ID, optional)', help: 'Leave empty to use this server’s metadata address.',
    base: () => (process.env.ENTRA_SAML_ENTITY_ID ? envDefaults.entra.samlEntityId : ''), apply: (v) => (config.entra.samlEntityId = v || `${config.publicUrl}/auth/saml/metadata`),
  },
  {
    key: 'entra.adminGroup', section: 'entra', kind: 'string', env: ['ENTRA_ADMIN_GROUP'],
    label: 'Admin group or app role', help: 'Group object ID or app role value whose members are War Room admins.',
    base: () => envDefaults.entra.adminGroup, apply: (v) => (config.entra.adminGroup = v),
  },
  {
    key: 'entra.jit', section: 'entra', kind: 'bool', env: ['ENTRA_JIT_PROVISIONING'],
    label: 'Create accounts on first sign-in', help: 'Leave off when Entra provisions people over SCIM.',
    base: () => envDefaults.entra.jitProvisioning, apply: (v) => (config.entra.jitProvisioning = Boolean(v)),
  },

  // ---- SCIM
  {
    key: 'scim.token', section: 'scim', kind: 'secret', env: ['SCIM_TOKEN'],
    label: 'Bearer token', help: 'Generated here and shown once. Paste it into your identity provider’s provisioning settings.',
    base: () => envDefaults.scim.token, apply: (v) => (config.scim.token = v),
  },

  // ---- Email
  { key: 'smtp.host', section: 'email', kind: 'string', env: ['SMTP_HOST'], label: 'SMTP server', placeholder: 'smtp.office365.com', help: 'Leave empty to turn email off.', base: () => envDefaults.smtp.host, apply: (v) => (config.smtp.host = v) },
  { key: 'smtp.port', section: 'email', kind: 'number', min: 1, max: 65535, env: ['SMTP_PORT'], label: 'Port', base: () => envDefaults.smtp.port, apply: (v) => (config.smtp.port = v) },
  {
    key: 'smtp.tls', section: 'email', kind: 'enum', env: ['SMTP_SECURE', 'SMTP_ALLOW_PLAIN'], label: 'Encryption',
    options: [
      { value: 'starttls', label: 'STARTTLS, required (port 587)' },
      { value: 'implicit', label: 'TLS from the start (port 465)' },
      { value: 'none', label: 'None (local test servers only)' },
    ],
    base: smtpTlsBase,
    apply: (v) => {
      config.smtp.secure = v === 'implicit';
      config.smtp.allowPlain = v === 'none' && !config.production;
    },
  },
  { key: 'smtp.user', section: 'email', kind: 'string', env: ['SMTP_USER'], label: 'Username', base: () => envDefaults.smtp.user, apply: (v) => (config.smtp.user = v) },
  { key: 'smtp.pass', section: 'email', kind: 'secret', env: ['SMTP_PASS'], label: 'Password', base: () => envDefaults.smtp.pass, apply: (v) => (config.smtp.pass = v) },
  { key: 'smtp.from', section: 'email', kind: 'string', env: ['SMTP_FROM'], label: 'From address', placeholder: 'War Room <warroom@company.com>', base: () => envDefaults.smtp.from, apply: (v) => (config.smtp.from = v) },
  {
    key: 'guestRequireEmail', section: 'email', kind: 'bool', env: ['GUEST_REQUIRE_EMAIL'],
    label: 'Guests must verify an emailed code', help: 'When email is set up, every guest invite needs an email address, and the guest enters a code sent there to join.',
    base: () => envDefaults.guestRequireEmail, apply: (v) => (config.guestRequireEmail = Boolean(v)),
  },

  // ---- Voice (LiveKit)
  {
    key: 'livekit.url', section: 'voice', kind: 'url', schemes: ['wss:', 'ws:'], env: ['LIVEKIT_URL'],
    label: 'LiveKit address for browsers', placeholder: 'wss://livekit.example.com',
    base: () => envDefaults.livekit.url, apply: (v) => (config.livekit.url = v),
  },
  {
    key: 'livekit.apiUrl', section: 'voice', kind: 'url', schemes: ['https:', 'http:'], env: ['LIVEKIT_API_URL'],
    label: 'LiveKit address for the server (optional)', help: 'Used to mute, move and remove people. Leave empty to use the browser address.',
    base: () => (process.env.LIVEKIT_API_URL ? envDefaults.livekit.apiUrl : ''),
    apply: (v) => (config.livekit.apiUrl = v || config.livekit.url.replace(/^ws/, 'http')),
  },
  {
    key: 'livekit.apiKey', section: 'voice', kind: 'string', env: ['LIVEKIT_API_KEY'], label: 'API key',
    base: () => envDefaults.livekit.apiKey, apply: (v) => (config.livekit.apiKey = v),
    readOnly: () => (bundledLiveKit() ? 'Managed automatically for the LiveKit server that ships with War Room.' : null),
  },
  {
    key: 'livekit.apiSecret', section: 'voice', kind: 'secret', env: ['LIVEKIT_API_SECRET'], label: 'API secret',
    base: () => envDefaults.livekit.apiSecret, apply: (v) => (config.livekit.apiSecret = v),
    readOnly: () => (bundledLiveKit() ? 'Managed automatically for the LiveKit server that ships with War Room.' : null),
  },

  // ---- Webhooks
  {
    key: 'webhooks.room', section: 'webhooks', kind: 'bool', env: ['WEBHOOKS_ROOM'],
    label: 'Room webhooks',
    help: 'The Incident Commander and room admins can add webhooks for their own war room (for example a channel for that incident). Off stops room webhooks from sending.',
    base: () => envDefaults.webhooks.room, apply: (v) => (config.webhooks.room = Boolean(v)),
  },
  {
    key: 'webhooks.allowPrivate', section: 'webhooks', kind: 'bool', env: ['WEBHOOKS_ALLOW_PRIVATE'],
    label: 'Allow internal addresses',
    help: 'Let webhooks post to http and to internal network addresses, for a self-hosted Mattermost or chat server inside your network. Leave off otherwise: it stops a webhook URL from reaching internal systems.',
    base: () => envDefaults.webhooks.allowPrivate, apply: (v) => (config.webhooks.allowPrivate = Boolean(v)),
  },

  // ---- AI agents (MCP)
  {
    key: 'agents.enabled', section: 'agents', kind: 'bool', env: ['MCP_ENABLED'],
    label: 'Allow AI agents',
    help: 'Agents connect to the MCP address below and act for the person who approved them, never with more access than that person. They can’t change roles, invite people or moderate. Turning this off disconnects every agent at once.',
    base: () => envDefaults.agents.enabled, apply: (v) => (config.agents.enabled = Boolean(v)),
  },
  {
    key: 'agents.roomKeys', section: 'agents', kind: 'bool', env: ['MCP_ROOM_KEYS'],
    label: 'Room agent keys',
    help: 'The Incident Commander and room admins can issue a key that gives an agent access to one war room for a few hours. Simplest for command-line agents; the key is a secret, so keep lifetimes short.',
    base: () => envDefaults.agents.roomKeys, apply: (v) => (config.agents.roomKeys = Boolean(v)),
  },
  {
    key: 'agents.selfKeys', section: 'agents', kind: 'enum', env: ['MCP_SELF_KEYS'],
    label: 'Who can create a room agent key',
    help: 'Each person creates their own key in the war room; it acts as them, with their access. Guests also need the Incident Commander or a room admin to allow it in their guest access.',
    options: [
      { value: 'everyone', label: 'Responders, and guests the room allows' },
      { value: 'responders', label: 'Responders only' },
      { value: 'controllers', label: 'Only the Incident Commander, room admins and admins' },
    ],
    showIf: { key: 'agents.roomKeys', in: ['true'] },
    base: () => envDefaults.agents.selfKeys, apply: (v) => (config.agents.selfKeys = v),
  },
  {
    key: 'agents.grantDays', section: 'agents', kind: 'number', min: 1, max: 90, env: ['MCP_GRANT_DAYS'],
    label: 'Agent sign-in lasts (days)',
    help: 'How long an agent connected through sign-in (OAuth) keeps access before the person approves it again.',
    base: () => envDefaults.agents.grantDays, apply: (v) => (config.agents.grantDays = v),
  },
  {
    key: 'agents.dynamicClients', section: 'agents', kind: 'bool', env: ['MCP_DYNAMIC_CLIENTS'],
    label: 'Let agent apps register themselves',
    help: 'MCP clients such as Claude register automatically (OAuth dynamic client registration) before asking someone to approve them. Turn off to allow only room keys.',
    base: () => envDefaults.agents.dynamicClients, apply: (v) => (config.agents.dynamicClients = Boolean(v)),
  },
];

const byKey = new Map(FIELDS.map((f) => [f.key, f]));

export const SECTIONS: { id: SectionId; label: string; description: string }[] = [
  { id: 'general', label: 'General', description: 'Address, sign-in length and admins.' },
  { id: 'incidents', label: 'Incidents', description: 'How often status updates are expected, by severity. The war room dashboard flags an update as overdue.' },
  { id: 'okta', label: 'Okta', description: 'Sign in with Okta over OpenID Connect.' },
  { id: 'entra', label: 'Microsoft Entra ID', description: 'Sign in with Microsoft over OpenID Connect or SAML.' },
  { id: 'scim', label: 'Provisioning (SCIM)', description: 'Let Okta or Entra create, update and deactivate accounts.' },
  { id: 'email', label: 'Email', description: 'SMTP for guest sign-in codes.' },
  { id: 'voice', label: 'Voice (LiveKit)', description: 'The media server for voice rooms and screen share.' },
  { id: 'webhooks', label: 'Webhooks', description: 'Post incident updates to Slack, Discord, Mattermost, Teams or any JSON endpoint. Global webhooks are under Admin → Webhooks.' },
  { id: 'agents', label: 'AI agents (MCP)', description: 'Let AI agents such as Claude read and work in war rooms, on behalf of a person.' },
];

// ---------- storage ----------

type Stored = Map<string, unknown>;
function loadStored(): Stored {
  const out: Stored = new Map();
  for (const r of q.all<{ key: string; value: string }>('SELECT key, value FROM settings')) {
    const f = byKey.get(r.key);
    if (!f) continue;
    try {
      out.set(r.key, f.kind === 'secret' ? decryptSecret(r.value).v : JSON.parse(r.value));
    } catch {
      console.error(`[settings] could not read saved value for ${r.key}; using the default`);
    }
  }
  return out;
}

function writeStored(key: string, value: unknown, by: string | null) {
  const f = byKey.get(key)!;
  const raw = f.kind === 'secret' ? encryptSecret({ v: String(value) }) : JSON.stringify(value);
  q.run(
    'INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at',
    key, raw, by, now(),
  );
}
const deleteStored = (key: string) => q.run('DELETE FROM settings WHERE key = ?', key);

const listeners: (() => void)[] = [];
/** Modules that cache clients built from settings (OIDC, SAML, SMTP) reset them here. */
export function onSettingsChanged(fn: () => void) {
  listeners.push(fn);
}

let stored: Stored = new Map();

/** Load saved settings into the live config. Called at startup and after every save. */
export function applySettings() {
  stored = loadStored();
  // publicUrl first: other defaults are built from it.
  for (const f of [byKey.get('publicUrl')!, ...FIELDS.filter((x) => x.key !== 'publicUrl')]) {
    f.apply(stored.has(f.key) ? stored.get(f.key) : f.base());
  }
  config.oidc.redirectUri = `${config.publicUrl}/auth/callback`;
  config.entra.samlAcsUrl = `${config.publicUrl}/auth/saml/acs`;
  ensureBundledLiveKitKeys();
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      console.error('[settings] listener failed', err);
    }
  }
}

/**
 * With the LiveKit server from docker-compose, War Room makes the API key pair itself and writes it
 * to a file the LiveKit container reads, so nobody has to copy keys between the two.
 */
function ensureBundledLiveKitKeys() {
  if (!bundledLiveKit()) return;
  if (!stored.has('livekit.apiKey') || !stored.has('livekit.apiSecret')) {
    writeStored('livekit.apiKey', `wr_${randomBytes(6).toString('hex')}`, null);
    writeStored('livekit.apiSecret', randomBytes(32).toString('base64url'), null);
    stored = loadStored();
    config.livekit.apiKey = String(stored.get('livekit.apiKey'));
    config.livekit.apiSecret = String(stored.get('livekit.apiSecret'));
  }
  try {
    mkdirSync(dirname(LIVEKIT_KEY_FILE), { recursive: true });
    writeFileSync(LIVEKIT_KEY_FILE, `${config.livekit.apiKey}: ${config.livekit.apiSecret}\n`, { mode: 0o600 });
    chmodSync(LIVEKIT_KEY_FILE, 0o600);
  } catch (err) {
    console.error(`[settings] could not write the LiveKit key file ${LIVEKIT_KEY_FILE}`, err);
  }
}

/** Save a setting from code (setup page). */
export function saveSetting(key: string, value: unknown, by: string | null) {
  writeStored(key, value, by);
  applySettings();
}
export const isSaved = (key: string) => stored.has(key);

// ---------- validation ----------

class SettingError extends Error {}

function clean(f: Field, raw: unknown): unknown {
  switch (f.kind) {
    case 'bool':
      if (typeof raw !== 'boolean') throw new SettingError(`${f.label}: must be on or off`);
      return raw;
    case 'number': {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < (f.min ?? -Infinity) || n > (f.max ?? Infinity)) throw new SettingError(`${f.label}: enter a whole number from ${f.min} to ${f.max}`);
      return n;
    }
    case 'enum':
      if (!f.options!.some((o) => o.value === raw)) throw new SettingError(`${f.label}: pick one of the options`);
      return raw;
    case 'list': {
      const arr = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,;]+/);
      const out = [...new Set(arr.map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
      if (out.length > 200 || out.some((s) => s.length > 254)) throw new SettingError(`${f.label}: too long`);
      return out;
    }
    case 'url': {
      const s = String(raw ?? '').trim();
      if (!s) return '';
      let u: URL;
      try {
        u = new URL(s);
      } catch {
        throw new SettingError(`${f.label}: not a valid address`);
      }
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
      const schemes = f.schemes ?? ['https:'];
      // Plain http/ws is fine for local testing, and for internal addresses the server alone uses.
      const plainOk = !config.production || local || f.key === 'livekit.apiUrl' || f.key === 'publicUrl';
      const ok = schemes.includes(u.protocol) && (plainOk || u.protocol === 'https:' || u.protocol === 'wss:');
      if (!ok) throw new SettingError(`${f.label}: must start with ${schemes.filter((x) => plainOk || x.endsWith('s:')).join(' or ')}//`);
      if (u.username || u.password) throw new SettingError(`${f.label}: don’t put credentials in the address`);
      return u.href.replace(/\/+$/, '');
    }
    case 'text':
      if (String(raw ?? '').length > 20_000) throw new SettingError(`${f.label}: too long`);
      return String(raw ?? '').trim();
    default: {
      const s = String(raw ?? '').trim();
      if (s.length > 2000) throw new SettingError(`${f.label}: too long`);
      return s;
    }
  }
}

// ---------- read for the admin page ----------

function sourceOf(f: Field): 'saved' | 'environment' | 'default' {
  if (stored.has(f.key)) return 'saved';
  if (f.env?.some((e) => process.env[e] !== undefined && process.env[e] !== '')) return 'environment';
  return 'default';
}

const current = (f: Field) => (stored.has(f.key) ? stored.get(f.key) : f.base());

function describeField(f: Field) {
  const v = current(f);
  return {
    key: f.key,
    kind: f.kind,
    label: f.label,
    help: f.help,
    placeholder: f.placeholder,
    options: f.options,
    min: f.min,
    max: f.max,
    showIf: f.showIf,
    source: sourceOf(f),
    readOnly: f.readOnly?.() ?? null,
    // Secrets never leave the server; the page only learns whether one is set.
    ...(f.kind === 'secret' ? { isSet: Boolean(v) } : { value: v }),
  };
}

function sectionStatus(id: SectionId) {
  switch (id) {
    case 'okta':
      return config.oidc.issuer && config.oidc.clientId && config.oidc.clientSecret ? 'on' : config.oidc.issuer || config.oidc.clientId ? 'incomplete' : 'off';
    case 'entra': {
      const e = config.entra;
      const done = e.tenantId && (e.protocol === 'saml' ? e.samlCert : e.clientId && e.clientSecret);
      return done ? 'on' : e.tenantId ? 'incomplete' : 'off';
    }
    case 'scim':
      return config.scim.token ? 'on' : 'off';
    case 'email':
      return config.smtp.host && config.smtp.from ? 'on' : config.smtp.host ? 'incomplete' : 'off';
    case 'voice':
      return config.livekit.url && config.livekit.apiKey && config.livekit.apiSecret ? 'on' : 'incomplete';
    case 'agents':
      return config.agents.enabled ? 'on' : 'off';
    case 'webhooks':
      return 'on';
    default:
      return 'on';
  }
}

function sectionInfo(id: SectionId) {
  const base = config.publicUrl;
  switch (id) {
    case 'okta':
      return [{ label: 'Sign-in redirect URI', value: `${base}/auth/callback` }, { label: 'Sign-out redirect URI', value: `${base}/login` }];
    case 'entra': {
      // Both sets; the page shows the one for the protocol picked in the form.
      const saml = { key: 'entra.protocol', in: ['saml'] };
      return [
        { label: 'Redirect URI (Web)', value: `${base}/auth/callback`, showIf: { key: 'entra.protocol', in: ['oidc'] } },
        { label: 'Identifier (Entity ID)', value: config.entra.samlEntityId, showIf: saml },
        { label: 'Reply URL (ACS)', value: config.entra.samlAcsUrl, showIf: saml },
        { label: 'Metadata', value: `${base}/auth/saml/metadata`, showIf: saml },
      ];
    }
    case 'scim':
      return [{ label: 'SCIM base URL', value: `${base}/scim/v2` }];
    case 'agents':
      return [{ label: 'MCP server address', value: `${base}/mcp` }];
    default:
      return [];
  }
}

export function settingsView() {
  return {
    production: config.production,
    bundledLiveKit: bundledLiveKit(),
    sections: SECTIONS.map((s) => ({
      ...s,
      status: sectionStatus(s.id),
      info: sectionInfo(s.id),
      testable: ['okta', 'entra', 'email', 'voice'].includes(s.id),
      fields: FIELDS.filter((f) => f.section === s.id).map(describeField),
    })),
  };
}

// ---------- tests with unsaved values ----------

/** The values a section would have after a save: current values with the draft on top. */
function draftValues(section: SectionId, values: Record<string, unknown>, clear: string[]) {
  const out: Record<string, any> = {};
  for (const f of FIELDS.filter((x) => x.section === section)) {
    if (clear.includes(f.key)) out[f.key] = '';
    else if (f.key in values && !(f.kind === 'secret' && values[f.key] === '')) out[f.key] = clean(f, values[f.key]);
    else out[f.key] = current(f);
  }
  return out;
}

const errText = (err: unknown) => {
  const e = err as { message?: string; cause?: { message?: string; code?: string } };
  return [e?.message, e?.cause?.code ?? e?.cause?.message].filter(Boolean).join(': ') || String(err);
};

async function runTest(section: SectionId, d: Record<string, any>): Promise<{ ok: boolean; message: string }> {
  try {
    switch (section) {
      case 'okta': {
        if (!d['okta.issuer'] || !d['okta.clientId']) return { ok: false, message: 'Enter the issuer URL and client ID first.' };
        const c = await oidc.discovery(new URL(d['okta.issuer']), d['okta.clientId'], d['okta.clientSecret'] || undefined);
        const m = c.serverMetadata();
        return { ok: true, message: `Reached Okta. Issuer ${m.issuer}${d['okta.clientSecret'] ? '' : '. Client secret still needed.'}` };
      }
      case 'entra': {
        const tenant = String(d['entra.tenantId'] ?? '').trim();
        if (!/^[0-9a-f-]{36}$/i.test(tenant) && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(tenant)) return { ok: false, message: 'Enter the tenant ID (a GUID) first.' };
        if (d['entra.protocol'] === 'saml') {
          const pem = String(d['entra.samlCert'] ?? '');
          if (!pem) return { ok: false, message: 'Paste the token-signing certificate.' };
          const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [
            `-----BEGIN CERTIFICATE-----\n${pem.replace(/\s+/g, '').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`,
          ];
          const certs = blocks.map((b) => new X509Certificate(b));
          const soonest = certs.map((c) => new Date(c.validTo)).sort((a, b) => +a - +b)[0];
          if (soonest < new Date()) return { ok: false, message: `The certificate expired on ${soonest.toISOString().slice(0, 10)}.` };
          return { ok: true, message: `Certificate looks good: ${certs[0].subject.replace(/\n/g, ', ')}, valid until ${soonest.toISOString().slice(0, 10)}.` };
        }
        if (!d['entra.clientId']) return { ok: false, message: 'Enter the application (client) ID first.' };
        const c = await oidc.discovery(new URL(`https://login.microsoftonline.com/${tenant}/v2.0`), d['entra.clientId'], d['entra.clientSecret'] || undefined);
        return { ok: true, message: `Reached your Microsoft tenant (${c.serverMetadata().issuer})${d['entra.clientSecret'] ? '' : '. Client secret still needed.'}` };
      }
      case 'email': {
        if (!d['smtp.host']) return { ok: false, message: 'Enter the SMTP server first.' };
        const t = nodemailer.createTransport({
          host: d['smtp.host'],
          port: d['smtp.port'],
          secure: d['smtp.tls'] === 'implicit',
          requireTLS: d['smtp.tls'] === 'starttls',
          ignoreTLS: d['smtp.tls'] === 'none',
          auth: d['smtp.user'] ? { user: d['smtp.user'], pass: d['smtp.pass'] } : undefined,
          connectionTimeout: 10_000,
          greetingTimeout: 8_000,
          socketTimeout: 12_000,
        });
        await t.verify();
        t.close();
        return { ok: true, message: `Connected to ${d['smtp.host']}:${d['smtp.port']}${d['smtp.user'] ? ' and signed in' : ''}.` };
      }
      case 'voice': {
        const apiUrl = d['livekit.apiUrl'] || String(d['livekit.url']).replace(/^ws/, 'http');
        const rooms = await new RoomServiceClient(apiUrl, d['livekit.apiKey'], d['livekit.apiSecret']).listRooms();
        return { ok: true, message: `Connected to LiveKit at ${new URL(apiUrl).host}. ${rooms.length} active room${rooms.length === 1 ? '' : 's'}.` };
      }
      default:
        return { ok: false, message: 'Nothing to test here.' };
    }
  } catch (err) {
    if (err instanceof SettingError) return { ok: false, message: err.message };
    return { ok: false, message: errText(err) };
  }
}

// ---------- routes (mounted under /api, after requireAuth) ----------

export const settingsRouter = Router();

settingsRouter.use('/admin/settings', (req, res, next) => {
  if (!req.user || !isAdmin(req.user)) return res.status(403).json({ error: 'admins only' });
  next();
});

settingsRouter.get('/admin/settings', (_req, res) => res.json(settingsView()));

const isSection = (s: string): s is SectionId => SECTIONS.some((x) => x.id === s);

/** Save one section. Body: { values: {key: value}, clear: [secret keys to remove] }. An empty secret keeps the saved one. */
settingsRouter.put('/admin/settings/:section', (req, res) => {
  const section = req.params.section;
  if (!isSection(section)) return res.status(404).json({ error: 'unknown section' });
  const values = (req.body?.values ?? {}) as Record<string, unknown>;
  const clear = Array.isArray(req.body?.clear) ? (req.body.clear as string[]) : [];
  const changes: { key: string; value: unknown }[] = [];
  const removes: string[] = [];
  try {
    for (const [key, raw] of Object.entries(values)) {
      const f = byKey.get(key);
      if (!f || f.section !== section) throw new SettingError(`Unknown setting ${key}`);
      if (f.readOnly?.()) continue;
      if (f.kind === 'secret' && (raw === '' || raw == null)) continue;
      const v = clean(f, raw);
      if (JSON.stringify(v) !== JSON.stringify(current(f)) || f.kind === 'secret') changes.push({ key, value: v });
    }
    for (const key of clear) {
      const f = byKey.get(key);
      if (!f || f.section !== section || f.readOnly?.()) throw new SettingError(`Can’t clear ${key}`);
      removes.push(key);
    }
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'invalid' });
  }

  db.exec('BEGIN');
  try {
    for (const c of changes) writeStored(c.key, c.value, req.user!.id);
    // Clearing a secret saves it as empty, so an environment value can't quietly come back.
    for (const key of removes) {
      if (byKey.get(key)!.kind === 'secret') writeStored(key, '', req.user!.id);
      else deleteStored(key);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  applySettings();
  const names = [...changes.map((c) => c.key), ...removes.map((k) => `${k} (cleared)`)];
  if (names.length) {
    // Values of secrets never go in the audit log; other values do, so changes are traceable.
    const detail = [...changes.map((c) => (byKey.get(c.key)!.kind === 'secret' ? `${c.key}=(new secret)` : `${c.key}=${JSON.stringify(c.value).slice(0, 200)}`)), ...removes.map((k) => `${k} cleared`)].join('; ');
    logAdminAction(req.user!.id, null, 'settings_changed', `${section}: ${detail}`);
  }
  res.json({ ...settingsView(), saved: names.length });
});

/** Revert a section to the environment/default values by deleting what was saved. */
settingsRouter.post('/admin/settings/:section/reset', (req, res) => {
  const section = req.params.section;
  if (!isSection(section)) return res.status(404).json({ error: 'unknown section' });
  const keys = FIELDS.filter((f) => f.section === section && !f.readOnly?.()).map((f) => f.key);
  for (const k of keys) deleteStored(k);
  applySettings();
  logAdminAction(req.user!.id, null, 'settings_changed', `${section}: reset to defaults`);
  res.json(settingsView());
});

settingsRouter.post('/admin/settings/:section/test', async (req, res) => {
  const section = req.params.section;
  if (!isSection(section)) return res.status(404).json({ error: 'unknown section' });
  let d: Record<string, unknown>;
  try {
    d = draftValues(section, req.body?.values ?? {}, Array.isArray(req.body?.clear) ? req.body.clear : []);
  } catch (err) {
    return res.json({ ok: false, message: err instanceof Error ? err.message : 'invalid' });
  }
  res.json(await runTest(section, d));
});

/** New SCIM token: saved at once and shown this one time. */
settingsRouter.post('/admin/settings/scim/token', (req, res) => {
  const token = `wrscim_${randomBytes(32).toString('base64url')}`;
  writeStored('scim.token', token, req.user!.id);
  applySettings();
  logAdminAction(req.user!.id, null, 'settings_changed', 'scim: new bearer token generated');
  res.json({ token, view: settingsView() });
});
