import express, { Router, type Request, type Response, type NextFunction } from 'express';
import * as oidc from 'openid-client';
import { SAML, ValidateInResponseTo, type Profile } from '@node-saml/node-saml';
import { SignJWT, jwtVerify } from 'jose';
import { config } from './config.js';
import { createUser, findUserByLogin, getUser, toPublic, logAdminAction, updateUser, type UserRow } from './users.js';
import { now, q } from './db.js';
import { guestAllowed, guestSessionValid } from './guests.js';
import { onSettingsChanged } from './settings.js';
import { emailCanSend, emailLoginEnabled } from './email-login.js';
import { getProvider, resolveSsoUser, ssoProviders, type ProviderId, type SsoIdentity, type SsoProvider } from './sso.js';

const SESSION_COOKIE = 'wr_session';
const OIDC_TX_COOKIE = 'wr_oidc';
const key = new TextEncoder().encode(config.sessionSecret);

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserRow;
    }
  }
}

const cookieOpts = (maxAgeMs: number) => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: config.publicUrl.startsWith('https://'),
  maxAge: maxAgeMs,
  path: '/',
});

async function sign(payload: Record<string, unknown>, ttlSeconds: number) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(key);
}

async function verify<T>(token: string | undefined): Promise<T | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key);
    return payload as T;
  } catch {
    return null;
  }
}

/** Only same-origin paths; rejects `//host` and `/\host`, which browsers treat as other sites. */
const safeReturnTo = (v: unknown) => (typeof v === 'string' && /^\/(?![/\\])/.test(v) ? v : '/');

/** People listed under Admin → Settings → General → "Make admin on sign-in" become admins when they sign in. */
function applyBootstrapAdmin(user: UserRow): UserRow {
  if (user.is_admin || !config.bootstrapAdmins.length) return user;
  const ids = [user.user_name, user.email].filter(Boolean).map((s) => s!.toLowerCase());
  if (!ids.some((id) => config.bootstrapAdmins.includes(id))) return user;
  const updated = updateUser(user.id, { is_admin: 1 })!;
  logAdminAction(null, user.id, 'admin_granted', 'Listed under "Make admin on sign-in"');
  return updated;
}

export async function startSession(res: Response, user: UserRow) {
  q.run('UPDATE users SET last_login_at = ? WHERE id = ?', now(), user.id);
  const ttl = config.sessionHours * 3600;
  res.cookie(SESSION_COOKIE, await sign({ sub: user.id }, ttl), cookieOpts(ttl * 1000));
}

/** Resolve the signed-in, still-active user from a raw Cookie header (used by Socket.IO too). */
export async function userFromCookieHeader(header: string | undefined): Promise<UserRow | null> {
  if (!header) return null;
  const match = header
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!match) return null;
  return userFromToken(decodeURIComponent(match.slice(SESSION_COOKIE.length + 1)));
}

async function userFromToken(token: string | undefined) {
  const payload = await verify<{ sub: string }>(token);
  if (!payload?.sub) return null;
  const user = getUser(payload.sub);
  if (!user || !user.active || user.deleted) return null;
  if (user.is_guest && !guestSessionValid(user)) return null;
  return user;
}

/** Sign in a guest who just redeemed an invite. Their session never outlives their access. */
export async function startGuestSession(res: Response, user: UserRow, ttlSeconds: number) {
  q.run('UPDATE users SET last_login_at = ? WHERE id = ?', now(), user.id);
  res.cookie(SESSION_COOKIE, await sign({ sub: user.id, guest: true }, ttlSeconds), cookieOpts(ttlSeconds * 1000));
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const user = await userFromToken(req.cookies?.[SESSION_COOKIE]);
  if (!user) return res.status(401).json({ error: 'unauthenticated' });
  // Guests only reach an allowlist of routes inside their one war room.
  if (user.is_guest && !guestAllowed(req, user)) return res.status(403).json({ error: 'Guests don’t have access to that' });
  req.user = user;
  next();
}

function loginRedirect(res: Response, error: string, provider?: ProviderId) {
  res.redirect(`/login?error=${encodeURIComponent(error)}${provider ? `&provider=${provider}` : ''}`);
}

async function finishSso(res: Response, provider: SsoProvider, identity: SsoIdentity, returnTo: string) {
  const result = resolveSsoUser(provider, identity);
  if (typeof result === 'string') {
    console.warn(`[auth] ${provider.id} sign-in refused for ${identity.login ?? identity.subject}: ${result}`);
    return loginRedirect(res, result, provider.id);
  }
  await startSession(res, applyBootstrapAdmin(result));
  res.redirect(safeReturnTo(returnTo));
}

// ---------- OIDC (Okta, Entra) ----------

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const strList = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : []);

function oidcSettings(id: ProviderId) {
  if (id === 'okta') {
    return { issuer: config.oidc.issuer, clientId: config.oidc.clientId, clientSecret: config.oidc.clientSecret, scopes: config.oidc.scopes };
  }
  return {
    // Tenant-specific v2.0 issuer: only accounts from this directory can sign in.
    issuer: `https://login.microsoftonline.com/${config.entra.tenantId}/v2.0`,
    clientId: config.entra.clientId,
    clientSecret: config.entra.clientSecret,
    scopes: config.entra.scopes,
  };
}

const oidcConfigs = new Map<ProviderId, Promise<oidc.Configuration>>();
function getOidcConfig(id: ProviderId) {
  let cfg = oidcConfigs.get(id);
  if (!cfg) {
    const s = oidcSettings(id);
    cfg = oidc.discovery(new URL(s.issuer), s.clientId, s.clientSecret).catch((err) => {
      oidcConfigs.delete(id);
      throw err;
    });
    oidcConfigs.set(id, cfg);
  }
  return cfg;
}

/** Entra puts groups in `groups` (object IDs) and app roles in `roles`. Over ~200 groups it sends an overage marker instead. */
function entraGroups(groups: string[], roles: string[], overage: boolean): string[] | null {
  if (!overage) return [...groups, ...roles];
  const want = config.entra.adminGroup.toLowerCase();
  // We can't see the groups, so only a matching app role can decide; otherwise leave IdP admin as it was.
  return roles.some((r) => r.toLowerCase() === want) ? roles : null;
}

function identityFromOidc(provider: SsoProvider, c: Record<string, unknown>): SsoIdentity | null {
  if (provider.id === 'okta') {
    return {
      subject: String(c.sub),
      login: str(c.preferred_username) ?? str(c.email),
      email: str(c.email),
      emailTrusted: true,
      name: str(c.name),
      givenName: str(c.given_name),
      familyName: str(c.family_name),
      groups: Array.isArray(c.groups) ? strList(c.groups) : null,
    };
  }
  if (str(c.tid) && String(c.tid).toLowerCase() !== config.entra.tenantId.toLowerCase()) return null;
  const claimNames = (c._claim_names ?? {}) as Record<string, unknown>;
  return {
    // `oid` is the user's object ID across the tenant; `sub` differs per app.
    subject: str(c.oid) ?? String(c.sub),
    // UPN, set by admins. The `email` claim in Entra is user-editable and never used for matching.
    login: str(c.preferred_username) ?? str(c.upn),
    email: str(c.email),
    emailTrusted: false,
    name: str(c.name),
    givenName: str(c.given_name),
    familyName: str(c.family_name),
    groups: entraGroups(strList(c.groups), strList(c.roles), 'groups' in claimNames || c.hasgroups === true),
  };
}

// ---------- SAML (Entra) ----------

/** Accept a PEM (one or more certificates) or the bare Base64 body Entra lets you download. */
function toPemList(raw: string): string[] {
  const blocks = raw.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (blocks) return blocks;
  const body = raw.replace(/\s+/g, '');
  return body ? [`-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`] : [];
}

let saml: SAML | null = null;

// New settings from the admin page: rebuild sign-in clients on next use.
onSettingsChanged(() => {
  oidcConfigs.clear();
  saml = null;
});
function getSaml() {
  if (!saml) {
    const tenant = config.entra.tenantId;
    saml = new SAML({
      entryPoint: config.entra.samlLoginUrl || `https://login.microsoftonline.com/${tenant}/saml2`,
      issuer: config.entra.samlEntityId,
      callbackUrl: config.entra.samlAcsUrl,
      idpCert: toPemList(config.entra.samlCert),
      idpIssuer: `https://sts.windows.net/${tenant}/`,
      audience: config.entra.samlEntityId,
      // Entra signs the assertion by default ("Sign SAML assertion"); that's what we require.
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: false,
      // Each response must answer a request we sent in the last 10 minutes (blocks replay and IdP-initiated logins).
      validateInResponseTo: ValidateInResponseTo.always,
      requestIdExpirationPeriodMs: 10 * 60_000,
      acceptedClockSkewMs: 2 * 60_000,
      identifierFormat: null,
      // Let Entra apply its own MFA / passwordless policy instead of demanding password auth.
      disableRequestedAuthnContext: true,
      signatureAlgorithm: 'sha256',
    });
  }
  return saml;
}

const MS = 'http://schemas.microsoft.com/identity/claims/';
const XS = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/';
const MS_WS = 'http://schemas.microsoft.com/ws/2008/06/identity/claims/';

function identityFromSaml(p: Profile): SsoIdentity | null {
  const attrs = (p.attributes ?? {}) as Record<string, unknown>;
  const a = (k: string) => p[k] ?? attrs[k];
  const tid = str(a(`${MS}tenantid`));
  if (tid && tid.toLowerCase() !== config.entra.tenantId.toLowerCase()) return null;
  const nameId = str(p.nameID);
  const upn = str(a(`${XS}name`)) ?? (nameId && nameId.includes('@') ? nameId : null);
  const subject = str(a(`${MS}objectidentifier`)) ?? nameId;
  if (!subject) return null;
  return {
    subject,
    login: upn,
    email: str(a(`${XS}emailaddress`)),
    emailTrusted: false,
    name: str(a(`${MS}displayname`)) ?? ([str(a(`${XS}givenname`)), str(a(`${XS}surname`))].filter(Boolean).join(' ') || null),
    givenName: str(a(`${XS}givenname`)),
    familyName: str(a(`${XS}surname`)),
    groups: entraGroups(strList(a(`${MS_WS}groups`)), strList(a(`${MS_WS}role`)), a('http://schemas.microsoft.com/claims/groups.link') != null),
  };
}

// ---------- routes ----------

export const authRouter = Router();

authRouter.get('/auth/config', (_req, res) => {
  const providers = ssoProviders().map((p) => ({ id: p.id, label: p.label, protocol: p.protocol }));
  res.json({ sso: providers.length > 0, providers, devAuth: config.devAuth, emailLogin: emailLoginEnabled(), emailCanSend: emailCanSend(), mode: config.mode });
});

/** Start SSO. `?provider=okta|entra`; defaults to the first configured provider. */
authRouter.get('/auth/login', async (req, res) => {
  const provider = req.query.provider ? getProvider(req.query.provider) : ssoProviders()[0];
  if (!provider) return loginRedirect(res, 'sso_not_configured');
  const returnTo = safeReturnTo(req.query.returnTo);
  try {
    if (provider.protocol === 'saml') {
      return res.redirect(await getSaml().getAuthorizeUrlAsync(returnTo, undefined, {}));
    }
    const cfg = await getOidcConfig(provider.id);
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    res.cookie(
      OIDC_TX_COOKIE,
      await sign({ provider: provider.id, verifier, state, nonce, returnTo }, 600),
      cookieOpts(600_000),
    );
    const url = oidc.buildAuthorizationUrl(cfg, {
      redirect_uri: config.oidc.redirectUri,
      scope: oidcSettings(provider.id).scopes,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    res.redirect(url.href);
  } catch (err) {
    console.error(`[auth] ${provider.id} login failed`, err);
    loginRedirect(res, 'sso_unavailable', provider.id);
  }
});

/** OIDC redirect URI shared by every OIDC provider; the transaction cookie says which one. */
authRouter.get('/auth/callback', async (req, res) => {
  const txn = await verify<{ provider?: ProviderId; verifier: string; state: string; nonce: string; returnTo: string }>(
    req.cookies?.[OIDC_TX_COOKIE],
  );
  res.clearCookie(OIDC_TX_COOKIE, { path: '/' });
  if (!txn) return loginRedirect(res, 'login_expired');
  const provider = getProvider(txn.provider ?? 'okta');
  if (!provider || provider.protocol !== 'oidc') return loginRedirect(res, 'sso_not_configured');
  try {
    const cfg = await getOidcConfig(provider.id);
    const tokens = await oidc.authorizationCodeGrant(cfg, new URL(req.originalUrl, config.publicUrl), {
      pkceCodeVerifier: txn.verifier,
      expectedState: txn.state,
      expectedNonce: txn.nonce,
    });
    const claims = tokens.claims();
    if (!claims) return loginRedirect(res, 'no_id_token', provider.id);
    const identity = identityFromOidc(provider, claims as Record<string, unknown>);
    if (!identity) return loginRedirect(res, 'wrong_tenant', provider.id);
    await finishSso(res, provider, identity, txn.returnTo);
  } catch (err) {
    console.error(`[auth] ${provider.id} callback failed`, err);
    loginRedirect(res, 'sso_failed', provider.id);
  }
});

/** SAML Assertion Consumer Service (Entra posts the signed response here). */
authRouter.post('/auth/saml/acs', express.urlencoded({ extended: false, limit: '512kb' }), async (req, res) => {
  const provider = getProvider('entra');
  if (!provider || provider.protocol !== 'saml') return loginRedirect(res, 'sso_not_configured');
  try {
    const { profile } = await getSaml().validatePostResponseAsync(req.body ?? {});
    const identity = profile && identityFromSaml(profile);
    if (!identity) return loginRedirect(res, 'wrong_tenant', provider.id);
    await finishSso(res, provider, identity, String(req.body?.RelayState ?? '/'));
  } catch (err) {
    console.error('[auth] SAML response rejected', err instanceof Error ? err.message : err);
    loginRedirect(res, 'sso_failed', provider.id);
  }
});

/** SP metadata to upload to Entra (Enterprise application → Single sign-on → Upload metadata file). */
authRouter.get('/auth/saml/metadata', (_req, res) => {
  if (getProvider('entra')?.protocol !== 'saml') return res.status(404).send('SAML is not enabled');
  res.type('application/samlmetadata+xml').send(getSaml().generateServiceProviderMetadata(null, null));
});

authRouter.post('/auth/dev-login', async (req, res) => {
  if (!config.devAuth) return res.status(404).json({ error: 'disabled' });
  const name = String(req.body?.name ?? '').trim();
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  if (!name || !email) return res.status(400).json({ error: 'name and email required' });
  let user = findUserByLogin(email);
  if (!user) user = createUser({ userName: email, email, displayName: name });
  else if (!user.active || user.deleted) return res.status(403).json({ error: 'This account is deactivated' });
  // First user on a dev install becomes admin.
  const count = q.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n;
  if (count === 1 && !user.is_admin) {
    user = updateUser(user.id, { is_admin: 1 })!;
    logAdminAction(null, user.id, 'admin_granted', 'First user on a dev install');
  }
  user = applyBootstrapAdmin(user);
  await startSession(res, user);
  res.json({ user: toPublic(user) });
});

authRouter.post('/auth/logout', (_req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

authRouter.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: toPublic(req.user!) });
});
