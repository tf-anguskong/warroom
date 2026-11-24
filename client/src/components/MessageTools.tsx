import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { useApp } from '../lib/app';
import { renderMessage, utcTime, type MentionLookup } from '../lib/format';
import type { IncidentState, Message } from '../types';
import { Modal } from './ui';

/** Message moderation and history: edit in place, delete (or erase), copy or move, earlier versions. */

const when = (iso: string) => `${iso.slice(0, 10)} ${utcTime(iso)}Z`;

/** Inline editor that replaces the message body while editing. Enter saves, Shift+Enter is a new line, Esc cancels. */
export function MessageEditor({ message, incidentId, onDone, othersMessage }: { message: Message; incidentId: string; onDone: () => void; othersMessage: boolean }) {
  const { toast } = useApp();
  const [text, setText] = useState(message.body);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, []);
  const save = async () => {
    if (text.trim() === message.body) return onDone();
    setBusy(true);
    try {
      await api.patch(`/api/messages/${message.id}`, { body: text, incidentId });
      onDone();
    } catch (e) {
      toast({ text: e instanceof ApiError ? e.message : 'Could not save the edit', tone: 'error' }, 6000);
      setBusy(false);
    }
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onDone();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void save();
    }
  };
  return (
    <div className="msg-edit">
      <textarea ref={ref} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={keys} rows={Math.min(10, Math.max(2, text.split('\n').length))} maxLength={20000} />
      <div className="msg-edit-bar">
        <span className="muted small">
          {othersMessage ? 'You’re editing someone else’s message: it’s marked as edited by you, goes on the timeline, and the original stays in its history. ' : 'The earlier version stays in the message’s history. '}
          Enter saves, Esc cancels.
        </span>
        <button className="btn ghost sm" onClick={onDone} disabled={busy}>
          Cancel
        </button>
        <button className="btn primary sm" onClick={save} disabled={busy || (!text.trim() && !message.attachments.length)}>
          Save
        </button>
      </div>
    </div>
  );
}

interface History {
  versions: { body: string; writtenAt: string; writtenBy: string; replacedAt: string; replacedBy: string; deleted: boolean }[];
  current: { body: string; writtenAt: string; writtenBy: string } | null;
  deleted: { by: string; at: string; erased: boolean } | null;
  canSeeDeleted: boolean;
  channel: string;
}

export function HistoryDialog({ message, incidentId, mentions, onClose }: { message: Message; incidentId: string; mentions: MentionLookup; onClose: () => void }) {
  const [h, setH] = useState<History | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api
      .get<History>(`/api/messages/${message.id}/history?incidentId=${incidentId}`)
      .then(setH)
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Could not load the history'));
  }, [message.id, incidentId]);
  const edits = h?.versions.filter((v) => !v.deleted) ?? [];
  return (
    <Modal title={`Message history · #${h?.channel ?? ''}`} onClose={onClose} wide footer={<button className="btn ghost" onClick={onClose}>Close</button>}>
      {err ? (
        <div className="alert error">
          <div>{err}</div>
        </div>
      ) : !h ? (
        <div className="skeleton" />
      ) : (
        <ol className="msg-history">
          {h.versions.map((v, i) => (
            <li key={i} className={v.deleted ? 'deleted' : ''}>
              <div className="small muted">
                <strong>{v.deleted ? 'Deleted text' : i === 0 ? 'Original' : `Version ${i + 1}`}</strong> · written by {v.writtenBy} at {when(v.writtenAt)} ·{' '}
                {v.deleted ? `deleted by ${v.replacedBy} at ${when(v.replacedAt)}` : `replaced by ${v.replacedBy} at ${when(v.replacedAt)}`}
              </div>
              <div className="msg-history-body">{v.body ? renderMessage(v.body, undefined, mentions) : <em className="muted">(no text)</em>}</div>
            </li>
          ))}
          {h.current && (
            <li className="current">
              <div className="small muted">
                <strong>Current</strong> · {edits.length ? `edited by ${h.current.writtenBy}` : `written by ${h.current.writtenBy}`} at {when(h.current.writtenAt)}
              </div>
              <div className="msg-history-body">{renderMessage(h.current.body, undefined, mentions)}</div>
            </li>
          )}
          {h.deleted && (
            <li className="deleted">
              <div className="small">
                Deleted by {h.deleted.by} at {when(h.deleted.at)}.{' '}
                {h.deleted.erased
                  ? 'It was erased: the text and its earlier versions are gone for good.'
                  : h.canSeeDeleted
                    ? ''
                    : 'Only the Incident Commander and room admins can see what it said.'}
              </div>
            </li>
          )}
          {h.versions.length === 0 && !h.deleted && <li className="muted small">No earlier versions.</li>}
        </ol>
      )}
    </Modal>
  );
}

export function DeleteDialog({ message, incidentId, own, onClose }: { message: Message; incidentId: string; own: boolean; onClose: () => void }) {
  const { toast } = useApp();
  const [erase, setErase] = useState(false);
  const [busy, setBusy] = useState(false);
  const already = Boolean(message.deleted);
  const go = async () => {
    setBusy(true);
    try {
      await api.del(`/api/messages/${message.id}?incidentId=${incidentId}${erase || already ? '&erase=1' : ''}`);
      toast({ text: erase || already ? 'Message erased' : 'Message deleted' }, 2500);
      onClose();
    } catch (e) {
      toast({ text: e instanceof ApiError ? e.message : 'Could not delete the message', tone: 'error' }, 6000);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={already ? 'Erase this message' : own ? 'Delete your message' : `Delete ${message.displayName}’s message`}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn danger" onClick={go} disabled={busy}>
            {already || erase ? 'Erase' : 'Delete'}
          </button>
        </>
      }
    >
      <div className="form">
        {already ? (
          <p>The text is already hidden. Erasing also removes it, and every earlier version, from the history, and deletes the message’s attachments. This can’t be undone.</p>
        ) : (
          <>
            <p>
              Everyone sees “Message deleted by you” in its place. The Incident Commander and room admins can still read the original in its history, and the delete
              goes on the timeline.
            </p>
            <label className="check">
              <input type="checkbox" checked={erase} onChange={(e) => setErase(e.target.checked)} /> Erase it completely: also remove the text and earlier versions from the
              history and delete its attachments. Use this for a password, key or personal data pasted by mistake. It can’t be undone.
            </label>
          </>
        )}
      </div>
    </Modal>
  );
}

/** Copy or move a message to another channel in this war room, showing who will (and won't) see it. */
export function CopyMoveDialog({ message, state, onClose }: { message: Message; state: IncidentState; onClose: () => void }) {
  const { toast } = useApp();
  const from = state.channels.find((c) => c.id === message.channelId);
  const targets = state.channels.filter((c) => c.id !== message.channelId);
  const [to, setTo] = useState(targets[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const guestsIn = (channelId: string) => state.guests.filter((g) => g.active && g.scope?.channels.some((c) => c.id === channelId)).map((g) => g.displayName);
  const target = targets.find((c) => c.id === to);
  const gain = target ? guestsIn(target.id) : [];
  const lose = from ? guestsIn(from.id).filter((g) => !gain.includes(g)) : [];
  const act = async (action: 'copy' | 'move') => {
    setBusy(true);
    try {
      await api.post(`/api/messages/${message.id}/${action}`, { channelId: to, incidentId: state.incident.id });
      toast({ text: `${action === 'copy' ? 'Copied' : 'Moved'} to #${target?.name}` }, 2500);
      onClose();
    } catch (e) {
      toast({ text: e instanceof ApiError ? e.message : `Could not ${action} the message`, tone: 'error' }, 6000);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Copy or move this message"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn secondary" disabled={busy || !to} onClick={() => act('copy')} title="Keep it here and post a copy in the other channel">
            Copy
          </button>
          <button className="btn primary" disabled={busy || !to} onClick={() => act('move')} title="Take it out of this channel and put it in the other one">
            Move
          </button>
        </>
      }
    >
      <div className="form">
        <div className="msg-quote">
          <div className="small muted">
            {message.displayName} in #{from?.name}
          </div>
          <div className="small">{message.body.length > 300 ? `${message.body.slice(0, 300)}…` : message.body || <em className="muted">(attachments only)</em>}</div>
        </div>
        {targets.length === 0 ? (
          <div className="muted small">This war room has no other channels.</div>
        ) : (
          <label>
            To
            <select value={to} onChange={(e) => setTo(e.target.value)}>
              {targets.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                  {c.shared ? ` (shared from ${c.incidentKey})` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        <ul className="small copy-move-notes">
          <li>It keeps its author{message.attachments.length ? ' and attachments' : ''}, and is marked as copied or moved by you. Both go on the timeline.</li>
          {gain.length > 0 && <li className="warn-text">Guests who will see it in #{target?.name}: {gain.join(', ')}.</li>}
          {lose.length > 0 && <li>If you move it, guests in #{from?.name} who will no longer see it: {lose.join(', ')}.</li>}
          {target?.shared && <li className="warn-text">#{target.name} is shared with another war room; people there will see it too.</li>}
        </ul>
      </div>
    </Modal>
  );
}
