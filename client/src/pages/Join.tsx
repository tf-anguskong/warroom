import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { SeverityBadge } from '../components/ui';
import type { GuestScopeSummary, Severity, User } from '../types';

interface InviteInfo {
  status: 'ok' | 'resume' | 'used' | 'expired' | 'revoked' | 'closed' | 'invalid';
  incidentKey?: string;
  incidentTitle?: string;
  severity?: Severity;
  label?: string;
  org?: string;
  note?: string;
  invitedBy?: string;
  accessHours?: number;
  accessEndsAt?: string | null;
  linkExpiresAt?: string;
  requiresCode?: boolean;
  email?: string | null;
  devOutbox?: boolean;
  scope?: GuestScopeSummary & { incidentId: string };
}

const DEAD: Record<string, string> = {
  used: 'This invite link has already been used. Links work once. Ask the person who invited you for a new one.',
  expired: 'This invite link has expired. Ask the person who invited you for a new one.',
  revoked: 'This invite was cancelled.',
  closed: 'This incident has been resolved, so guest access is closed.',
  invalid: 'This link isn’t valid. Check that you copied all of it.',
};

/**
 * Landing page for a guest invite. Opening it doesn't use it (mail scanners open links). If the
 * invite has an email, we send a one-time code there and the guest must enter it to join, or to
 * sign back in later with the same link.
 */
export function Join() {
  const { token } = useParams();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [me, setMe] = useState<User | null | undefined>(undefined);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState<{ to: string; minutes: number } | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const codeBox = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .get<InviteInfo>(`/auth/invite/${token}`)
      .then((i) => {
        setInfo(i);
        setName(i.label ?? '');
      })
      .catch(() => setInfo({ status: 'invalid' }));
    fetch('/api/me', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((r) => setMe(r?.user ?? null))
      .catch(() => setMe(null));
  }, [token]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const sendCode = async () => {
    setErr(null);
    setBusy(true);
    try {
      const r = await api.post<{ sentTo: string; expiresInMinutes: number; resendAfter: number }>(`/auth/invite/${token}/code`);
      setSent({ to: r.sentTo, minutes: r.expiresInMinutes });
      setCode('');
      setCooldown(r.resendAfter);
      requestAnimationFrame(() => codeBox.current?.focus());
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not send the code');
    } finally {
      setBusy(false);
    }
  };

  const resume = info?.status === 'resume';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = resume
        ? await api.post<{ incidentId: string }>(`/auth/invite/${token}/resume`, { code })
        : await api.post<{ incidentId: string }>(`/auth/invite/${token}/accept`, { displayName: name.trim(), code });
      location.href = `/incidents/${r.incidentId}`;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not join. Try again.');
      setBusy(false);
    }
  };

  const s = info?.scope;
  const alreadyMember = me && !me.isGuest;
  const needsCode = Boolean(info?.requiresCode);
  const canSubmit = !busy && (resume || name.trim()) && (!needsCode || code.replace(/\D/g, '').length === 6);

  return (
    <div className="login-page">
      <div className="login-card join-card">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <div>
            <h1>War Room</h1>
            <p className="muted">{resume ? 'Guest sign-in' : 'Guest invitation'}</p>
          </div>
        </div>

        {!info ? (
          <div className="skeleton" />
        ) : info.status !== 'ok' && info.status !== 'resume' ? (
          <div className="alert error">{DEAD[info.status]}</div>
        ) : alreadyMember ? (
          <>
            <div className="alert info">
              <div>
                You’re signed in as <strong>{me.displayName}</strong>, who already has access. This link is meant for a guest and hasn’t been used.
              </div>
            </div>
            <a className="btn primary lg block" href={`/incidents/${s?.incidentId}`}>
              Open the war room
            </a>
          </>
        ) : (
          <form className="form" onSubmit={submit}>
            <div className="join-incident">
              <span className="mono muted">{info.incidentKey}</span>
              {info.severity && <SeverityBadge severity={info.severity} />}
              <strong>{info.incidentTitle}</strong>
            </div>
            {resume ? (
              <p className="small">
                Welcome back, <strong>{info.label}</strong>. Your guest access lasts until {info.accessEndsAt?.slice(11, 16)} UTC. Confirm it’s you with a code sent to{' '}
                <strong>{info.email}</strong>.
              </p>
            ) : (
              <>
                <p className="small">
                  <strong>{info.invitedBy}</strong> invited {info.label}
                  {info.org ? ` (${info.org})` : ''} to help with this incident{info.note ? `: ${info.note}` : '.'}
                </p>
                <div className="join-scope">
                  <div className="muted small">You’ll be able to see</div>
                  <ul>
                    {s?.channels.map((c) => <li key={c.id}># {c.name}</li>)}
                    {s?.voiceRooms.map((v) => <li key={v.id}>🔊 {v.name}</li>)}
                    {s?.sheets.map((x) => <li key={x.id}>▦ {x.name}</li>)}
                    {s?.notes?.map((x) => <li key={x.id}>📝 {x.name}</li>)}
                    {s?.timeline && <li>🕑 Incident timeline</li>}
                  </ul>
                </div>
                <label>
                  Your name, as others will see it
                  <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
                </label>
              </>
            )}

            {needsCode && (
              <div className="code-step">
                {!sent ? (
                  <>
                    <div className="small">
                      To {resume ? 'sign in' : 'join'}, we’ll email a 6-digit code to <strong>{info.email}</strong>.
                    </div>
                    <button type="button" className="btn primary block" onClick={sendCode} disabled={busy}>
                      Email me a code
                    </button>
                  </>
                ) : (
                  <>
                    <div className="small">
                      We sent a code to <strong>{sent.to}</strong>. It works once and expires in {sent.minutes} minutes.
                      {info.devOutbox && <span className="muted"> (Development: no SMTP server, so the code is in the server log.)</span>}
                    </div>
                    <input
                      ref={codeBox}
                      className="code-input mono"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="123456"
                      maxLength={7}
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ''))}
                      aria-label="Code from the email"
                    />
                    <button type="button" className="btn ghost sm" onClick={sendCode} disabled={busy || cooldown > 0}>
                      {cooldown > 0 ? `Send a new code in ${cooldown}s` : 'Send a new code'}
                    </button>
                  </>
                )}
              </div>
            )}

            {err && <div className="alert error">{err}</div>}
            {(!needsCode || sent) && (
              <button className="btn primary lg block" disabled={!canSubmit}>
                {resume ? 'Sign in' : 'Join as guest'}
              </button>
            )}
            <p className="hint">
              {resume
                ? 'Each code works once. Requesting a new code cancels the previous one.'
                : `This link works once. Your access lasts ${info.accessHours} hours and ends early if the incident is resolved or the Incident Commander ends it. Everyone in the room will see that you are a guest.`}
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
