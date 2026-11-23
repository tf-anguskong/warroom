import type { Request, Response } from 'express';
import { HttpError } from '../model.js';

/** Wrap a handler so its return value is sent as JSON and thrown HttpErrors become JSON errors. */
export const h =
  (fn: (req: Request, res: Response) => unknown) =>
  async (req: Request, res: Response) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
      console.error('[api]', err);
      res.status(500).json({ error: 'internal error' });
    }
  };

/** A trimmed string from untrusted input, at most `max` characters ('' if it isn't a string). */
export const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
