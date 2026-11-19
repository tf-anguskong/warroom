import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';

type Provider = { id: 'okta' | 'entra'; label: string; protocol: 'oidc' | 'saml' };
type AuthConfig = { sso: boolean; providers: Provider[]; devAuth: boolean };

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

export function Login() {
  const [params] = useSearchParams();
  const [cfg, setCfg] = useState<AuthConfig | null>(null);
  const [cfgErr, setCfgErr] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const error = params.get('error');
  const returnTo = params.get('returnTo') ?? '/';
  const idp = IDP_NAME[params.get('provider') ?? ''] ?? 'your identity provider';

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
      location.href = returnTo.startsWith('/') ? returnTo : '/';
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
        {cfg && !cfg.sso && !cfg.devAuth && (
          <div className="alert warn">Single sign-on isn’t set up yet. An admin can set up Okta or Microsoft Entra ID under Admin → Settings.</div>
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
