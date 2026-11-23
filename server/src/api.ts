import { Router } from 'express';
import { requireAuth } from './auth.js';
import { router as incidents } from './routes/incidents.js';
import { router as voice } from './routes/voice.js';
import { router as assignments } from './routes/assignments.js';
import { router as channels } from './routes/channels.js';
import { router as timeline } from './routes/timeline.js';
import { router as sheets } from './routes/sheets.js';
import { router as admin } from './routes/admin.js';

/**
 * The core war room API under /api. Everything here needs a signed-in person (or an agent); guests
 * and agents are further limited by the allowlists in guests.ts and agents.ts, which match on the
 * full URL, so routes can move between these files freely.
 */
export const api = Router();
api.use(requireAuth);
api.use(incidents, voice, assignments, channels, timeline, sheets, admin);
