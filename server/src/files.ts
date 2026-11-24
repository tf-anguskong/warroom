import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, createReadStream, createWriteStream, mkdirSync, openSync, readSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { Router, type Request, type Response } from 'express';
import { config } from './config.js';
import { db, newId, now, q } from './db.js';
import { canControl } from './permissions.js';
import { addTimeline } from './timeline.js';
import { emitToChannel, emitToIncident, visibleChannelIds } from './realtime.js';
import { canSee } from './guests.js';
import { getUser, isAdmin, type UserRow } from './users.js';

/**
 * Files and screenshots in a war room: chat attachments, images in notes, and evidence uploaded
 * from the Files view. Stored on disk under DATA_DIR/files with a SHA-256 recorded at upload, so
 * the room has a hash for chain of custody. Only images we recognise by their bytes are ever shown
 * inline; everything else downloads as an opaque file (people upload malware samples here).
 */

db.exec(`
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  note_id TEXT,
  source TEXT NOT NULL,
  name TEXT NOT NULL,
  declared_type TEXT NOT NULL DEFAULT '',
  image_type TEXT,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  uploaded_by TEXT REFERENCES users(id),
  uploaded_at TEXT NOT NULL,
  deleted_by TEXT REFERENCES users(id),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_files_incident ON files(incident_id, uploaded_at);
CREATE INDEX IF NOT EXISTS idx_files_message ON files(message_id);
`);
if (!q.all<{ name: string }>('PRAGMA table_info(files)').some((c) => c.name === 'preview')) db.exec('ALTER TABLE files ADD COLUMN preview TEXT');

const dir = join(config.dataDir, 'files');
mkdirSync(dir, { recursive: true });
const blobPath = (id: string) => join(dir, id);

export interface FileRow {
  id: string;
  incident_id: string;
  channel_id: string | null;
  message_id: string | null;
  note_id: string | null;
  source: 'chat' | 'note' | 'evidence';
  name: string;
  declared_type: string;
  image_type: string | null;
  preview: Preview | null;
  size: number;
  sha256: string;
  description: string;
  uploaded_by: string | null;
  uploaded_at: string;
  deleted_by: string | null;
  deleted_at: string | null;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
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
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
      console.error('[files]', err);
      if (!res.headersSent) res.status(500).json({ error: 'internal error' });
    }
  };
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Images we will show inline, recognised by their first bytes (never by name or claimed type). */
function sniffImage(head: Buffer): string | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export type Preview = 'image' | 'pdf' | 'docx' | 'text' | 'none';
const HEAD_BYTES = 8192;
/** Text previews show at most this much; the rest is a download. */
const TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;

/**
 * Can the in-app viewer show this file? Decided from the bytes (and, for .docx, the zip signature
 * plus the name), never from the claimed type alone. 'text' means no NUL bytes and almost all
 * printable UTF-8 in the first 8 KB, whatever the extension (logs come with odd names).
 */
function previewKind(name: string, head: Buffer, imageType: string | null): Preview {
  if (imageType) return 'image';
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (head.length >= 4 && head.readUInt32BE(0) === 0x504b0304 && /\.docx$/i.test(name)) return 'docx';
  if (!head.length || head.includes(0)) return 'none';
  // Ignore a multi-byte character cut off at the end of the sample.
  let sample = head;
  for (let i = 1; i <= 3 && i <= sample.length; i++) {
    const b = sample[sample.length - i];
    if ((b & 0xc0) === 0xc0) {
      sample = sample.subarray(0, sample.length - i);
      break;
    }
    if ((b & 0x80) === 0) break;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(sample);
  } catch {
    return 'none';
  }
  const control = [...text].filter((c) => {
    const n = c.charCodeAt(0);
    return n < 32 && n !== 9 && n !== 10 && n !== 13 && n !== 12;
  }).length;
  return control / Math.max(1, text.length) < 0.01 ? 'text' : 'none';
}

function readHead(path: string) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/** Files uploaded before previews existed: work out their preview kind once. */
for (const f of q.all<{ id: string; name: string; image_type: string | null }>('SELECT id, name, image_type FROM files WHERE preview IS NULL AND deleted_at IS NULL')) {
  try {
    q.run('UPDATE files SET preview = ? WHERE id = ?', previewKind(f.name, readHead(join(dir, f.id)), f.image_type), f.id);
  } catch {
    q.run("UPDATE files SET preview = 'none' WHERE id = ?", f.id);
  }
}

/** A file name safe to show and to put in a download header. */
function cleanName(raw: string) {
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? '';
  const n = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').trim().slice(0, 200);
  return n && n !== '.' && n !== '..' ? n : 'file';
}

export const getFile = (id: string) => q.get<FileRow>('SELECT * FROM files WHERE id = ?', id);

/** Can this person open this file? Members: yes. Guests: only through a channel or note they were given. */
function canOpen(user: UserRow, f: FileRow) {
  if (!user.is_guest) return true;
  const inc = user.guest_incident_id ?? '';
  // canSee checks the guest's own incident and scope (a shared channel counts if it's in their scope).
  if (f.channel_id) return canSee(user, inc, 'channel', f.channel_id);
  if (f.note_id) return f.incident_id === inc && canSee(user, inc, 'note', f.note_id);
  return false;
}

export function fileView(f: FileRow) {
  return {
    id: f.id,
    incidentId: f.incident_id,
    channelId: f.channel_id,
    messageId: f.message_id,
    noteId: f.note_id,
    source: f.source,
    name: f.name,
    size: f.size,
    sha256: f.sha256,
    image: Boolean(f.image_type),
    preview: f.preview && f.preview !== 'none' ? f.preview : null,
    type: f.image_type ?? f.declared_type,
    description: f.description,
    uploadedBy: f.uploaded_by,
    uploadedByName: f.uploaded_by ? getUser(f.uploaded_by)?.display_name ?? null : null,
    uploadedAt: f.uploaded_at,
    deleted: Boolean(f.deleted_at),
    deletedByName: f.deleted_by ? getUser(f.deleted_by)?.display_name ?? null : null,
    deletedAt: f.deleted_at,
    url: `/api/files/${f.id}`,
  };
}
export type FileView = ReturnType<typeof fileView>;

/** Attachments for a message, for serializeMessage. */
export const attachmentsOf = (messageId: string) =>
  q.all<FileRow>('SELECT * FROM files WHERE message_id = ? ORDER BY uploaded_at', messageId).map(fileView);

/** Attach uploaded files to a new message: only the sender's own, unattached uploads to this channel. */
export function attachToMessage(messageId: string, channelId: string, userId: string, ids: string[]) {
  for (const id of ids.slice(0, 10)) {
    q.run(
      "UPDATE files SET message_id = ? WHERE id = ? AND channel_id = ? AND uploaded_by = ? AND message_id IS NULL AND source = 'chat' AND deleted_at IS NULL",
      messageId, id, channelId, userId,
    );
  }
}

/** A copied message gets its own copy of the attachments (same name and hash, new records). */
export function copyAttachments(fromMessageId: string, toMessageId: string, toChannelId: string) {
  const incidentId = q.get<{ incident_id: string }>('SELECT incident_id FROM channels WHERE id = ?', toChannelId)!.incident_id;
  for (const f of q.all<FileRow>('SELECT * FROM files WHERE message_id = ? AND deleted_at IS NULL', fromMessageId)) {
    const id = newId();
    try {
      copyFileSync(blobPath(f.id), blobPath(id));
    } catch {
      continue;
    }
    q.run(
      `INSERT INTO files (id, incident_id, channel_id, message_id, note_id, source, name, declared_type, image_type, preview, size, sha256, description, uploaded_by, uploaded_at)
       VALUES (?, ?, ?, ?, NULL, 'chat', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, incidentId, toChannelId, toMessageId, f.name, f.declared_type, f.image_type, f.preview, f.size, f.sha256, f.description, f.uploaded_by, f.uploaded_at,
    );
  }
  emitFiles(incidentId);
}

/** A moved message takes its attachments with it, so who can open them follows the new channel. */
export function moveAttachments(messageId: string, toChannelId: string) {
  const incidentId = q.get<{ incident_id: string }>('SELECT incident_id FROM channels WHERE id = ?', toChannelId)!.incident_id;
  q.run('UPDATE files SET channel_id = ?, incident_id = ? WHERE message_id = ?', toChannelId, incidentId, messageId);
  emitFiles(incidentId);
}

/** Erasing a message (a pasted secret) removes its attachments' bytes too; the records and hashes stay. */
export function eraseAttachments(messageId: string, userId: string) {
  const files = q.all<FileRow>('SELECT * FROM files WHERE message_id = ? AND deleted_at IS NULL', messageId);
  for (const f of files) {
    q.run('UPDATE files SET deleted_by = ?, deleted_at = ? WHERE id = ?', userId, now(), f.id);
    try {
      unlinkSync(blobPath(f.id));
    } catch {
      /* already gone */
    }
    emitFiles(f.incident_id);
  }
  return files.length;
}

/** Uploads waiting to be attached: checked before a message with attachments is created. */
export function pendingUploads(channelId: string, userId: string, ids: string[]) {
  return ids.filter((id) =>
    q.get("SELECT 1 FROM files WHERE id = ? AND channel_id = ? AND uploaded_by = ? AND message_id IS NULL AND source = 'chat' AND deleted_at IS NULL", id, channelId, userId),
  );
}

const human = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** Evidence list for the postmortem export. */
export function filesForExport(incidentId: string): string[] {
  const rows = q.all<FileRow>('SELECT * FROM files WHERE incident_id = ? ORDER BY uploaded_at', incidentId);
  if (!rows.length) return [];
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const out = ['## Files', '', '| Uploaded (UTC) | File | Size | SHA-256 | By | Where | Notes |', '|---|---|---|---|---|---|---|'];
  for (const f of rows) {
    const where = f.source === 'evidence' ? 'Files' : f.channel_id ? `#${q.get<{ name: string }>('SELECT name FROM channels WHERE id = ?', f.channel_id)?.name ?? 'channel'}` : 'Note';
    const by = f.uploaded_by ? getUser(f.uploaded_by)?.display_name ?? '' : '';
    const notes = [f.description, f.deleted_at ? `deleted ${f.deleted_at.slice(0, 16).replace('T', ' ')} by ${getUser(f.deleted_by ?? '')?.display_name ?? '?'}` : ''].filter(Boolean).join('; ');
    out.push(`| ${f.uploaded_at.slice(0, 19).replace('T', ' ')} | ${cell(f.name)} | ${human(f.size)} | \`${f.sha256}\` | ${cell(by)} | ${cell(where)} | ${cell(notes)} |`);
  }
  out.push('');
  return out;
}

const emitFiles = (incidentId: string) => emitToIncident(incidentId, 'files:update', { incidentId });

export const filesRouter = Router();

/**
 * Upload one file. The body is the raw bytes (sent as application/octet-stream so no body parser
 * touches it); the name and context come in the query string. Streams to disk while hashing.
 * ?source=chat&channelId=…   ?source=note&noteId=…   ?source=evidence&description=…
 */
filesRouter.post(
  '/incidents/:id/files',
  h(async (req) => {
    const user = req.user!;
    const inc = q.get<{ id: string }>('SELECT id FROM incidents WHERE id = ?', req.params.id);
    if (!inc) throw new HttpError(404, 'incident not found');
    const source = str(req.query.source, 20) as FileRow['source'];
    if (!['chat', 'note', 'evidence'].includes(source)) throw new HttpError(400, 'unknown upload type');
    const channelId = source === 'chat' ? str(req.query.channelId, 40) : null;
    const noteId = source === 'note' ? str(req.query.noteId, 40) : null;
    if (source === 'chat') {
      if (!channelId || !visibleChannelIds(inc.id).includes(channelId) || !canSee(user, inc.id, 'channel', channelId)) throw new HttpError(403, 'you can’t post files in that channel');
    } else if (source === 'note') {
      const n = q.get<{ incident_id: string }>('SELECT incident_id FROM notes WHERE id = ?', noteId);
      if (!n || n.incident_id !== inc.id || !canSee(user, inc.id, 'note', noteId!)) throw new HttpError(403, 'you can’t add files to that note');
    } else if (user.is_guest) {
      throw new HttpError(403, 'guests can attach files in chat, but not add evidence');
    }

    const max = config.files.maxMb * 1024 * 1024;
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > max) throw new HttpError(413, `That file is too large (the limit is ${config.files.maxMb} MB).`);
    const name = cleanName(str(req.query.name, 400) || 'file');
    const declaredType = str(req.headers['x-file-type'], 120).replace(/[^\w.+/-]/g, '');

    const id = newId();
    const tmp = `${blobPath(id)}.part`;
    const hash = createHash('sha256');
    let size = 0;
    let head = Buffer.alloc(0);
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > max) return cb(new HttpError(413, `That file is too large (the limit is ${config.files.maxMb} MB).`));
        if (head.length < HEAD_BYTES) head = Buffer.concat([head, chunk.subarray(0, HEAD_BYTES - head.length)]);
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(req, meter, createWriteStream(tmp, { mode: 0o600 }));
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        /* nothing written */
      }
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, 'upload interrupted');
    }
    if (size === 0) {
      unlinkSync(tmp);
      throw new HttpError(400, 'that file is empty');
    }
    renameSync(tmp, blobPath(id));
    const sha256 = hash.digest('hex');
    const imageType = sniffImage(head);
    const description = source === 'evidence' ? str(req.query.description, 500) : '';
    q.run(
      `INSERT INTO files (id, incident_id, channel_id, note_id, source, name, declared_type, image_type, preview, size, sha256, description, uploaded_by, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, inc.id, channelId, noteId, source, name, declaredType, imageType, previewKind(name, head, imageType), size, sha256, description, user.id, now(),
    );
    if (source === 'evidence') {
      addTimeline(inc.id, user.id, 'evidence', `Evidence added: ${name} (${human(size)}, SHA-256 ${sha256})${description ? ` — ${description}` : ''}`, { fileId: id });
    }
    emitFiles(inc.id);
    return { file: fileView(getFile(id)!) };
  }),
);

/** Everything uploaded in an incident, newest first (members only; guests are blocked by the guest gate). */
filesRouter.get(
  '/incidents/:id/files',
  h((req) => ({
    files: q.all<FileRow>('SELECT * FROM files WHERE incident_id = ? ORDER BY uploaded_at DESC', req.params.id).map(fileView),
  })),
);

filesRouter.get(
  '/files/:id',
  h((req, res) => {
    const f = getFile(req.params.id);
    if (!f || !canOpen(req.user!, f)) throw new HttpError(404, 'file not found');
    if (f.deleted_at) throw new HttpError(410, 'this file was deleted');
    const inline = Boolean(f.image_type) && req.query.download === undefined && req.query.preview === undefined;
    // The viewer asks for ?preview: text files are cut to the first 2 MB.
    const cut = req.query.preview !== undefined && f.preview === 'text' && f.size > TEXT_PREVIEW_BYTES;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Even if a browser decided to render it, nothing in it may run or load.
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Type', inline ? f.image_type! : 'application/octet-stream');
    res.setHeader('Content-Length', String(cut ? TEXT_PREVIEW_BYTES : f.size));
    if (cut) res.setHeader('X-Preview-Truncated', '1');
    const ascii = f.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    res.setHeader('X-File-SHA256', f.sha256);
    createReadStream(blobPath(f.id), cut ? { end: TEXT_PREVIEW_BYTES - 1 } : undefined)
      .on('error', () => {
        if (!res.headersSent) res.status(404).json({ error: 'file missing on the server' });
        else res.destroy();
      })
      .pipe(res);
    return undefined;
  }),
);

filesRouter.patch(
  '/files/:id',
  h((req) => {
    const f = getFile(req.params.id);
    if (!f || req.user!.is_guest) throw new HttpError(404, 'file not found');
    q.run('UPDATE files SET description = ? WHERE id = ?', str(req.body?.description, 500), f.id);
    emitFiles(f.incident_id);
    return { file: fileView(getFile(f.id)!) };
  }),
);

/** Delete: whoever uploaded it, or someone who runs the room. The record and hash stay; the bytes go. */
filesRouter.delete(
  '/files/:id',
  h((req) => {
    const user = req.user!;
    const f = getFile(req.params.id);
    if (!f || !canOpen(user, f)) throw new HttpError(404, 'file not found');
    if (f.deleted_at) return { ok: true };
    if (f.uploaded_by !== user.id && !(isAdmin(user) || canControl(user, f.incident_id))) {
      throw new HttpError(403, 'only the person who uploaded it, the Incident Commander or a room admin can delete it');
    }
    q.run('UPDATE files SET deleted_by = ?, deleted_at = ? WHERE id = ?', user.id, now(), f.id);
    try {
      unlinkSync(blobPath(f.id));
    } catch {
      /* already gone */
    }
    addTimeline(f.incident_id, user.id, 'evidence', `File deleted: ${f.name} (SHA-256 ${f.sha256})`, { fileId: f.id });
    emitFiles(f.incident_id);
    if (f.message_id && f.channel_id) {
      const m = q.get<{ id: string }>('SELECT id FROM messages WHERE id = ?', f.message_id);
      if (m) emitToChannel(f.channel_id, 'message:files', { messageId: f.message_id, channelId: f.channel_id, attachments: attachmentsOf(f.message_id) });
    }
    return { ok: true };
  }),
);
