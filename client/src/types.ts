export interface User {
  id: string;
  userName: string;
  displayName: string;
  email: string | null;
  title: string | null;
  isAdmin: boolean;
  active: boolean;
  /** Outside the identity provider, joined one war room with an invite link. */
  isGuest: boolean;
  guestIncidentId: string | null;
  guestOrg: string | null;
  guestExpiresAt: string | null;
}

export interface GuestScopeSummary {
  channels: { id: string; name: string }[];
  voiceRooms: { id: string; name: string }[];
  sheets: { id: string; name: string }[];
  notes: { id: string; name: string }[];
  timeline: boolean;
}

export interface Guest extends User {
  invitedBy: string | null;
  /** Present for the guest themself and for people who can manage guests. */
  scope?: GuestScopeSummary;
}

export type Severity = 'SEV1' | 'SEV2' | 'SEV3' | 'SEV4';
export type Status = 'investigating' | 'identified' | 'mitigating' | 'monitoring' | 'resolved';

export interface Incident {
  id: string;
  number: number;
  key: string;
  title: string;
  summary: string;
  severity: Severity;
  status: Status;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface IncidentListItem extends Incident {
  commander: string | null;
  members: number;
  present: number;
  inVoice: number;
  mentions: number;
}

export interface VoiceRoom {
  id: string;
  name: string;
  kind: 'main' | 'breakout';
  channelIds: string[];
  /** What this workstream is trying to get done. */
  objective: string;
  objectiveBy: string | null;
  objectiveAt: string | null;
}

export interface Assignment {
  targetKind: 'voice' | 'channel';
  targetId: string;
  userId: string;
  lead: boolean;
  assignedBy: string | null;
  assignedAt: string;
}

export interface Member {
  userId: string;
  joinedAt: string;
  /** What they're working on right now ('' if not set). */
  task: string;
  taskBy: string | null;
  taskAt: string | null;
}

export interface Channel {
  id: string;
  name: string;
  topic: string;
  incidentId: string;
  incidentKey: string;
  shared: boolean;
  voiceRoomIds: string[];
  sharedWith: { incidentId: string; key: string; title: string }[];
}

export interface IncidentState {
  incident: Incident;
  roles: { role: string; userId: string }[];
  /** People besides the IC who can run the room (roles, voice moves, severity/status). */
  roomAdmins: string[];
  /** Whether I can run the room. */
  canControl: boolean;
  unreadMentions: Record<string, number>;
  assignments: Assignment[];
  members: Member[];
  guests: Guest[];
  canSeeTimeline: boolean;
  voiceRooms: VoiceRoom[];
  channels: Channel[];
  sheets: { id: string; name: string }[];
  notes: { id: string; name: string }[];
  shifts: Shift[];
}

/** A scheduled shift in a war room (times are ISO, UTC). */
export interface Shift {
  id: string;
  userId: string;
  userName: string;
  startsAt: string;
  endsAt: string;
  note: string;
  createdBy: string | null;
  createdByName: string | null;
}

export interface Message {
  id: string;
  channelId: string;
  userId: string | null;
  displayName: string;
  body: string;
  kind: 'msg' | 'system';
  pinned: boolean;
  /** User IDs this message notified. */
  mentions: string[];
  mentionNames: Record<string, string>;
  createdAt: string;
  editedAt: string | null;
  attachments: FileItem[];
}

/** A file or screenshot uploaded in a war room. */
export interface FileItem {
  id: string;
  incidentId: string;
  channelId: string | null;
  messageId: string | null;
  noteId: string | null;
  source: 'chat' | 'note' | 'evidence';
  name: string;
  size: number;
  sha256: string;
  image: boolean;
  /** What the in-app viewer can show; null means download only. */
  preview: 'image' | 'pdf' | 'docx' | 'text' | null;
  type: string;
  description: string;
  uploadedBy: string | null;
  uploadedByName: string | null;
  uploadedAt: string;
  deleted: boolean;
  deletedByName: string | null;
  deletedAt: string | null;
  url: string;
}

export interface TimelineEntry {
  id: string;
  incidentId: string;
  ts: string;
  userId: string | null;
  displayName: string | null;
  type: string;
  text: string;
  ref: { messageId?: string; channelId?: string } | null;
}

export interface Presence {
  userId: string;
  displayName: string;
  voiceRoomId: string | null;
  muted: boolean;
  sharing: boolean;
  view: string | null;
}

export type ColumnType = 'text' | 'number' | 'select' | 'date' | 'person' | 'checkbox';

export interface SelectOption {
  value: string;
  color: string;
}

export interface Column {
  id: string;
  name: string;
  type: ColumnType;
  width?: number;
  options?: SelectOption[];
}

export interface SheetData {
  sheet: { id: string; incidentId: string; name: string; columns: Column[] };
  rows: { id: string; position: number }[];
  cells: { rowId: string; colId: string; value: string; updatedBy: string | null; updatedAt: string }[];
}

export interface Meta {
  roles: { key: string; label: string }[];
  severities: Severity[];
  statuses: Status[];
  templates: { key: string; name: string; description: string }[];
  /** Email codes for guest invites: available, mandatory, or going to the dev outbox (no SMTP). */
  guestEmail: { enabled: boolean; required: boolean; dev: boolean };
  /** 'now' = temporary quick War Room. */
  mode?: 'now' | 'standard';
}

export type View =
  | { kind: 'channel'; id: string }
  | { kind: 'sheet'; id: string }
  | { kind: 'note'; id: string }
  | { kind: 'files' }
  | { kind: 'schedule' }
  | { kind: 'timeline' }
  | { kind: 'investigate' }
  | { kind: 'roster' };

export interface MentionEvent {
  messageId: string;
  channelId: string;
  channelName: string;
  incidentId: string;
  incidentKey: string;
  by: string;
  preview: string;
}

export interface AssignedEvent {
  incidentId: string;
  incidentKey: string;
  targetKind: 'voice' | 'channel';
  targetId: string;
  label: string;
  lead: boolean;
  by: string;
}
