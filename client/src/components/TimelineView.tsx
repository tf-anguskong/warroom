import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { getSocket } from '../lib/socket';
import { localTime, utcTime } from '../lib/format';
import type { IncidentState, TimelineEntry } from '../types';
import { Icons } from './ui';
import { AgentTag } from './Agents';

const HUMAN = new Set(['note', 'decision', 'action', 'finding', 'pin']);
const PEOPLE = new Set(['joined', 'presence', 'guest', 'access']);
const TYPE_LABEL: Record<string, string> = {
  declared: 'Declared',
  webhook: 'Webhook',
  moderation: 'Moderation',
  status: 'Status',
  severity: 'Severity',
  role: 'Role',
  voice: 'Voice',
  channel: 'Channel',
  sheet: 'Sheet',
  joined: 'Joined',
  presence: 'In / out',
  guest: 'Invite',
  access: 'Access',
  summary: 'Summary',
  note: 'Note',
  decision: 'Decision',
  action: 'Action',
  finding: 'Finding',
  pin: 'Pinned',
  assign: 'Assigned',
  task: 'Task',
  investigation: 'Query',
};

const FILTERS = [
  { key: 'key', label: 'Key events' },
  { key: 'human', label: 'Notes & decisions' },
  { key: 'people', label: 'Comings & goings' },
  { key: 'all', label: 'Everything' },
] as const;

/** Convert "YYYY-MM-DDTHH:mm" entered as UTC to ISO. */
const utcInputToIso = (v: string) => (v ? new Date(`${v}:00Z`).toISOString() : undefined);

export function TimelineView({ state, onOpenChannel }: { state: IncidentState; onOpenChannel: (id: string) => void }) {
  const { me, toast } = useApp();
  const [entries, setEntries] = useState<TimelineEntry[] | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('key');
  const [type, setType] = useState('note');
  const [text, setText] = useState('');
  const [when, setWhen] = useState('');
  const incidentId = state.incident.id;

  useEffect(() => {
    api.get<{ entries: TimelineEntry[] }>(`/api/incidents/${incidentId}/timeline`).then((r) => setEntries(r.entries));
    const s = getSocket();
    const onNew = (e: TimelineEntry) =>
      e.incidentId === incidentId && setEntries((es) => (es ? [...es, e].sort((a, b) => a.ts.localeCompare(b.ts)) : es));
    const onDel = ({ id }: { id: string }) => setEntries((es) => es?.filter((e) => e.id !== id) ?? es);
    s.on('timeline:new', onNew);
    s.on('timeline:deleted', onDel);
    return () => {
      s.off('timeline:new', onNew);
      s.off('timeline:deleted', onDel);
    };
  }, [incidentId]);

  const shown = useMemo(() => {
    if (!entries) return [];
    if (filter === 'all') return entries;
    if (filter === 'human') return entries.filter((e) => HUMAN.has(e.type));
    if (filter === 'people') return entries.filter((e) => PEOPLE.has(e.type));
    // Room and voice comings and goings are many; they have their own filter.
    return entries.filter((e) => e.type !== 'joined' && e.type !== 'presence');
  }, [entries, filter]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    await api.post(`/api/incidents/${incidentId}/timeline`, { type, text, ts: utcInputToIso(when) });
    setText('');
    setWhen('');
  };

  let lastDay = '';

  return (
    <div className="timeline-view">
      <div className="view-head">
        <h2>{Icons.clock} Timeline</h2>
        <div className="seg">
          {FILTERS.map((f) => (
            <button key={f.key} className={filter === f.key ? 'on' : ''} onClick={() => setFilter(f.key)}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <a className="btn ghost sm" href={`/api/incidents/${incidentId}/export.md`}>
          {Icons.download} Export Markdown
        </a>
      </div>

      <form className="timeline-add" onSubmit={add}>
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Entry type">
          <option value="note">Note</option>
          <option value="decision">Decision</option>
          <option value="action">Action</option>
          <option value="finding">Finding</option>
        </select>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="What happened? e.g. Blocked 203.0.113.7 at the edge firewall" />
        <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} title="When it happened (UTC). Leave empty for now." aria-label="Time (UTC)" />
        <button className="btn primary" disabled={!text.trim()}>
          Add
        </button>
      </form>

      <ol className="timeline">
        {entries === null && <div className="skeleton" />}
        {entries && shown.length === 0 && <div className="empty sm">No entries for this filter.</div>}
        {shown.map((e) => {
          const day = e.ts.slice(0, 10);
          const dayHeader = day !== lastDay;
          lastDay = day;
          const human = HUMAN.has(e.type);
          return (
            <li key={e.id} className={`tl ${human ? 'human' : 'auto'} tl-${e.type}`}>
              {dayHeader && <div className="tl-day">{day} UTC</div>}
              <div className="tl-row">
                <span className="tl-time mono" title={`${localTime(e.ts)} local`}>
                  {utcTime(e.ts)}
                </span>
                <span className="tl-dot" aria-hidden />
                <div className="tl-body">
                  <span className={`tl-type t-${e.type}`}>{TYPE_LABEL[e.type] ?? e.type}</span>
                  <span className="tl-text">{e.text}</span>
                  <span className="muted small">{e.displayName ? ` — ${e.displayName}` : ''}</span>
                  {e.agent && <AgentTag name={e.agent} person={e.displayName} />}
                  {e.ref?.channelId && state.channels.some((c) => c.id === e.ref!.channelId) && (
                    <button className="link-btn small" onClick={() => onOpenChannel(e.ref!.channelId!)}>
                      view in chat
                    </button>
                  )}
                </div>
                {human && e.userId === me.id && (
                  <button
                    className="icon-btn sm tl-del"
                    title="Remove entry"
                    onClick={() => api.del(`/api/timeline/${e.id}`).catch((err) => toast({ text: err.message, tone: 'error' }))}
                  >
                    {Icons.trash}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
