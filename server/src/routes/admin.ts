import { Router } from 'express';
import { config } from '../config.js';
import { q } from '../db.js';
import { adminGroupIds, adminSources, getUser, isAdmin, logAdminAction, otherActiveAdmins, toPublic, updateUser, type UserRow } from '../users.js';
import { linkedProviders, providerLabel, ssoProviders } from '../sso.js';
import { HttpError } from '../model.js';
import { requireAdmin } from '../permissions.js';
import { h } from './common.js';

/** Admin → People: the directory, granting admin, deactivating accounts, and the audit log. */

export const router = Router();

// ---------- admin ----------

function mustUser(id: string) {
  const u = getUser(id);
  if (!u || u.deleted) throw new HttpError(404, 'user not found');
  return u;
}

router.get(
  '/admin/directory',
  h((req) => {
    requireAdmin(req);
    const users = q.all<UserRow>('SELECT * FROM users WHERE deleted = 0 ORDER BY display_name');
    const groups = q.all<{ id: string; display_name: string; external_id: string | null; n: number }>(
      'SELECT g.id, g.display_name, g.external_id, COUNT(gm.user_id) AS n FROM groups g LEFT JOIN group_members gm ON gm.group_id = g.id GROUP BY g.id ORDER BY g.display_name',
    );
    const adminIds = adminGroupIds();
    return {
      users: users.map((u) => ({
        ...toPublic(u),
        adminSources: adminSources(u),
        scimManaged: Boolean(u.scim_managed),
        ssoLinked: Boolean(u.oidc_sub) || linkedProviders(u.id).length > 0,
        ssoProviders: linkedProviders(u.id).map(providerLabel),
        idpLabel: providerLabel(u.last_login_provider),
        createdAt: u.created_at,
        lastLoginAt: u.last_login_at,
      })),
      groups: groups.map((g) => ({
        id: g.id,
        displayName: g.display_name,
        members: g.n,
        isAdminGroup: [g.display_name, g.external_id ?? ''].some((v) => adminIds.includes(v.toLowerCase())),
      })),
      scimEnabled: Boolean(config.scim.token),
      adminGroup: config.oidc.adminGroup || null,
      adminGroups: ssoProviders()
        .filter((p) => p.adminGroup)
        .map((p) => ({ provider: providerLabel(p.id), group: p.adminGroup })),
      providers: ssoProviders().map((p) => providerLabel(p.id)),
    };
  }),
);

/** Grant or revoke in-app admin. Okta-derived admin can only be removed in Okta. */
router.put(
  '/admin/users/:id/admin',
  h((req) => {
    requireAdmin(req);
    const target = mustUser(req.params.id);
    const grant = req.body?.admin === true;
    if (grant) {
      if (!target.active) throw new HttpError(400, 'reactivate the user before making them an admin');
      if (target.is_admin) return { ok: true };
      updateUser(target.id, { is_admin: 1 });
      logAdminAction(req.user!.id, target.id, 'admin_granted');
    } else {
      if (!target.is_admin) {
        const s = adminSources(target);
        if (s.idpClaim || s.idpGroup) {
          throw new HttpError(400, `${target.display_name} is an admin through an admin group in ${providerLabel(target.last_login_provider)}; remove them from that group there`);
        }
        return { ok: true };
      }
      const s = adminSources(target);
      const stillAdmin = s.idpClaim || s.idpGroup;
      if (!stillAdmin && otherActiveAdmins(target.id) === 0) {
        throw new HttpError(400, 'cannot remove the last admin; make someone else an admin first');
      }
      updateUser(target.id, { is_admin: 0 });
      logAdminAction(req.user!.id, target.id, 'admin_revoked', stillAdmin ? 'Still an admin through Okta group' : '');
    }
    return { user: toPublic(getUser(target.id)!), adminSources: adminSources(getUser(target.id)!) };
  }),
);

/** Deactivate/reactivate accounts that War Room owns. Okta-provisioned users are managed in Okta. */
router.put(
  '/admin/users/:id/active',
  h((req) => {
    requireAdmin(req);
    const target = mustUser(req.params.id);
    const active = req.body?.active === true;
    if (target.scim_managed) throw new HttpError(400, 'this user is provisioned by Okta; assign or unassign them in Okta');
    if (target.id === req.user!.id && !active) throw new HttpError(400, 'you cannot deactivate yourself');
    if (!active && isAdmin(target) && otherActiveAdmins(target.id) === 0) {
      throw new HttpError(400, 'cannot deactivate the last admin');
    }
    if (Boolean(target.active) === active) return { ok: true };
    updateUser(target.id, { active: active ? 1 : 0 });
    logAdminAction(req.user!.id, target.id, active ? 'user_reactivated' : 'user_deactivated');
    return { ok: true };
  }),
);

router.get(
  '/admin/audit',
  h((req) => {
    requireAdmin(req);
    const rows = q.all<{ id: string; ts: string; action: string; detail: string; actor: string | null; target: string | null }>(
      `SELECT a.id, a.ts, a.action, a.detail, ua.display_name AS actor, ut.display_name AS target
       FROM admin_audit a LEFT JOIN users ua ON ua.id = a.actor_id LEFT JOIN users ut ON ut.id = a.target_id
       ORDER BY a.ts DESC LIMIT 200`,
    );
    return { entries: rows };
  }),
);
