/**
 * SCIM 2.0 provisioning endpoint for Okta (Users + Groups/Push Groups).
 * Base URL to configure in Okta: {public address}/scim/v2   Auth: HTTP Header (Bearer token from Admin → Settings → Provisioning)
 */
import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { newId, now, q, tx } from './db.js';
import { bus, createUser, getUser, updateUser, type UserRow } from './users.js';

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

interface GroupRow {
  id: string;
  display_name: string;
  external_id: string | null;
  created_at: string;
  updated_at: string;
}

type Json = Record<string, any>; // SCIM payloads are loosely typed by nature

const base = () => `${config.publicUrl}/scim/v2`;

function scimError(res: Response, status: number, detail: string, scimType?: string) {
  res.status(status).type('application/scim+json').json({
    schemas: [ERROR_SCHEMA],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail,
  });
}

function send(res: Response, status: number, body: unknown) {
  res.status(status).type('application/scim+json').send(JSON.stringify(body));
}

function bearer(req: Request, res: Response, next: NextFunction) {
  if (!config.scim.token) return scimError(res, 501, 'SCIM is not set up (Admin → Settings → Provisioning)');
  const header = req.headers.authorization ?? '';
  const token = header.replace(/^Bearer\s+/i, '');
  const a = Buffer.from(token);
  const b = Buffer.from(config.scim.token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return scimError(res, 401, 'Unauthorized');
  next();
}

const truthy = (v: unknown) => v === true || (typeof v === 'string' && v.toLowerCase() === 'true');

function userGroups(userId: string) {
  return q.all<{ id: string; display_name: string }>(
    `SELECT g.id, g.display_name FROM groups g JOIN group_members gm ON gm.group_id = g.id WHERE gm.user_id = ?`,
    userId,
  );
}

function toScimUser(u: UserRow): Json {
  return {
    schemas: [USER_SCHEMA],
    id: u.id,
    ...(u.external_id ? { externalId: u.external_id } : {}),
    userName: u.user_name,
    name: {
      givenName: u.given_name ?? undefined,
      familyName: u.family_name ?? undefined,
      formatted: u.display_name,
    },
    displayName: u.display_name,
    ...(u.title ? { title: u.title } : {}),
    emails: u.email ? [{ value: u.email, primary: true, type: 'work' }] : [],
    active: Boolean(u.active),
    groups: userGroups(u.id).map((g) => ({
      value: g.id,
      display: g.display_name,
      $ref: `${base()}/Groups/${g.id}`,
    })),
    meta: {
      resourceType: 'User',
      created: u.created_at,
      lastModified: u.updated_at,
      location: `${base()}/Users/${u.id}`,
    },
  };
}

function toScimGroup(g: GroupRow, includeMembers = true): Json {
  const members = includeMembers
    ? q.all<{ id: string; display_name: string }>(
        `SELECT u.id, u.display_name FROM users u JOIN group_members gm ON gm.user_id = u.id WHERE gm.group_id = ?`,
        g.id,
      )
    : [];
  return {
    schemas: [GROUP_SCHEMA],
    id: g.id,
    ...(g.external_id ? { externalId: g.external_id } : {}),
    displayName: g.display_name,
    members: members.map((m) => ({ value: m.id, display: m.display_name, $ref: `${base()}/Users/${m.id}` })),
    meta: {
      resourceType: 'Group',
      created: g.created_at,
      lastModified: g.updated_at,
      location: `${base()}/Groups/${g.id}`,
    },
  };
}

/** Supports the `attr eq "value"` filters Okta sends. */
function parseFilter(filter: unknown): { attr: string; value: string } | null {
  if (typeof filter !== 'string' || !filter.trim()) return null;
  const m = filter.trim().match(/^([\w.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"$/i);
  if (!m) return { attr: '__unsupported__', value: '' };
  return { attr: m[1].toLowerCase(), value: m[2].replace(/\\(.)/g, '$1') };
}

function listResponse(res: Response, all: Json[], req: Request) {
  const startIndex = Math.max(1, Number(req.query.startIndex ?? 1) || 1);
  const count = Math.max(0, Number(req.query.count ?? 100) || 100);
  const page = all.slice(startIndex - 1, startIndex - 1 + count);
  send(res, 200, {
    schemas: [LIST_SCHEMA],
    totalResults: all.length,
    startIndex,
    itemsPerPage: page.length,
    Resources: page,
  });
}

/** Apply a SCIM attribute (from POST/PUT body or a PATCH op) to user column updates. */
function userAttr(updates: Partial<Record<keyof UserRow, unknown>>, path: string, value: any) {
  switch (path.toLowerCase()) {
    case 'username':
      updates.user_name = String(value);
      break;
    case 'externalid':
      updates.external_id = value == null ? null : String(value);
      break;
    case 'displayname':
      if (value) updates.display_name = String(value);
      break;
    case 'title':
      updates.title = value == null ? null : String(value);
      break;
    case 'active':
      updates.active = truthy(value) ? 1 : 0;
      break;
    case 'name':
      if (value && typeof value === 'object') {
        if ('givenName' in value) updates.given_name = value.givenName ?? null;
        if ('familyName' in value) updates.family_name = value.familyName ?? null;
        if (value.formatted && !updates.display_name) updates.display_name = String(value.formatted);
      }
      break;
    case 'name.givenname':
      updates.given_name = value ?? null;
      break;
    case 'name.familyname':
      updates.family_name = value ?? null;
      break;
    case 'name.formatted':
      if (value) updates.display_name = String(value);
      break;
    case 'emails':
      if (Array.isArray(value) && value.length) {
        const primary = value.find((e: Json) => e.primary) ?? value[0];
        updates.email = primary?.value ?? null;
      }
      break;
    default:
      if (/^emails\[.*\]\.value$/i.test(path)) updates.email = value ?? null;
  }
}

function userUpdatesFromResource(body: Json) {
  const updates: Partial<Record<keyof UserRow, unknown>> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'schemas' || k === 'id' || k === 'meta' || k === 'groups') continue;
    userAttr(updates, k, v);
  }
  if (!updates.display_name && (updates.given_name || updates.family_name)) {
    updates.display_name = [updates.given_name, updates.family_name].filter(Boolean).join(' ');
  }
  return updates;
}

const liveUser = (id: string) => {
  const u = getUser(id);
  return u && !u.deleted ? u : undefined;
};

export const scimRouter = Router();
scimRouter.use(express.json({ type: ['application/json', 'application/scim+json'], limit: '1mb' }));
scimRouter.use(bearer);

scimRouter.get('/ServiceProviderConfig', (_req, res) => {
  send(res, 200, {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      { type: 'oauthbearertoken', name: 'Bearer token', description: 'Static bearer token', primary: true },
    ],
  });
});

scimRouter.get('/ResourceTypes', (_req, res) => {
  send(res, 200, {
    schemas: [LIST_SCHEMA],
    totalResults: 2,
    Resources: [
      { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: USER_SCHEMA },
      { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'Group', name: 'Group', endpoint: '/Groups', schema: GROUP_SCHEMA },
    ],
  });
});

// ---- Users ----

scimRouter.get('/Users', (req, res) => {
  const f = parseFilter(req.query.filter);
  let rows: UserRow[];
  if (!f) rows = q.all<UserRow>('SELECT * FROM users WHERE deleted = 0 ORDER BY created_at');
  else if (f.attr === 'username') rows = q.all<UserRow>('SELECT * FROM users WHERE deleted = 0 AND user_name = ?', f.value);
  else if (f.attr === 'externalid') rows = q.all<UserRow>('SELECT * FROM users WHERE deleted = 0 AND external_id = ?', f.value);
  else if (f.attr === 'emails.value' || f.attr === 'emails') rows = q.all<UserRow>('SELECT * FROM users WHERE deleted = 0 AND email = ?', f.value);
  else if (f.attr === 'id') rows = q.all<UserRow>('SELECT * FROM users WHERE deleted = 0 AND id = ?', f.value);
  else return scimError(res, 400, 'Unsupported filter', 'invalidFilter');
  listResponse(res, rows.map(toScimUser), req);
});

scimRouter.post('/Users', (req, res) => {
  const body = req.body as Json;
  if (!body?.userName) return scimError(res, 400, 'userName is required', 'invalidValue');
  const existing = q.get<UserRow>('SELECT * FROM users WHERE user_name = ?', body.userName);
  const updates = userUpdatesFromResource(body);
  if (existing && !existing.deleted && existing.scim_managed) {
    return scimError(res, 409, 'User already exists', 'uniqueness');
  }
  if (existing) {
    // Re-provisioned after delete, or adopting a user who signed in before SCIM was set up.
    const user = updateUser(existing.id, { ...updates, deleted: 0, scim_managed: 1, active: updates.active ?? 1 })!;
    return send(res, 201, toScimUser(user));
  }
  const user = createUser({
    userName: String(body.userName),
    externalId: (updates.external_id as string) ?? null,
    email: (updates.email as string) ?? null,
    displayName: (updates.display_name as string) ?? undefined,
    givenName: (updates.given_name as string) ?? null,
    familyName: (updates.family_name as string) ?? null,
    title: (updates.title as string) ?? null,
    active: body.active === undefined ? true : truthy(body.active),
    scimManaged: true,
  });
  send(res, 201, toScimUser(user));
});

scimRouter.get('/Users/:id', (req, res) => {
  const u = liveUser(req.params.id);
  if (!u) return scimError(res, 404, 'User not found');
  send(res, 200, toScimUser(u));
});

scimRouter.put('/Users/:id', (req, res) => {
  const u = liveUser(req.params.id);
  if (!u) return scimError(res, 404, 'User not found');
  const updates = userUpdatesFromResource(req.body as Json);
  if (req.body?.active === undefined) delete updates.active;
  const user = updateUser(u.id, { ...updates, scim_managed: 1 })!;
  send(res, 200, toScimUser(user));
});

scimRouter.patch('/Users/:id', (req, res) => {
  const u = liveUser(req.params.id);
  if (!u) return scimError(res, 404, 'User not found');
  const ops: Json[] = Array.isArray(req.body?.Operations) ? req.body.Operations : [];
  const updates: Partial<Record<keyof UserRow, unknown>> = {};
  for (const op of ops) {
    const kind = String(op.op ?? '').toLowerCase();
    if (kind !== 'replace' && kind !== 'add') continue;
    if (op.path) userAttr(updates, String(op.path), op.value);
    else if (op.value && typeof op.value === 'object') {
      for (const [k, v] of Object.entries(op.value)) userAttr(updates, k, v);
    }
  }
  const user = updateUser(u.id, updates)!;
  send(res, 200, toScimUser(user));
});

scimRouter.delete('/Users/:id', (req, res) => {
  const u = liveUser(req.params.id);
  if (!u) return scimError(res, 404, 'User not found');
  // Keep the row so chat history and timeline authorship survive.
  updateUser(u.id, { active: 0, deleted: 1 });
  q.run('DELETE FROM group_members WHERE user_id = ?', u.id);
  res.status(204).end();
});

// ---- Groups ----

const getGroup = (id: string) => q.get<GroupRow>('SELECT * FROM groups WHERE id = ?', id);

function setMembers(groupId: string, members: Json[] | undefined, mode: 'add' | 'replace' | 'remove') {
  if (mode === 'replace') q.run('DELETE FROM group_members WHERE group_id = ?', groupId);
  for (const m of members ?? []) {
    const userId = String(m?.value ?? '');
    if (!userId) continue;
    if (mode === 'remove') q.run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', groupId, userId);
    else if (getUser(userId)) {
      q.run('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)', groupId, userId);
    }
  }
}

const touchGroup = (id: string) => q.run('UPDATE groups SET updated_at = ? WHERE id = ?', now(), id);

scimRouter.get('/Groups', (req, res) => {
  const f = parseFilter(req.query.filter);
  let rows: GroupRow[];
  if (!f) rows = q.all<GroupRow>('SELECT * FROM groups ORDER BY created_at');
  else if (f.attr === 'displayname') rows = q.all<GroupRow>('SELECT * FROM groups WHERE display_name = ?', f.value);
  else if (f.attr === 'externalid') rows = q.all<GroupRow>('SELECT * FROM groups WHERE external_id = ?', f.value);
  else if (f.attr === 'id') rows = q.all<GroupRow>('SELECT * FROM groups WHERE id = ?', f.value);
  else return scimError(res, 400, 'Unsupported filter', 'invalidFilter');
  const excludeMembers = String(req.query.excludedAttributes ?? '').includes('members');
  listResponse(res, rows.map((g) => toScimGroup(g, !excludeMembers)), req);
});

scimRouter.post('/Groups', (req, res) => {
  const body = req.body as Json;
  if (!body?.displayName) return scimError(res, 400, 'displayName is required', 'invalidValue');
  if (q.get('SELECT 1 FROM groups WHERE display_name = ?', body.displayName)) {
    return scimError(res, 409, 'Group already exists', 'uniqueness');
  }
  const id = newId();
  const ts = now();
  tx(() => {
    q.run(
      'INSERT INTO groups (id, display_name, external_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      id,
      String(body.displayName),
      body.externalId ?? null,
      ts,
      ts,
    );
    setMembers(id, body.members, 'add');
  });
  send(res, 201, toScimGroup(getGroup(id)!));
});

scimRouter.get('/Groups/:id', (req, res) => {
  const g = getGroup(req.params.id);
  if (!g) return scimError(res, 404, 'Group not found');
  send(res, 200, toScimGroup(g, !String(req.query.excludedAttributes ?? '').includes('members')));
});

scimRouter.put('/Groups/:id', (req, res) => {
  const g = getGroup(req.params.id);
  if (!g) return scimError(res, 404, 'Group not found');
  const body = req.body as Json;
  tx(() => {
    if (body.displayName) q.run('UPDATE groups SET display_name = ? WHERE id = ?', String(body.displayName), g.id);
    if (body.externalId !== undefined) q.run('UPDATE groups SET external_id = ? WHERE id = ?', body.externalId, g.id);
    if (Array.isArray(body.members)) setMembers(g.id, body.members, 'replace');
    touchGroup(g.id);
  });
  bus.emit('groups:changed');
  send(res, 200, toScimGroup(getGroup(g.id)!));
});

scimRouter.patch('/Groups/:id', (req, res) => {
  const g = getGroup(req.params.id);
  if (!g) return scimError(res, 404, 'Group not found');
  const ops: Json[] = Array.isArray(req.body?.Operations) ? req.body.Operations : [];
  tx(() => {
    for (const op of ops) {
      const kind = String(op.op ?? '').toLowerCase() as 'add' | 'replace' | 'remove';
      const path = String(op.path ?? '');
      const memberFilter = path.match(/^members\[value eq "([^"]+)"\]$/i);
      if (memberFilter) {
        if (kind === 'remove') setMembers(g.id, [{ value: memberFilter[1] }], 'remove');
      } else if (path.toLowerCase() === 'members') {
        setMembers(g.id, Array.isArray(op.value) ? op.value : [], kind);
      } else if (path.toLowerCase() === 'displayname') {
        q.run('UPDATE groups SET display_name = ? WHERE id = ?', String(op.value), g.id);
      } else if (path.toLowerCase() === 'externalid') {
        q.run('UPDATE groups SET external_id = ? WHERE id = ?', op.value ?? null, g.id);
      } else if (!path && op.value && typeof op.value === 'object') {
        if (op.value.displayName) q.run('UPDATE groups SET display_name = ? WHERE id = ?', String(op.value.displayName), g.id);
        if (Array.isArray(op.value.members)) setMembers(g.id, op.value.members, kind === 'remove' ? 'remove' : kind);
      }
    }
    touchGroup(g.id);
  });
  bus.emit('groups:changed');
  if (req.body?.schemas?.includes(PATCH_SCHEMA) && String(req.query.attributes ?? '') === '') {
    return res.status(204).end();
  }
  send(res, 200, toScimGroup(getGroup(g.id)!));
});

scimRouter.delete('/Groups/:id', (req, res) => {
  const g = getGroup(req.params.id);
  if (!g) return scimError(res, 404, 'Group not found');
  q.run('DELETE FROM groups WHERE id = ?', g.id);
  bus.emit('groups:changed');
  res.status(204).end();
});
