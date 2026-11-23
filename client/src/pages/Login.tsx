import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { api, ApiError } from '../lib/api';

type Provider = { id: 'okta' | 'entra'; label: string; protocol: 'oidc' | 'saml' };
type AuthConfig = { sso: boolean; providers: Provider[]; devAuth: boolean; emailLogin: boolean; emailCanSend: boolean; mode: 'now' | 'standard' };

const IDP_NAME: Record<string, string> = { okta: 'Okta', entra: 'Microsoft Entra ID' };

const ERRORS: Record<string, (idp: string) => string> = {
  not_provisioned: (idp) => `Your ${idp} account is not assigned to War Room. Ask your ${idp} admin to assign the app.`,
  inactive: () => 'Your War Room access has been deactivated.',
  revoked: () => 'Your access was revoked while you were signed in.',
  sso_unavailable: (idp) => `${idp} is unreachable right now. Try again in a moment.`,
  sso_failed: (idp) => `Sign-in with ${idp} failed. Try again.`,
  sso_not_configured: () => 'That sign-in method is not configured on this server.',
  login_expired: () => 'The sign-in attempt expired. Try again.',
  no_id_token: (idp) => `${idp} did not return an identity token.`,
  wrong_tenant: (idp) => `That account belongs to a different ${idp} directory than the one War Room trusts.`,
};

/** Turn a failed request into something a person can act on. */
function describeFailure(e: unknown) {
  if (e instanceof ApiError) {
    if (e.status >= 500 || e.status === 0) return "Can't reach the War Room server. Check that it's running, then try again.";
    return e.message;
  }
  return "Can't reach the War Room server. Check that it's running, then try again.";
}

/**
 * Where to go after signing in: a path on this site, or '/'. Resolved the way the browser will
 * resolve it, so `//host`, `/\host` and `/<tab>/host` (browsers drop tabs and newlines) can't leave.
 */
function safeReturnTo(raw: string | null): string {
  if (!raw || !raw.startsWith('/')) return '/';
  try {
    const u = new URL(raw, location.origin);
    return u.origin === location.origin ? `${u.pathname}${u.search}${u.hash}` : '/';
  } catch {
    return '/';
  }
}

export function Login() {
  const [params] = useSearchParams();
  const [cfg, setCfg] = useState<AuthConfig | null>(null);
  const [cfgErr, setCfgErr] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const error = params.get('error');
  const returnTo = safeReturnTo(params.get('returnTo'));
  const idp = IDP_NAME[params.get('provider') ?? ''] ?? 'your identity provider';

  // Opened from a war room link: people without an account can ask to join instead.
  const roomId = /^\/incidents\/([0-9a-f-]{36})$/.exec(returnTo)?.[1] ?? null;
  const [room, setRoom] = useState<{ incidentKey: string } | null>(null);
  useEffect(() => {
    if (roomId) api.get<{ incidentKey: string }>(`/auth/rooms/${roomId}`).then(setRoom).catch(() => setRoom(null));
  }, [roomId]);

  useEffect(() => {
    api
      .get<AuthConfig>('/auth/config')
      .then(setCfg)
      .catch(() => setCfgErr(true));
  }, []);

  const devLogin = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await api.post('/auth/dev-login', { name, email });
      location.href = returnTo;
    } catch (e) {
      setErr(describeFailure(e));
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <div>
            <h1>War Room</h1>
            <p className="muted">Incident response, together.</p>
          </div>
        </div>

        {room && (
          <p className="small">
            Sign in to join <span className="mono">{room.incidentKey}</span>.
          </p>
        )}
        {error && <div className="alert error">{ERRORS[error]?.(idp) ?? 'Sign-in failed.'}</div>}
        {cfgErr && <div className="alert error">{describeFailure(null)}</div>}

        {cfg?.providers.map((p, i) => (
          <a
            key={p.id}
            className={`btn ${i === 0 ? 'primary' : 'secondary'} lg block sso-btn`}
            href={`/auth/login?provider=${p.id}&returnTo=${encodeURIComponent(returnTo)}`}
          >
            Sign in with {p.label}
          </a>
        ))}
        {cfg?.emailLogin && <EmailLogin returnTo={returnTo} first={!cfg.sso} canSend={cfg.emailCanSend} />}
        {cfg && !cfg.sso && !cfg.devAuth && !cfg.emailLogin && (
          <div className="alert warn">
            {cfg.mode === 'now'
              ? 'This is a temporary War Room. Join with the invite link you were sent; the admin can set up email so people can sign back in.'
              : 'Single sign-on isn’t set up yet. An admin can set up Okta or Microsoft Entra ID under Admin → Settings.'}
          </div>
        )}

        {room && roomId && (
          <>
            <div className="divider">
              <span>No account?</span>
            </div>
            <a className="btn secondary block" href={`/ask/${roomId}`}>
              Ask to join {room.incidentKey}
            </a>
          </>
        )}

        {cfg?.devAuth && (
          <form className="dev-login" onSubmit={devLogin}>
            <div className="divider">
              <span>Developer sign-in</span>
            </div>
            <label>
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Alex Rivera" required />
            </label>
            <label>
              Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="alex@example.com" required />
            </label>
            {err && <div className="alert error">{err}</div>}
            <button className="btn secondary block" type="submit">
              Continue
            </button>
            <p className="hint">Dev login is enabled because DEV_AUTH is on. Turn it off in production.</p>
          </form>
        )}
      </div>
    </div>
  );
}

/** Sign in with a one-time code sent to your email (accounts not linked to Okta or Entra). */
function EmailLogin({ returnTo, first, canSend }: { returnTo: string; first: boolean; canSend: boolean }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  // Without email, people get a sign-in code from an admin, so go straight to entering it.
  const [sent, setSent] = useState(!canSend);
  const [given, setGiven] = useState(!canSend);
  const [cooldown, setCooldown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const r = await api.post<{ resendAfter: number }>('/auth/email/code', { email: email.trim() });
      setSent(true);
      setCooldown(r.resendAfter);
    } catch (x) {
      setErr(describeFailure(x));
    } finally {
      setBusy(false);
    }
  };
  const verify = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await api.post('/auth/email/verify', { email: email.trim(), code });
      location.href = returnTo;
    } catch (x) {
      setErr(describeFailure(x));
      setBusy(false);
    }
  };

  return (
    <form className="dev-login" onSubmit={sent ? verify : send}>
      {!first && (
        <div className="divider">
          <span>Or sign in with email</span>
        </div>
      )}
      {!sent ? (
        <>
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="email" required autoFocus={first} />
          </label>
          {err && <div className="alert error">{err}</div>}
          <button className={`btn ${first ? 'primary lg' : 'secondary'} block`} disabled={busy || !email.trim()}>
            Email me a sign-in code
          </button>
          <p className="hint">For people invited to this War Room by email. You’ll get a 6-digit code that works once.</p>
          <button type="button" className="link-btn small" onClick={() => (setSent(true), setGiven(true), setErr(null))}>
            I already have a code
          </button>
        </>
      ) : (
        <>
          {given ? (
            <>
              <label>
                Email
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="email" required autoFocus />
              </label>
              <div className="small muted">
                {canSend ? 'Enter the sign-in code an admin or the person running your room gave you.' : 'This War Room doesn’t send email: ask the person running your room (or an admin) for a sign-in code, then enter it here.'}
              </div>
            </>
          ) : (
            <div className="small">
              If <strong>{email}</strong> has a War Room account, a code is on its way. It works once and expires in 10 minutes.
            </div>
          )}
          <input
            className="code-input mono"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            maxLength={7}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ''))}
            aria-label="Sign-in code"
            autoFocus={!given}
          />
          {err && <div className="alert error">{err}</div>}
          <button className="btn primary lg block" disabled={busy || !email.trim() || code.replace(/\D/g, '').length !== 6}>
            Sign in
          </button>
          {canSend && (
            <div className="row">
              {!given && (
                <button type="button" className="btn ghost sm" onClick={() => send()} disabled={busy || cooldown > 0}>
                  {cooldown > 0 ? `Send a new code in ${cooldown}s` : 'Send a new code'}
                </button>
              )}
              <button type="button" className="btn ghost sm" onClick={() => (setSent(false), setGiven(false), setCode(''), setErr(null))}>
                {given ? 'Email me a code instead' : 'Use a different email'}
              </button>
            </div>
          )}
        </>
      )}
    </form>
  );
}
