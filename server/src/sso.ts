import { config, entraEnabled, oidcEnabled } from './config.js';
import { now, q } from './db.js';
import { bus, createUser, findUserByLogin, logAdminAction, updateUser, type UserRow } from './users.js';

export type ProviderId = 'okta' | 'entra';

export interface SsoProvider {
  id: ProviderId;
  label: string;
  protocol: 'oidc' | 'saml';
  adminGroup: string;
  jitProvisioning: boolean;
}

export function ssoProviders(): SsoProvider[] {
  const list: SsoProvider[] = [];
  if (oidcEnabled()) {
    list.push({
      id: 'okta',
      label: 'Okta',
      protocol: 'oidc',
      adminGroup: config.oidc.adminGroup,
      jitProvisioning: config.oidc.jitProvisioning,
    });
  }
  if (entraEnabled()) {
    list.push({
      id: 'entra',
      label: 'Microsoft',
      protocol: config.entra.protocol,
      adminGroup: config.entra.adminGroup,
      jitProvisioning: config.entra.jitProvisioning,
    });
  }
  return list;
}

export const getProvider = (id: unknown) => ssoProviders().find((p) => p.id === id);

/** What an identity provider told us about the person, normalized across OIDC and SAML. */
export interface SsoIdentity {
  /** Stable, provider-scoped ID (Okta `sub`, Entra object ID). */
  subject: string;
  /** Admin-controlled login name (Okta login, Entra UPN). Used to match SCIM-provisioned users. */
  login: string | null;
  /** Email claim. Only used for matching when the provider guarantees it (see `emailTrusted`). */
  email: string | null;
  emailTrusted: boolean;
  name: string | null;
  givenName: string | null;
  familyName: string | null;
  /**
   * Group names/IDs and app roles. `null` means the provider didn't say (claim not configured,
   * or Entra group overage), in which case IdP admin is left as it was.
   */
  groups: string[] | null;
}

export type SsoError = 'not_provisioned' | 'inactive';

/** Map an SSO identity onto a local user, honoring SCIM provisioning. */
export function resolveSsoUser(provider: SsoProvider, id: SsoIdentity): UserRow | SsoError {
  const linked = q.get<{ user_id: string }>(
    'SELECT user_id FROM user_identities WHERE provider = ? AND subject = ?',
    provider.id,
    id.subject,
  );
  // An unverified email (Entra's is user-editable) is only stored when nobody else already uses it.
  const email =
    id.email && !id.emailTrusted && (findUserByLogin(id.email)?.id ?? null) !== null ? null : id.email;
  let user =
    (linked && q.get<UserRow>('SELECT * FROM users WHERE id = ? AND deleted = 0', linked.user_id)) ||
    (id.login ? findUserByLogin(id.login) : undefined) ||
    (id.email && id.emailTrusted ? findUserByLogin(id.email) : undefined);

  const existed = Boolean(user);
  if (!user) {
    if (!provider.jitProvisioning) return 'not_provisioned';
    user = createUser({
      userName: id.login ?? id.email ?? id.subject,
      email,
      displayName: id.name ?? undefined,
      givenName: id.givenName,
      familyName: id.familyName,
    });
  }
  if (!user.active || user.deleted) return 'inactive';

  if (!linked) {
    q.run(
      'INSERT OR REPLACE INTO user_identities (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?)',
      provider.id,
      id.subject,
      user.id,
      now(),
    );
    if (existed) {
      // The account was made before its owner first signed in (by SCIM, an invite, an admin or email
      // sign-in). Whoever used it until now must not carry on as the person who just proved who they are.
      q.run('UPDATE users SET sessions_valid_after = ? WHERE id = ?', Math.floor(Date.now() / 1000), user.id);
      logAdminAction(null, user.id, 'sso_linked', `${providerLabel(provider.id)} sign-in linked to an existing account; its earlier sessions were ended`);
      bus.emit('user:sessions-ended', user.id);
    }
  }

  const updates: Partial<Record<keyof UserRow, unknown>> = { last_login_provider: provider.id };
  if (provider.id === 'okta' && !user.oidc_sub) updates.oidc_sub = id.subject;
  // SCIM is the source of truth for profile data when it manages the user.
  if (!user.scim_managed) {
    if (id.name && id.name !== user.display_name) updates.display_name = id.name;
    const ownEmail = email ?? (id.email && findUserByLogin(id.email)?.id === user.id ? id.email : null);
    if (ownEmail && ownEmail !== user.email) updates.email = ownEmail;
  }
  // IdP-derived admin is tracked separately so it never overwrites admin granted in the app.
  if (id.groups && provider.adminGroup) {
    const want = provider.adminGroup.toLowerCase();
    updates.idp_admin = id.groups.some((g) => g.toLowerCase() === want) ? 1 : 0;
  }
  return updateUser(user.id, updates) ?? user;
}

export const providerLabel = (id: string | null | undefined) =>
  id === 'entra' ? 'Entra ID' : id === 'okta' ? 'Okta' : 'SSO';

export function linkedProviders(userId: string): string[] {
  return q
    .all<{ provider: string }>('SELECT provider FROM user_identities WHERE user_id = ? ORDER BY provider', userId)
    .map((r) => r.provider);
}
