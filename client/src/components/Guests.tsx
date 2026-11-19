import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { getSocket } from '../lib/socket';
import type { Guest, GuestScopeSummary, IncidentState, User } from '../types';
import { Avatar, Icons, Modal } from './ui';

/** Unmissable "this person is a guest" marker, used everywhere a name appears. */
export function GuestTag({ user }: { user?: Pick<User, 'isGuest' | 'guestOrg'> | null }) {
  if (!user?.isGuest) return null;
  return (
    <span className="guest-tag" title={`Guest from outside the organization${user.guestOrg ? ` (${user.guestOrg})` : ''}`}>
      guest{user.guestOrg ? ` · ${user.guestOrg}` : ''}
    </span>
  );
}

interface Scope {
  channels: string[];
  voiceRooms: string[];
  sheets: string[];
  timeline: boolean;
}
const toIds = (s?: GuestScopeSummary): Scope => ({
  channels: s?.channels.map((c) => c.id) ?? [],
  voiceRooms: s?.voiceRooms.map((v) => v.id) ?? [],
  sheets: s?.sheets.map((x) => x.id) ?? [],
  timeline: s?.timeline ?? false,
});

/** Checklist of what a guest can see. Nothing is included unless ticked. */
function ScopePicker({ state, scope, onChange }: { state: IncidentState; scope: Scope; onChange: (s: Scope) => void }) {
  const toggle = (key: 'channels' | 'voiceRooms' | 'sheets', id: string) =>
    onChange({ ...scope, [key]: scope[key].includes(id) ? scope[key].filter((x) => x !== id) : [...scope[key], id] });
  const group = (title: string, key: 'channels' | 'voiceRooms' | 'sheets', items: { id: string; name: string; prefix: string }[]) => (
    <fieldset className="scope-group">
      <legend>{title}</legend>
      {items.length === 0 && <span className="muted small">None in this war room</span>}
      {items.map((i) => (
        <label key={i.id} className="check">
          <input type="checkbox" checked={scope[key].includes(i.id)} onChange={() => toggle(key, i.id)} /> {i.prefix}
          {i.name}
        </label>
      ))}
    </fieldset>
  );
  return (
    <div className="scope-picker">
      {group('Channels', 'channels', state.channels.map((c) => ({ id: c.id, name: c.name, prefix: '# ' })))}
      {group('Voice rooms', 'voiceRooms', state.voiceRooms.map((v) => ({ id: v.id, name: v.name, prefix: '' })))}
      {group('Sheets', 'sheets', state.sheets.map((s) => ({ id: s.id, name: s.name, prefix: '' })))}
      <fieldset className="scope-group">
        <legend>Other</legend>
        <label className="check">
          <input type="checkbox" checked={scope.timeline} onChange={(e) => onChange({ ...scope, timeline: e.target.checked })} /> Incident timeline (read and add notes)
        </label>
      </fieldset>
    </div>
  );
}

function InviteDialog({ state, onClose }: { state: IncidentState; onClose: () => void }) {
  const { toast, meta } = useApp();
  const [email, setEmail] = useState('');
  const main = state.voiceRooms.find((v) => v.kind === 'main');
  const general = state.channels.find((c) => c.name === 'general') ?? state.channels[0];
  const [label, setLabel] = useState('');
  const [org, setOrg] = useState('');
  const [note, setNote] = useState('');
  const [linkHours, setLinkHours] = useState(24);
  const [accessHours, setAccessHours] = useState(12);
  const [scope, setScope] = useState<Scope>({ channels: general ? [general.id] : [], voiceRooms: main ? [main.id] : [], sheets: [], timeline: false });
  const [created, setCreated] = useState<{ url: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      setCreated(await api.post<{ url: string; expiresAt: string }>(`/api/incidents/${state.incident.id}/invites`, { label, org, note, linkHours, accessHours, scope, email: email.trim() }));
    } catch (err) {
      toast({ text: err instanceof Error ? err.message : 'Could not create the invite', tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <Modal title="Invite link ready" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
        <div className="form">
          <div className="alert warn">
            <div>
            Copy it now: the link is shown only once.{email.trim() && <> Joining also needs a code we email to <strong>{email.trim()}</strong>, so the link alone isn’t enough.</>} It works <strong>one time</strong>, until {new Date(created.expiresAt).toUTCString().slice(17, 22)} UTC{' '}
            {new Date(created.expiresAt).toDateString() !== new Date().toDateString() ? `on ${created.expiresAt.slice(0, 10)}` : 'today'}. Whoever opens it first gets in, so send it
            directly to {label}.
            </div>
          </div>
          <div className="invite-url">
            <input readOnly value={created.url} onFocus={(e) => e.target.select()} className="mono" />
            <button
              className="btn primary"
              onClick={() => {
                navigator.clipboard.writeText(created.url);
                toast({ text: 'Invite link copied' }, 2000);
              }}
            >
              Copy
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  const nothing = !scope.channels.length && !scope.voiceRooms.length && !scope.sheets.length;
  return (
    <Modal
      title="Invite a guest"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" form="invite" disabled={busy || !label.trim() || nothing || (meta.guestEmail.required && !email.trim())}>
            Create single-use link
          </button>
        </>
      }
    >
      <form id="invite" className="form" onSubmit={submit}>
        <p className="muted small">
          For people outside {`your identity provider`}: vendors, outside IR firms, counsel. They see only what you tick below, and everyone in the room sees they’re a
          guest.
        </p>
        <div className="row2">
          <label>
            Guest name
            <input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Dana Kim" maxLength={80} />
          </label>
          <label>
            Organization
            <input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="Outside IR firm" maxLength={80} />
          </label>
        </div>
        {meta.guestEmail.enabled ? (
          <label>
            Guest email {meta.guestEmail.required ? '' : <span className="muted">(recommended)</span>}
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="dana@outside-ir.example" maxLength={254} />
            <span className="muted small">
              When they open the link we email a one-time code to this address; they need it to join or to sign back in.
              {meta.guestEmail.dev && ' (No SMTP server is set up: in development the code is printed in the server log.)'}
            </span>
          </label>
        ) : (
          <div className="alert info small">
            <div>Email verification is off because no SMTP server is configured, so anyone holding the link can join. An admin can set up email under Admin → Settings → Email to require an emailed code.</div>
          </div>
        )}
        <label>
          Why they’re joining
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Malware reverse engineering support" maxLength={300} />
        </label>
        <div className="muted small">They can see</div>
        <ScopePicker state={state} scope={scope} onChange={setScope} />
        <div className="row2">
          <label>
            Link works for
            <select value={linkHours} onChange={(e) => setLinkHours(Number(e.target.value))}>
              {[1, 4, 8, 24, 72].map((h) => (
                <option key={h} value={h}>
                  {h} hour{h > 1 ? 's' : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            Access lasts
            <select value={accessHours} onChange={(e) => setAccessHours(Number(e.target.value))}>
              {[2, 4, 8, 12, 24, 72].map((h) => (
                <option key={h} value={h}>
                  {h} hours after joining
                </option>
              ))}
            </select>
          </label>
        </div>
        {nothing && <div className="warn-text small">Tick at least one channel, voice room or sheet.</div>}
      </form>
    </Modal>
  );
}

function AccessDialog({ state, guest, onClose }: { state: IncidentState; guest: Guest; onClose: () => void }) {
  const { toast } = useApp();
  const [scope, setScope] = useState<Scope>(toIds(guest.scope));
  const save = async () => {
    try {
      await api.put(`/api/incidents/${state.incident.id}/guests/${guest.id}/scope`, { scope });
      toast({ text: `Updated ${guest.displayName}'s access` }, 2500);
      onClose();
    } catch (err) {
      toast({ text: err instanceof Error ? err.message : 'Could not save', tone: 'error' });
    }
  };
  return (
    <Modal
      title={`What ${guest.displayName} can see`}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save access
          </button>
        </>
      }
    >
      <div className="form">
        <p className="muted small">Changes apply immediately, and are recorded on the timeline.</p>
        <ScopePicker state={state} scope={scope} onChange={setScope} />
      </div>
    </Modal>
  );
}

interface Invite {
  id: string;
  label: string;
  org: string;
  status: 'ok' | 'used' | 'expired' | 'revoked' | 'closed';
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  usedBy: string | null;
  email: string | null;
}

const hhmm = (iso: string | null) => (iso ? `${iso.slice(11, 16)} UTC` : '');

/** Right-pane section: who the guests are, what they can see, and (for the IC / room admins) invites. */
export function GuestsSection({ state }: { state: IncidentState }) {
  const { userById, toast } = useApp();
  const [invites, setInvites] = useState<Invite[]>([]);
  const [dialog, setDialog] = useState<null | 'invite' | { access: Guest }>(null);
  const manage = state.canControl;

  const load = useCallback(() => {
    if (manage) api.get<{ invites: Invite[] }>(`/api/incidents/${state.incident.id}/invites`).then((r) => setInvites(r.invites)).catch(() => undefined);
  }, [manage, state.incident.id]);
  useEffect(() => {
    load();
    const s = getSocket();
    s.on('incident:refresh', load);
    return () => {
      s.off('incident:refresh', load);
    };
  }, [load]);

  const active = state.guests.filter((g) => g.active);
  const pending = invites.filter((i) => i.status === 'ok');
  if (!manage && active.length === 0) return null;

  const end = async (g: Guest) => {
    if (!confirm(`End ${g.displayName}'s guest access now? They are signed out and removed from voice.`)) return;
    await api.post(`/api/incidents/${state.incident.id}/guests/${g.id}/revoke`).catch((e) => toast({ text: e.message, tone: 'error' }));
  };

  return (
    <section>
      <div className="section-head">
        <h3>
          Guests <span className="count">{active.length}</span>
        </h3>
        {manage && state.incident.status !== 'resolved' && (
          <button className="btn ghost sm" onClick={() => setDialog('invite')}>
            {Icons.link} Invite guest
          </button>
        )}
      </div>
      {active.length === 0 && <p className="muted small">No guests. Invite people outside the organization with a single-use link.</p>}
      <ul className="guest-list">
        {active.map((g) => (
          <li key={g.id}>
            <div className="guest-row">
              <Avatar id={g.id} name={g.displayName} size={22} />
              <span className="guest-name">
                {g.displayName} <GuestTag user={g} />
                <div className="muted small">
                  Invited by {userById(g.invitedBy)?.displayName ?? 'someone'} · until {hhmm(g.guestExpiresAt)}
                </div>
              </span>
            </div>
            {g.scope && (
              <div className="guest-scope small">
                {[...g.scope.channels.map((c) => `#${c.name}`), ...g.scope.voiceRooms.map((v) => v.name), ...g.scope.sheets.map((x) => x.name), ...(g.scope.timeline ? ['Timeline'] : [])].join(' · ') ||
                  'No access'}
              </div>
            )}
            {manage && (
              <div className="row gap-sm">
                <button className="btn ghost sm" onClick={() => setDialog({ access: g })}>
                  Change access
                </button>
                <button className="btn ghost sm danger-text" onClick={() => end(g)}>
                  End access
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {manage && pending.length > 0 && (
        <>
          <div className="muted small pending-head">Unused invite links</div>
          <ul className="guest-list">
            {pending.map((i) => (
              <li key={i.id} className="pending">
                <span>
                  {i.label}
                  {i.org && <span className="muted"> · {i.org}</span>}
                  {i.email && <div className="muted small mono">{i.email}</div>}
                  <div className="muted small">
                    by {userById(i.createdBy)?.displayName ?? 'someone'} · expires {hhmm(i.expiresAt)}
                  </div>
                </span>
                <button
                  className="btn ghost sm"
                  onClick={() => api.del(`/api/invites/${i.id}`).then(load).catch((e) => toast({ text: e.message, tone: 'error' }))}
                >
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {dialog === 'invite' && <InviteDialog state={state} onClose={() => setDialog(null)} />}
      {dialog && typeof dialog === 'object' && <AccessDialog state={state} guest={dialog.access} onClose={() => setDialog(null)} />}
    </section>
  );
}
