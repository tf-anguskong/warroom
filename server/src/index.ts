import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { ssoProviders } from './sso.js';
import { guestsRouter, inviteAuthRouter, startGuestSweeper } from './guests.js';
import { requireAuth } from './auth.js';
import './db.js';
import { authRouter } from './auth.js';
import { scimRouter } from './scim.js';
import { api } from './api.js';
import { integrationsRouter } from './integrations/index.js';
import { initRealtime } from './realtime.js';
import { applySettings, settingsRouter } from './settings.js';
import { notesRouter } from './notes.js';
import { filesRouter } from './files.js';
import { shiftsRouter } from './shifts.js';
import { announceSetupIfNeeded, setupRouter } from './setup.js';

// Saved settings (Admin → Settings) go on top of the environment and defaults before anything runs.
applySettings();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// SCIM has its own body parser (application/scim+json) and bearer auth.
app.use('/scim/v2', scimRouter);

app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(authRouter);
app.use(inviteAuthRouter);
app.use(setupRouter);
app.use('/api', api);
app.use('/api', integrationsRouter);
app.use('/api', requireAuth, guestsRouter);
app.use('/api', requireAuth, settingsRouter);
app.use('/api', requireAuth, notesRouter);
app.use('/api', requireAuth, filesRouter);
app.use('/api', requireAuth, shiftsRouter);

const here = dirname(fileURLToPath(import.meta.url));
const clientDist = resolve(process.env.CLIENT_DIST ?? join(here, '../../client/dist'));
if (existsSync(clientDist)) {
  app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api\/|auth\/|scim\/|socket\.io\/).*/, (_req, res) => res.sendFile(join(clientDist, 'index.html')));
}

const server = createServer(app);
initRealtime(server);
startGuestSweeper();

server.listen(config.port, () => {
  console.log(`[warroom] listening on :${config.port}  public=${config.publicUrl}`);
  console.log(`[warroom] SSO: ${ssoProviders().map((p) => `${p.label === 'Microsoft' ? 'Entra' : p.label} (${p.protocol.toUpperCase()})`).join(', ') || 'not configured'}  SCIM: ${config.scim.token ? 'enabled' : 'disabled'}  dev login: ${config.devAuth ? 'ON' : 'off'}`);
  announceSetupIfNeeded();
});
