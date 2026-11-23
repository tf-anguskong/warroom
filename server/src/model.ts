import { q } from './db.js';

/**
 * Row shapes, lookups and labels shared by the war room routes and the modules built on them.
 * `HttpError` is thrown by lookups and checks; route handlers wrapped in `h()` turn it into JSON.
 */

export interface IncidentRow {
  id: string;
  number: number;
  title: string;
  summary: string;
  severity: string;
  status: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface ChannelRow {
  id: string;
  incident_id: string;
  name: string;
  topic: string;
  created_by: string | null;
  created_at: string;
  archived: number;
}

export interface SheetRow {
  id: string;
  incident_id: string;
  name: string;
  columns: string;
  position: number;
}

export interface MessageRow {
  id: string;
  channel_id: string;
  user_id: string | null;
  body: string;
  kind: string;
  pinned: number;
  created_at: string;
  edited_at: string | null;
  display_name?: string | null;
  agent?: string | null;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const incidentKey = (n: number) => `INC-${String(n).padStart(4, '0')}`;

export function mustIncident(id: string) {
  const inc = q.get<IncidentRow>('SELECT * FROM incidents WHERE id = ?', id);
  if (!inc) throw new HttpError(404, 'incident not found');
  return inc;
}
export function mustChannel(id: string) {
  const ch = q.get<ChannelRow>('SELECT * FROM channels WHERE id = ?', id);
  if (!ch) throw new HttpError(404, 'channel not found');
  return ch;
}
export function mustSheet(id: string) {
  const s = q.get<SheetRow>('SELECT * FROM sheets WHERE id = ?', id);
  if (!s) throw new HttpError(404, 'sheet not found');
  return s;
}

export function serializeIncident(i: IncidentRow) {
  return {
    id: i.id,
    number: i.number,
    key: incidentKey(i.number),
    title: i.title,
    summary: i.summary,
    severity: i.severity,
    status: i.status,
    createdBy: i.created_by,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    resolvedAt: i.resolved_at,
  };
}

export const STATUS_LABEL: Record<string, string> = {
  investigating: 'Investigating',
  identified: 'Identified',
  mitigating: 'Mitigating',
  monitoring: 'Monitoring',
  resolved: 'Resolved',
};
