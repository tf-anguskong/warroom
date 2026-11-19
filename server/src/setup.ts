import { Router } from 'express';
import { config, smtpEnabled } from './config.js';
import { now, q } from './db.js';
import { startSession } from './auth.js';
import { isSaved, saveSetting } from './settings.js';
import { adminCount, createSetupToken, hashSetupToken } from './setup-token.js';
import { createUser, findUserByLogin, logAdminAction, updateUser } from './users.js';

export const setupRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface TokenRow {
  id: string;
  purpose: string;
  expires_at: string;
  used_at: string | null;
}
const findToken = (token: string) =>
  q.get<TokenRow>('SELECT id, purpose, expires_at, used_at FROM setup_tokens WHERE token_hash = ?', hashSetupToken(String(token)));

const publicUrlFromEnv = () => Boolean(process.env.PUBLIC_URL);

setupRouter.get('/auth/setup/:token', (req, res) => {
  const t = findToken(req.params.token);
  if (!t) return res.json({ status: 'invalid' });
  if (t.used_at) return res.json({ status: 'used' });
  if (t.expires_at <= now()) return res.json({ status: 'expired' });
  res.json({
    status: 'ok',
    purpose: t.purpose,
    admins: adminCount(),
    publicUrl: config.publicUrl,
    mode: config.mode,
    suggestedEmail: config.adminEmail || null,
    emailReady: smtpEnabled(),
    // Ask for the address only while nobody has set it.
    askPublicUrl: !isSaved('publicUrl') && !publicUrlFromEnv(),
  });
});

/** Use the link: make (or find) the admin account, sign it in, and send it to Admin → Settings. */
setupRouter.post('/auth/setup/:token', async (req, res) => {
  const name = String(req.body?.name ?? '').trim().slice(0, 80);
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  if (!name || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter your name and work email.' });

  let publicUrl: string | null = null;
  if (req.body?.publicUrl && !isSaved('publicUrl') && !publicUrlFromEnv()) {
    try {
      const u = new URL(String(req.body.publicUrl));
      if (!['https:', 'http:'].includes(u.protocol)) throw new Error();
      publicUrl = u.origin;
    } catch {
      return res.status(400).json({ error: 'The public address isn’t a valid URL.' });
    }
  }

  const t = findToken(req.params.token);
  if (!t) return res.status(404).json({ error: 'This setup link isn’t valid.' });
  // Use the link exactly once, even if two requests race.
  const used = q.run('UPDATE setup_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?', now(), t.id, now());
  if (used.changes !== 1) return res.status(410).json({ error: 'This setup link has expired or was already used.' });

  let user = findUserByLogin(email);
  if (user && (user.is_guest || user.deleted)) return res.status(409).json({ error: 'That email belongs to a guest or deleted account. Use a different one.' });
  if (!user) user = createUser({ userName: email, email, displayName: name });
  if (!user.active) user = updateUser(user.id, { active: 1 })!;
  if (!user.is_admin) {
    user = updateUser(user.id, { is_admin: 1 })!;
    logAdminAction(null, user.id, 'admin_granted', t.purpose === 'recovery' ? 'Recovery link from the server' : 'First-run setup link');
  } else {
    logAdminAction(null, user.id, 'setup_link_used', t.purpose === 'recovery' ? 'Recovery sign-in' : 'First-run setup');
  }
  q.run('UPDATE setup_tokens SET used_by = ? WHERE id = ?', user.id, t.id);
  if (publicUrl) saveSetting('publicUrl', publicUrl, user.id);

  await startSession(res, user);
  // Quick mode: straight on to starting or restoring a room; otherwise finish configuring.
  res.json({ redirect: config.mode === 'now' ? '/start' : '/admin?tab=settings' });
});

/** At startup: with no admins yet, print a setup link so the first one can get in. */
export function announceSetupIfNeeded() {
  if (adminCount() > 0) return;
  const { url, expiresAt } = createSetupToken('first-run', 24 * 60);
  const line = '='.repeat(78);
  console.log(`\n${line}\n  War Room has no admin yet. Open this link to finish setup (works once, until ${expiresAt.slice(0, 16)}Z):\n\n  ${url}\n\n  Lost it? Restart the server, or run: npm run setup-link\n${line}\n`);
}
