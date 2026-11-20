import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api';
import { useApp } from '../lib/app';
import { utcTime } from '../lib/format';
import type { IncidentState } from '../types';
import { Icons, Modal } from './ui';

/** AI agents (MCP): connecting them, room keys, and who is connected. */

export interface AgentGrant {
  id: string;
  kind: 'key' | 'oauth';
  name: string;
  scopes: ('read' | 'write' | 'investigate')[];
  scopeText: string;
  userId: string;
  userName: string;
  userIsGuest?: boolean;
  incidentId: string | null;
  incidentKey: string | null;
  incidentTitle: string | null;
  keyHint: string | null;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  active: boolean;
  status: string | null;
  canRevoke: boolean;
}

/** Shown next to a person's name on what an AI agent did for them. */
export function AgentTag({ name, person }: { name: string; person?: string | null }) {
  return (
    <span className="agent-tag" title={`Written by ${person ? `${person}’s` : 'their'} AI agent “${name}”, not by ${person ?? 'them'} directly`}>
      {Icons.bot} AI agent · {name}
    </span>
  );
}

const when = (iso: string) => {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return `${sameDay ? '' : `${iso.slice(0, 10)} `}${utcTime(iso)} UTC`;
};

function ago(iso: string | null) {
  if (!iso) return 'not used yet';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'used just now';
  if (s < 5400) return `used ${Math.round(s / 60)} min ago`;
  if (s < 129600) return `used ${Math.round(s / 3600)} h ago`;
  return `used ${Math.round(s / 86400)} days ago`;
}

export function CopyBlock({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="cmd-block">
      {label && <div className="muted small">{label}</div>}
      <div className="cmd-row">
        <pre className="mono">{text}</pre>
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => {
            void navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

/** How to point an agent at this War Room with sign-in (OAuth). */
export function ConnectHelp({ mcpUrl }: { mcpUrl: string }) {
  return (
    <div className="agent-help">
      <CopyBlock label="MCP server address" text={mcpUrl} />
      <details>
        <summary>Claude (web, desktop or mobile)</summary>
        <p className="small">
          Settings → Connectors → <strong>Add custom connector</strong>, paste the address above, then <strong>Connect</strong>. You sign in to War Room and
          choose what Claude may do. Claude connects from Anthropic’s cloud, so this War Room has to be reachable over HTTPS from the internet.
        </p>
      </details>
      <details>
        <summary>Claude Code</summary>
        <CopyBlock text={`claude mcp add --transport http warroom ${mcpUrl}`} />
        <p className="small">
          Then run <code>/mcp</code> in Claude Code and choose <strong>warroom → Authenticate</strong>. Your browser opens War Room to approve it.
        </p>
      </details>
      <details>
        <summary>Other MCP clients</summary>
        <p className="small">
          Any client that supports Streamable HTTP and OAuth sign-in can connect with the address above. Clients without OAuth can use a room agent key as an{' '}
          <code>Authorization: Bearer</code> header.
        </p>
      </details>
    </div>
  );
}

export function GrantList({ grants, onRevoked, showIncident, empty }: { grants: AgentGrant[]; onRevoked: () => void; showIncident?: boolean; empty: ReactNode }) {
  const { toast } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const revoke = async (g: AgentGrant) => {
    if (!confirm(`Disconnect “${g.name}”${g.kind === 'oauth' ? ` (for ${g.userName})` : ''}? It stops working right away.`)) return;
    setBusy(g.id);
    try {
      await api.del(`/api/agent-grants/${g.id}`);
      toast({ text: `${g.name} disconnected` }, 3000);
      onRevoked();
    } catch (e) {
      toast({ text: e instanceof ApiError ? e.message : 'Could not disconnect it', tone: 'error' }, 6000);
    } finally {
      setBusy(null);
    }
  };
  if (!grants.length) return <div className="muted small">{empty}</div>;
  return (
    <ul className="agent-list">
      {grants.map((g) => (
        <li key={g.id} className={g.active ? '' : 'ended'}>
          <div className="agent-main">
            <div>
              <strong>{g.name}</strong> <span className="agent-tag">{g.kind === 'key' ? `room key ••••${g.keyHint ?? ''}` : 'signed in'}</span>
            </div>
            <div className="small">
              Acts as <strong>{g.userName}</strong>
              {g.userIsGuest && <span className="guest-tag">guest</span>} · {g.scopeText}
              {showIncident && <> · {g.incidentKey ? <span className="mono">{g.incidentKey}</span> : 'every war room they can open'}</>}
            </div>
            <div className="muted small">
              {g.active ? <>Until {when(g.expiresAt)} · {ago(g.lastUsedAt)}</> : g.status}
            </div>
          </div>
          {g.canRevoke ? (
            <button className="btn ghost sm danger" disabled={busy === g.id} onClick={() => revoke(g)}>
              Disconnect
            </button>
          ) : (
            <span className="muted small" title="Only the person it acts for, the Incident Commander, room admins and admins can disconnect it">
              {Icons.lock}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

interface RoomAgents {
  enabled: boolean;
  mcpUrl: string;
  oauth: boolean;
  keyBlock: string | null;
  keyHours: number[];
  canInvestigate: boolean;
  canDisconnectAll: boolean;
  grants: AgentGrant[];
}

/** Room header → AI agents: connect your own agent, issue a room key, see who is connected here. */
export function RoomAgentsDialog({ state, onClose }: { state: IncidentState; onClose: () => void }) {
  const { toast, me } = useApp();
  const inc = state.incident;
  const [data, setData] = useState<RoomAgents | null>(null);
  const [name, setName] = useState('Claude');
  const [write, setWrite] = useState(false);
  const [investigate, setInvestigate] = useState(false);
  const [hours, setHours] = useState(12);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ key: string; mcpUrl: string } | null>(null);

  const load = useCallback(() => {
    api.get<RoomAgents>(`/api/incidents/${inc.id}/agents`).then(setData).catch(() => undefined);
  }, [inc.id]);
  useEffect(load, [load]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const scopes = [...(write ? ['write'] : []), ...(investigate ? ['investigate'] : [])];
      const r = await api.post<{ key: string; mcpUrl: string }>(`/api/incidents/${inc.id}/agent-keys`, { name: name.trim(), scopes, hours });
      setCreated(r);
      load();
    } catch (err) {
      toast({ text: err instanceof ApiError ? err.message : 'Could not create the key', tone: 'error' }, 6000);
    } finally {
      setBusy(false);
    }
  };

  const disconnectAll = async () => {
    if (!confirm(`Disconnect every AI agent connected to ${inc.key}? Their keys and sign-ins for this war room stop working right away.`)) return;
    try {
      const r = await api.del<{ disconnected: number }>(`/api/incidents/${inc.id}/agent-grants`);
      toast({ text: `${r.disconnected} agent${r.disconnected === 1 ? '' : 's'} disconnected` }, 3000);
      load();
    } catch (err) {
      toast({ text: err instanceof ApiError ? err.message : 'Could not disconnect them', tone: 'error' }, 6000);
    }
  };

  if (created) {
    const json = JSON.stringify({ mcpServers: { warroom: { type: 'http', url: created.mcpUrl, headers: { Authorization: `Bearer ${created.key}` } } } }, null, 2);
    return (
      <Modal title="Agent key ready" onClose={onClose} wide footer={<button className="btn primary" onClick={onClose}>Done</button>}>
        <div className="form">
          <div className="alert warn">
            <div>
              Copy it now: the key is shown only once. Anyone who has it can act as <strong>you</strong> in {inc.key} ({write ? 'including posting' : 'read only'}) until
              it expires or someone disconnects it, so give it only to the agent.
            </div>
          </div>
          <CopyBlock label="Key" text={created.key} />
          <CopyBlock label="Claude Code" text={`claude mcp add --transport http warroom ${created.mcpUrl} --header "Authorization: Bearer ${created.key}"`} />
          <CopyBlock label="Other MCP clients (JSON config)" text={json} />
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`AI agents in ${inc.key}`} onClose={onClose} wide footer={<button className="btn ghost" onClick={onClose}>Close</button>}>
      {!data ? (
        <div className="skeleton" />
      ) : !data.enabled ? (
        <div className="alert info">
          <div>AI agents are turned off on this War Room. An admin can turn them on in Admin → Settings → AI agents (MCP).</div>
        </div>
      ) : (
        <div className="form">
          <p className="small">
            Agents such as Claude can read this war room and, if you allow it, post messages, add timeline entries and fill in sheets and notes. They act as a
            person and are marked as an agent everywhere. They can never change roles, invite people, moderate voice or change settings. War Room tells them to treat what they
            read as data, not instructions.
          </p>

          <section>
            <h3>Your agent key</h3>
            <p className="muted small">
              A key for your own AI agent (for example Claude Code). It works only in {inc.key}, for a few hours, and acts as you with {me.isGuest ? 'the access you were given as a guest' : 'your access'}. Everything it writes
              shows your name with an <strong>AI agent</strong> tag. It stops when the incident is resolved{me.isGuest ? ' or your guest access ends' : ''}, and the Incident Commander or a room admin can disconnect it.
            </p>
            <form onSubmit={submit}>
              <fieldset className="agent-key-form" disabled={Boolean(data.keyBlock) || busy}>
                {data.keyBlock && <div className="muted small readonly-why">{data.keyBlock}</div>}
                <label>
                  Name the agent
                  <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Claude Code" />
                </label>
                <div className="agent-scopes">
                  <label className="check">
                    <input type="checkbox" checked disabled /> Read the war room
                  </label>
                  <label className="check">
                    <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} /> Post and edit (messages, timeline, sheets, notes)
                  </label>
                  {data.canInvestigate && (
                    <label className="check">
                      <input type="checkbox" checked={investigate} onChange={(e) => setInvestigate(e.target.checked)} /> Run integration searches
                    </label>
                  )}
                </div>
                <label>
                  Works for
                  <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
                    {data.keyHours.map((h) => (
                      <option key={h} value={h}>
                        {h} hours
                      </option>
                    ))}
                  </select>
                </label>
                <button className="btn primary" disabled={!name.trim()}>
                  Create key
                </button>
              </fieldset>
            </form>
          </section>

          {!me.isGuest && (
            <section>
              <h3>Or connect by signing in</h3>
              {data.oauth ? (
                <ConnectHelp mcpUrl={data.mcpUrl} />
              ) : (
                <div className="muted small">Sign-in for agent apps is turned off on this War Room; use a key.</div>
              )}
            </section>
          )}

          <section>
            <div className="section-head">
              <h3>Connected here</h3>
              {data.canDisconnectAll && data.grants.length > 0 && (
                <button type="button" className="btn ghost sm" onClick={disconnectAll}>
                  Disconnect all
                </button>
              )}
            </div>
            <GrantList
              grants={data.grants}
              onRevoked={load}
              empty={state.canControl ? 'No agents are connected to this war room.' : 'You have no agents connected to this war room.'}
            />
            {!state.canControl && <div className="muted small">You see only your own agents; the Incident Commander and room admins see everyone’s and can disconnect them.</div>}
          </section>
        </div>
      )}
    </Modal>
  );
}

/** Dashboard → AI agents: the agents connected for me, and how to connect one. */
export function MyAgentsDialog({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<{ enabled: boolean; mcpUrl: string; grants: AgentGrant[] } | null>(null);
  const load = useCallback(() => {
    api.get<{ enabled: boolean; mcpUrl: string; grants: AgentGrant[] }>('/api/agent-grants').then(setData).catch(() => undefined);
  }, []);
  useEffect(load, [load]);
  return (
    <Modal title="Your AI agents" onClose={onClose} wide footer={<button className="btn ghost" onClick={onClose}>Close</button>}>
      {!data ? (
        <div className="skeleton" />
      ) : !data.enabled ? (
        <div className="alert info">
          <div>AI agents are turned off on this War Room. An admin can turn them on in Admin → Settings → AI agents (MCP).</div>
        </div>
      ) : (
        <div className="form">
          <section>
            <h3>Connected for you</h3>
            <GrantList grants={data.grants} onRevoked={load} showIncident empty="No agents are connected for you." />
          </section>
          <section>
            <h3>Connect an agent</h3>
            <ConnectHelp mcpUrl={data.mcpUrl} />
          </section>
        </div>
      )}
    </Modal>
  );
}

/** Admin → AI agents: every connected agent. */
export function AdminAgents() {
  const [data, setData] = useState<{ enabled: boolean; mcpUrl: string; grants: AgentGrant[] } | null>(null);
  const load = useCallback(() => {
    api.get<{ enabled: boolean; mcpUrl: string; grants: AgentGrant[] }>('/api/admin/agent-grants').then(setData).catch(() => undefined);
  }, []);
  useEffect(load, [load]);
  if (!data) return <div className="skeleton" />;
  return (
    <div className="admin-agents">
      <div className="alert info">
        <div>
          {data.enabled ? (
            <>
              AI agents connect at <code>{data.mcpUrl}</code> and act for the person who approved them. Turn agents or room keys off in{' '}
              <a href="/admin?tab=settings">Settings → AI agents (MCP)</a>.
            </>
          ) : (
            <>
              AI agents are turned off. Turn them on in <a href="/admin?tab=settings">Settings → AI agents (MCP)</a>.
            </>
          )}
        </div>
      </div>
      <h2>Connected agents ({data.grants.length})</h2>
      <GrantList grants={data.grants} onRevoked={load} showIncident empty="No agents are connected." />
    </div>
  );
}
