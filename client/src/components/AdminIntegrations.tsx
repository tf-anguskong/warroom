import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useApp } from '../lib/app';
import { utcTime } from '../lib/format';
import { Icons, Modal } from './ui';
import { IntegrationGuide } from './SetupGuides';

type Access = 'all' | 'roles' | 'admins';

interface Template {
  id?: string;
  name: string;
  description: string;
  query: string;
  range: string;
  autoRun: boolean;
}

type IntegrationType = 'okta' | 'sumo' | 'crowdstrike';
const TYPE_LABEL: Record<IntegrationType, string> = { okta: 'Okta', sumo: 'Sumo Logic', crowdstrike: 'CrowdStrike' };

interface AdminIntegration {
  id: string;
  type: IntegrationType;
  name: string;
  baseUrl: string;
  enabled: boolean;
  settings: { access: Access; templates?: Template[] };
  credentials: Record<string, string | null>;
  lastTest: { at: string; ok: boolean; message: string } | null;
}

interface Catalog {
  types: { type: IntegrationType; label: string; description: string }[];
  sumoDeployments: { key: string; label: string; url: string }[];
  falconClouds: { key: string; label: string; url: string }[];
  defaultSumoTemplates: Template[];
  access: Record<Access, string>;
}

export function AdminIntegrations({ onChanged }: { onChanged: () => void }) {
  const { toast } = useApp();
  const [items, setItems] = useState<AdminIntegration[] | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [editing, setEditing] = useState<AdminIntegration | { type: IntegrationType } | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const load = useCallback(() => {
    api.get<{ integrations: AdminIntegration[]; catalog: Catalog }>('/api/admin/integrations').then((r) => {
      setItems(r.integrations);
      setCatalog(r.catalog);
    });
  }, []);
  useEffect(load, [load]);

  const test = async (id: string) => {
    setTesting(id);
    try {
      const r = await api.post<{ ok: boolean; message: string }>(`/api/admin/integrations/${id}/test`);
      toast({ text: r.message, tone: r.ok ? 'info' : 'error' }, 6000);
    } finally {
      setTesting(null);
      load();
    }
  };

  const toggle = async (i: AdminIntegration) => {
    await api.patch(`/api/admin/integrations/${i.id}`, { enabled: !i.enabled });
    load();
    onChanged();
  };

  if (!items || !catalog) return <div className="skeleton" />;

  return (
    <div className="integrations-admin">
      <div className="alert info">
        <span>
          Integrations let responders search external systems from the war room's <strong>Investigate</strong> view. Credentials are encrypted at rest and
          never sent to browsers. Every search is logged to the incident timeline.
        </span>
      </div>

      <MailCard />

      <div className="integration-catalog">
        {catalog.types.map((t) => (
          <div key={t.type} className="catalog-card">
            <div>
              <strong>{t.label}</strong>
              <p className="muted small">{t.description}</p>
            </div>
            <button className="btn secondary sm" onClick={() => setEditing({ type: t.type })}>
              {Icons.plus} Connect {t.label}
            </button>
          </div>
        ))}
      </div>

      <h2>Connected ({items.length})</h2>
      {items.length === 0 ? (
        <p className="muted">Nothing connected yet.</p>
      ) : (
        <div className="integration-list">
          {items.map((i) => (
            <div key={i.id} className={`integration-row ${i.enabled ? '' : 'disabled'}`}>
              <span className="integ-icon">{Icons.plug}</span>
              <div className="grow">
                <div>
                  <strong>{i.name}</strong> <span className="tag">{TYPE_LABEL[i.type]}</span>
                  {!i.enabled && <span className="tag">disabled</span>}
                </div>
                <div className="muted small mono">{i.baseUrl}</div>
                <div className="small">
                  {i.lastTest ? (
                    <span className={i.lastTest.ok ? 'ok-text' : 'danger-text'}>
                      {i.lastTest.ok ? '✓' : '✕'} {i.lastTest.message} · <span className="mono">{utcTime(i.lastTest.at, true).slice(0, 16)}Z</span>
                    </span>
                  ) : (
                    <span className="muted">Not tested yet</span>
                  )}
                  <span className="muted"> · {catalog.access[i.settings.access]}</span>
                  {i.type === 'sumo' && <span className="muted"> · {i.settings.templates?.length ?? 0} starter queries</span>}
                </div>
              </div>
              <button className="btn ghost sm" onClick={() => test(i.id)} disabled={testing === i.id}>
                {testing === i.id ? 'Testing…' : 'Test'}
              </button>
              <button className="btn ghost sm" onClick={() => toggle(i)}>
                {i.enabled ? 'Disable' : 'Enable'}
              </button>
              <button className="btn secondary sm" onClick={() => setEditing(i)}>
                Edit
              </button>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <IntegrationDialog
          catalog={catalog}
          existing={'id' in editing ? editing : null}
          type={editing.type}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            setEditing(null);
            load();
            onChanged();
            void test(id);
          }}
          onDeleted={() => {
            setEditing(null);
            load();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function IntegrationDialog({
  catalog,
  existing,
  type,
  onClose,
  onSaved,
  onDeleted,
}: {
  catalog: Catalog;
  existing: AdminIntegration | null;
  type: IntegrationType;
  onClose: () => void;
  onSaved: (id: string) => void;
  onDeleted: () => void;
}) {
  const { toast } = useApp();
  const [name, setName] = useState(existing?.name ?? TYPE_LABEL[type]);
  const [baseUrl, setBaseUrl] = useState(
    existing?.baseUrl ?? (type === 'sumo' ? catalog.sumoDeployments[0].url : type === 'crowdstrike' ? catalog.falconClouds[0].url : ''),
  );
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [access, setAccess] = useState<Access>(existing?.settings.access ?? 'roles');
  const [templates, setTemplates] = useState<Template[]>(existing?.settings.templates ?? catalog.defaultSumoTemplates);
  const [editTpl, setEditTpl] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const saved = existing?.credentials ?? {};
  const deployment = catalog.sumoDeployments.find((d) => d.url === baseUrl)?.key ?? 'custom';
  const cloud = catalog.falconClouds.find((d) => d.url === baseUrl)?.key ?? 'custom';

  const save = async () => {
    setBusy(true);
    try {
      const body = { type, name, baseUrl, credentials: creds, settings: { access, ...(type === 'sumo' ? { templates } : {}) } };
      const r = existing
        ? await api.patch<{ integration: { id: string } }>(`/api/admin/integrations/${existing.id}`, body)
        : await api.post<{ integration: { id: string } }>('/api/admin/integrations', body);
      onSaved(r.integration.id);
    } catch (e) {
      toast({ text: e instanceof ApiError ? e.message : 'Save failed', tone: 'error' }, 6000);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!existing || !confirm(`Remove ${existing.name}? Its saved credentials are deleted and live watches stop. Past search results stay in their incidents.`)) return;
    await api.del(`/api/admin/integrations/${existing.id}`);
    onDeleted();
  };

  const secretInput = (field: string, label: string, placeholder: string) => (
    <label>
      {label}
      <input
        type="password"
        autoComplete="new-password"
        value={creds[field] ?? ''}
        onChange={(e) => setCreds({ ...creds, [field]: e.target.value })}
        placeholder={saved[field] ? `Saved${saved[field] !== 'saved' ? ` (${saved[field]})` : ''} — leave blank to keep` : placeholder}
      />
    </label>
  );

  return (
    <Modal
      title={existing ? `Edit ${existing.name}` : `Connect ${TYPE_LABEL[type]}`}
      onClose={onClose}
      wide
      footer={
        <>
          {existing && (
            <button className="btn ghost danger-text" onClick={remove}>
              Remove integration
            </button>
          )}
          <div className="spacer" />
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy || !baseUrl.trim()}>
            {existing ? 'Save & test' : 'Connect & test'}
          </button>
        </>
      }
    >
      <div className="form">
        <IntegrationGuide type={type} open={!existing} />
        <label>
          Display name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>

        {type === 'okta' ? (
          <>
            <label>
              Okta org URL
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://your-org.okta.com" />
            </label>
            {secretInput('token', 'API token', 'SSWS token from Security → API → Tokens')}
            <p className="hint">
              Create the token while signed in as a <strong>Read-Only Administrator</strong> service account. War Room only reads users, factors, groups and the
              System Log; it never changes anything in Okta.
            </p>
          </>
        ) : type === 'crowdstrike' ? (
          <>
            <label>
              Falcon cloud
              <select
                value={cloud}
                onChange={(e) => {
                  const d = catalog.falconClouds.find((x) => x.key === e.target.value);
                  setBaseUrl(d ? d.url : '');
                }}
              >
                {catalog.falconClouds.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label} — {d.url}
                  </option>
                ))}
                <option value="custom">Custom API address…</option>
              </select>
            </label>
            {cloud === 'custom' && (
              <label>
                API address
                <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.crowdstrike.com" />
              </label>
            )}
            <div className="row">
              {secretInput('clientId', 'Client ID', 'API client ID')}
              {secretInput('clientSecret', 'Client secret', 'API client secret')}
            </div>
            <p className="hint">
              In Falcon, go to Support and resources → <strong>API clients and keys</strong> and add a client with only <strong>Hosts: Read</strong> and{' '}
              <strong>Alerts: Read</strong>. War Room finds hosts, reads their state and alerts, and tracks endpoints you pick; it never changes anything in
              Falcon.
            </p>
          </>
        ) : (
          <>
            <label>
              Deployment
              <select
                value={deployment}
                onChange={(e) => {
                  const d = catalog.sumoDeployments.find((x) => x.key === e.target.value);
                  setBaseUrl(d ? d.url : '');
                }}
              >
                {catalog.sumoDeployments.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label} — {d.url}
                  </option>
                ))}
                <option value="custom">Custom API endpoint…</option>
              </select>
            </label>
            {deployment === 'custom' && (
              <label>
                API endpoint
                <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.<deployment>.sumologic.com/api" />
              </label>
            )}
            <div className="row">
              {secretInput('accessId', 'Access ID', 'Access ID')}
              {secretInput('accessKey', 'Access key', 'Access key')}
            </div>
            <p className="hint">Create an access key (Administration → Security → Access Keys) for a role that can run searches on the data responders need.</p>
          </>
        )}

        <label>
          Who can run searches from a war room
          <select value={access} onChange={(e) => setAccess(e.target.value as Access)}>
            {(Object.keys(catalog.access) as Access[]).map((a) => (
              <option key={a} value={a}>
                {catalog.access[a]}
              </option>
            ))}
          </select>
        </label>
        <p className="hint">These searches can expose a person's activity. "Incident role holders" means anyone the IC has assigned a role in that incident.</p>

        {type === 'sumo' && (
          <fieldset>
            <legend>Starter queries</legend>
            <p className="hint">
              Use <code>{'{{ip}}'}</code>, <code>{'{{user}}'}</code>, <code>{'{{host}}'}</code>, <code>{'{{hash}}'}</code>, <code>{'{{domain}}'}</code> as
              placeholders — responders get suggestions from the incident's sheets. Queries with no placeholders can auto-run when an incident is declared.
            </p>
            {templates.map((t, i) =>
              editTpl === i ? (
                <div key={i} className="tpl-edit">
                  <input value={t.name} onChange={(e) => setTemplates(templates.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="Name" />
                  <input
                    value={t.description}
                    onChange={(e) => setTemplates(templates.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))}
                    placeholder="What it shows"
                  />
                  <textarea
                    className="mono"
                    rows={4}
                    value={t.query}
                    onChange={(e) => setTemplates(templates.map((x, j) => (j === i ? { ...x, query: e.target.value } : x)))}
                  />
                  <div className="row">
                    <select value={t.range} onChange={(e) => setTemplates(templates.map((x, j) => (j === i ? { ...x, range: e.target.value } : x)))}>
                      {['15m', '1h', '4h', '24h', '7d', '30d'].map((r) => (
                        <option key={r}>{r}</option>
                      ))}
                    </select>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={t.autoRun}
                        disabled={/\{\{/.test(t.query)}
                        onChange={(e) => setTemplates(templates.map((x, j) => (j === i ? { ...x, autoRun: e.target.checked } : x)))}
                      />
                      Auto-run on declare
                    </label>
                    <div className="spacer" />
                    <button className="btn ghost sm danger-text" onClick={() => (setTemplates(templates.filter((_, j) => j !== i)), setEditTpl(null))}>
                      Delete
                    </button>
                    <button className="btn secondary sm" onClick={() => setEditTpl(null)}>
                      Done
                    </button>
                  </div>
                </div>
              ) : (
                <div key={i} className="tpl-row">
                  <div className="grow">
                    <strong>{t.name}</strong> {t.autoRun && <span className="tag">auto-runs</span>}
                    <div className="mono small muted tpl-preview">{t.query.split('\n')[0]}</div>
                  </div>
                  <button className="btn ghost sm" onClick={() => setEditTpl(i)}>
                    Edit
                  </button>
                </div>
              ),
            )}
            <button
              className="btn ghost sm left"
              onClick={() => {
                setTemplates([...templates, { name: 'New query', description: '', query: '"{{ip}}"', range: '24h', autoRun: false }]);
                setEditTpl(templates.length);
              }}
            >
              {Icons.plus} Add starter query
            </button>
          </fieldset>
        )}
      </div>
    </Modal>
  );
}

interface MailStatus {
  configured: boolean;
  host: string | null;
  port: number;
  from: string | null;
  tls: string;
  requireEmail: boolean;
  devOutbox: boolean;
}

/** Outgoing email (SMTP) used for guest sign-in codes. Configured on the server; tested here. */
function MailCard() {
  const { toast, me } = useApp();
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [to, setTo] = useState(me.email ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get<MailStatus>('/api/admin/mail').then(setStatus).catch(() => undefined);
  }, []);
  if (!status) return null;
  const test = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ dev: boolean }>('/api/admin/mail/test', { to });
      toast({ text: r.dev ? 'No SMTP server: the test email was printed in the server log' : `Test email sent to ${to}` }, 5000);
    } catch (e) {
      toast({ text: e instanceof Error ? e.message : 'Sending failed', tone: 'error' }, 10000);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="integration-card mail-card">
      <div className="integration-head">
        <strong>Email (SMTP)</strong>
        <span className={`status ${status.configured ? 'status-monitoring' : 'status-identified'}`}>{status.configured ? 'Configured' : 'Not configured'}</span>
      </div>
      <p className="muted small">
        Sends one-time codes to guests: when a guest opens an invite link, they get a code by email and must enter it to join or sign back in.
        {status.configured
          ? ` Every guest invite ${status.requireEmail ? 'requires' : 'can include'} an email.`
          : ' Set it up under Settings → Email.'}
        {status.devOutbox && ' In development, emails are printed in the server log instead.'}
      </p>
      {status.configured && (
        <div className="small mono muted">
          {status.host}:{status.port} · {status.tls} · from {status.from}
        </div>
      )}
      <div className="row gap-sm" style={{ marginTop: 8 }}>
        <input type="email" placeholder="you@company.com" value={to} onChange={(e) => setTo(e.target.value)} />
        <button className="btn secondary sm" onClick={test} disabled={busy || !to.trim()}>
          Send test email
        </button>
      </div>
    </section>
  );
}
