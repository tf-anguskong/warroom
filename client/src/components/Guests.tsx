import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { getSocket } from '../lib/socket';
import type { Guest, GuestScopeSummary, IncidentState, User } from '../types';
import { useSignInCode } from './SignInCode';
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

export interface Scope {
  channels: string[];
  voiceRooms: string[];
  sheets: string[];
  notes: string[];
  timeline: boolean;
}
const toIds = (s?: GuestScopeSummary): Scope => ({
  channels: s?.channels.map((c) => c.id) ?? [],
  voiceRooms: s?.voiceRooms.map((v) => v.id) ?? [],
  sheets: s?.sheets.map((x) => x.id) ?? [],
  notes: s?.notes?.map((x) => x.id) ?? [],
  timeline: s?.timeline ?? false,
});

/** Checklist of what a guest can see. Nothing is included unless ticked. */
export function ScopePicker({ state, scope, onChange }: { state: IncidentState; scope: Scope; onChange: (s: Scope) => void }) {
  const toggle = (key: 'channels' | 'voiceRooms' | 'sheets' | 'notes', id: string) =>
    onChange({ ...scope, [key]: scope[key].includes(id) ? scope[key].filter((x) => x !== id) : [...scope[key], id] });
  const group = (title: string, key: 'channels' | 'voiceRooms' | 'sheets' | 'notes', items: { id: string; name: string; prefix: string }[]) => (
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
      {group('Notes', 'notes', state.notes.map((n) => ({ id: n.id, name: n.name, prefix: '' })))}
      <fieldset className="scope-group">
        <legend>Other</legend>
        <label className="check">
          <input type="checkbox" checked={scope.timeline} onChange={(e) => onChange({ ...scope, timeline: e.target.checked })} /> Incident timeline (read and add notes)
        </label>
      </fieldset>
    </div>
  );
}

/** Why this person can't add responders right now (no email to check the address), or null. */
export function responderBlock(isAdmin: boolean, meta: { mode?: string; guestEmail: { enabled: boolean } }) {
  if (isAdmin || meta.mode === 'now' || meta.guestEmail.enabled) return null;
  return 'This War Room can’t send email, so a responder’s address can’t be checked: only an admin can add responders. Invite them as a guest, or ask an admin.';
}

export function InviteDialog({ state, onClose }: { state: IncidentState; onClose: () => void }) {
  const { toast, meta, me } = useApp();
  // Full responders (accounts) can be invited by admins and whoever runs the room.
  const canInviteMembers = me.isAdmin || state.canControl;
  // Without email the address on a new account can't be checked, so only admins add responders then.
  const memberBlocked = canInviteMembers ? responderBlock(me.isAdmin, meta) : null;
  const [kind, setKind] = useState<'member' | 'guest'>(canInviteMembers && !memberBlocked && meta.mode === 'now' ? 'member' : 'guest');
  const member = kind === 'member';
  const [email, setEmail] = useState('');
  const main = state.voiceRooms.find((v) => v.kind === 'main');
  const general = state.channels.find((c) => c.name === 'general') ?? state.channels[0];
  const [label, setLabel] = useState('');
  const [org, setOrg] = useState('');
  const [note, setNote] = useState('');
  const [linkHours, setLinkHours] = useState(24);
  const [accessHours, setAccessHours] = useState(12);
  const [scope, setScope] = useState<Scope>({ channels: general ? [general.id] : [], voiceRooms: main ? [main.id] : [], sheets: [], notes: [], timeline: false });
  const [created, setCreated] = useState<{ url: string; expiresAt: string; code: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      setCreated(
        await api.post<{ url: string; expiresAt: string; code: string | null }>(`/api/incidents/${state.incident.id}/invites`, {
          kind,
          label,
          org,
          note,
          linkHours,
          accessHours,
          scope,
          email: email.trim(),
        }),
      );
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
            Copy it now: the link is shown only once.{created.code ? <> Joining also needs the <strong>code below</strong>, so the link alone isn’t enough.</> : email.trim() && <> Joining also needs a code we email to <strong>{email.trim()}</strong>, so the link alone isn’t enough.</>} It works <strong>one time</strong>, until {new Date(created.expiresAt).toUTCString().slice(17, 22)} UTC{' '}
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
          {created.code && (
            <div className="invite-code">
              <div className="muted small">Join code for {label}</div>
              <div className="code-big mono">{created.code.replace(/(\d{3})(\d{3})/, '$1 $2')}</div>
              <div className="small">
                This War Room can’t send email, so <strong>you</strong> give {label} this code. Send it a different way from the link (for example the link by
                email and the code by text message or a call), so someone who only sees one of them can’t get in. It works until the link expires; 5 wrong tries
                lock it. Lost it? Use <strong>New code</strong> next to the invite.
              </div>
            </div>
          )}
        </div>
      </Modal>
    );
  }

  const nothing = !scope.channels.length && !scope.voiceRooms.length && !scope.sheets.length && !scope.notes.length;
  return (
    <Modal
      title={member ? 'Invite a responder' : 'Invite a guest'}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            form="invite"
            disabled={busy || !label.trim() || (!member && nothing) || (member && !email.trim()) || (!member && meta.guestEmail.required && !email.trim())}
          >
            Create single-use link
          </button>
        </>
      }
    >
      <form id="invite" className="form" onSubmit={submit}>
        {canInviteMembers && (
          <div className="seg kind-seg" role="radiogroup" aria-label="Invite as">
            <button type="button" className={member ? 'on' : ''} onClick={() => setKind('member')} disabled={Boolean(memberBlocked)} title={memberBlocked ?? undefined}>
              Responder
            </button>
            <button type="button" className={!member ? 'on' : ''} onClick={() => setKind('guest')}>
              Guest
            </button>
          </div>
        )}
        {memberBlocked && <p className="muted small">{memberBlocked}</p>}
        <p className="muted small">
          {member
            ? 'A full member of the response team: sees the whole room, can take roles and tasks, and can sign back in later with a code. Use for your own people.'
            : 'For people outside your team: vendors, outside IR firms, counsel. They see only what you tick below, their access ends on its own, and everyone in the room sees they’re a guest.'}
        </p>
        <div className="row2">
          <label>
            {member ? 'Name' : 'Guest name'}
            <input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Dana Kim" maxLength={80} />
          </label>
          <label>
            {member ? 'Team / title' : 'Organization'}
            <input
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              placeholder={member ? 'Network team · Firewall engineer' : 'Outside IR firm'}
              maxLength={80}
            />
          </label>
        </div>
        {member && !meta.guestEmail.enabled ? (
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="dana@company.com" maxLength={254} />
            <span className="muted small">Their account name. This War Room can’t send email, so you’ll get a join code to give them.</span>
          </label>
        ) : meta.guestEmail.enabled ? (
          <label>
            {member ? 'Email' : 'Guest email'} {meta.guestEmail.required || member ? '' : <span className="muted">(recommended)</span>}
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="dana@outside-ir.example" maxLength={254} />
            <span className="muted small">
              When they open the link we email a one-time code to this address; they need it to join or to sign back in.
              {meta.guestEmail.dev && ' (No SMTP server is set up: in development the code is printed in the server log.)'}
            </span>
          </label>
        ) : (
          <div className="alert info small">
            <div>This War Room can’t send email, so you’ll get a 6-digit join code with the link. Give it to the guest a different way from the link. (An admin can set up email under Admin → Settings → Email.)</div>
          </div>
        )}
        <label>
          Why they’re joining
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Malware reverse engineering support" maxLength={300} />
        </label>
        {!member && (
          <>
            <div className="muted small">They can see</div>
            <ScopePicker state={state} scope={scope} onChange={setScope} />
          </>
        )}
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
          {!member && <label>
            Access lasts
            <select value={accessHours} onChange={(e) => setAccessHours(Number(e.target.value))}>
              {[2, 4, 8, 12, 24, 72].map((h) => (
                <option key={h} value={h}>
                  {h} hours after joining
                </option>
              ))}
            </select>
          </label>}
        </div>
        {!member && nothing && <div className="warn-text small">Tick at least one channel, voice room, sheet or note.</div>}
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
  kind?: 'guest' | 'member';
  codeMode?: 'email' | 'manual';
}

/** Shows a code the inviter passes on themselves (no email, lost code, or signing back in). */
function CodeDialog({ info, onClose }: { info: { code: string; forName: string; expiresInMinutes: number; signBackIn: boolean }; onClose: () => void }) {
  return (
    <Modal title={`Code for ${info.forName}`} onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      <div className="invite-code">
        <div className="code-big mono">{info.code.replace(/(\d{3})(\d{3})/, '$1 $2')}</div>
        <div className="small">
          Give this to {info.forName} directly (call, text, chat). {info.signBackIn ? 'They open their original invite link and enter it to sign back in.' : 'They enter it after opening their invite link.'}{' '}
          It replaces any earlier code and works for {info.expiresInMinutes >= 120 ? `${Math.round(info.expiresInMinutes / 60)} hours` : `${info.expiresInMinutes} minutes`}.
        </div>
      </div>
    </Modal>
  );
}

const hhmm = (iso: string | null) => (iso ? `${iso.slice(11, 16)} UTC` : '');

/** Right-pane section: who the guests are, what they can see, and (for the IC / room admins) invites. */
export function GuestsSection({ state }: { state: IncidentState }) {
  const { userById, toast } = useApp();
  const [invites, setInvites] = useState<Invite[]>([]);
  const { me, meta } = useApp();
  const [dialog, setDialog] = useState<null | 'invite' | { access: Guest }>(null);
  const [codeInfo, setCodeInfo] = useState<{ code: string; forName: string; expiresInMinutes: number; signBackIn: boolean } | null>(null);
  const manage = state.canControl;
  const signIn = useSignInCode(state.incident.id);
  const canInviteMembers = me.isAdmin || manage;
  const newCode = (inviteId: string) =>
    api
      .post<{ code: string; forName: string; expiresInMinutes: number; signBackIn: boolean }>(`/api/invites/${inviteId}/code`)
      .then(setCodeInfo)
      .catch((e) => toast({ text: e.message, tone: 'error' }, 6000));

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

      </div>
      {active.length === 0 && <p className="muted small">No guests. Use Invite at the top of the room to add someone outside your team.</p>}
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
                {[...g.scope.channels.map((c) => `#${c.name}`), ...g.scope.voiceRooms.map((v) => v.name), ...g.scope.sheets.map((x) => x.name), ...(g.scope.notes ?? []).map((x) => x.name), ...(g.scope.timeline ? ['Timeline'] : [])].join(' · ') ||
                  'No access'}
              </div>
            )}
            {manage && (
              <div className="row gap-sm">
                <button className="btn ghost sm" onClick={() => setDialog({ access: g })}>
                  Change access
                </button>
                {(() => {
                  const block = state.members.find((m) => m.userId === g.id)?.codeBlock;
                  return (
                    block !== undefined && (
                      <button
                        className="btn ghost sm"
                        disabled={block !== null}
                        title={block ?? 'A new link and one-time code to get back in (dropped off, new device). The old link stops working.'}
                        onClick={() => signIn.request(g.id, g.displayName)}
                      >
                        Sign-in code
                      </button>
                    )
                  );
                })()}
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
                  {i.kind === 'member' && <span className="tag">responder</span>}
                  {i.org && <span className="muted"> · {i.org}</span>}
                  {i.email && <div className="muted small mono">{i.email}</div>}
                  <div className="muted small">
                    by {userById(i.createdBy)?.displayName ?? 'someone'} · expires {hhmm(i.expiresAt)}
                  </div>
                </span>
                <span className="row gap-sm">
                  <button className="btn ghost sm" title="Make a new join code to give them yourself" onClick={() => newCode(i.id)}>
                    New code
                  </button>
                  <button
                    className="btn ghost sm"
                    onClick={() => api.del(`/api/invites/${i.id}`).then(load).catch((e) => toast({ text: e.message, tone: 'error' }))}
                  >
                    Cancel
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {dialog === 'invite' && <InviteDialog state={state} onClose={() => (setDialog(null), load())} />}
      {codeInfo && <CodeDialog info={codeInfo} onClose={() => setCodeInfo(null)} />}
      {signIn.dialog}
      {dialog && typeof dialog === 'object' && <AccessDialog state={state} guest={dialog.access} onClose={() => setDialog(null)} />}
    </section>
  );
}
