import { createReadStream, createWriteStream, existsSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { config } from './config.js';
import { q } from './db.js';
import { canControl } from './permissions.js';
import { addTimeline } from './timeline.js';
import { ArchiveError, archivePath, exportRoom, importRoom, inspectArchive, isEncrypted } from './archive.js';
import { refreshIncident } from './realtime.js';
import { isAdmin, logAdminAction } from './users.js';

class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}
const h =
  (fn: (req: Request, res: Response) => unknown) =>
  async (req: Request, res: Response) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
      if (err instanceof ArchiveError) return res.status(err.code === 'passphrase' ? 401 : 400).json({ error: err.message, code: err.code });
      console.error('[archive]', err);
      if (!res.headersSent) res.status(500).json({ error: 'internal error' });
    }
  };

const MAX_UPLOAD = 20 * 1024 ** 3;
const dir = join(config.dataDir, 'archives');
const metaPath = (token: string) => join(dir, `${token}.json`);
const uploadPath = (token: string) => (/^[\w-]{20,64}$/.test(token) ? join(dir, `${token}.upload`) : null);

export const archiveRouter = Router();

/** Export one room. Body: { passphrase } or { plain: true } for an unencrypted archive; includeFiles (default true). */
archiveRouter.post(
  '/incidents/:id/archive',
  h(async (req) => {
    const user = req.user!;
    const inc = q.get<{ id: string }>('SELECT id FROM incidents WHERE id = ?', req.params.id);
    if (!inc) throw new HttpError(404, 'incident not found');
    if (!isAdmin(user) && !canControl(user, inc.id)) throw new HttpError(403, 'Only the Incident Commander, a room admin or an admin can export a room');
    const plain = req.body?.plain === true;
    const passphrase = typeof req.body?.passphrase === 'string' ? req.body.passphrase : '';
    if (!plain && passphrase.length < 10) throw new HttpError(400, 'Use a passphrase of at least 10 characters (or choose an unencrypted export)');
    const info = await exportRoom(inc.id, { passphrase: plain ? undefined : passphrase, by: user, includeFiles: req.body?.includeFiles !== false });
    writeFileSync(metaPath(info.token), JSON.stringify({ by: user.id, name: info.name }));
    addTimeline(inc.id, user.id, 'export', `Room exported by ${user.display_name} (${info.encrypted ? 'encrypted' : 'NOT encrypted'}, SHA-256 ${info.sha256})`);
    logAdminAction(user.id, null, 'room_exported', `${info.name} (${info.encrypted ? 'encrypted' : 'unencrypted'})`);
    return {
      name: info.name,
      size: info.size,
      sha256: info.sha256,
      encrypted: info.encrypted,
      download: `/api/archives/${info.token}`,
    };
  }),
);

/** Download an export. Only the person who made it, within an hour. */
archiveRouter.get(
  '/archives/:token',
  h((req, res) => {
    const p = archivePath(req.params.token);
    if (!p || !existsSync(p) || !existsSync(metaPath(req.params.token))) throw new HttpError(404, 'This export has expired. Export the room again.');
    const meta = JSON.parse(readFileSync(metaPath(req.params.token), 'utf8')) as { by: string; name: string };
    if (meta.by !== req.user!.id) throw new HttpError(404, 'This export has expired. Export the room again.');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(statSync(p).size));
    res.setHeader('Content-Disposition', `attachment; filename="${meta.name}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    createReadStream(p).pipe(res);
    return undefined;
  }),
);

const requireAdmin = (req: Request) => {
  if (!isAdmin(req.user!)) throw new HttpError(403, 'Only an admin can import rooms');
};

/**
 * Step 1 of an import: upload the archive (raw bytes). It's kept for an hour and checked with
 * the passphrase (header X-Archive-Passphrase), so the person sees what's inside before importing.
 */
archiveRouter.post(
  '/archives/upload',
  h(async (req) => {
    requireAdmin(req);
    if (Number(req.headers['content-length'] ?? 0) > MAX_UPLOAD) throw new HttpError(413, 'That archive is too large');
    const token = randomBytes(24).toString('base64url');
    const p = uploadPath(token)!;
    let size = 0;
    try {
      await pipeline(
        req,
        new Transform({
          transform(chunk: Buffer, _e, cb) {
            size += chunk.length;
            cb(size > MAX_UPLOAD ? new HttpError(413, 'That archive is too large') : null, chunk);
          },
        }),
        createWriteStream(p, { mode: 0o600 }),
      );
    } catch (err) {
      rmSync(p, { force: true });
      throw err instanceof HttpError ? err : new HttpError(400, 'Upload interrupted');
    }
    if (!size) {
      unlinkSync(p);
      throw new HttpError(400, 'That file is empty');
    }
    writeFileSync(metaPath(token), JSON.stringify({ by: req.user!.id, upload: true }));
    const encrypted = isEncrypted(p);
    const passphrase = String(req.headers['x-archive-passphrase'] ?? '');
    if (encrypted && !passphrase) return { uploadToken: token, encrypted, needsPassphrase: true };
    const summary = await inspectArchive(p, passphrase || undefined);
    return { uploadToken: token, encrypted, summary };
  }),
);

/** Check the passphrase for an uploaded archive and show what's inside. */
archiveRouter.post(
  '/archives/check',
  h(async (req) => {
    requireAdmin(req);
    const p = mineUpload(String(req.body?.uploadToken ?? ''), req.user!.id);
    return { summary: await inspectArchive(p, String(req.body?.passphrase ?? '') || undefined) };
  }),
);

function mineUpload(token: string, userId: string) {
  const p = uploadPath(token);
  if (!p || !existsSync(p) || !existsSync(metaPath(token))) throw new HttpError(404, 'That upload has expired. Upload the archive again.');
  if ((JSON.parse(readFileSync(metaPath(token), 'utf8')) as { by: string }).by !== userId) throw new HttpError(404, 'That upload has expired. Upload the archive again.');
  return p;
}

/** Step 2: import the uploaded archive as a new room. */
archiveRouter.post(
  '/archives/import',
  h(async (req) => {
    requireAdmin(req);
    const token = String(req.body?.uploadToken ?? '');
    const p = mineUpload(token, req.user!.id);
    const result = await importRoom(p, { passphrase: String(req.body?.passphrase ?? '') || undefined, by: req.user! });
    rmSync(p, { force: true });
    rmSync(metaPath(token), { force: true });
    logAdminAction(req.user!.id, null, 'room_imported', `${result.key} from ${result.originalKey}: ${result.title}`);
    refreshIncident(result.incidentId);
    return result;
  }),
);
