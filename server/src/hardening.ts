import type { IncomingHttpHeaders, Server as HttpServer } from 'node:http';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { config } from './config.js';

/**
 * Request-level protections shared by Express and Socket.IO: same-origin checks for anything a
 * browser sends with the session cookie, a JSON error handler, and orderly shutdown.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Paths that legitimately receive cross-site POSTs and never rely on the session cookie:
 * Entra's SAML response, and the OAuth endpoints MCP clients call (bearer tokens / client auth).
 */
const CROSS_SITE_OK = [/^\/auth\/saml\/acs$/, /^\/oauth\//];

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * True when a browser request came from War Room's own pages. Requests without `Origin` are
 * allowed unless `Sec-Fetch-Site` says they are cross-site: browsers omit `Origin` on same-origin
 * GETs, and non-browser clients don't carry the session cookie anyway.
 */
export function sameOrigin(headers: IncomingHttpHeaders): boolean {
  const origin = headers.origin;
  if (!origin) return headers['sec-fetch-site'] !== 'cross-site';
  if (origin === 'null') return false;
  const o = originOf(origin);
  if (!o) return false;
  if (o === originOf(config.publicUrl)) return true;
  // Same host the request was sent to (covers a Public address that hasn't been set yet).
  const host = headers.host;
  return Boolean(host) && new URL(o).host === host;
}

/** Rejects cookie-authenticated, state-changing requests that come from another site (CSRF). */
export const originGuard: RequestHandler = (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  if (req.headers.authorization) return next(); // agents, SCIM: bearer tokens, no cookies
  if (CROSS_SITE_OK.some((r) => r.test(req.path))) return next();
  if (sameOrigin(req.headers)) return next();
  res.status(403).json({ error: 'This request came from another site, so it was blocked. Open War Room at its own address and try again.' });
};

/** Last stop for errors: JSON, no stack traces, real causes in the server log. */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number(err?.status ?? err?.statusCode) || 500;
  if (status >= 500) console.error(`[warroom] ${req.method} ${req.path} failed:`, err);
  const message =
    status < 500 && err?.expose !== false && typeof err?.message === 'string'
      ? err.message
      : 'Something went wrong on the server. Try again; if it keeps happening, check the server log.';
  res.status(status).json({ error: message });
};

/** Unknown API paths answer in JSON rather than Express's HTML page. */
export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: 'not found' });
};

let stopping = false;

/**
 * Stops taking requests and lets in-flight ones finish (`close` must close the HTTP server; here
 * Socket.IO's close does that after disconnecting every socket), then runs `cleanup` (the
 * database). Forced exit after 10 seconds so a stuck connection can't hold a restart.
 */
export function installShutdown(server: HttpServer, close: () => Promise<void>, cleanup: () => void) {
  const shutdown = (reason: string, code: number) => {
    if (stopping) return;
    stopping = true;
    console.log(`[warroom] shutting down (${reason})`);
    setTimeout(() => process.exit(code), 10_000).unref();
    const closed = close();
    server.closeIdleConnections();
    void closed.then(() => {
      try {
        cleanup();
      } catch (e) {
        console.error('[warroom] cleanup failed', e);
      }
      process.exit(code);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM', 0));
  process.on('SIGINT', () => shutdown('SIGINT', 0));
  // A failed background promise (a poller, a webhook) shouldn't take a live war room down; log it.
  process.on('unhandledRejection', (e) => console.error('[warroom] unhandled rejection', e));
  // A thrown exception leaves the process in an unknown state: stop cleanly and let the supervisor restart it.
  process.on('uncaughtException', (e) => {
    console.error('[warroom] uncaught exception', e);
    shutdown('uncaught exception', 1);
  });
}
