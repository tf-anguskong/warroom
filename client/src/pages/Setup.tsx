import { useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';

interface SetupInfo {
  status: 'ok' | 'used' | 'expired' | 'invalid';
  purpose?: 'first-run' | 'recovery';
  admins?: number;
  publicUrl?: string;
  askPublicUrl?: boolean;
}

const DEAD: Record<string, string> = {
  used: 'This setup link was already used. Run “npm run setup-link” on the server for a new one.',
  expired: 'This setup link has expired. Restart the server or run “npm run setup-link” for a new one.',
  invalid: 'This setup link isn’t valid. Check that you copied all of it from the server log.',
};

/** One-time admin sign-in from a link printed by the server: the first admin, or recovery. */
export function Setup() {
  const { token } = useParams();
  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [publicUrl, setPublicUrl] = useState(location.origin);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<SetupInfo>(`/auth/setup/${token}`)
      .then(setInfo)
      .catch(() => setInfo({ status: 'invalid' }));
  }, [token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ redirect: string }>(`/auth/setup/${token}`, {
        name: name.trim(),
        email: email.trim(),
        publicUrl: info?.askPublicUrl ? publicUrl.trim() : undefined,
      });
      location.href = r.redirect;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Setup failed. Try again.');
      setBusy(false);
    }
  };

  const recovery = info?.purpose === 'recovery';

  return (
    <div className="login-page">
      <div className="login-card join-card">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <div>
            <h1>War Room</h1>
            <p className="muted">{recovery ? 'Admin recovery' : 'First-time setup'}</p>
          </div>
        </div>
        {!info ? (
          <div className="skeleton" />
        ) : info.status !== 'ok' ? (
          <div className="alert error">{DEAD[info.status]}</div>
        ) : (
          <form className="form" onSubmit={submit}>
            <p className="small">
              {recovery
                ? 'This link signs you in as an admin so you can fix the sign-in settings. If an account with your email exists, you’ll use it; otherwise a new admin account is made.'
                : 'Create the first admin account. Next you’ll set up sign-in (Okta or Microsoft Entra ID), email and voice under Admin → Settings. Use the same email your identity provider has for you, so your sign-in links up with this account.'}
            </p>
            <label>
              Your name
              <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} autoFocus />
            </label>
            <label>
              Work email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
            </label>
            {info.askPublicUrl && (
              <label>
                Public address of this War Room
                <input value={publicUrl} onChange={(e) => setPublicUrl(e.target.value)} required inputMode="url" spellCheck={false} />
                <span className="muted small">Where people reach War Room. You can change it later under Settings → General.</span>
              </label>
            )}
            {err && <div className="alert error">{err}</div>}
            <button className="btn primary lg block" disabled={busy || !name.trim() || !email.trim()}>
              {recovery ? 'Sign in as admin' : 'Create admin and continue'}
            </button>
            <p className="hint">This link works once. Anyone with it can become an admin, so don’t share it.</p>
          </form>
        )}
      </div>
    </div>
  );
}
