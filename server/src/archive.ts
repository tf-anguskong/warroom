import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { closeSync, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import { config } from './config.js';
import { db, newId, now, q } from './db.js';
import { getUser, type UserRow } from './users.js';

/**
 * Room archives: one file with everything in a war room (incident, people, channels, messages,
 * timeline, sheets, notes, files, schedule, assignments, investigations), so a room can be moved
 * to a fresh War Room instance and the old server destroyed.
 *
 * File: a gzipped tar of manifest.json + data.json + files/<id>, optionally wrapped in
 * AES-256-GCM with a key from scrypt(passphrase). Import gives every row a new ID (so it can't
 * collide with anything already on the target), maps people by username/email, and rewrites
 * references inside text (mentions, note images, timeline refs, person cells).
 */

export const FORMAT = 'warroom-room-archive';
export const VERSION = 1;
const MAGIC = 'WARROOM-ARCHIVE-1\n';
const archiveDir = join(config.dataDir, 'archives');
const filesDir = join(config.dataDir, 'files');
mkdirSync(archiveDir, { recursive: true });

// ---------- what belongs to a room ----------

type Col = 'id' | 'user' | 'incident' | 'ref' | 'refOrNull';
interface TableSpec {
  table: string;
  /** SQL that selects this room's rows; :inc is the incident id, :ch / :msg / … are id lists. */
  where: (ctx: Ctx) => { sql: string; params: unknown[] };
  /** Columns holding IDs and how to treat them on import. */
  cols: Record<string, Col>;
  /** Columns holding JSON or text with IDs inside. */
  text?: string[];
  /** Fix up a row on import (after IDs are mapped). */
  fix?: (row: Row, ctx: ImportCtx) => void;
}
type Row = Record<string, unknown>;
interface Ctx {
  inc: string;
  ids: Record<string, string[]>;
}
const list = (ids: string[]) => (ids.length ? ids.map(() => '?').join(',') : "''");

const SPECS: TableSpec[] = [
  { table: 'incidents', where: (c) => ({ sql: 'id = ?', params: [c.inc] }), cols: { id: 'id', created_by: 'user' } },
  { table: 'voice_rooms', where: (c) => ({ sql: 'incident_id = ?', params: [c.inc] }), cols: { id: 'id', incident_id: 'incident', created_by: 'user', objective_by: 'user' } },
  {
    // The room's own channels and channels shared into it; on import they all belong to the new room.
    table: 'channels',
    where: (c) => ({ sql: 'incident_id = ? OR id IN (SELECT channel_id FROM channel_shares WHERE incident_id = ?)', params: [c.inc, c.inc] }),
    cols: { id: 'id', incident_id: 'incident', created_by: 'user' },
  },
  {
    table: 'channel_voice_links',
    where: (c) => ({ sql: `channel_id IN (${list(c.ids.channels)}) AND voice_room_id IN (${list(c.ids.voice_rooms)})`, params: [...c.ids.channels, ...c.ids.voice_rooms] }),
    cols: { channel_id: 'ref', voice_room_id: 'ref' },
  },
  { table: 'messages', where: (c) => ({ sql: `channel_id IN (${list(c.ids.channels)})`, params: c.ids.channels }), cols: { id: 'id', channel_id: 'ref', user_id: 'user' }, text: ['body'] },
  { table: 'message_mentions', where: (c) => ({ sql: `message_id IN (${list(c.ids.messages)})`, params: c.ids.messages }), cols: { message_id: 'ref', user_id: 'user' } },
  { table: 'timeline', where: (c) => ({ sql: 'incident_id = ?', params: [c.inc] }), cols: { id: 'id', incident_id: 'incident', user_id: 'user' }, text: ['ref'] },
  { table: 'incident_roles', where: (c) => ({ sql: 'incident_id = ?', params: [c.inc] }), cols: { incident_id: 'incident', user_id: 'user' } },
  {
    table: 'incident_members',
    where: (c) => ({ sql: 'incident_id = ?', params: [c.inc] }),
    cols: { incident_id: 'incident', user_id: 'user', task_by: 'user' },
    // Nobody is connected to the imported room yet.
    fix: (row) => Object.assign(row, { present: 0, present_voice: null }),
  },
  { table: 'incident_room_admins', where: (c) => ({ sql: 'incident_id = ?', params: [c.inc] }), cols: { incident_id: 'incident', user_id: 'user', granted_by: 'user' } },
  { table: 'assignments', where: (c) => ({ sql: 'incident_id = ?', params: [c.inc] }), cols: { incident_id: 'incident', target_id: 'ref', user_id: 'user', assigned_by: 'user' } },
  { table: 'sheets', where: (c) => ({ sql: 'incident_id = ?', params: [c.inc] }), cols: { id: 'id', incident_id: 'incident', created_by: 'user' } },
  { table: 'sheet_rows', where: (c) => ({ sql: `sheet_id IN (${list(c.ids.sheets)})`, params: c.ids.sheets }), cols: { id: 'id', sheet_id: 'ref', created_by: 'user' } },
  {
    table: 'sheet_cells',
    where: (c) => ({ sql: `sheet_id IN (${list(c.ids.sheets)})`, params: c.ids.sheets }),
    cols: { sheet_id: 'ref', row_id: 'ref', updated_by: 'user' },
    // Person columns hold a user ID as the value.
    fix: (row, x) => {
      if (typeof row.value === 'string' && x.map.has(row.value)) row.value = x.map.get(row.value);
    },
  },
  { table: 'notes', where: (c) => ({ sql: 'incident_id = ?', params: [c.inc] }), cols: { id: 'id', incident_id: 'incident', created_by: 'user', updated_by: 'user' }, text: ['body'] },
  {
    table: 'files',
    where: (c) => ({ sql: 'incident_id = ?', params: [c.inc] }),
    cols: { id: 'id', incident_id: 'incident', channel_id: 'refOrNull', message_id: 'refOrNull', note_id: 'refOrNull', uploaded_by: 'user', deleted_by: 'user' },
  },
  { table: 'shifts', where: (c) => ({ sql: 'incident_id = ?', params: [c.inc] }), cols: { id: 'id', incident_id: 'incident', user_id: 'user', created_by: 'user' } },
  {
    table: 'investigation_runs',
    where: (c) => ({ sql: 'incident_id = ?', params: [c.inc] }),
    cols: { id: 'id', incident_id: 'incident', integration_id: 'refOrNull', created_by: 'user' },
    fix: (row) => {
      if (row.status === 'running') Object.assign(row, { status: 'error', error: 'Interrupted by moving the room' });
    },
  },
  {
    table: 'tracked_endpoints',
    where: (c) => ({ sql: 'incident_id = ?', params: [c.inc] }),
    cols: { id: 'id', incident_id: 'incident', integration_id: 'refOrNull', owner_id: 'user', channel_id: 'refOrNull', added_by: 'user', removed_by: 'user' },
    // The CrowdStrike connection isn't moved; tracking stops, the history stays.
    fix: (row) => {
      if (row.active) Object.assign(row, { active: 0, last_error: 'Stopped: room was moved to another War Room; connect CrowdStrike and track it again' });
    },
  },
  { table: 'endpoint_alerts', where: (c) => ({ sql: `endpoint_id IN (${list(c.ids.tracked_endpoints)})`, params: c.ids.tracked_endpoints }), cols: { endpoint_id: 'ref' } },
];

const USER_FIELDS = ['id', 'user_name', 'email', 'display_name', 'given_name', 'family_name', 'title', 'is_guest', 'guest_org', 'active'] as const;

const columnsOf = (table: string) => new Set(q.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name));
const tableExists = (table: string) => Boolean(q.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", table));

// ---------- export ----------

export interface ArchiveInfo {
  token: string;
  name: string;
  size: number;
  sha256: string;
  encrypted: boolean;
  path: string;
}

/** Everything about one room as plain rows, plus the people those rows mention. */
function collect(incidentId: string) {
  const ctx: Ctx = { inc: incidentId, ids: {} };
  const tables: Record<string, Row[]> = {};
  const userIds = new Set<string>();
  for (const spec of SPECS) {
    if (!tableExists(spec.table)) continue;
    const { sql, params } = spec.where(ctx);
    const rows = q.all<Row>(`SELECT * FROM ${spec.table} WHERE ${sql}`, ...params);
    tables[spec.table] = rows;
    if (spec.cols.id) ctx.ids[spec.table] = rows.map((r) => String(r.id));
    for (const r of rows) for (const [c, kind] of Object.entries(spec.cols)) if (kind === 'user' && r[c]) userIds.add(String(r[c]));
  }
  // People mentioned only inside text (mentions, person cells) too.
  for (const m of tables.messages ?? []) for (const [, id] of String(m.body).matchAll(/<@([0-9a-f-]{36})>/g)) userIds.add(id);
  for (const c of tables.sheet_cells ?? []) if (typeof c.value === 'string' && getUser(c.value)) userIds.add(c.value);
  const users = [...userIds]
    .map((id) => getUser(id))
    .filter((u): u is UserRow => Boolean(u))
    .map((u) => Object.fromEntries(USER_FIELDS.map((f) => [f, (u as unknown as Row)[f] ?? null])));
  return { tables, users };
}

function deriveKey(passphrase: string, salt: Buffer, n = 32768) {
  return scryptSync(passphrase.normalize('NFKC'), salt, 32, { N: n, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
}

const safeName = (s: string) => s.replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'room';

/** Build an archive file for one room. Returns where it is and its SHA-256. */
export async function exportRoom(incidentId: string, opts: { passphrase?: string; by: UserRow | null; includeFiles?: boolean }): Promise<ArchiveInfo> {
  const inc = q.get<{ number: number; title: string }>('SELECT number, title FROM incidents WHERE id = ?', incidentId);
  if (!inc) throw new Error('incident not found');
  const key = `INC-${String(inc.number).padStart(4, '0')}`;
  const { tables, users } = collect(incidentId);
  const includeFiles = opts.includeFiles !== false;
  const work = mkdtempSync(join(archiveDir, 'build-'));
  try {
    mkdirSync(join(work, 'files'));
    const fileList: { id: string; name: string; size: number; sha256: string }[] = [];
    if (includeFiles) {
      for (const f of tables.files ?? []) {
        const src = join(filesDir, String(f.id));
        if (f.deleted_at || !existsSync(src)) continue;
        copyFileSync(src, join(work, 'files', String(f.id)));
        fileList.push({ id: String(f.id), name: String(f.name), size: Number(f.size), sha256: String(f.sha256) });
      }
    }
    const data = JSON.stringify({ users, tables });
    const manifest = {
      format: FORMAT,
      version: VERSION,
      exportedAt: now(),
      exportedBy: opts.by ? { name: opts.by.display_name, email: opts.by.email } : null,
      source: config.publicUrl,
      incident: { id: incidentId, key, title: inc.title },
      counts: Object.fromEntries(Object.entries(tables).map(([t, r]) => [t, r.length])),
      people: users.length,
      files: fileList,
      filesIncluded: includeFiles,
      dataSha256: createHash('sha256').update(data).digest('hex'),
    };
    writeFileSync(join(work, 'manifest.json'), JSON.stringify(manifest, null, 2));
    writeFileSync(join(work, 'data.json'), data);

    const token = randomBytes(24).toString('base64url');
    const tgz = join(archiveDir, `${token}.tgz`);
    await pipeline(tar.c({ gzip: true, cwd: work, portable: true }, ['manifest.json', 'data.json', 'files']), createWriteStream(tgz));
    const out = join(archiveDir, `${token}.warroom`);
    if (opts.passphrase) {
      const salt = randomBytes(16);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', deriveKey(opts.passphrase, salt), iv);
      const header = `${MAGIC}${JSON.stringify({ enc: 'aes-256-gcm', kdf: 'scrypt', N: 32768, r: 8, p: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), incident: key })}\n`;
      const ws = createWriteStream(out, { mode: 0o600 });
      ws.write(header);
      await pipeline(createReadStream(tgz), cipher, ws, { end: false });
      await new Promise<void>((res, rej) => ws.end(cipher.getAuthTag(), (err?: Error | null) => (err ? rej(err) : res())));
      rmSync(tgz);
    } else {
      // Plain archives are just the .tgz.
      copyFileSync(tgz, out);
      rmSync(tgz);
    }
    const sha256 = await hashFile(out);
    return {
      token,
      name: `${key}-${safeName(inc.title)}-${now().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}.warroom`,
      size: statSync(out).size,
      sha256,
      encrypted: Boolean(opts.passphrase),
      path: out,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function hashFile(path: string) {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

export const archivePath = (token: string) => (/^[\w-]{20,64}$/.test(token) ? join(archiveDir, `${token}.warroom`) : null);

/** Archives waiting to be downloaded are removed after an hour. */
setInterval(() => {
  for (const f of readdirSync(archiveDir)) {
    const p = join(archiveDir, f);
    try {
      if (Date.now() - statSync(p).mtimeMs > 3600e3) rmSync(p, { recursive: true, force: true });
    } catch {
      /* gone */
    }
  }
}, 10 * 60e3).unref();

// ---------- reading an archive ----------

export class ArchiveError extends Error {
  constructor(message: string, public code: 'passphrase' | 'invalid' | 'version' = 'invalid') {
    super(message);
  }
}

function readBytes(path: string, start: number, length: number) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/** Is this file encrypted (needs a passphrase)? */
export function isEncrypted(path: string) {
  return readBytes(path, 0, MAGIC.length).toString('latin1') === MAGIC;
}

/** Decrypt (if needed) and unpack into a temp folder; returns the folder. Wrong passphrase → ArchiveError('passphrase'). */
async function unpack(path: string, passphrase: string | undefined): Promise<string> {
  const work = mkdtempSync(join(archiveDir, 'import-'));
  let tgz = path;
  try {
    if (isEncrypted(path)) {
      if (!passphrase) throw new ArchiveError('This archive is encrypted. Enter its passphrase.', 'passphrase');
      const head = readBytes(path, 0, 4096).toString('latin1');
      const nl = head.indexOf('\n', MAGIC.length);
      if (nl < 0) throw new ArchiveError('This archive’s header is damaged.');
      const meta = JSON.parse(head.slice(MAGIC.length, nl)) as { salt: string; iv: string; N: number };
      const start = nl + 1;
      const size = statSync(path).size;
      if (size < start + 16) throw new ArchiveError('This archive is incomplete.');
      const tag = readBytes(path, size - 16, 16);
      const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, Buffer.from(meta.salt, 'base64'), meta.N), Buffer.from(meta.iv, 'base64'));
      decipher.setAuthTag(tag);
      tgz = join(work, 'archive.tgz');
      try {
        await pipeline(createReadStream(path, { start, end: size - 17 }), decipher, createWriteStream(tgz));
      } catch {
        throw new ArchiveError('Wrong passphrase, or the archive was changed or damaged.', 'passphrase');
      }
    } else if (readBytes(path, 0, 2).toString('hex') !== '1f8b') {
      throw new ArchiveError('This isn’t a War Room archive.');
    }
    const out = join(work, 'x');
    mkdirSync(out);
    // Only the three things an archive may contain; nothing outside the folder, no links.
    await tar.x({
      file: tgz,
      cwd: out,
      strict: true,
      filter: (p, e) => {
        const ok = /^(\.\/)?(manifest\.json|data\.json|files\/?|files\/[0-9a-f-]{36})$/.test(p);
        return ok && (('type' in e && (e.type === 'File' || e.type === 'Directory')) || !('type' in e));
      },
    });
    return out;
  } catch (err) {
    rmSync(work, { recursive: true, force: true });
    if (err instanceof ArchiveError) throw err;
    throw new ArchiveError(`Could not read the archive: ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface Manifest {
  format: string;
  version: number;
  exportedAt: string;
  source: string;
  incident: { key: string; title: string };
  files: { id: string; sha256: string; size: number; name: string }[];
  dataSha256: string;
  people: number;
  counts: Record<string, number>;
}

function readManifest(dir: string): Manifest {
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
  if (m.format !== FORMAT) throw new ArchiveError('This isn’t a War Room room archive.');
  if (m.version > VERSION) throw new ArchiveError('This archive is from a newer version of War Room. Update this server first.', 'version');
  return m;
}

/** Check an archive without importing it: passphrase, integrity, what's inside. */
export async function inspectArchive(path: string, passphrase?: string) {
  const dir = await unpack(path, passphrase);
  try {
    const m = readManifest(dir);
    return { incident: m.incident, exportedAt: m.exportedAt, source: m.source, counts: m.counts, people: m.people, files: m.files.length };
  } finally {
    rmSync(join(dir, '..'), { recursive: true, force: true });
  }
}

// ---------- import ----------

interface ImportCtx {
  map: Map<string, string>;
  newIncident: string;
}

/** Map every ID-looking string inside text/JSON to its new ID. */
function rewrite(text: string, map: Map<string, string>) {
  return text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => map.get(id) ?? id);
}

export interface ImportResult {
  incidentId: string;
  key: string;
  title: string;
  originalKey: string;
  people: { matched: number; created: number };
  files: number;
  warnings: string[];
}

/** Rebuild a room from an archive file on disk. */
export async function importRoom(path: string, opts: { passphrase?: string; by: UserRow | null }): Promise<ImportResult> {
  const dir = await unpack(path, opts.passphrase);
  try {
    const manifest = readManifest(dir);
    const raw = readFileSync(join(dir, 'data.json'), 'utf8');
    if (createHash('sha256').update(raw).digest('hex') !== manifest.dataSha256) throw new ArchiveError('The archive’s contents don’t match its manifest (damaged or edited).');
    const data = JSON.parse(raw) as { users: Row[]; tables: Record<string, Row[]> };
    const warnings: string[] = [];

    // Files present and intact before anything is written.
    for (const f of manifest.files) {
      const p = join(dir, 'files', f.id);
      if (!existsSync(p)) throw new ArchiveError(`File ${f.name} is missing from the archive.`);
      if ((await hashFile(p)) !== f.sha256) throw new ArchiveError(`File ${f.name} doesn’t match its recorded SHA-256; the archive was changed or damaged.`);
    }

    const map = new Map<string, string>();
    const newIncident = newId();
    const oldIncident = String(data.tables.incidents?.[0]?.id ?? '');
    if (!oldIncident) throw new ArchiveError('The archive has no incident in it.');
    map.set(oldIncident, newIncident);
    // Every other row ID gets a new one up front, so references can point forward.
    for (const spec of SPECS) if (spec.cols.id) for (const r of data.tables[spec.table] ?? []) if (r.id !== oldIncident) map.set(String(r.id), newId());

    let matched = 0;
    let created = 0;
    const blobs: { from: string; to: string }[] = [];
    const ctx: ImportCtx = { map, newIncident };
    const ts = now();

    db.exec('BEGIN');
    try {
      // People: match members by username or email; recreate the rest (guests come back without access).
      for (const u of data.users) {
        const id = String(u.id);
        if (!u.is_guest) {
          const found = q.get<{ id: string }>(
            'SELECT id FROM users WHERE is_guest = 0 AND deleted = 0 AND (user_name = ? COLLATE NOCASE OR (email IS NOT NULL AND email = ? COLLATE NOCASE))',
            u.user_name, u.email ?? '',
          );
          if (found) {
            map.set(id, found.id);
            matched++;
            continue;
          }
        }
        const nid = newId();
        let userName = String(u.user_name);
        if (u.is_guest || q.get('SELECT 1 FROM users WHERE user_name = ? COLLATE NOCASE', userName)) userName = `${u.is_guest ? 'guest' : 'imported'}-${nid}@archive.invalid`;
        q.run(
          `INSERT INTO users (id, user_name, email, display_name, given_name, family_name, title, active, is_guest, guest_incident_id, guest_expires_at, guest_org, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          nid, userName, u.is_guest ? null : (u.email ?? null), u.display_name, u.given_name ?? null, u.family_name ?? null, u.title ?? null,
          // Members can sign in again (SSO match or emailed code); guests' access has ended.
          u.is_guest ? 0 : 1, u.is_guest ? 1 : 0, u.is_guest ? newIncident : null, u.is_guest ? ts : null, u.guest_org ?? null, ts, ts,
        );
        map.set(id, nid);
        created++;
      }

      const next = (q.get<{ n: number | null }>('SELECT MAX(number) AS n FROM incidents')?.n ?? 0) + 1;
      for (const spec of SPECS) {
        const rows = data.tables[spec.table] ?? [];
        if (!rows.length || !tableExists(spec.table)) continue;
        const have = columnsOf(spec.table);
        for (const src of rows) {
          const row: Row = { ...src };
          for (const [c, kind] of Object.entries(spec.cols)) {
            const v = row[c];
            if (v === null || v === undefined || v === '') continue;
            if (kind === 'incident') row[c] = newIncident;
            else if (map.has(String(v))) row[c] = map.get(String(v));
            else if (kind === 'refOrNull' || kind === 'user') row[c] = null;
          }
          for (const t of spec.text ?? []) if (typeof row[t] === 'string') row[t] = rewrite(row[t] as string, map);
          spec.fix?.(row, ctx);
          if (spec.table === 'incidents') Object.assign(row, { number: next, updated_at: ts });
          if (spec.table === 'files' && manifest.files.some((f) => f.id === src.id)) blobs.push({ from: String(src.id), to: String(row.id) });
          if (spec.table === 'files' && !row.deleted_at && !manifest.files.some((f) => f.id === src.id)) {
            Object.assign(row, { deleted_at: ts, deleted_by: opts.by?.id ?? null });
          }
          const cols = Object.keys(row).filter((c) => have.has(c));
          q.run(`INSERT INTO ${spec.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => row[c]));
        }
      }
      // Guests that came along can't sign in, but stay attributed to this room.
      q.run('UPDATE users SET guest_incident_id = ? WHERE is_guest = 1 AND guest_incident_id IS NULL AND id IN (SELECT user_id FROM incident_members WHERE incident_id = ?)', newIncident, newIncident);

      const key = `INC-${String(next).padStart(4, '0')}`;
      q.run(
        'INSERT INTO timeline (id, incident_id, ts, user_id, type, text, ref) VALUES (?, ?, ?, ?, ?, ?, ?)',
        newId(), newIncident, ts, opts.by?.id ?? null, 'imported',
        `Room restored from an archive of ${manifest.incident.key} (exported ${manifest.exportedAt.slice(0, 16).replace('T', ' ')} UTC from ${manifest.source})${opts.by ? ` by ${opts.by.display_name}` : ''}`,
        null,
      );
      db.exec('COMMIT');

      for (const b of blobs) copyFileSync(join(dir, 'files', b.from), join(filesDir, b.to));
      if (!manifest.files.length && (data.tables.files ?? []).length) warnings.push('The archive was exported without file contents; file records are kept, marked as not available.');
      if ((data.tables.tracked_endpoints ?? []).some((e) => e.active)) warnings.push('Tracked endpoints were stopped: connect CrowdStrike on this server and track them again.');
      return {
        incidentId: newIncident,
        key,
        title: String(data.tables.incidents[0].title),
        originalKey: manifest.incident.key,
        people: { matched, created },
        files: blobs.length,
        warnings,
      };
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* already committed */
      }
      throw err;
    }
  } finally {
    rmSync(join(dir, '..'), { recursive: true, force: true });
  }
}
