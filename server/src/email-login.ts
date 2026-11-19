import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { config, smtpEnabled } from './config.js';
import { db, now, q } from './db.js';
import { mailStatus, sendMail } from './mail.js';
import { startSession } from './auth.js';
import { getUser, isAdmin, logAdminAction, type UserRow } from './users.js';

/**
 * Sign in with a code emailed to you: for accounts that aren't linked to Okta or Entra (people
 * invited as responders, the first admin of a quick War Room). Same protections as guest codes:
 * hashed, 10 minutes, single use, 5 wrong tries, 30 s between sends, 5 sends an hour. The answer
 * never says whether an address has an account.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS login_codes (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  code_hash TEXT,
  expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  sends TEXT NOT NULL DEFAULT '[]'
);
`);

const CODE_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const SEND_GAP_S = 30;
const SENDS_PER_HOUR = 5;
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;

const key = () => createHmac('sha256', config.sessionSecret).update('email-login').digest();
const hash = (email: string, code: string) => createHmac('sha256', key()).update(`${email.toLowerCase()}:${code}`).digest('hex');

export const emailLoginEnabled = () => config.emailLogin;
/** Can War Room email codes itself? If not, an admin hands out sign-in codes (see /admin/users/:id/login-code). */
export const emailCanSend = () => smtpEnabled() || mailStatus().devOutbox;

/** Accounts allowed to sign in this way: active members with no single sign-on identity. */
function eligible(email: string): UserRow | undefined {
  const u = q.get<UserRow>(
    `SELECT * FROM users WHERE email = ? COLLATE NOCASE AND is_guest = 0 AND deleted = 0 AND active = 1
       AND id NOT IN (SELECT user_id FROM user_identities)`,
    email,
  );
  return u;
}

interface CodeRow {
  email: string;
  code_hash: string | null;
  expires_at: string | null;
  attempts: number;
  sends: string;
}

export const emailLoginRouter = Router();

emailLoginRouter.post('/auth/email/code', async (req, res) => {
  if (!emailLoginEnabled()) return res.status(404).json({ error: 'Signing in by email isn’t turned on' });
  const email = String(req.body?.email ?? '').trim().toLowerCase().slice(0, 254);
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter your email address' });
  if (!emailCanSend()) return res.status(400).json({ error: 'This War Room can’t send email. Ask an admin for a sign-in code, then choose “I have a code”.', noEmail: true });
  const row = q.get<CodeRow>('SELECT * FROM login_codes WHERE email = ?', email);
  const t = Date.now();
  const sends = (JSON.parse(row?.sends ?? '[]') as string[]).filter((s) => t - new Date(s).getTime() < 3600e3);
  const last = sends.length ? new Date(sends[sends.length - 1]).getTime() : 0;
  if (t - last < SEND_GAP_S * 1000) {
    const wait = Math.ceil((SEND_GAP_S * 1000 - (t - last)) / 1000);
    return res.status(429).json({ error: `Wait ${wait} seconds before asking for another code`, retryAfter: wait });
  }
  if (sends.length >= SENDS_PER_HOUR) return res.status(429).json({ error: 'Too many codes for this address. Try again in an hour.' });
  const user = eligible(email);
  const nextSends = JSON.stringify([...sends, new Date(t).toISOString()]);
  if (user) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    try {
      await sendMail({
        to: email,
        subject: `${code} is your War Room sign-in code`,
        text: `Your War Room sign-in code is:\n\n    ${code}\n\nIt expires in ${CODE_MINUTES} minutes and works once.\n\nIf you didn't just try to sign in to War Room, ignore this email.`,
      });
    } catch (err) {
      console.error('[email-login] send failed', err instanceof Error ? err.message : err);
      return res.status(502).json({ error: 'We couldn’t send the email right now. Try again in a minute.' });
    }
    q.run(
      `INSERT INTO login_codes (email, code_hash, expires_at, attempts, sends) VALUES (?, ?, ?, 0, ?)
       ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, sends = excluded.sends`,
      email, hash(email, code), new Date(t + CODE_MINUTES * 60e3).toISOString(), nextSends,
    );
  } else {
    // Same answer and the same rate limit, so this can't be used to find out who has an account.
    q.run('INSERT INTO login_codes (email, sends) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET sends = excluded.sends, code_hash = NULL', email, nextSends);
  }
  res.json({ ok: true, expiresInMinutes: CODE_MINUTES, resendAfter: SEND_GAP_S });
});

emailLoginRouter.post('/auth/email/verify', async (req, res) => {
  if (!emailLoginEnabled()) return res.status(404).json({ error: 'Signing in by email isn’t turned on' });
  const email = String(req.body?.email ?? '').trim().toLowerCase().slice(0, 254);
  const code = String(req.body?.code ?? '').replace(/\D/g, '');
  const row = q.get<CodeRow>('SELECT * FROM login_codes WHERE email = ?', email);
  const fail = (msg: string, status = 401) => res.status(status).json({ error: msg });
  if (!row?.code_hash || !row.expires_at) return fail('That code isn’t right. Ask for a new one.');
  if (row.attempts >= MAX_ATTEMPTS) return fail('Too many wrong codes. Ask for a new one.');
  if (row.expires_at <= now()) return fail('That code has expired. Ask for a new one.');
  q.run('UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?', email);
  const a = Buffer.from(hash(email, code));
  const b = Buffer.from(row.code_hash);
  if (code.length !== 6 || a.length !== b.length || !timingSafeEqual(a, b)) return fail('That code isn’t right. Check the newest email.');
  // Single use.
  const spent = q.run('UPDATE login_codes SET code_hash = NULL WHERE email = ? AND code_hash = ?', email, row.code_hash);
  if (spent.changes !== 1) return fail('That code was already used. Ask for a new one.');
  const user = eligible(email);
  if (!user) return fail('This account can’t sign in by email.', 403);
  await startSession(res, user);
  q.run("UPDATE users SET last_login_provider = 'email' WHERE id = ?", user.id);
  logAdminAction(user.id, user.id, 'email_login', 'Signed in with an emailed code');
  res.json({ user: { id: user.id, displayName: getUser(user.id)?.display_name } });
});

/**
 * An admin gives someone a one-time sign-in code (for War Rooms without email, or email that
 * isn't arriving). Same account rules as emailed codes; 15 minutes; replaces any earlier code.
 */
export const loginCodeRouter = Router();

/** Can this account sign in with a code (email sign-in on, an email, no Okta / Entra identity, active)? */
export const codeSignInPossible = (u: UserRow) => emailLoginEnabled() && Boolean(u.email) && eligible(u.email!)?.id === u.id;

/** Make a one-time sign-in code for an account (replacing any earlier one) and return it. */
export function issueLoginCode(u: UserRow, minutes: number) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  q.run(
    `INSERT INTO login_codes (email, code_hash, expires_at, attempts, sends) VALUES (?, ?, ?, 0, '[]')
     ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`,
    u.email!.toLowerCase(), hash(u.email!, code), new Date(Date.now() + minutes * 60e3).toISOString(),
  );
  return code;
}

loginCodeRouter.post('/admin/users/:id/login-code', async (req, res) => {
  const admin = req.user!;
  if (!isAdmin(admin)) return res.status(403).json({ error: 'admins only' });
  const u = getUser(req.params.id);
  if (!u || !u.email) return res.status(404).json({ error: 'That person has no email on their account' });
  if (!eligible(u.email) || eligible(u.email)!.id !== u.id) return res.status(400).json({ error: 'This account signs in with Okta or Entra, or is a guest or deactivated' });
  const code = issueLoginCode(u, 15);
  logAdminAction(admin.id, u.id, 'login_code_issued', 'One-time sign-in code (15 minutes)');
  res.json({ code, email: u.email, expiresInMinutes: 15 });
});
