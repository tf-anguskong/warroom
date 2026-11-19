import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useApp } from '../lib/app';
import { getSocket } from '../lib/socket';
import { useVoice, VoiceProvider } from '../lib/voice';
import type { AssignedEvent, IncidentState, MentionEvent, Message, Presence, View } from '../types';
import { RoomHeader } from '../components/RoomHeader';
import { Sidebar } from '../components/Sidebar';
import { DetailsPanel } from '../components/DetailsPanel';
import { ScreenStage } from '../components/ScreenStage';
import { ChatView } from '../components/ChatView';
import { SheetView } from '../components/SheetView';
import { NoteView } from '../components/NoteView';
import { FilesView } from '../components/Files';
import { TimelineView } from '../components/TimelineView';
import { InvestigateView } from '../components/InvestigateView';
import { RosterView } from '../components/RosterView';
import { Icons } from '../components/ui';

export function IncidentRoom() {
  const { id } = useParams();
  return (
    <VoiceProvider key={id}>
      <Room incidentId={id!} />
    </VoiceProvider>
  );
}

const viewKey = (v: View) => ('id' in v ? `${v.kind}:${v.id}` : v.kind);
function parseView(s: string | null): View | null {
  if (!s) return null;
  if (s === 'timeline') return { kind: 'timeline' };
  if (s === 'investigate') return { kind: 'investigate' };
  if (s === 'roster') return { kind: 'roster' };
  if (s === 'files') return { kind: 'files' };
  const [kind, id] = s.split(':');
  if ((kind === 'channel' || kind === 'sheet' || kind === 'note') && id) return { kind, id };
  return null;
}

function Room({ incidentId }: { incidentId: string }) {
  const { me, toast } = useApp();
  const voice = useVoice();
  const [state, setState] = useState<IncidentState | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [presence, setPresence] = useState<Presence[]>([]);
  const [params, setParams] = useSearchParams();
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [mentions, setMentions] = useState<Record<string, number>>({});
  const [connected, setConnected] = useState(true);

  const load = useCallback(() => {
    api
      .get<IncidentState>(`/api/incidents/${incidentId}`)
      .then((st) => {
        setState(st);
        // Server count is the truth (it survives reloads); the open channel has already been read.
        const v = viewRef.current;
        setMentions({ ...st.unreadMentions, ...(v?.kind === 'channel' ? { [v.id]: 0 } : {}) });
      })
      .catch((e) => e instanceof ApiError && e.status === 404 && setNotFound(true));
  }, [incidentId]);

  const requested = parseView(params.get('view'));
  const view: View | null = useMemo(() => {
    if (!state) return null;
    if (requested?.kind === 'channel' && state.channels.some((c) => c.id === requested.id)) return requested;
    if (requested?.kind === 'sheet' && state.sheets.some((s) => s.id === requested.id)) return requested;
    if (requested?.kind === 'note' && state.notes.some((n) => n.id === requested.id)) return requested;
    if (requested?.kind === 'timeline' || requested?.kind === 'investigate' || requested?.kind === 'roster') return requested;
    if (requested?.kind === 'files' && !me.isGuest) return requested;
    return state.channels[0] ? { kind: 'channel', id: state.channels[0].id } : { kind: 'timeline' };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, params]);

  const setView = useCallback(
    (v: View) => {
      setParams((p) => {
        const n = new URLSearchParams(p);
        n.set('view', viewKey(v));
        return n;
      });
    },
    [setParams],
  );

  // Refs so socket handlers see the latest values without re-subscribing.
  const viewRef = useRef(view);
  viewRef.current = view;
  const voiceRoomRef = useRef(voice.roomId);
  voiceRoomRef.current = voice.roomId;
  const joinRef = useRef(voice.join);
  joinRef.current = voice.join;
  const joinVoiceRef = useRef<(id: string) => Promise<void>>(async () => undefined);
  const setViewRef = useRef<(v: View) => void>(() => undefined);

  useEffect(() => {
    load();
    const s = getSocket();
    const join = () => {
      setConnected(true);
      s.emit('incident:join', { incidentId });
      if (voiceRoomRef.current) s.emit('presence:update', { voiceRoomId: voiceRoomRef.current });
      load();
    };
    const onRefresh = ({ incidentId: iid }: { incidentId: string }) => iid === incidentId && load();
    const onPresence = (p: { incidentId: string; users: Presence[] }) => p.incidentId === incidentId && setPresence(p.users);
    const onMessage = (m: Message) => {
      const v = viewRef.current;
      const visible = v?.kind === 'channel' && v.id === m.channelId;
      if (!visible && m.userId !== me.id) setUnread((u) => ({ ...u, [m.channelId]: (u[m.channelId] ?? 0) + 1 }));
    };
    const onSummon = (e: { voiceRoomId: string; name: string; by: string }) => {
      if (voiceRoomRef.current === e.voiceRoomId) return;
      toast({ text: `${e.by} is calling everyone to ${e.name}`, action: { label: 'Join', run: () => void joinRef.current(e.voiceRoomId) }, tone: 'warn' }, 20000);
    };
    const isVisible = (channelId: string) => {
      const v = viewRef.current;
      return v?.kind === 'channel' && v.id === channelId;
    };
    const onMention = (e: MentionEvent) => {
      if (e.incidentId === incidentId && isVisible(e.channelId)) return;
      if (e.incidentId === incidentId) setMentions((m) => ({ ...m, [e.channelId]: (m[e.channelId] ?? 0) + 1 }));
      const where = e.incidentId === incidentId ? `#${e.channelName}` : `#${e.channelName} (${e.incidentKey})`;
      toast(
        {
          text: `${e.by} mentioned you in ${where}: ${e.preview}`,
          tone: 'warn',
          action: {
            label: 'Open',
            run: () =>
              e.incidentId === incidentId
                ? setViewRef.current({ kind: 'channel', id: e.channelId })
                : (location.href = `/incidents/${e.incidentId}?view=channel:${e.channelId}`),
          },
        },
        15000,
      );
    };
    const onMoved = (e: { incidentId: string; voiceRoomId: string; name: string; by: string; invite: boolean }) => {
      if (e.incidentId !== incidentId) return;
      if (!e.invite && voiceRoomRef.current) {
        void joinVoiceRef.current(e.voiceRoomId);
        toast({ text: `${e.by} moved you to ${e.name}` }, 5000);
      } else {
        toast({ text: `${e.by} is asking you to join ${e.name}`, tone: 'warn', action: { label: 'Join', run: () => void joinVoiceRef.current(e.voiceRoomId) } }, 20000);
      }
    };
    const onMuted = (e: { incidentId: string; by: string }) =>
      e.incidentId === incidentId && toast({ text: `${e.by} muted your microphone. Unmute with the mic button or Ctrl+Shift+M.`, tone: 'warn' }, 8000);
    const onRemoved = (e: { incidentId: string; name: string; by: string }) =>
      e.incidentId === incidentId && toast({ text: `${e.by} removed you from ${e.name}`, tone: 'warn' }, 8000);
    const onAssigned = (e: AssignedEvent) => {
      if (e.incidentId !== incidentId) return;
      const role = e.lead ? 'lead of' : 'to';
      if (e.targetKind === 'voice') {
        const already = voiceRoomRef.current === e.targetId;
        toast(
          {
            text: `${e.by} assigned you ${role} ${e.label}`,
            tone: 'warn',
            action: already ? undefined : { label: 'Join', run: () => void joinVoiceRef.current(e.targetId) },
          },
          20000,
        );
      } else {
        toast({ text: `${e.by} assigned you ${role} ${e.label}`, tone: 'warn', action: { label: 'Open', run: () => setViewRef.current({ kind: 'channel', id: e.targetId }) } }, 20000);
      }
    };
    const onCommand = (e: { incidentId: string; to: string | null; from: string | null; by: string; you: boolean; note: string }) => {
      if (e.incidentId !== incidentId) return;
      const text = e.you
        ? `${e.by} handed Incident Command to you${e.note ? `: ${e.note}` : ''}`
        : `${e.by} ${e.to ? `made ${e.to} Incident Commander` : 'released Incident Command'}${e.note ? `: ${e.note}` : ''}`;
      toast({ text, tone: 'warn' }, 20000);
    };
    const onTaskSet = (e: { incidentId: string; task: string; by: string }) =>
      e.incidentId === incidentId &&
      toast({ text: e.task ? `${e.by} set your task: ${e.task}` : `${e.by} cleared your task`, action: { label: 'View', run: () => setViewRef.current({ kind: 'roster' }) } }, 10000);
    const onDisconnect = () => setConnected(false);
    if (s.connected) join();
    s.on('connect', join);
    s.on('disconnect', onDisconnect);
    s.on('incident:refresh', onRefresh);
    s.on('presence', onPresence);
    s.on('message:new', onMessage);
    s.on('voice:summon', onSummon);
    s.on('mention', onMention);
    s.on('voice:moved', onMoved);
    s.on('voice:muted', onMuted);
    s.on('voice:removed', onRemoved);
    s.on('assigned', onAssigned);
    s.on('task:set', onTaskSet);
    s.on('command:changed', onCommand);
    return () => {
      s.emit('incident:leave');
      s.off('connect', join);
      s.off('disconnect', onDisconnect);
      s.off('incident:refresh', onRefresh);
      s.off('presence', onPresence);
      s.off('message:new', onMessage);
      s.off('voice:summon', onSummon);
      s.off('mention', onMention);
      s.off('voice:moved', onMoved);
      s.off('voice:muted', onMuted);
      s.off('voice:removed', onRemoved);
      s.off('assigned', onAssigned);
      s.off('task:set', onTaskSet);
      s.off('command:changed', onCommand);
    };
  }, [incidentId, load, me.id, toast]);

  // Clear unread for whatever is on screen, and tell others what we're looking at.
  useEffect(() => {
    if (!view) return;
    getSocket().emit('presence:update', { view: viewKey(view) });
    if (view.kind === 'channel') {
      setUnread((u) => ({ ...u, [view.id]: 0 }));
      setMentions((m) => ({ ...m, [view.id]: 0 }));
    }
  }, [view]);

  const joinVoice = useCallback(
    async (voiceRoomId: string) => {
      await voice.join(voiceRoomId);
      const vr = state?.voiceRooms.find((v) => v.id === voiceRoomId);
      const ch = vr?.channelIds[0];
      if (!ch) return;
      // Don't pull someone off a sheet they're working in; otherwise open the room's channel.
      if (viewRef.current?.kind !== 'sheet' && viewRef.current?.kind !== 'note') setView({ kind: 'channel', id: ch });
    },
    [voice, state, setView],
  );
  joinVoiceRef.current = joinVoice;
  setViewRef.current = setView;

  if (notFound)
    return (
      <div className="empty">
        <h2>Incident not found</h2>
        <Link to="/" className="btn secondary">
          Back to incidents
        </Link>
      </div>
    );
  if (!state || !view) return <div className="splash">Opening war room…</div>;

  return (
    <div className={`room ${state.incident.status === 'resolved' ? 'is-resolved' : ''} room-${state.incident.severity.toLowerCase()}`}>
      {!connected && <div className="conn-banner">Reconnecting to the war room…</div>}
      <RoomHeader state={state} />
      <Sidebar
        state={state}
        presence={presence}
        view={view}
        unread={unread}
        mentions={mentions}
        onView={setView}
        onJoinVoice={joinVoice}
      />
      <main className="room-main">
        {me.isGuest && (
          <div className="guest-banner">
            You’re a <strong>guest</strong> in {state.incident.key}. You see only what you were invited to; your access ends at{' '}
            {me.guestExpiresAt?.slice(11, 16)} UTC.
          </div>
        )}
        <ScreenStage />
        <div className="room-view">
          {view.kind === 'channel' && <ChatView key={view.id} channelId={view.id} state={state} presence={presence} />}
          {view.kind === 'sheet' && <SheetView key={view.id} sheetId={view.id} state={state} presence={presence} />}
          {view.kind === 'note' && <NoteView key={view.id} noteId={view.id} state={state} presence={presence} />}
          {view.kind === 'timeline' && <TimelineView state={state} onOpenChannel={(id) => setView({ kind: 'channel', id })} />}
          {view.kind === 'files' && <FilesView state={state} onOpenChannel={(id) => setView({ kind: 'channel', id })} onOpenNote={(id) => setView({ kind: 'note', id })} />}
          {view.kind === 'roster' && <RosterView state={state} presence={presence} onOpenChannel={(id) => setView({ kind: 'channel', id })} />}
          {view.kind === 'investigate' && (
            <InvestigateView
              state={state}
              onOpenChannel={(id) => setView({ kind: 'channel', id })}
              onOpenSheet={(id) => setView({ kind: 'sheet', id })}
            />
          )}
        </div>
      </main>
      <aside className="room-right">
        <div className="right-head">Incident</div>
        <DetailsPanel state={state} presence={presence} />
      </aside>
    </div>
  );
}
