import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { newId, now, q } from './db.js';

export interface UserRow {
  id: string;
  user_name: string;
  external_id: string | null;
  email: string | null;
  display_name: string;
  given_name: string | null;
  family_name: string | null;
  title: string | null;
  active: number;
  deleted: number;
  is_admin: number;
  idp_admin: number;
  last_login_at: string | null;
  last_login_provider: string | null;
  /** Unix seconds; sessions issued earlier are rejected. */
  sessions_valid_after: number | null;
  is_guest: number;
  guest_incident_id: string | null;
  guest_expires_at: string | null;
  guest_org: string | null;
  invited_by: string | null;
  /** JSON GuestScope: what a guest can see inside their war room. */
  guest_scope: string | null;
  oidc_sub: string | null;
  scim_managed: number;
  created_at: string;
  updated_at: string;
}

export interface PublicUser {
  id: string;
  userName: string;
  displayName: string;
  email: string | null;
  title: string | null;
  isAdmin: boolean;
  active: boolean;
  isGuest: boolean;
  guestIncidentId: string | null;
  guestOrg: string | null;
  guestExpiresAt: string | null;
}

/** In-process events other modules react to (e.g. disconnect a deprovisioned user's sockets). */
export const bus = new EventEmitter();

export const getUser = (id: string) => q.get<UserRow>('SELECT * FROM users WHERE id = ?', id);

export const findUserByLogin = (login: string) =>
  q.get<UserRow>(
    'SELECT * FROM users WHERE deleted = 0 AND (user_name = ? OR email = ?) ORDER BY scim_managed DESC LIMIT 1',
    login,
    login,
  );

export interface AdminSources {
  /** Granted inside War Room (admin panel, bootstrap list, first dev user). Revocable in the app. */
  granted: boolean;
  /** The identity provider said so at last sign-in (groups or app-role claim). */
  idpClaim: boolean;
  /** Member of an admin group pushed by SCIM (matched on group name or Entra object ID). */
  idpGroup: boolean;
}

/** Admin group names/IDs configured for any identity provider. */
export const adminGroupIds = () =>
  [config.oidc.adminGroup, config.entra.adminGroup].filter(Boolean).map((g) => g.toLowerCase());

export function adminSources(user: UserRow): AdminSources {
  const ids = adminGroupIds();
  const idpGroup = ids.length
    ? Boolean(
        q.get(
          `SELECT 1 FROM group_members gm JOIN groups g ON g.id = gm.group_id
           WHERE gm.user_id = ? AND (lower(g.display_name) IN (${ids.map(() => '?').join(',')})
             OR lower(coalesce(g.external_id, '')) IN (${ids.map(() => '?').join(',')}))`,
          user.id,
          ...ids,
          ...ids,
        ),
      )
    : false;
  return { granted: Boolean(user.is_admin), idpClaim: Boolean(user.idp_admin), idpGroup };
}

export function isAdmin(user: UserRow): boolean {
  if (user.is_guest) return false;
  const s = adminSources(user);
  return s.granted || s.idpClaim || s.idpGroup;
}

/** Active admins other than the given user (used to block removing the last admin). */
export function otherActiveAdmins(exceptId: string): number {
  return q
    .all<UserRow>('SELECT * FROM users WHERE active = 1 AND deleted = 0 AND id <> ?', exceptId)
    .filter(isAdmin).length;
}

export function logAdminAction(actorId: string | null, targetId: string | null, action: string, detail = '') {
  q.run(
    'INSERT INTO admin_audit (id, ts, actor_id, target_id, action, detail) VALUES (?, ?, ?, ?, ?, ?)',
    newId(),
    now(),
    actorId,
    targetId,
    action,
    detail,
  );
}

export function toPublic(u: UserRow): PublicUser {
  return {
    id: u.id,
    userName: u.user_name,
    displayName: u.display_name,
    email: u.email,
    title: u.title,
    isAdmin: isAdmin(u),
    active: Boolean(u.active) && !u.deleted,
    isGuest: Boolean(u.is_guest),
    guestIncidentId: u.guest_incident_id ?? null,
    guestOrg: u.guest_org ?? null,
    guestExpiresAt: u.guest_expires_at ?? null,
  };
}

export interface NewUser {
  userName: string;
  displayName?: string;
  email?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  title?: string | null;
  externalId?: string | null;
  active?: boolean;
  oidcSub?: string | null;
  scimManaged?: boolean;
}

export function createUser(u: NewUser): UserRow {
  const id = newId();
  const ts = now();
  const displayName =
    u.displayName || [u.givenName, u.familyName].filter(Boolean).join(' ') || u.userName;
  q.run(
    `INSERT INTO users (id, user_name, external_id, email, display_name, given_name, family_name, title,
       active, oidc_sub, scim_managed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    u.userName,
    u.externalId,
    u.email,
    displayName,
    u.givenName,
    u.familyName,
    u.title,
    u.active === false ? 0 : 1,
    u.oidcSub,
    u.scimManaged ? 1 : 0,
    ts,
    ts,
  );
  return getUser(id)!;
}

const USER_COLUMNS = new Set([
  'user_name',
  'external_id',
  'email',
  'display_name',
  'given_name',
  'family_name',
  'title',
  'active',
  'deleted',
  'is_admin',
  'idp_admin',
  'oidc_sub',
  'scim_managed',
  'last_login_provider',
  'guest_expires_at',
  'guest_scope',
]);

export function updateUser(id: string, fields: Partial<Record<keyof UserRow, unknown>>) {
  const keys = Object.keys(fields).filter((k) => USER_COLUMNS.has(k));
  if (!keys.length) return getUser(id);
  const before = getUser(id);
  q.run(
    `UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    ...keys.map((k) => fields[k as keyof UserRow]),
    now(),
    id,
  );
  const after = getUser(id);
  if (before && after && (before.active !== after.active || before.deleted !== after.deleted)) {
    if (!after.active || after.deleted) bus.emit('user:deactivated', id);
  }
  if (before && after && (before.is_admin !== after.is_admin || before.idp_admin !== after.idp_admin)) {
    bus.emit('user:changed', id);
  }
  return after;
}
