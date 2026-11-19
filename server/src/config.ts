import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

try {
  process.loadEnvFile();
} catch {
  // no .env file; rely on the real environment
}

const env = process.env;
const bool = (v: string | undefined, d = false) =>
  v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

const production = env.NODE_ENV === 'production';
const publicUrl = (env.PUBLIC_URL ?? 'http://localhost:5173').replace(/\/$/, '');

const dataDir = env.DATA_DIR ?? './data';

/**
 * Server keys live in the data directory, generated on first start, so there is nothing to set by
 * hand. SESSION_SECRET in the environment still wins (for anyone who manages keys externally).
 * The old dev file name is kept so existing installs don't sign everyone out.
 */
function keyFile(name: string, legacy?: string) {
  mkdirSync(dataDir, { recursive: true });
  for (const f of [name, legacy].filter(Boolean) as string[]) {
    const p = join(dataDir, f);
    if (existsSync(p)) return readFileSync(p, 'utf8').trim();
  }
  const v = randomBytes(32).toString('hex');
  writeFileSync(join(dataDir, name), v, { mode: 0o600 });
  return v;
}
const sessionSecret = env.SESSION_SECRET || keyFile('.session-secret', '.dev-session-secret');

export const config = {
  production,
  // `--port N` (used by `npm run dev`) wins over PORT so a dev tool's PORT can't collide with Vite.
  port: Number(process.argv.find((_, i, a) => a[i - 1] === '--port') ?? env.PORT ?? 3000),
  publicUrl,
  dataDir,
  sessionSecret,
  sessionHours: Number(env.SESSION_HOURS ?? 12),
  /** Name/email login with no password. Never enable in production. */
  devAuth: bool(env.DEV_AUTH, !production),
  oidc: {
    issuer: env.OIDC_ISSUER ?? '',
    clientId: env.OIDC_CLIENT_ID ?? '',
    clientSecret: env.OIDC_CLIENT_SECRET ?? '',
    redirectUri: `${publicUrl}/auth/callback`,
    scopes: env.OIDC_SCOPES ?? 'openid profile email groups',
    /** Members of this Okta group (groups claim or SCIM-pushed group) are app admins. */
    adminGroup: env.OIDC_ADMIN_GROUP ?? '',
    /** Create users on first SSO login. Leave off when Okta provisions via SCIM. */
    jitProvisioning: bool(env.OIDC_JIT_PROVISIONING, false),
  },
  /** Microsoft Entra ID, over OIDC (default) or SAML 2.0. */
  entra: {
    protocol: (env.ENTRA_PROTOCOL ?? 'oidc').toLowerCase() === 'saml' ? ('saml' as const) : ('oidc' as const),
    tenantId: env.ENTRA_TENANT_ID ?? '',
    // OIDC
    clientId: env.ENTRA_CLIENT_ID ?? '',
    clientSecret: env.ENTRA_CLIENT_SECRET ?? '',
    scopes: env.ENTRA_SCOPES ?? 'openid profile email',
    // SAML
    samlLoginUrl: env.ENTRA_SAML_LOGIN_URL ?? '',
    /** Entra's token-signing certificate: PEM, or the Base64 download, or a file path via ENTRA_SAML_CERT_FILE. */
    samlCert: env.ENTRA_SAML_CERT_FILE ? readFileSync(env.ENTRA_SAML_CERT_FILE, 'utf8') : (env.ENTRA_SAML_CERT ?? ''),
    samlEntityId: env.ENTRA_SAML_ENTITY_ID ?? `${publicUrl}/auth/saml/metadata`,
    samlAcsUrl: `${publicUrl}/auth/saml/acs`,
    /** Group object ID or app role value whose members are app admins. */
    adminGroup: env.ENTRA_ADMIN_GROUP ?? '',
    jitProvisioning: bool(env.ENTRA_JIT_PROVISIONING, false),
  },
  /** Comma-separated usernames/emails that become admins on sign-in. Use it to seed the first admin. */
  bootstrapAdmins: (env.BOOTSTRAP_ADMINS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  scim: {
    token: env.SCIM_TOKEN ?? '',
  },
  /** Outgoing email (guest sign-in codes). Leave SMTP_HOST empty to disable. */
  smtp: {
    host: env.SMTP_HOST ?? '',
    port: Number(env.SMTP_PORT ?? 587),
    /** true = TLS from the start (port 465). false = STARTTLS upgrade, which is required unless SMTP_ALLOW_PLAIN. */
    secure: bool(env.SMTP_SECURE, Number(env.SMTP_PORT ?? 587) === 465),
    user: env.SMTP_USER ?? '',
    pass: env.SMTP_PASS ?? '',
    from: env.SMTP_FROM ?? '',
    /** Only for local test servers: allow a connection without TLS. */
    allowPlain: bool(env.SMTP_ALLOW_PLAIN, false),
  },
  /** When email is configured, every guest invite needs an email and a code to join (default on). */
  guestRequireEmail: bool(env.GUEST_REQUIRE_EMAIL, true),
  livekit: {
    /** URL browsers use to reach LiveKit (ws:// or wss://). */
    url: env.LIVEKIT_URL ?? 'ws://localhost:7880',
    /** URL the server uses for LiveKit's admin API (mute/remove). Defaults to LIVEKIT_URL over http(s). */
    apiUrl: env.LIVEKIT_API_URL ?? (env.LIVEKIT_URL ?? 'ws://localhost:7880').replace(/^ws/, 'http'),
    apiKey: env.LIVEKIT_API_KEY ?? 'devkey',
    apiSecret: env.LIVEKIT_API_SECRET ?? 'secret',
  },
};

/**
 * Everything above is only a starting point. Settings saved in Admin → Settings (settings.ts) are
 * applied on top of this object at startup and whenever an admin saves, so code reading `config`
 * always sees the current values. Development login can never be turned on in production.
 */
export const envDefaults = structuredClone(config);

export const oidcEnabled =() => Boolean(config.oidc.issuer && config.oidc.clientId);
export const entraEnabled = () =>
  Boolean(
    config.entra.tenantId &&
      (config.entra.protocol === 'saml' ? config.entra.samlCert : config.entra.clientId && config.entra.clientSecret),
  );
export const smtpEnabled = () => Boolean(config.smtp.host && config.smtp.from);
export const ssoEnabled = () => oidcEnabled() || entraEnabled();
