import { createHash, randomBytes } from 'node:crypto';
import { config } from './config.js';
import { db, newId, now, q } from './db.js';

/**
 * One-time setup links: how the first admin gets in without any configuration file, and how an
 * admin recovers if sign-in is misconfigured. Links are printed to the server log (first start) or
 * by `npm run setup-link`, so only someone with access to the server can get one.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS setup_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT REFERENCES users(id)
);
`);

export const hashSetupToken = (t: string) => createHash('sha256').update(t).digest('hex');

export function createSetupToken(purpose: 'first-run' | 'recovery', minutes: number) {
  const token = randomBytes(32).toString('base64url');
  // Only the newest link works.
  q.run('UPDATE setup_tokens SET expires_at = ? WHERE used_at IS NULL AND expires_at > ?', now(), now());
  q.run(
    'INSERT INTO setup_tokens (id, token_hash, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    newId(), hashSetupToken(token), purpose, now(), new Date(Date.now() + minutes * 60_000).toISOString(),
  );
  return { url: `${config.publicUrl}/setup/${token}`, expiresAt: new Date(Date.now() + minutes * 60_000).toISOString() };
}

export const adminCount = () =>
  q.get<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE (is_admin = 1 OR idp_admin = 1) AND active = 1 AND COALESCE(is_guest, 0) = 0 AND COALESCE(deleted, 0) = 0')!.n;
