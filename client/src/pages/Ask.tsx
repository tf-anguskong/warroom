import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';

type Status = 'pending' | 'admitted' | 'denied' | 'cancelled' | 'expired' | 'used' | 'closed';
interface Saved {
  id: string;
  secret: string;
}

const ENDED: Record<Exclude<Status, 'pending' | 'admitted'>, string> = {
  denied: 'The people running this war room didn’t let you in. If you think that’s a mistake, contact them another way.',
  cancelled: 'You cancelled your request.',
  expired: 'Nobody answered in time, so your request expired. You can ask again.',
  used: 'You were already let in from another tab or device. Use that one, or ask again here.',
  closed: 'This incident has been resolved, so the war room is closed.',
};

const store = {
  key: (id: string) => `wr_ask_${id}`,
  get(id: string): Saved | null {
    try {
      return JSON.parse(sessionStorage.getItem(this.key(id)) ?? 'null');
    } catch {
      return null;
    }
  },
  set(id: string, v: Saved | null) {
    try {
      if (v) sessionStorage.setItem(this.key(id), JSON.stringify(v));
      else sessionStorage.removeItem(this.key(id));
    } catch {
      /* private mode: just don't remember */
    }
  },
};

/**
 * Asking to join from the war room link, for people without an account. They say who they are and
 * wait here; when someone running the room lets them in, they're sent on to their own one-time invite.
 */
export function Ask() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [room, setRoom] = useState<{ incidentKey: string; emailCode: boolean } | null>(null);
  const [roomErr, setRoomErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<Saved | null>(() => store.get(id));
  const [status, setStatus] = useState<Status | null>(saved ? 'pending' : null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [org, setOrg] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ incidentKey: string; emailCode: boolean }>(`/auth/rooms/${id}`)
      .then(setRoom)
      .catch((e) => setRoomErr(e instanceof ApiError && e.status < 500 ? e.message : 'Can’t reach War Room right now. Try again in a moment.'));
  }, [id]);

  // Waiting: check every few seconds until someone answers.
  useEffect(() => {
    if (!saved || (status && status !== 'pending')) return;
    let stop = false;
    const check = async () => {
      try {
        const r = await api.post<{ status: Status; url?: string }>(`/auth/join-requests/${saved.id}/status`, { secret: saved.secret });
        if (stop) return;
        setStatus(r.status);
        if (r.status !== 'pending') store.set(id, null);
        if (r.status === 'admitted' && r.url) navigate(r.url, { replace: true });
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          store.set(id, null);
          setSaved(null);
          setStatus(null);
        }
      }
    };
    void check();
    const t = setInterval(check, 3000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [saved, status, id, navigate]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const r = await api.post<{ id: string; secret: string }>(`/auth/rooms/${id}/join-requests`, { name, email, org, note });
      const s = { id: r.id, secret: r.secret };
      store.set(id, s);
      setSaved(s);
      setStatus('pending');
    } catch (e) {
      setErr(e instanceof ApiError && e.status < 500 ? e.message : 'Can’t reach War Room right now. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (saved) await api.post(`/auth/join-requests/${saved.id}/cancel`, { secret: saved.secret }).catch(() => undefined);
    store.set(id, null);
    setStatus('cancelled');
  };

  const again = () => {
    setSaved(null);
    setStatus(null);
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <div>
            <h1>War Room</h1>
            <p className="muted">{room ? <>Ask to join <span className="mono">{room.incidentKey}</span></> : 'Ask to join'}</p>
          </div>
        </div>

        {roomErr ? (
          <div className="alert error">{roomErr}</div>
        ) : status === 'pending' || status === 'admitted' ? (
          <div className="form">
            <div className="ask-waiting">
              <span className="spinner" aria-hidden />
              <div>
                <strong>{status === 'admitted' ? 'You’re in. Opening your invite…' : 'Waiting to be let in'}</strong>
                <div className="small muted">
                  The people running {room?.incidentKey ?? 'this war room'} can see your request. Keep this page open: it moves on by itself when they answer
                  (requests expire after 30 minutes).
                </div>
              </div>
            </div>
            {status === 'pending' && (
              <button className="btn ghost block" onClick={cancel}>
                Cancel request
              </button>
            )}
          </div>
        ) : status ? (
          <div className="form">
            <div className={`alert ${status === 'denied' || status === 'closed' ? 'error' : 'info'}`}>
              <div>{ENDED[status]}</div>
            </div>
            {status !== 'closed' && status !== 'denied' && (
              <button className="btn primary block" onClick={again}>
                Ask again
              </button>
            )}
          </div>
        ) : !room ? (
          <div className="skeleton" />
        ) : (
          <form className="form" onSubmit={submit}>
            <p className="small">
              You don’t need an account. Say who you are; the Incident Commander or a room admin decides whether to let you in, and what you can see.
            </p>
            <label>
              Your name
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="Dana Kim" />
            </label>
            <label>
              Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={254} placeholder="dana@company.com" />
              {room.emailCode && <span className="muted small">If they let you in, we email a code here to confirm it’s you.</span>}
            </label>
            <label>
              Team or organization
              <input value={org} onChange={(e) => setOrg(e.target.value)} maxLength={80} placeholder="Network team, or Outside IR firm" />
            </label>
            <label>
              Why you’re joining <span className="muted">(optional)</span>
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="On call for the firewall cluster" />
            </label>
            {err && <div className="alert error">{err}</div>}
            <button className="btn primary lg block" disabled={busy || !name.trim() || !email.trim()}>
              Ask to join
            </button>
            <p className="hint">
              Have an account? <a href={`/login?returnTo=${encodeURIComponent(`/incidents/${id}`)}`}>Sign in</a> instead.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
