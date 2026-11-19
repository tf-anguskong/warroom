import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { config } from './config.js';

mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(join(config.dataDir, 'warroom.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  user_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  external_id TEXT,
  email TEXT COLLATE NOCASE,
  display_name TEXT NOT NULL,
  given_name TEXT,
  family_name TEXT,
  title TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  is_admin INTEGER NOT NULL DEFAULT 0,
  oidc_sub TEXT UNIQUE,
  scim_managed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  external_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL DEFAULT 'SEV3',
  status TEXT NOT NULL DEFAULT 'investigating',
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS incident_roles (
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (incident_id, role)
);

CREATE TABLE IF NOT EXISTS incident_members (
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (incident_id, user_id)
);

CREATE TABLE IF NOT EXISTS voice_rooms (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'breakout',
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);

-- A channel can be attached to several voice rooms in its incident,
-- and shared into other incidents.
CREATE TABLE IF NOT EXISTS channel_voice_links (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  voice_room_id TEXT NOT NULL REFERENCES voice_rooms(id) ON DELETE CASCADE,
  PRIMARY KEY (channel_id, voice_room_id)
);

CREATE TABLE IF NOT EXISTS channel_shares (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  shared_by TEXT REFERENCES users(id),
  shared_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, incident_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id),
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'msg',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  edited_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);

CREATE TABLE IF NOT EXISTS timeline (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  ts TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  ref TEXT
);
CREATE INDEX IF NOT EXISTS idx_timeline_incident ON timeline(incident_id, ts);

CREATE TABLE IF NOT EXISTS sheets (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  columns TEXT NOT NULL DEFAULT '[]',
  position INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sheet_rows (
  id TEXT PRIMARY KEY,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  position REAL NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rows_sheet ON sheet_rows(sheet_id, position);

CREATE TABLE IF NOT EXISTS sheet_cells (
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  row_id TEXT NOT NULL REFERENCES sheet_rows(id) ON DELETE CASCADE,
  col_id TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (row_id, col_id)
);
CREATE INDEX IF NOT EXISTS idx_cells_sheet ON sheet_cells(sheet_id);

CREATE TABLE IF NOT EXISTS admin_audit (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  actor_id TEXT REFERENCES users(id),
  target_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_ts ON admin_audit(ts);
`);

// Additive migrations for databases created by earlier versions.
const userCols = new Set((db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name));
if (!userCols.has('idp_admin')) db.exec('ALTER TABLE users ADD COLUMN idp_admin INTEGER NOT NULL DEFAULT 0');
if (!userCols.has('last_login_at')) db.exec('ALTER TABLE users ADD COLUMN last_login_at TEXT');
if (!userCols.has('last_login_provider')) db.exec('ALTER TABLE users ADD COLUMN last_login_provider TEXT');

// War room control: people besides the Incident Commander who can run the room.
db.exec(`
CREATE TABLE IF NOT EXISTS incident_room_admins (
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  granted_by TEXT REFERENCES users(id),
  granted_at TEXT NOT NULL,
  PRIMARY KEY (incident_id, user_id)
);
CREATE TABLE IF NOT EXISTS message_mentions (
  message_id TEXT NOT NULL REFERENCES messages(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  read_at TEXT,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_mentions_user ON message_mentions(user_id, read_at);
`);

// Who is assigned to which voice room or channel, inside one war room (a shared channel can have
// different people assigned in each incident it is open in).
db.exec(`
CREATE TABLE IF NOT EXISTS assignments (
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  lead INTEGER NOT NULL DEFAULT 0,
  assigned_by TEXT REFERENCES users(id),
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (incident_id, target_kind, target_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_assignments_user ON assignments(incident_id, user_id);
`);
const memberCols = new Set((db.prepare('PRAGMA table_info(incident_members)').all() as { name: string }[]).map((c) => c.name));
if (!memberCols.has('task')) {
  db.exec(`ALTER TABLE incident_members ADD COLUMN task TEXT NOT NULL DEFAULT '';
           ALTER TABLE incident_members ADD COLUMN task_by TEXT;
           ALTER TABLE incident_members ADD COLUMN task_at TEXT;`);
}
// Someone asking the Incident Commander to hand command to them (cleared on handoff or decline).
db.exec(`
CREATE TABLE IF NOT EXISTS command_requests (
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  note TEXT NOT NULL DEFAULT '',
  requested_at TEXT NOT NULL,
  PRIMARY KEY (incident_id, user_id)
);
`);
// Away from keyboard: set by the person, kept per war room so it survives reloads and closed laptops.
if (!memberCols.has('away_since')) {
  db.exec(`ALTER TABLE incident_members ADD COLUMN away_since TEXT;
           ALTER TABLE incident_members ADD COLUMN away_until TEXT;
           ALTER TABLE incident_members ADD COLUMN away_note TEXT NOT NULL DEFAULT '';`);
}
// Last presence written to the timeline (comings and goings), so restarts and reloads don't repeat it.
if (!memberCols.has('present')) db.exec('ALTER TABLE incident_members ADD COLUMN present INTEGER NOT NULL DEFAULT 0;');
if (!memberCols.has('present_voice')) db.exec('ALTER TABLE incident_members ADD COLUMN present_voice TEXT;');
const vrCols = new Set((db.prepare('PRAGMA table_info(voice_rooms)').all() as { name: string }[]).map((c) => c.name));
if (!vrCols.has('objective')) {
  db.exec(`ALTER TABLE voice_rooms ADD COLUMN objective TEXT NOT NULL DEFAULT '';
           ALTER TABLE voice_rooms ADD COLUMN objective_by TEXT;
           ALTER TABLE voice_rooms ADD COLUMN objective_at TEXT;`);
}

// Guests: people outside the identity provider, invited into one war room with a single-use link.
for (const [col, type] of [
  ['is_guest', 'INTEGER NOT NULL DEFAULT 0'],
  ['guest_incident_id', 'TEXT'],
  ['guest_expires_at', 'TEXT'],
  ['guest_org', 'TEXT'],
  ['invited_by', 'TEXT'],
  ['guest_scope', 'TEXT'],
]) {
  if (!userCols.has(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} ${type}`);
}
db.exec(`
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  org TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT '{}',
  access_hours INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT REFERENCES users(id),
  used_ip TEXT,
  revoked_at TEXT,
  revoked_by TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_invites_incident ON invites(incident_id);
`);
const inviteCols = new Set((db.prepare('PRAGMA table_info(invites)').all() as { name: string }[]).map((c) => c.name));
if (!inviteCols.has('scope')) db.exec("ALTER TABLE invites ADD COLUMN scope TEXT NOT NULL DEFAULT '{}'");
// Email verification: the guest's address, and the current one-time code (hashed) with its limits.
for (const [col, type] of [
  ['email', 'TEXT'],
  ['code_hash', 'TEXT'],
  ['code_expires_at', 'TEXT'],
  ['code_attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ['code_sends', "TEXT NOT NULL DEFAULT '[]'"],
  // 'guest' (only what the invite lists) or 'member' (a full responder account, verified by email).
  ['kind', "TEXT NOT NULL DEFAULT 'guest'"],
  // How the join code reaches the person: 'email' (sent by War Room) or 'manual' (shown to the inviter, who passes it on).
  ['code_mode', "TEXT NOT NULL DEFAULT 'email'"],
]) {
  if (!inviteCols.has(col)) db.exec(`ALTER TABLE invites ADD COLUMN ${col} ${type}`);
}

// One row per identity-provider account linked to a user (Okta, Entra, ...).
db.exec(`
CREATE TABLE IF NOT EXISTS user_identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS idx_user_identities_user ON user_identities(user_id);
INSERT OR IGNORE INTO user_identities (provider, subject, user_id, created_at)
  SELECT 'okta', oidc_sub, id, created_at FROM users WHERE oidc_sub IS NOT NULL;
`);

export type Row = Record<string, SQLInputValue>;

const clean = (params: unknown[]) => params.map((p) => (p === undefined ? null : p)) as SQLInputValue[];

export const q = {
  get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    return db.prepare(sql).get(...clean(params)) as T | undefined;
  },
  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return db.prepare(sql).all(...clean(params)) as T[];
  },
  run(sql: string, ...params: unknown[]) {
    return db.prepare(sql).run(...clean(params));
  },
};

export function tx<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const now = () => new Date().toISOString();
export const newId = () => randomUUID();
