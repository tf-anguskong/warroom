import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';
import { play } from './sounds';
import { getSocket } from './socket';
import type { MentionEvent, Meta, User } from '../types';

interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
  tone?: 'info' | 'warn' | 'error';
}

interface AppContextValue {
  me: User;
  users: User[];
  userById: (id: string | null | undefined) => User | undefined;
  meta: Meta;
  reloadUsers: () => void;
  toast: (t: Omit<Toast, 'id'>, ms?: number) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp outside AppProvider');
  return ctx;
}

let toastId = 0;

export function AppProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<User | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const reloadUsers = useCallback(() => {
    api.get<{ users: User[] }>('/api/users').then((r) => setUsers(r.users));
  }, []);

  useEffect(() => {
    const loadMe = () => api.get<{ user: User }>('/api/me').then((r) => setMe(r.user));
    loadMe();
    api.get<Meta>('/api/meta').then(setMeta);
    reloadUsers();
    // Admin rights granted/revoked elsewhere take effect without a reload.
    const s = getSocket();
    s.on('me:changed', loadMe);
    const onMention = (e: MentionEvent) => {
      if (location.pathname.startsWith('/incidents/')) return;
      play('mention');
      toast(
        {
          text: `${e.by} mentioned you in #${e.channelName} (${e.incidentKey}): ${e.preview}`,
          tone: 'warn',
          action: { label: 'Open', run: () => (location.href = `/incidents/${e.incidentId}?view=channel:${e.channelId}`) },
        },
        15000,
      );
    };
    s.on('mention', onMention);
    return () => {
      s.off('me:changed', loadMe);
      s.off('mention', onMention);
    };
  }, [reloadUsers]);

  const toast = useCallback((t: Omit<Toast, 'id'>, ms = 6000) => {
    const id = ++toastId;
    setToasts((ts) => [...ts, { ...t, id }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), ms);
  }, []);

  const value = useMemo(() => {
    if (!me || !meta) return null;
    const map = new Map(users.map((u) => [u.id, u]));
    return {
      me,
      users,
      meta,
      reloadUsers,
      toast,
      userById: (id: string | null | undefined) => (id ? map.get(id) : undefined),
    };
  }, [me, users, meta, reloadUsers, toast]);

  if (!value) return <div className="splash">Loading…</div>;

  return (
    <AppContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone ?? 'info'}`}>
            <span>{t.text}</span>
            {t.action && (
              <button
                className="btn primary sm"
                onClick={() => {
                  t.action!.run();
                  setToasts((ts) => ts.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
            <button className="icon-btn" aria-label="Dismiss" onClick={() => setToasts((ts) => ts.filter((x) => x.id !== t.id))}>
              ×
            </button>
          </div>
        ))}
      </div>
    </AppContext.Provider>
  );
}
