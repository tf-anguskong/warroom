import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useApp } from '../lib/app';
import { utcTime } from '../lib/format';
import { Avatar, Icons, Modal } from '../components/ui';
import { AdminIntegrations } from '../components/AdminIntegrations';
import { AdminSettings } from '../components/AdminSettings';

interface AdminSources {
  granted: boolean;
  idpClaim: boolean;
  idpGroup: boolean;
}

interface DirUser {
  id: string;
  displayName: string;
  userName: string;
  email: string | null;
  isAdmin: boolean;
  active: boolean;
  adminSources: AdminSources;
  scimManaged: boolean;
  ssoLinked: boolean;
  ssoProviders: string[];
  idpLabel: string;
  createdAt: string;
  lastLoginAt: string | null;
}

interface Directory {
  users: DirUser[];
  groups: { id: string; displayName: string; members: number; isAdminGroup: boolean }[];
  scimEnabled: boolean;
  adminGroup: string | null;
  adminGroups: { provider: string; group: string }[];
  providers: string[];
}

interface AuditEntry {
  id: string;
  ts: string;
  action: string;
  detail: string;
  actor: string | null;
  target: string | null;
}

const ACTION_LABEL: Record<string, string> = {
  admin_granted: 'made admin',
  admin_revoked: 'removed admin from',
  user_deactivated: 'deactivated',
  user_reactivated: 'reactivated',
  integration_added: 'connected integration',
  integration_updated: 'updated integration',
  integration_removed: 'removed integration',
  mail_test: 'sent a test email to',
  settings_changed: 'changed settings:',
  setup_link_used: 'used a setup link:',
  guest_invited: 'invited guest',
  guest_joined: 'guest joined:',
  guest_revoked: 'ended guest access for',
};

type Confirm = { user: DirUser; kind: 'grant' | 'revoke' | 'deactivate' | 'reactivate' };

export function Admin() {
  const { me, toast } = useApp();
  const [dir, setDir] = useState<Directory | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [filter, setFilter] = useState<'all' | 'admins' | 'inactive'>('all');
  const [search, setSearch] = useState('');
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [params, setParams] = useSearchParams();
  const t = params.get('tab');
  const tab = t === 'integrations' || t === 'settings' ? t : 'people';

  const load = useCallback(() => {
    api.get<Directory>('/api/admin/directory').then(setDir);
    api.get<{ entries: AuditEntry[] }>('/api/admin/audit').then((r) => setAudit(r.entries));
  }, []);

  useEffect(() => {
    if (me.isAdmin) load();
  }, [me.isAdmin, load]);

  const shown = useMemo(() => {
    if (!dir) return [];
    const s = search.trim().toLowerCase();
    return dir.users.filter((u) => {
      if (filter === 'admins' && !u.isAdmin) return false;
      if (filter === 'inactive' && u.active) return false;
      return !s || u.displayName.toLowerCase().includes(s) || u.userName.toLowerCase().includes(s) || (u.email ?? '').toLowerCase().includes(s);
    });
  }, [dir, filter, search]);

  if (!me.isAdmin) return <Navigate to="/" replace />;

  const run = async () => {
    if (!confirm) return;
    setBusy(true);
    const { user, kind } = confirm;
    try {
      if (kind === 'grant' || kind === 'revoke') await api.put(`/api/admin/users/${user.id}/admin`, { admin: kind === 'grant' });
      else await api.put(`/api/admin/users/${user.id}/active`, { active: kind === 'reactivate' });
      toast({ text: CONFIRM_TEXT[kind].done(user.displayName) }, 3000);
      setConfirm(null);
      load();
    } catch (e) {
      toast({ text: e instanceof ApiError ? e.message : 'Action failed', tone: 'error' }, 6000);
    } finally {
      setBusy(false);
    }
  };

  const adminCount = dir?.users.filter((u) => u.isAdmin && u.active).length ?? 0;

  return (
    <div className="dash">
      <header className="dash-head">
        <Link to="/" className="btn ghost sm">
          {Icons.back} Incidents
        </Link>
        <strong>Admin</strong>
        <div className="seg">
          <button className={tab === 'people' ? 'on' : ''} onClick={() => setParams({})}>
            {Icons.users} People
          </button>
          <button className={tab === 'integrations' ? 'on' : ''} onClick={() => setParams({ tab: 'integrations' })}>
            {Icons.plug} Integrations
          </button>
          <button className={tab === 'settings' ? 'on' : ''} onClick={() => setParams({ tab: 'settings' })}>
            {Icons.settings} Settings
          </button>
        </div>
      </header>
      <main className="dash-main">
        {tab === 'settings' ? (
          <AdminSettings onChanged={load} />
        ) : tab === 'integrations' ? (
          <AdminIntegrations onChanged={load} />
        ) : (
        <>
        <div className="alert info">
          <div>
            People are provisioned from{' '}
            <strong>{dir?.providers.length ? dir.providers.join(' and ') : 'your identity provider'}</strong>. Grant War Room admin here, or through
            an admin group:{' '}
            {dir?.adminGroups.length ? (
              dir.adminGroups.map((g, i) => (
                <span key={g.provider}>
                  {i > 0 && ', '}
                  {g.provider} <code>{g.group}</code>
                </span>
              ))
            ) : (
              <em>none set (Settings → Okta or Microsoft Entra ID)</em>
            )}
            . Admin that comes from an identity provider can only be removed there.
            {dir && !dir.scimEnabled && <div className="warn-text">SCIM provisioning is off. Turn it on under Settings → Provisioning.</div>}
          </div>
        </div>

        {!dir ? (
          <div className="skeleton" />
        ) : (
          <div className="admin-grid">
            <section>
              <div className="admin-toolbar">
                <h2>
                  People <span className="count">{dir.users.length}</span>
                </h2>
                <div className="seg">
                  <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>
                    All
                  </button>
                  <button className={filter === 'admins' ? 'on' : ''} onClick={() => setFilter('admins')}>
                    Admins ({adminCount})
                  </button>
                  <button className={filter === 'inactive' ? 'on' : ''} onClick={() => setFilter('inactive')}>
                    Deactivated
                  </button>
                </div>
                <input className="admin-search" placeholder="Search name or email" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Role</th>
                    <th>Account</th>
                    <th>Last sign-in</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((u) => {
                    const oktaAdmin = u.adminSources.idpClaim || u.adminSources.idpGroup;
                    return (
                      <tr key={u.id} className={u.active ? '' : 'inactive'}>
                        <td>
                          <span className="person">
                            <Avatar id={u.id} name={u.displayName} size={24} />
                            <span>
                              {u.displayName}
                              {u.id === me.id && <span className="muted"> (you)</span>}
                              <div className="muted small mono">{u.email ?? u.userName}</div>
                            </span>
                          </span>
                        </td>
                        <td>
                          {u.isAdmin ? (
                            <span className="role-tags">
                              {u.adminSources.granted && <span className="tag" title="Granted in War Room">admin</span>}
                              {oktaAdmin && (
                                <span className="tag okta" title={`Member of an admin group in ${u.idpLabel}`}>
                                  admin · {u.idpLabel}
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="muted small">Member</span>
                          )}
                        </td>
                        <td className="small">
                          {u.active ? <span className="status status-monitoring">Active</span> : <span className="status status-resolved">Deactivated</span>}
                          <div className="muted">{u.scimManaged ? 'Provisioned (SCIM)' : u.ssoLinked ? 'SSO' : 'Local'}
                            {u.ssoProviders.length > 0 && ` · ${u.ssoProviders.join(', ')}`}</div>
                        </td>
                        <td className="small mono muted">{u.lastLoginAt ? `${utcTime(u.lastLoginAt, true).slice(0, 16)}Z` : 'never'}</td>
                        <td className="row-actions">
                          {u.active &&
                            (u.adminSources.granted ? (
                              <button className="btn ghost sm" onClick={() => setConfirm({ user: u, kind: 'revoke' })}>
                                Remove admin
                              </button>
                            ) : !oktaAdmin ? (
                              <button className="btn secondary sm" onClick={() => setConfirm({ user: u, kind: 'grant' })}>
                                Make admin
                              </button>
                            ) : (
                              <span className="muted small" title={`Remove them from the admin group in ${u.idpLabel}`}>
                                Managed in {u.idpLabel}
                              </span>
                            ))}
                          {!u.scimManaged && u.id !== me.id && (
                            <button
                              className={`btn ghost sm ${u.active ? 'danger-text' : ''}`}
                              onClick={() => setConfirm({ user: u, kind: u.active ? 'deactivate' : 'reactivate' })}
                            >
                              {u.active ? 'Deactivate' : 'Reactivate'}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {shown.length === 0 && (
                    <tr>
                      <td colSpan={5} className="muted">
                        No one matches.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </section>

            <div className="admin-side">
              <section>
                <h2>Provisioned groups</h2>
                {dir.groups.length === 0 ? (
                  <p className="muted small">No groups pushed by SCIM yet.</p>
                ) : (
                  <ul className="group-list">
                    {dir.groups.map((g) => (
                      <li key={g.id}>
                        <strong>{g.displayName}</strong> <span className="muted">{g.members} members</span>
                        {g.isAdminGroup && <span className="tag okta">admin group</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section>
                <h2>Admin activity</h2>
                {audit.length === 0 ? (
                  <p className="muted small">No admin changes yet.</p>
                ) : (
                  <ol className="audit">
                    {audit.map((a) => (
                      <li key={a.id}>
                        <span className="mono muted small">{utcTime(a.ts, true).slice(0, 16)}Z</span>
                        <span>
                          <strong>{a.actor ?? 'System'}</strong> {ACTION_LABEL[a.action] ?? a.action}{' '}
                          {a.action.startsWith('integration_') || a.action === 'mail_test' || a.action === 'guest_invited' || a.action === 'settings_changed' ? <strong>{a.detail}</strong> : <strong>{a.target ?? 'unknown'}</strong>}
                          {a.detail && !a.action.startsWith('integration_') && a.action !== 'mail_test' && a.action !== 'guest_invited' && a.action !== 'settings_changed' && <span className="muted small"> — {a.detail}</span>}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </div>
          </div>
        )}
        </>
        )}
      </main>

      {confirm && (
        <Modal
          title={CONFIRM_TEXT[confirm.kind].title(confirm.user.displayName)}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button className={`btn ${confirm.kind === 'deactivate' || confirm.kind === 'revoke' ? 'danger' : 'primary'}`} onClick={run} disabled={busy}>
                {CONFIRM_TEXT[confirm.kind].button}
              </button>
            </>
          }
        >
          <p>{CONFIRM_TEXT[confirm.kind].body(confirm.user.displayName, confirm.user.id === me.id)}</p>
        </Modal>
      )}
    </div>
  );
}

const CONFIRM_TEXT: Record<
  Confirm['kind'],
  { title: (n: string) => string; body: (n: string, self: boolean) => string; button: string; done: (n: string) => string }
> = {
  grant: {
    title: (n) => `Make ${n} an admin?`,
    body: (n) => `${n} will be able to grant and remove admin, deactivate local accounts and see the admin activity log.`,
    button: 'Make admin',
    done: (n) => `${n} is now an admin`,
  },
  revoke: {
    title: (n) => `Remove admin from ${n}?`,
    body: (n, self) =>
      self ? 'You will lose access to this page immediately.' : `${n} keeps their account and incident access, but loses admin rights.`,
    button: 'Remove admin',
    done: (n) => `${n} is no longer an admin`,
  },
  deactivate: {
    title: (n) => `Deactivate ${n}?`,
    body: (n) => `${n} is signed out everywhere right away and cannot sign in. Their messages and timeline entries stay in the record.`,
    button: 'Deactivate',
    done: (n) => `${n} was deactivated`,
  },
  reactivate: {
    title: (n) => `Reactivate ${n}?`,
    body: (n) => `${n} will be able to sign in again.`,
    button: 'Reactivate',
    done: (n) => `${n} was reactivated`,
  },
};
