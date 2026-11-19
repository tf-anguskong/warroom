/**
 * `npm run setup-link` (or `node dist/setup-link.js` in the container): print a one-time link that
 * signs you in as an admin. For the first admin, or to get back in if sign-in settings are broken.
 * Usage: setup-link [minutes]   (default 60)
 */
import { applySettings } from './settings.js';
import { adminCount, createSetupToken } from './setup-token.js';

applySettings();
// --if-no-admin: print nothing once someone is admin (used by warroom-now.sh on every start).
if (process.argv.includes('--if-no-admin') && adminCount() > 0) process.exit(0);
const minutes = Math.min(Math.max(Number(process.argv.find((a) => /^\d+$/.test(a))) || 60, 5), 24 * 60);
const { url, expiresAt } = createSetupToken(adminCount() > 0 ? 'recovery' : 'first-run', minutes);
console.log(`\nOne-time admin link (works once, until ${expiresAt.slice(0, 16)}Z):\n\n  ${url}\n`);
process.exit(0);
