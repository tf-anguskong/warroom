import { newId, now, q } from './db.js';
import { SHEET_TEMPLATES, type Column } from './templates.js';

/** Creating the parts of a war room: voice rooms, channels and sheets. */

export function createSheet(incidentId: string, userId: string, templateKey: string, name?: string) {
  const tpl = SHEET_TEMPLATES.find((t) => t.key === templateKey) ?? SHEET_TEMPLATES.find((t) => t.key === 'blank')!;
  const id = newId();
  const columns: Column[] = tpl.columns.map((c) => ({ ...c, id: newId().slice(0, 8) }));
  const position =
    (q.get<{ p: number | null }>('SELECT MAX(position) AS p FROM sheets WHERE incident_id = ?', incidentId)?.p ?? -1) + 1;
  const ts = now();
  q.run(
    'INSERT INTO sheets (id, incident_id, name, columns, position, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id,
    incidentId,
    name || tpl.name,
    JSON.stringify(columns),
    position,
    userId,
    ts,
  );
  for (let i = 0; i < (tpl.rows ?? 20); i++) {
    q.run(
      'INSERT INTO sheet_rows (id, sheet_id, position, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
      newId(),
      id,
      i + 1,
      userId,
      ts,
    );
  }
  return id;
}

export function createVoiceRoom(incidentId: string, userId: string, name: string, kind: 'main' | 'breakout') {
  const id = newId();
  q.run(
    'INSERT INTO voice_rooms (id, incident_id, name, kind, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    incidentId,
    name,
    kind,
    userId,
    now(),
  );
  return id;
}

export function createChannel(incidentId: string, userId: string, name: string, topic: string, voiceRoomIds: string[]) {
  const id = newId();
  q.run(
    'INSERT INTO channels (id, incident_id, name, topic, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    incidentId,
    name,
    topic,
    userId,
    now(),
  );
  for (const vr of voiceRoomIds) {
    q.run('INSERT OR IGNORE INTO channel_voice_links (channel_id, voice_room_id) VALUES (?, ?)', id, vr);
  }
  return id;
}

export const channelName = (s: string) =>
  s
    .toLowerCase()
    .replace(/^#/, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
