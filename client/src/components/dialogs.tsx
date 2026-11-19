import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import type { Channel, IncidentListItem, IncidentState } from '../types';
import { Modal } from './ui';

export function NewBreakoutDialog({ incidentId, onClose, onCreated }: { incidentId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [withChannel, setWithChannel] = useState(true);
  const [joinNow, setJoinNow] = useState(true);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await api.post<{ id: string }>(`/api/incidents/${incidentId}/voice-rooms`, { name, withChannel });
    onClose();
    if (joinNow) onCreated(r.id);
  };
  return (
    <Modal
      title="New breakout room"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" form="breakout" disabled={!name.trim()}>
            Open room
          </button>
        </>
      }
    >
      <form id="breakout" className="form" onSubmit={submit}>
        <label>
          Room name
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Forensics, Network Containment, Exec Briefing" />
        </label>
        <label className="check">
          <input type="checkbox" checked={withChannel} onChange={(e) => setWithChannel(e.target.checked)} /> Create a matching text channel
        </label>
        <label className="check">
          <input type="checkbox" checked={joinNow} onChange={(e) => setJoinNow(e.target.checked)} /> Move me there now
        </label>
      </form>
    </Modal>
  );
}

export function NewChannelDialog({ state, onClose, onCreated }: { state: IncidentState; onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [rooms, setRooms] = useState<string[]>([]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await api.post<{ id: string }>(`/api/incidents/${state.incident.id}/channels`, { name, topic, voiceRoomIds: rooms });
    onClose();
    onCreated(r.id);
  };
  return (
    <Modal
      title="New channel"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" form="channel" disabled={!name.trim()}>
            Create channel
          </button>
        </>
      }
    >
      <form id="channel" className="form" onSubmit={submit}>
        <label>
          Name
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. forensics, vendor-bridge" />
        </label>
        <label>
          Topic <span className="muted">(optional)</span>
          <input value={topic} onChange={(e) => setTopic(e.target.value)} />
        </label>
        <VoiceRoomPicker state={state} value={rooms} onChange={setRooms} />
      </form>
    </Modal>
  );
}

function VoiceRoomPicker({ state, value, onChange }: { state: IncidentState; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset>
      <legend>Show in voice rooms</legend>
      <p className="hint">A channel can be attached to several voice rooms so breakouts can share the same conversation.</p>
      {state.voiceRooms.map((vr) => (
        <label key={vr.id} className="check">
          <input
            type="checkbox"
            checked={value.includes(vr.id)}
            onChange={(e) => onChange(e.target.checked ? [...value, vr.id] : value.filter((x) => x !== vr.id))}
          />
          {vr.name}
        </label>
      ))}
    </fieldset>
  );
}

export function ChannelSettingsDialog({ state, channel, onClose }: { state: IncidentState; channel: Channel; onClose: () => void }) {
  const { toast } = useApp();
  const [rooms, setRooms] = useState<string[]>(channel.voiceRoomIds.filter((id) => state.voiceRooms.some((v) => v.id === id)));
  const [topic, setTopic] = useState(channel.topic);
  const [others, setOthers] = useState<IncidentListItem[]>([]);
  const [shareTo, setShareTo] = useState('');
  const owned = !channel.shared;

  useEffect(() => {
    api.get<{ incidents: IncidentListItem[] }>('/api/incidents?filter=active').then((r) =>
      setOthers(r.incidents.filter((i) => i.id !== channel.incidentId && !channel.sharedWith.some((s) => s.incidentId === i.id))),
    );
  }, [channel]);

  const save = async () => {
    await api.put(`/api/channels/${channel.id}/voice-links`, { incidentId: state.incident.id, voiceRoomIds: rooms });
    if (owned && topic !== channel.topic) await api.patch(`/api/channels/${channel.id}`, { topic });
    onClose();
  };

  const share = async () => {
    if (!shareTo) return;
    await api.post(`/api/channels/${channel.id}/shares`, { incidentId: shareTo });
    toast({ text: `#${channel.name} shared` }, 3000);
    onClose();
  };

  const unshare = async (incidentId: string) => {
    await api.del(`/api/channels/${channel.id}/shares/${incidentId}`);
    onClose();
  };

  return (
    <Modal
      title={`#${channel.name}`}
      onClose={onClose}
      footer={
        <>
          {owned && (
            <button
              className="btn ghost danger-text"
              onClick={async () => {
                if (!confirm(`Archive #${channel.name}? Messages are kept for the record.`)) return;
                await api.patch(`/api/channels/${channel.id}`, { archived: true });
                onClose();
              }}
            >
              Archive channel
            </button>
          )}
          <div className="spacer" />
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="form">
        {channel.shared && (
          <div className="alert info">
            Shared into this incident from <strong>{channel.incidentKey}</strong>. Messages are visible in both war rooms.
            <button className="btn ghost sm" onClick={() => unshare(state.incident.id)}>
              Remove from this incident
            </button>
          </div>
        )}
        {owned && (
          <label>
            Topic
            <input value={topic} onChange={(e) => setTopic(e.target.value)} />
          </label>
        )}
        <VoiceRoomPicker state={state} value={rooms} onChange={setRooms} />
        {owned && (
          <fieldset>
            <legend>Share with another incident</legend>
            <p className="hint">Useful when two incidents are related: both war rooms see and post to the same channel.</p>
            {channel.sharedWith.map((s) => (
              <div key={s.incidentId} className="share-row">
                <span className="mono">{s.key}</span> {s.title}
                <button className="btn ghost sm" onClick={() => unshare(s.incidentId)}>
                  Stop sharing
                </button>
              </div>
            ))}
            <div className="row">
              <select value={shareTo} onChange={(e) => setShareTo(e.target.value)}>
                <option value="">Choose an active incident…</option>
                {others.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.key} — {i.title}
                  </option>
                ))}
              </select>
              <button className="btn secondary" onClick={share} disabled={!shareTo}>
                Share
              </button>
            </div>
          </fieldset>
        )}
      </div>
    </Modal>
  );
}

export function NewSheetDialog({ incidentId, onClose, onCreated }: { incidentId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const { meta } = useApp();
  const [template, setTemplate] = useState('ioc');
  const [name, setName] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await api.post<{ id: string }>(`/api/incidents/${incidentId}/sheets`, { template, name });
    onClose();
    onCreated(r.id);
  };
  return (
    <Modal
      title="New sheet"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" form="sheet">
            Create sheet
          </button>
        </>
      }
    >
      <form id="sheet" className="form" onSubmit={submit}>
        <div className="template-grid">
          {meta.templates.map((t) => (
            <label key={t.key} className={`template ${template === t.key ? 'on' : ''}`}>
              <input type="radio" name="template" checked={template === t.key} onChange={() => setTemplate(t.key)} />
              <span>
                <strong>{t.name}</strong>
                <small className="muted">{t.description}</small>
              </span>
            </label>
          ))}
        </div>
        <label>
          Name <span className="muted">(optional)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={meta.templates.find((t) => t.key === template)?.name} />
        </label>
      </form>
    </Modal>
  );
}
