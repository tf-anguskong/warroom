import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { getSocket } from '../lib/socket';
import { localTime, plainText, renderMessage, utcTime, type MentionLookup } from '../lib/format';
import type { IncidentState, Message, Presence } from '../types';
import { Avatar, Icons } from './ui';
import { MentionComposer, type ComposerHandle } from './MentionComposer';
import { Attachments } from './Files';
import { filesFrom } from '../lib/upload';
import { AssignDialog } from './AssignDialog';
import { GuestTag } from './Guests';

const TIMELINE_TYPES = [
  { key: 'decision', label: 'Decision' },
  { key: 'action', label: 'Action' },
  { key: 'finding', label: 'Finding' },
  { key: 'note', label: 'Note' },
];

export function ChatView({
  channelId,
  state,
  presence,
  compact,
}: {
  channelId: string;
  state: IncidentState;
  presence: Presence[];
  compact?: boolean;
}) {
  const { toast, me, meta, userById } = useApp();
  const nameCache = useRef<Record<string, string>>({});
  const channel = state.channels.find((c) => c.id === channelId);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [showPins, setShowPins] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [dragging, setDragging] = useState(false);
  const composer = useRef<ComposerHandle>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const resolved = state.incident.status === 'resolved';

  useEffect(() => {
    let alive = true;
    api.get<{ messages: Message[]; hasMore: boolean }>(`/api/channels/${channelId}/messages`).then((r) => {
      if (!alive) return;
      setMessages(r.messages);
      setHasMore(r.hasMore);
    });
    const s = getSocket();
    const markRead = () => void api.post(`/api/channels/${channelId}/mentions/read`).catch(() => undefined);
    markRead();
    const onNew = (m: Message) => {
      if (m.channelId !== channelId) return;
      setMessages((ms) => (ms && !ms.some((x) => x.id === m.id) ? [...ms, m] : ms));
      if (m.mentions.includes(me.id)) markRead();
    };
    const onUpd = (m: Message) => m.channelId === channelId && setMessages((ms) => ms?.map((x) => (x.id === m.id ? m : x)) ?? ms);
    const onFiles = (e: { messageId: string; channelId: string; attachments: Message['attachments'] }) =>
      e.channelId === channelId && setMessages((ms) => ms?.map((x) => (x.id === e.messageId ? { ...x, attachments: e.attachments } : x)) ?? ms);
    s.on('message:new', onNew);
    s.on('message:updated', onUpd);
    s.on('message:files', onFiles);
    return () => {
      alive = false;
      s.off('message:new', onNew);
      s.off('message:updated', onUpd);
      s.off('message:files', onFiles);
    };
  }, [channelId, me.id]);

  const mentionLookup = useMemo<MentionLookup>(
    () => ({
      user: (id) => userById(id)?.displayName ?? state.guests.find((g) => g.id === id)?.displayName ?? nameCache.current[id],
      role: (key) => meta.roles.find((r) => r.key === key)?.label,
      isMe: (token) =>
        token === me.id ||
        token === 'here' ||
        (token.startsWith('role:') && state.roles.some((r) => r.role === token.slice(5) && r.userId === me.id)),
    }),
    [userById, meta.roles, me.id, state.roles, state.guests],
  );

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const el = listRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const loadEarlier = async () => {
    if (!messages?.length) return;
    const el = listRef.current;
    const before = el?.scrollHeight ?? 0;
    const r = await api.get<{ messages: Message[]; hasMore: boolean }>(
      `/api/channels/${channelId}/messages?before=${encodeURIComponent(messages[0].createdAt)}`,
    );
    stick.current = false;
    setMessages((ms) => [...r.messages, ...(ms ?? [])]);
    setHasMore(r.hasMore);
    requestAnimationFrame(() => {
      if (el) el.scrollTop = el.scrollHeight - before;
    });
  };

  const send = async (body: string, attachments: string[]) => {
    stick.current = true;
    try {
      await api.post(`/api/channels/${channelId}/messages`, { body, attachments, incidentId: state.incident.id });
      return true;
    } catch (e) {
      toast({ text: e instanceof Error ? e.message : 'Message failed', tone: 'error' });
      return false;
    }
  };

  const copy = useCallback(
    (text: string) => {
      navigator.clipboard.writeText(text);
      toast({ text: 'Copied' }, 1500);
    },
    [toast],
  );

  const togglePin = (m: Message) => api.patch(`/api/messages/${m.id}`, { pinned: !m.pinned, incidentId: state.incident.id });

  const toTimeline = async (m: Message, type: string) => {
    setMenuFor(null);
    await api.post(`/api/incidents/${state.incident.id}/timeline`, {
      type,
      text: `${m.displayName}: ${plainText(m.body, mentionLookup)}`.slice(0, 4000),
      messageId: m.id,
      channelId: m.channelId,
    });
    toast({ text: `Added to timeline as ${type}` }, 2500);
  };

  for (const m of messages ?? []) Object.assign(nameCache.current, m.mentionNames);
  if (!channel) return <div className="empty sm">Channel not available</div>;
  const pins = messages?.filter((m) => m.pinned) ?? [];

  return (
    <div
      className={`chat ${compact ? 'compact' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDragging(false)}
      onDrop={(e) => {
        const files = filesFrom(e.dataTransfer);
        if (!files.length) return;
        e.preventDefault();
        setDragging(false);
        composer.current?.addFiles(files);
      }}
    >
      {!compact && (
        <div className="view-head">
          <div>
            <h2>
              <span className="muted">#</span>
              {channel.name}
              {channel.shared && <span className="shared-badge">↗ shared from {channel.incidentKey}</span>}
              {!channel.shared && channel.sharedWith.length > 0 && (
                <span className="shared-badge">shared with {channel.sharedWith.map((s) => s.key).join(', ')}</span>
              )}
            </h2>
            {channel.topic && <div className="muted small">{channel.topic}</div>}
          </div>
          <div className="spacer" />
          {(() => {
            const asg = state.assignments.filter((a) => a.targetKind === 'channel' && a.targetId === channelId);
            const lead = asg.find((a) => a.lead);
            if (!asg.length && !state.canControl) return null;
            return (
              <div className="channel-assignees" title={asg.map((a) => `${userById(a.userId)?.displayName}${a.lead ? ' (lead)' : ''}`).join(', ')}>
                {lead && (
                  <span className="channel-lead">
                    <span className="label">Lead</span> {userById(lead.userId)?.displayName}
                  </span>
                )}
                <span className="avatar-stack">
                  {asg.slice(0, 5).map((a) => (
                    <Avatar key={a.userId} id={a.userId} name={userById(a.userId)?.displayName ?? '?'} size={22} />
                  ))}
                  {asg.length > 5 && <span className="count">+{asg.length - 5}</span>}
                </span>
                {state.canControl && (
                  <button className="btn ghost sm" onClick={() => setAssigning(true)}>
                    {Icons.users} {asg.length ? 'Assigned' : 'Assign'}
                  </button>
                )}
              </div>
            );
          })()}
          <button className={`btn ghost sm ${showPins ? 'on' : ''}`} onClick={() => setShowPins((s) => !s)}>
            {Icons.pin} Pinned {pins.length > 0 && <span className="count">{pins.length}</span>}
          </button>
        </div>
      )}

      {showPins && !compact && (
        <div className="pins">
          {pins.length === 0 ? (
            <div className="muted small">Nothing pinned. Pin key facts so latecomers can catch up.</div>
          ) : (
            pins.map((m) => (
              <div key={m.id} className="pin">
                <strong>{m.displayName}</strong> <span className="muted small mono">{utcTime(m.createdAt)}Z</span>
                <div className="pin-body">{renderMessage(m.body, copy, mentionLookup)}</div>
              </div>
            ))
          )}
        </div>
      )}

      <div
        className="messages"
        ref={listRef}
        onScroll={onScroll}
        // Images load after the scroll; keep the view at the bottom if it was there.
        onLoadCapture={() => {
          const el = listRef.current;
          if (el && stick.current) el.scrollTop = el.scrollHeight;
        }}
      >
        {messages === null ? (
          <div className="skeleton-list">
            <div className="skeleton sm" />
            <div className="skeleton sm" />
            <div className="skeleton sm" />
          </div>
        ) : (
          <>
            {hasMore && (
              <button className="btn ghost sm load-earlier" onClick={loadEarlier}>
                Load earlier messages
              </button>
            )}
            {messages.length === 0 && <div className="empty sm">No messages yet. Start the conversation.</div>}
            {messages.map((m, i) => {
              if (m.kind === 'system') {
                return (
                  <div key={m.id} className="msg system">
                    <span className="mono muted small">{utcTime(m.createdAt)}Z</span> {renderMessage(m.body, undefined, mentionLookup)}
                  </div>
                );
              }
              const prev = messages[i - 1];
              const grouped =
                prev && prev.kind === 'msg' && prev.userId === m.userId && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000;
              return (
                <div key={m.id} className={`msg ${grouped ? 'grouped' : ''} ${m.pinned ? 'pinned' : ''} ${m.userId === me.id ? 'mine' : ''} ${m.mentions.includes(me.id) ? 'mentioned' : ''}`}>
                  {!grouped ? <Avatar id={m.userId ?? 'system'} name={m.displayName} size={compact ? 24 : 32} /> : <span className="msg-gutter" />}
                  <div className="msg-content">
                    {!grouped && (
                      <div className="msg-head">
                        <strong>{m.displayName}</strong>
                        <GuestTag user={userById(m.userId)} />
                        <span className="mono muted small" title={`${localTime(m.createdAt)} local`}>
                          {utcTime(m.createdAt)}Z
                        </span>
                        {m.pinned && <span className="pin-flag">{Icons.pin}</span>}
                      </div>
                    )}
                    <div className="msg-body">
                      {m.body && renderMessage(m.body, copy, mentionLookup)}
                      {m.editedAt && <span className="muted small"> (edited)</span>}
                    </div>
                    <Attachments files={m.attachments ?? []} />
                  </div>
                  <div className="msg-actions">
                    <button
                      className="icon-btn sm"
                      title={me.isGuest ? 'Guests can’t pin messages' : m.pinned ? 'Unpin' : 'Pin'}
                      disabled={me.isGuest}
                      onClick={() => togglePin(m)}
                    >
                      {Icons.pin}
                    </button>
                    <div className="menu-wrap">
                      <button className="icon-btn sm" title="Add to timeline" onClick={() => setMenuFor(menuFor === m.id ? null : m.id)}>
                        {Icons.clock}
                      </button>
                      {menuFor === m.id && (
                        <div className="menu" onMouseLeave={() => setMenuFor(null)}>
                          <div className="menu-label">Add to timeline as</div>
                          {TIMELINE_TYPES.map((t) => (
                            <button key={t.key} onClick={() => toTimeline(m, t.key)}>
                              {t.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <button className="icon-btn sm" title="Copy text" onClick={() => copy(plainText(m.body, mentionLookup))}>
                      ⧉
                    </button>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>

      {assigning && <AssignDialog state={state} presence={presence} target={{ kind: 'channel', id: channelId }} onClose={() => setAssigning(false)} />}
      {dragging && <div className="drop-overlay">Drop to attach to your message in #{channel.name}</div>}
      <MentionComposer
        ref={composer}
        channelId={channelId}
        key={channelId}
        state={state}
        presence={presence}
        onSend={send}
        placeholder={
          resolved
            ? 'This incident is resolved — messages are still recorded'
            : `Message #${channel.name}  ·  @ to mention, Enter to send, Shift+Enter for a new line`
        }
      />
    </div>
  );
}
