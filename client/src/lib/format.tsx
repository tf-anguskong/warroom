import { Fragment, type ReactNode } from 'react';

export const STATUS_LABEL: Record<string, string> = {
  investigating: 'Investigating',
  identified: 'Identified',
  mitigating: 'Mitigating',
  monitoring: 'Monitoring',
  resolved: 'Resolved',
};

export const SEVERITY_LABEL: Record<string, string> = {
  SEV1: 'Critical',
  SEV2: 'High',
  SEV3: 'Moderate',
  SEV4: 'Low',
};

const pad = (n: number) => String(n).padStart(2, '0');

export function utcTime(iso: string, withDate = false) {
  const d = new Date(iso);
  const t = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return withDate ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${t}` : t;
}

export function localTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function duration(fromIso: string, to = Date.now()) {
  let s = Math.max(0, Math.floor((to - new Date(fromIso).getTime()) / 1000));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (d) return `${d}d ${h}h ${pad(m)}m`;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

/** Stable color per user id, for avatars and sheet cursors. */
export function userColor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 70% 62%)`;
}

const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g;
const MENTION_SPLIT = /(<@(?:here|role:[a-z]+|[0-9a-f-]{36})>)/g;

/** Resolves mention tokens to names; `self` marks mentions that include the viewer. */
export interface MentionLookup {
  user: (id: string) => string | undefined;
  role: (key: string) => string | undefined;
  /** Is this token about me (my user ID, a role I hold, or @here)? */
  isMe: (token: string) => boolean;
}

export function mentionLabel(token: string, m?: MentionLookup) {
  if (token === 'here') return '@here';
  if (token.startsWith('role:')) return `@${m?.role(token.slice(5)) ?? token.slice(5)}`;
  return `@${m?.user(token) ?? 'unknown'}`;
}

/** Message text with mention tokens replaced by names (for copying, timeline entries). */
export const plainText = (body: string, m?: MentionLookup) =>
  body.replace(/<@(here|role:[a-z]+|[0-9a-f-]{36})>/g, (_x, t: string) => mentionLabel(t, m));

function linksAndMentions(text: string, key: string, m?: MentionLookup): ReactNode[] {
  const out: ReactNode[] = [];
  text.split(MENTION_SPLIT).forEach((chunk, k) => {
    if (k % 2 === 1) {
      const token = chunk.slice(2, -1);
      out.push(
        <span key={`${key}-m${k}`} className={`mention ${m?.isMe(token) ? 'me' : ''} ${token.startsWith('role:') || token === 'here' ? 'group' : ''}`}>
          {mentionLabel(token, m)}
        </span>,
      );
      return;
    }
    chunk.split(URL_RE).forEach((seg, j) => {
      // split() with one capture group puts matches at odd indexes
      if (j % 2 === 1) {
        out.push(
          <a key={`${key}-${k}-${j}`} href={seg} target="_blank" rel="noreferrer noopener">
            {seg}
          </a>,
        );
      } else if (seg) out.push(<Fragment key={`${key}-${k}-${j}`}>{seg}</Fragment>);
    });
  });
  return out;
}

function inline(text: string, keyBase: string, m?: MentionLookup): ReactNode[] {
  // `code`, **bold**, links
  const out: ReactNode[] = [];
  const parts = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g);
  parts.forEach((p, i) => {
    const key = `${keyBase}-${i}`;
    if (p.startsWith('`') && p.endsWith('`') && p.length > 2) out.push(<code key={key}>{p.slice(1, -1)}</code>);
    else if (p.startsWith('**') && p.endsWith('**') && p.length > 4) out.push(<strong key={key}>{p.slice(2, -2)}</strong>);
    else out.push(...linksAndMentions(p, key, m));
  });
  return out;
}

/** Small, safe markdown subset for chat: fenced code blocks, inline code, bold, links. */
export function renderMessage(body: string, onCopy?: (text: string) => void, mentions?: MentionLookup): ReactNode {
  const blocks = body.split(/```/);
  return blocks.map((block, i) => {
    if (i % 2 === 1) {
      const code = block.replace(/^[a-zA-Z0-9_-]*\n/, '').replace(/\n$/, '');
      return (
        <div className="codeblock" key={i}>
          <button className="copy-btn" onClick={() => onCopy?.(code)} title="Copy">
            Copy
          </button>
          <pre>{code}</pre>
        </div>
      );
    }
    const lines = block.split('\n');
    return (
      <Fragment key={i}>
        {lines.map((line, j) => (
          <Fragment key={j}>
            {inline(line, `${i}-${j}`, mentions)}
            {j < lines.length - 1 && <br />}
          </Fragment>
        ))}
      </Fragment>
    );
  });
}
