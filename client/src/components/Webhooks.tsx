import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { useApp } from '../lib/app';
import { utcTime } from '../lib/format';
import type { IncidentState } from '../types';
import { Icons, Modal } from './ui';
import { CopyBlock } from './Agents';

/** Outbound webhooks: global ones in Admin, and each war room's own. */

export interface Hook {
  id: string;
  scope: 'global' | 'room';
  name: string;
  kind: string;
  kindLabel: string;
  urlHint: string;
  events: string[];
  minSeverity: string;
  detail: 'full' | 'brief';
  enabled: boolean;
  createdBy: string | null;
  lastSentAt: string | null;
  lastOk: boolean | null;
  lastError: string | null;
  failures: number;
}
interface Meta {
  kinds: { id: string; label: string; help: string }[];
  events: { key: string; label: string }[];
  defaults: string[];
  severities: string[];
  allowPrivate: boolean;
}

const when = (iso: string) => `${iso.slice(0, 10)} ${utcTime(iso).slice(0, 5)} UTC`;

function HookEditor({ meta, scope, hook, create, onClose, onSaved }: { meta: Meta; scope: 'global' | 'room'; hook: Hook | null; create: string; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp();
  const [kind, setKind] = useState(hook?.kind ?? 'slack');
  const [name, setName] = useState(hook?.name ?? '');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(hook?.events ?? meta.defaults);
  const [minSeverity, setMinSeverity] = useState(hook?.minSeverity ?? 'SEV4');
  const [detail, setDetail] = useState<'full' | 'brief'>(hook?.detail ?? 'full');
  const [busy, setBusy] = useState(false);
  const [signing, setSigning] = useState<string | null>(null);
  const help = meta.kinds.find((k) => k.id === kind)?.help;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body = { kind, name: name.trim(), url: url.trim(), events, minSeverity, detail };
      const r = hook
        ? await api.patch<{ signingSecret: string | null }>(`/api/webhooks/${hook.id}`, body)
        : await api.post<{ signingSecret: string | null }>(create, body);
      onSaved();
      if (r.signingSecret) setSigning(r.signingSecret);
      else {
        toast({ text: hook ? 'Webhook saved' : 'Webhook added. Use Test to check it posts.' }, 4000);
        onClose();
      }
    } catch (err) {
      toast({ text: err instanceof ApiError ? err.message : 'Could not save the webhook', tone: 'error' }, 7000);
    } finally {
      setBusy(false);
    }
  };

  if (signing) {
    return (
      <Modal title="Signing secret" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
        <div className="form">
          <div className="alert warn">
            <div>Copy it now: it’s shown only once. Use it to check the X-WarRoom-Signature header: sha256 HMAC of “timestamp.body”, where timestamp is X-WarRoom-Timestamp.</div>
          </div>
          <CopyBlock text={signing} />
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={hook ? `Edit “${hook.name}”` : scope === 'global' ? 'Add a global webhook' : 'Add a webhook for this war room'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" form="hook-form" disabled={busy || !name.trim() || (!hook && !url.trim()) || !events.length}>
            {hook ? 'Save' : 'Add webhook'}
          </button>
        </>
      }
    >
      <form id="hook-form" className="form" onSubmit={submit}>
        <label>
          Posts to
          <select value={kind} onChange={(e) => setKind(e.target.value)} disabled={Boolean(hook)}>
            {meta.kinds.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
          {help && <span className="muted small">{help}</span>}
        </label>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="#incident-updates" required />
        </label>
        <label>
          Webhook URL
          <input
            type="password"
            autoComplete="off"
            className="mono"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={hook ? `Saved (${hook.urlHint}). Leave empty to keep it.` : 'https://…'}
          />
          <span className="muted small">
            Kept encrypted and never shown again; it works like a password for that channel.
            {meta.allowPrivate ? ' Internal addresses are allowed on this War Room.' : ''}
          </span>
        </label>
        <fieldset className="scope-group">
          <legend>Send</legend>
          {meta.events.map((ev) => (
            <label key={ev.key} className="check">
              <input type="checkbox" checked={events.includes(ev.key)} onChange={(e) => setEvents((x) => (e.target.checked ? [...x, ev.key] : x.filter((k) => k !== ev.key)))} />{' '}
              {ev.label}
            </label>
          ))}
        </fieldset>
        {scope === 'global' && (
          <label>
            For incidents of
            <select value={minSeverity} onChange={(e) => setMinSeverity(e.target.value)}>
              {meta.severities.map((s, i) => (
                <option key={s} value={s}>
                  {i === 0 ? 'SEV1 only' : i === meta.severities.length - 1 ? 'Every severity' : `${s} and above`}
                </option>
              ))}
            </select>
          </label>
        )}
        <fieldset className="scope-group">
          <legend>Detail</legend>
          <label className="check">
            <input type="radio" name="detail" checked={detail === 'full'} onChange={() => setDetail('full')} /> Full: incident title, the text of decisions and updates, who did it
          </label>
          <label className="check">
            <input type="radio" name="detail" checked={detail === 'brief'} onChange={() => setDetail('brief')} /> Headline only: incident key, severity, status and a link. Nothing sensitive leaves War Room
          </label>
        </fieldset>
      </form>
    </Modal>
  );
}

export function HookList({
  hooks,
  meta,
  scope,
  create,
  block,
  onChanged,
}: {
  hooks: Hook[];
  meta: Meta;
  scope: 'global' | 'room';
  create: string;
  block: string | null;
  onChanged: () => void;
}) {
  const { toast } = useApp();
  const [editing, setEditing] = useState<Hook | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    try {
      await fn();
    } catch (err) {
      toast({ text: err instanceof ApiError ? err.message : 'That didn’t work', tone: 'error' }, 7000);
    } finally {
      setBusy(null);
      onChanged();
    }
  };
  const test = (hk: Hook) =>
    run(hk.id, async () => {
      const r = await api.post<{ ok: boolean; error: string | null }>(`/api/webhooks/${hk.id}/test`, {});
      toast(r.ok ? { text: `Test message sent to “${hk.name}”` } : { text: `“${hk.name}” failed: ${r.error}`, tone: 'error' }, r.ok ? 3000 : 9000);
    });
  const toggle = (hk: Hook) => run(hk.id, () => api.patch(`/api/webhooks/${hk.id}`, { enabled: !hk.enabled }).then(() => undefined));
  const remove = (hk: Hook) => {
    if (!confirm(`Remove the webhook “${hk.name}”? War Room stops posting to it.`)) return;
    void run(hk.id, () => api.del(`/api/webhooks/${hk.id}`).then(() => undefined));
  };
  const label = (k: string) => meta.events.find((e) => e.key === k)?.label ?? k;
  return (
    <div className="hooks">
      {hooks.length === 0 && <div className="muted small">No webhooks yet.</div>}
      <ul className="hook-list">
        {hooks.map((hk) => (
          <li key={hk.id} className={hk.enabled ? '' : 'paused'}>
            <div className="hook-main">
              <div>
                <strong>{hk.name}</strong> <span className="hook-kind">{hk.kindLabel}</span>
                {!hk.enabled && <span className="hook-kind paused">paused</span>}
                {hk.detail === 'brief' && <span className="hook-kind">headline only</span>}
                {scope === 'global' && hk.minSeverity !== 'SEV4' && <span className="hook-kind">{hk.minSeverity === 'SEV1' ? 'SEV1 only' : `${hk.minSeverity}+`}</span>}
              </div>
              <div className="muted small mono">{hk.urlHint}</div>
              <div className="small">{hk.events.map(label).join(' · ')}</div>
              <div className="small">
                {hk.lastSentAt === null ? (
                  <span className="muted">Nothing sent yet</span>
                ) : hk.lastOk ? (
                  <span className="ok-text">Last sent {when(hk.lastSentAt)}</span>
                ) : (
                  <span className="bad-text">
                    Failed {when(hk.lastSentAt)}: {hk.lastError}
                    {hk.failures > 1 ? ` (${hk.failures} in a row)` : ''}
                  </span>
                )}
              </div>
            </div>
            <div className="hook-actions">
              <button className="btn ghost sm" disabled={Boolean(block) || busy === hk.id} title={block ?? 'Send a test message'} onClick={() => test(hk)}>
                Test
              </button>
              <button className="btn ghost sm" disabled={Boolean(block) || busy === hk.id} title={block ?? undefined} onClick={() => setEditing(hk)}>
                Edit
              </button>
              <button className="btn ghost sm" disabled={Boolean(block) || busy === hk.id} title={block ?? undefined} onClick={() => toggle(hk)}>
                {hk.enabled ? 'Pause' : 'Resume'}
              </button>
              <button className="btn ghost sm" disabled={Boolean(block) || busy === hk.id} title={block ?? undefined} onClick={() => remove(hk)}>
                {Icons.trash}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {block ? (
        <div className="muted small readonly-why">{block}</div>
      ) : (
        <button className="btn primary sm" onClick={() => setEditing('new')}>
          {Icons.plus} Add webhook
        </button>
      )}
      {editing && <HookEditor meta={meta} scope={scope} hook={editing === 'new' ? null : editing} create={create} onClose={() => setEditing(null)} onSaved={onChanged} />}
    </div>
  );
}

/** Admin → Webhooks: organization-wide webhooks. */
export function AdminWebhooks() {
  const [data, setData] = useState<({ hooks: Hook[] } & Meta) | null>(null);
  const load = useCallback(() => {
    api.get<{ hooks: Hook[] } & Meta>('/api/admin/webhooks').then(setData).catch(() => undefined);
  }, []);
  useEffect(load, [load]);
  if (!data) return <div className="skeleton" />;
  return (
    <div className="admin-webhooks">
      <div className="alert info">
        <div>
          Global webhooks post about <strong>every incident</strong> (filtered by severity), for example declarations and status changes to a security leadership channel. The Incident
          Commander and room admins can also add webhooks for their own war room. Who may do that, and whether internal addresses are allowed, is in{' '}
          <a href="/admin?tab=settings&section=webhooks">Settings → Webhooks</a>.
        </div>
      </div>
      <HookList hooks={data.hooks} meta={data} scope="global" create="/api/admin/webhooks" block={null} onChanged={load} />
    </div>
  );
}

interface RoomData extends Meta {
  hooks: Hook[];
  global: { id: string; name: string; kindLabel: string; events: string[]; detail: string }[];
  manageBlock: string | null;
  postBlock: string | null;
}

/** War room → Webhooks: this room's webhooks, the organization-wide ones that apply, and posting an update. */
export function RoomWebhooksView({ state }: { state: IncidentState }) {
  const { toast } = useApp();
  const inc = state.incident;
  const [data, setData] = useState<RoomData | null>(null);
  const [text, setText] = useState('');
  const [targets, setTargets] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api.get<RoomData>(`/api/incidents/${inc.id}/webhooks`).then(setData).catch(() => undefined);
  }, [inc.id]);
  useEffect(load, [load]);

  const takers = data ? [...data.hooks.filter((x) => x.enabled && x.events.includes('update.posted')), ...data.global.filter((g) => g.events.includes('update.posted'))] : [];
  const chosen = targets ?? takers.map((t) => t.id);

  const post = async (e: FormEvent) => {
    e.preventDefault();
    if (!confirm(`Post this update to ${takers.filter((t) => chosen.includes(t.id)).map((t) => `“${t.name}”`).join(', ')}? It leaves War Room.`)) return;
    setBusy(true);
    try {
      const r = await api.post<{ sentTo: string[] }>(`/api/incidents/${inc.id}/webhooks/post`, { text: text.trim(), hookIds: chosen });
      toast({ text: `Update posted to ${r.sentTo.join(', ')}` }, 4000);
      setText('');
      load();
    } catch (err) {
      toast({ text: err instanceof ApiError ? err.message : 'Could not post the update', tone: 'error' }, 7000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="webhooks-view">
      <div className="view-head">
        <h2>{Icons.megaphone} Webhooks</h2>
        <span className="muted small">Post this incident’s updates to Slack, Discord, Mattermost, Teams or any endpoint.</span>
      </div>
      <div className="dash-scroll">
        {!data ? (
          <div className="skeleton" />
        ) : (
          <div className="webhooks-body">
            <section className="dash-card">
              <h3>{Icons.megaphone} Post an update</h3>
              {data.postBlock ? (
                <div className="muted small readonly-why">{data.postBlock}</div>
              ) : takers.length === 0 ? (
                <div className="muted small">No webhook takes updates from this war room yet. Add one below with “Updates posted from the war room” ticked.</div>
              ) : (
                <form className="form" onSubmit={post}>
                  <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} maxLength={3000} placeholder="Status: contained. Next update at 14:00 UTC." />
                  <div className="hook-targets">
                    {takers.map((t) => (
                      <label key={t.id} className="check">
                        <input type="checkbox" checked={chosen.includes(t.id)} onChange={(e) => setTargets(e.target.checked ? [...chosen, t.id] : chosen.filter((x) => x !== t.id))} /> {t.name}{' '}
                        <span className="muted small">({t.kindLabel}{'scope' in t ? '' : ', organization-wide'})</span>
                      </label>
                    ))}
                  </div>
                  <div className="row">
                    <span className="muted small">It goes on the timeline, with your name. Consider adding it to the Comms Log too.</span>
                    <div className="spacer" />
                    <button className="btn primary sm" disabled={busy || !text.trim() || !chosen.length}>
                      Post update
                    </button>
                  </div>
                </form>
              )}
            </section>

            <section className="dash-card">
              <h3>{Icons.link} This war room’s webhooks</h3>
              <HookList hooks={data.hooks} meta={data} scope="room" create={`/api/incidents/${inc.id}/webhooks`} block={data.manageBlock} onChanged={load} />
            </section>

            <section className="dash-card">
              <h3>{Icons.shield} Organization-wide</h3>
              {data.global.length === 0 ? (
                <div className="muted small">No global webhooks cover this incident.</div>
              ) : (
                <ul className="hook-list compact">
                  {data.global.map((g) => (
                    <li key={g.id}>
                      <div className="hook-main">
                        <div>
                          <strong>{g.name}</strong> <span className="hook-kind">{g.kindLabel}</span>
                          {g.detail === 'brief' && <span className="hook-kind">headline only</span>}
                        </div>
                        <div className="small">{g.events.map((k) => data.events.find((e) => e.key === k)?.label ?? (k === 'incident.declared' ? 'Incident declared' : k)).join(' · ')}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <div className="muted small">Set up by admins (Admin → Webhooks).</div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
