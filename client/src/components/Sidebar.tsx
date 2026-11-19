import { useState, type DragEvent } from 'react';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { useVoice } from '../lib/voice';
import { PERSON_DRAG, useModeration } from '../lib/moderation';
import type { Channel, IncidentState, Presence, View } from '../types';
import { Avatar, Icons } from './ui';
import { ChannelSettingsDialog, NewBreakoutDialog, NewChannelDialog, NewNoteDialog, NewSheetDialog } from './dialogs';
import { VoiceDock } from './VoiceDock';
import { PersonActions } from './PersonActions';
import { AssignDialog, type AssignTarget } from './AssignDialog';
import { GuestTag } from './Guests';

interface Props {
  state: IncidentState;
  presence: Presence[];
  view: View;
  unread: Record<string, number>;
  mentions: Record<string, number>;
  onView: (v: View) => void;
  onJoinVoice: (voiceRoomId: string) => void;
}

export function Sidebar({ state, presence, view, unread, mentions, onView, onJoinVoice }: Props) {
  const { me, toast, userById } = useApp();
  const voice = useVoice();
  const [dialog, setDialog] = useState<null | 'breakout' | 'channel' | 'sheet' | 'note' | { channel: Channel }>(null);
  const [assign, setAssign] = useState<AssignTarget | null>(null);
  const asgFor = (kind: string, id: string) => state.assignments.filter((a) => a.targetKind === kind && a.targetId === id);
  const myAsg = state.assignments.filter((a) => a.userId === me.id);
  const mod = useModeration(state);
  const [dropOn, setDropOn] = useState<string | null>(null);

  const dragProps = (userId: string) =>
    mod.can && userId !== me.id
      ? {
          draggable: true,
          onDragStart: (e: DragEvent) => {
            e.dataTransfer.setData(PERSON_DRAG, userId);
            e.dataTransfer.effectAllowed = 'move';
          },
          title: 'Drag to another voice room to move them',
        }
      : {};
  const dropProps = (voiceRoomId: string) =>
    mod.can
      ? {
          onDragOver: (e: DragEvent) => {
            if (!e.dataTransfer.types.includes(PERSON_DRAG)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setDropOn(voiceRoomId);
          },
          onDragLeave: (e: DragEvent) => {
            if (!(e.currentTarget as Node).contains(e.relatedTarget as Node)) setDropOn(null);
          },
          onDrop: (e: DragEvent) => {
            setDropOn(null);
            const userId = e.dataTransfer.getData(PERSON_DRAG);
            if (userId) {
              e.preventDefault();
              void mod.move(userId, voiceRoomId);
            }
          },
        }
      : {};

  const speakingIds = new Set(voice.participants.filter((p) => p.speaking).map((p) => p.identity));
  const isActive = (v: View) =>
    v.kind === view.kind && ('id' in v && 'id' in view ? v.id === view.id : true);

  const channelRow = (c: Channel, nested = false) => (
    <div key={`${nested ? 'n' : 'c'}-${c.id}`} className={`nav-item ${nested ? 'nested' : ''} ${isActive({ kind: 'channel', id: c.id }) ? 'active' : ''}`}>
      <button className="nav-main" onClick={() => onView({ kind: 'channel', id: c.id })}>
        <span className="nav-icon">{Icons.hash}</span>
        <span className="nav-label">{c.name}</span>
        {myAsg.some((a) => a.targetKind === 'channel' && a.targetId === c.id) && (
          <span className="mine-tag" title="You are assigned here">
            {myAsg.find((a) => a.targetKind === 'channel' && a.targetId === c.id)?.lead ? 'lead' : 'you'}
          </span>
        )}
        {c.shared && (
          <span className="shared-badge" title={`Shared from ${c.incidentKey}`}>
            ↗ {c.incidentKey}
          </span>
        )}
        {!c.shared && c.sharedWith.length > 0 && (
          <span className="shared-badge" title={`Shared with ${c.sharedWith.map((s) => s.key).join(', ')}`}>
            {Icons.share}
          </span>
        )}
        {mentions[c.id] ? (
          <span className="badge mention-badge" title={`${mentions[c.id]} mention${mentions[c.id] > 1 ? 's' : ''} of you`}>
            @{mentions[c.id] > 1 ? mentions[c.id] : ''}
          </span>
        ) : unread[c.id] ? (
          <span className="badge">{unread[c.id]}</span>
        ) : null}
      </button>
      {!nested && !me.isGuest && (
        <button className="nav-action" title="Channel settings" aria-label={`Settings for #${c.name}`} onClick={() => setDialog({ channel: c })}>
          {Icons.more}
        </button>
      )}
    </div>
  );

  return (
    <aside className="room-left">
      <div className="nav-scroll">
        <section className="nav-section">
          <div className="nav-head">
            <span>Voice rooms</span>
            {!me.isGuest && <button className="icon-btn sm" title="New breakout room" aria-label="New breakout room" onClick={() => setDialog('breakout')}>
              {Icons.plus}
            </button>}
          </div>
          {state.voiceRooms.map((vr) => {
            const inRoom = presence.filter((p) => p.voiceRoomId === vr.id);
            const asg = asgFor('voice', vr.id);
            const leadId = asg.find((a) => a.lead)?.userId;
            const absent = asg.filter((a) => !inRoom.some((p) => p.userId === a.userId));
            const where = (userId: string) => {
              const p = presence.find((x) => x.userId === userId);
              if (!p) return 'not in the war room';
              return p.voiceRoomId ? `in ${state.voiceRooms.find((v) => v.id === p.voiceRoomId)?.name}` : 'not in voice';
            };
            const mine = voice.roomId === vr.id;
            const linked = state.channels.filter((c) => vr.channelIds.includes(c.id));
            return (
              <div key={vr.id} className={`voice-room ${mine ? 'mine' : ''} ${vr.kind} ${dropOn === vr.id ? 'drop-target' : ''}`} {...dropProps(vr.id)}>
                <div className="voice-room-head">
                  <button className="nav-main" onClick={() => onJoinVoice(vr.id)} title={mine ? 'You are here' : `Join ${vr.name}`}>
                    <span className="nav-icon">{Icons.volume}</span>
                    <span className="nav-label">{vr.name}</span>
                    {myAsg.some((a) => a.targetKind === 'voice' && a.targetId === vr.id) && (
                      <span className="mine-tag" title="You are assigned here">
                        {leadId === me.id ? 'lead' : 'you'}
                      </span>
                    )}
                    {inRoom.length > 0 && <span className="count">{inRoom.length}</span>}
                  </button>
                  {mod.can && (
                    <button className="nav-action" title={`Assign people to ${vr.name}`} aria-label={`Assign people to ${vr.name}`} onClick={() => setAssign({ kind: 'voice', id: vr.id })}>
                      {Icons.users}
                    </button>
                  )}
                  {vr.kind === 'main' && mod.can && (
                    <button
                      className="nav-action"
                      title="Call everyone to this room"
                      aria-label={`Call everyone to ${vr.name}`}
                      onClick={() => api.post(`/api/voice-rooms/${vr.id}/summon`).then(() => toast({ text: `Called everyone to ${vr.name}` }, 3000))}
                    >
                      {Icons.megaphone}
                    </button>
                  )}
                  {vr.kind === 'breakout' && mod.can && (
                    <button
                      className="nav-action"
                      title="Close breakout room"
                      aria-label={`Close ${vr.name}`}
                      onClick={() => {
                        if (inRoom.length && !confirm(`${inRoom.length} people are still in ${vr.name}. Close it?`)) return;
                        if (mine) void voice.leave();
                        api.patch(`/api/voice-rooms/${vr.id}`, { archived: true });
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
                {vr.objective && (
                  <div className="voice-objective" title="Objective">
                    {vr.objective}
                  </div>
                )}
                {(inRoom.length > 0 || absent.length > 0) && (
                  <ul className="voice-people">
                    {inRoom.map((p) => (
                      <li key={p.userId} className={`${speakingIds.has(p.userId) ? 'speaking' : ''} ${mod.can && p.userId !== me.id ? 'movable' : ''}`} {...dragProps(p.userId)}>
                        <Avatar id={p.userId} name={p.displayName} size={20} speaking={speakingIds.has(p.userId)} muted={p.muted} />
                        <span className="nav-label">{p.displayName}</span>
                        <GuestTag user={userById(p.userId)} />
                        {p.userId === leadId && <span className="lead-tag">lead</span>}
                        {p.sharing && <span className="sharing-tag" title="Sharing screen">{Icons.screen}</span>}
                        {p.userId !== me.id && <PersonActions state={state} person={p} />}
                      </li>
                    ))}
                    {absent.map((a) => (
                      <li key={`a-${a.userId}`} className="absent" title={`Assigned here, currently ${where(a.userId)}`}>
                        <Avatar id={a.userId} name={userById(a.userId)?.displayName ?? '?'} size={20} />
                        <span className="nav-label">{userById(a.userId)?.displayName}</span>
                        {a.lead && <span className="lead-tag">lead</span>}
                        <span className="absent-tag">{where(a.userId).replace(/^in /, '→ ').replace('not in the war room', 'away').replace('not in voice', 'no voice')}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {linked.map((c) => channelRow(c, true))}
              </div>
            );
          })}
        </section>

        <section className="nav-section">
          <div className="nav-head">
            <span>Channels</span>
            {!me.isGuest && <button className="icon-btn sm" title="New channel" aria-label="New channel" onClick={() => setDialog('channel')}>
              {Icons.plus}
            </button>}
          </div>
          {state.channels.map((c) => channelRow(c))}
        </section>

        <section className="nav-section">
          <div className="nav-head">
            <span>Sheets</span>
            {!me.isGuest && <button className="icon-btn sm" title="New sheet" aria-label="New sheet" onClick={() => setDialog('sheet')}>
              {Icons.plus}
            </button>}
          </div>
          {state.sheets.map((s) => {
            const viewers = presence.filter((p) => p.view === `sheet:${s.id}` && p.userId !== me.id);
            return (
              <div key={s.id} className={`nav-item ${isActive({ kind: 'sheet', id: s.id }) ? 'active' : ''}`}>
                <button className="nav-main" onClick={() => onView({ kind: 'sheet', id: s.id })}>
                  <span className="nav-icon">{Icons.grid}</span>
                  <span className="nav-label">{s.name}</span>
                  {viewers.length > 0 && <span className="count" title={viewers.map((v) => v.displayName).join(', ')}>{viewers.length}</span>}
                </button>
              </div>
            );
          })}
          {state.sheets.length === 0 && <div className="nav-empty">No sheets yet</div>}
        </section>

        <section className="nav-section">
          <div className="nav-head">
            <span>Notes</span>
            {!me.isGuest && <button className="icon-btn sm" title="New note" aria-label="New note" onClick={() => setDialog('note')}>
              {Icons.plus}
            </button>}
          </div>
          {state.notes.map((n) => {
            const viewers = presence.filter((p) => p.view === `note:${n.id}` && p.userId !== me.id);
            return (
              <div key={n.id} className={`nav-item ${isActive({ kind: 'note', id: n.id }) ? 'active' : ''}`}>
                <button className="nav-main" onClick={() => onView({ kind: 'note', id: n.id })}>
                  <span className="nav-icon">{Icons.note}</span>
                  <span className="nav-label">{n.name}</span>
                  {viewers.length > 0 && <span className="count" title={viewers.map((v) => v.displayName).join(', ')}>{viewers.length}</span>}
                </button>
              </div>
            );
          })}
          {state.notes.length === 0 && <div className="nav-empty">No notes yet</div>}
        </section>

        <section className="nav-section">
          {state.canSeeTimeline && <div className={`nav-item ${view.kind === 'timeline' ? 'active' : ''}`}>
            <button className="nav-main" onClick={() => onView({ kind: 'timeline' })}>
              <span className="nav-icon">{Icons.clock}</span>
              <span className="nav-label">Timeline</span>
            </button>
          </div>}
          {!me.isGuest && (<>
          <div className={`nav-item ${view.kind === 'roster' ? 'active' : ''}`}>
            <button className="nav-main" onClick={() => onView({ kind: 'roster' })}>
              <span className="nav-icon">{Icons.users}</span>
              <span className="nav-label">Who’s doing what</span>
            </button>
          </div>
          <div className={`nav-item ${view.kind === 'schedule' ? 'active' : ''}`}>
            <button className="nav-main" onClick={() => onView({ kind: 'schedule' })}>
              <span className="nav-icon">{Icons.calendar}</span>
              <span className="nav-label">Schedule</span>
              {(() => {
                const t = new Date().toISOString();
                const n = state.shifts.filter((s) => s.startsAt <= t && s.endsAt > t).length;
                return n > 0 ? <span className="count" title={`${n} on shift now`}>{n}</span> : null;
              })()}
            </button>
          </div>
          <div className={`nav-item ${view.kind === 'files' ? 'active' : ''}`}>
            <button className="nav-main" onClick={() => onView({ kind: 'files' })}>
              <span className="nav-icon">{Icons.folder}</span>
              <span className="nav-label">Files</span>
            </button>
          </div>
          <div className={`nav-item ${view.kind === 'investigate' ? 'active' : ''}`}>
            <button className="nav-main" onClick={() => onView({ kind: 'investigate' })}>
              <span className="nav-icon">{Icons.search}</span>
              <span className="nav-label">Investigate</span>
            </button>
          </div>
          </>)}
        </section>
      </div>

      <VoiceDock state={state} onJoin={onJoinVoice} />

      {dialog === 'breakout' && <NewBreakoutDialog incidentId={state.incident.id} onClose={() => setDialog(null)} onCreated={(id) => onJoinVoice(id)} />}
      {dialog === 'channel' && <NewChannelDialog state={state} onClose={() => setDialog(null)} onCreated={(id) => onView({ kind: 'channel', id })} />}
      {dialog === 'note' && <NewNoteDialog incidentId={state.incident.id} onClose={() => setDialog(null)} onCreated={(id) => onView({ kind: 'note', id })} />}
      {dialog === 'sheet' && <NewSheetDialog incidentId={state.incident.id} onClose={() => setDialog(null)} onCreated={(id) => onView({ kind: 'sheet', id })} />}
      {assign && <AssignDialog state={state} presence={presence} target={assign} onClose={() => setAssign(null)} />}
      {dialog && typeof dialog === 'object' && <ChannelSettingsDialog state={state} channel={dialog.channel} onClose={() => setDialog(null)} />}
    </aside>
  );
}
