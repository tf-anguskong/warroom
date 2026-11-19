/**
 * Sumo Logic Search Job API client.
 * Needs an Access ID/Key whose role has "View Collectors"-independent search access (Run search).
 * The Search Job API requires sticky cookies between calls, so we carry them manually.
 */
import { callApi, IntegrationError, MAX_ROWS, type TableResult } from './http.js';

export interface SumoCreds {
  baseUrl: string; // e.g. https://api.us2.sumologic.com/api
  accessId: string;
  accessKey: string;
}

export const SUMO_DEPLOYMENTS = [
  { key: 'us1', label: 'US1', url: 'https://api.sumologic.com/api' },
  { key: 'us2', label: 'US2', url: 'https://api.us2.sumologic.com/api' },
  { key: 'eu', label: 'EU (Dublin)', url: 'https://api.eu.sumologic.com/api' },
  { key: 'de', label: 'DE (Frankfurt)', url: 'https://api.de.sumologic.com/api' },
  { key: 'au', label: 'AU (Sydney)', url: 'https://api.au.sumologic.com/api' },
  { key: 'ca', label: 'CA (Montreal)', url: 'https://api.ca.sumologic.com/api' },
  { key: 'jp', label: 'JP (Tokyo)', url: 'https://api.jp.sumologic.com/api' },
  { key: 'kr', label: 'KR (Seoul)', url: 'https://api.kr.sumologic.com/api' },
  { key: 'in', label: 'IN (Mumbai)', url: 'https://api.in.sumologic.com/api' },
  { key: 'fed', label: 'FED', url: 'https://api.fed.sumologic.com/api' },
];

export interface QueryTemplate {
  id: string;
  name: string;
  description: string;
  query: string;
  /** Default time range, e.g. 15m, 1h, 24h, 7d */
  range: string;
  /** Run automatically when an incident is declared (only for templates without {{variables}}). */
  autoRun: boolean;
}

/** Starter queries seeded when a Sumo Logic integration is added. Admins edit them to match their source categories. */
export const DEFAULT_SUMO_TEMPLATES: Omit<QueryTemplate, 'id'>[] = [
  {
    name: 'Errors & alerts trend',
    description: 'Spike detection across all sources; runs automatically when an incident is declared.',
    query: '(error OR fail* OR denied OR alert OR critical)\n| timeslice 15m\n| count by _timeslice, _sourceCategory\n| sort by _timeslice desc, _count desc',
    range: '24h',
    autoRun: true,
  },
  {
    name: 'Everything about a user',
    description: 'Where a username or email appears, by source.',
    query: '"{{user}}"\n| count by _sourceCategory, _sourceHost\n| sort by _count desc',
    range: '24h',
    autoRun: false,
  },
  {
    name: 'IP address sightings',
    description: 'Every source that logged an IP (firewall, proxy, VPN, web).',
    query: '"{{ip}}"\n| count by _sourceCategory, _sourceHost\n| sort by _count desc',
    range: '7d',
    autoRun: false,
  },
  {
    name: 'Raw events for an IP',
    description: 'Most recent raw messages mentioning an IP.',
    query: '"{{ip}}"\n| fields _messagetime, _sourceCategory, _sourceHost, _raw',
    range: '24h',
    autoRun: false,
  },
  {
    name: 'Host activity',
    description: 'Event volume for a host by source category.',
    query: '_sourceHost="{{host}}"\n| timeslice 1h\n| count by _timeslice, _sourceCategory\n| sort by _timeslice desc',
    range: '24h',
    autoRun: false,
  },
  {
    name: 'File hash sightings',
    description: 'EDR / AV / proxy events mentioning a hash.',
    query: '"{{hash}}"\n| fields _messagetime, _sourceCategory, _sourceHost, _raw',
    range: '7d',
    autoRun: false,
  },
  {
    name: 'Domain lookups',
    description: 'DNS and proxy traffic to a domain.',
    query: '"{{domain}}"\n| count by _sourceCategory, _sourceHost\n| sort by _count desc',
    range: '7d',
    autoRun: false,
  },
];

export const templateVariables = (query: string) => [...new Set([...query.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]))];

export function fillTemplate(query: string, vars: Record<string, string>) {
  const missing: string[] = [];
  const out = query.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => {
    const v = vars[name]?.trim();
    if (!v) {
      missing.push(name);
      return '';
    }
    // Values land inside quoted search terms; strip characters that would break out of them.
    return v.replace(/["\\\n\r|]/g, '');
  });
  if (missing.length) throw new IntegrationError(`Fill in: ${[...new Set(missing)].join(', ')}`, 400);
  return out;
}

const RANGE_MS: Record<string, number> = {
  '15m': 15 * 60e3,
  '1h': 60 * 60e3,
  '4h': 4 * 60 * 60e3,
  '24h': 24 * 60 * 60e3,
  '7d': 7 * 24 * 60 * 60e3,
  '30d': 30 * 24 * 60 * 60e3,
};
export const rangeToMs = (r: string) => RANGE_MS[r] ?? RANGE_MS['24h'];

class SumoSession {
  private cookies = new Map<string, string>();
  constructor(private c: SumoCreds) {}

  async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await callApi(`${this.c.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.c.accessId}:${this.c.accessKey}`).toString('base64')}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(this.cookies.size ? { Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [pair] = sc.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }
}

interface JobStatus {
  state: string;
  messageCount: number;
  recordCount: number;
  pendingErrors?: string[];
  pendingWarnings?: string[];
}

const fmtUtc = (ms: number) => new Date(ms).toISOString().slice(0, 19);

export async function runSumoSearch(
  c: SumoCreds,
  query: string,
  fromMs: number,
  toMs: number,
  onProgress?: (msg: string) => void,
  timeoutMs = 180_000,
): Promise<TableResult & { kind: 'messages' | 'records'; warnings: string[] }> {
  const s = new SumoSession(c);
  const job = await s.req<{ id: string }>('POST', '/v1/search/jobs', {
    query,
    from: fmtUtc(fromMs),
    to: fmtUtc(toMs),
    timeZone: 'UTC',
    byReceiptTime: false,
  });
  if (!job.id) throw new IntegrationError('Sumo Logic did not return a search job id');
  const deadline = Date.now() + timeoutMs;
  let status: JobStatus;
  try {
    for (;;) {
      status = await s.req<JobStatus>('GET', `/v1/search/jobs/${job.id}`);
      if (status.pendingErrors?.length) throw new IntegrationError(`Query error: ${status.pendingErrors.join('; ')}`, 400);
      if (status.state === 'DONE GATHERING RESULTS') break;
      if (status.state === 'CANCELLED' || status.state === 'FORCE PAUSED') throw new IntegrationError(`Search ${status.state.toLowerCase()}`);
      if (Date.now() > deadline) throw new IntegrationError('Search took longer than 3 minutes; narrow the time range');
      onProgress?.(`${status.state.toLowerCase()} · ${status.messageCount} messages`);
      await new Promise((r) => setTimeout(r, 2000));
    }
    const kind = status.recordCount > 0 ? 'records' : 'messages';
    const total = kind === 'records' ? status.recordCount : status.messageCount;
    const page = await s.req<{ fields: { name: string }[]; messages?: { map: Record<string, string> }[]; records?: { map: Record<string, string> }[] }>(
      'GET',
      `/v1/search/jobs/${job.id}/${kind}?offset=0&limit=${MAX_ROWS}`,
    );
    const items = (kind === 'records' ? page.records : page.messages) ?? [];
    const hidden = new Set(['_blockid', '_collectorid', '_messageid', '_sourceid', '_receipttime', '_size', '_format', '_view', '_messagecount', '_source', '_collector', '_sourcename', '_loglevel']);
    let columns = (page.fields ?? []).map((f) => f.name).filter((n) => !hidden.has(n.toLowerCase()));
    // Put the useful columns first.
    const order = ['_timeslice', '_messagetime', '_sourcecategory', '_sourcehost', '_count'];
    columns = [...order.filter((o) => columns.includes(o)), ...columns.filter((c) => !order.includes(c) && c !== '_raw'), ...(columns.includes('_raw') ? ['_raw'] : [])];
    const rows = items.map((it) => {
      const r: Record<string, string> = {};
      for (const col of columns) {
        let v = it.map[col] ?? '';
        if ((col === '_messagetime' || col === '_timeslice') && /^\d{12,}$/.test(v)) v = fmtUtc(Number(v)).replace('T', ' ');
        r[col] = v;
      }
      return r;
    });
    return { kind, columns, rows, total, truncated: total > rows.length, warnings: status.pendingWarnings ?? [] };
  } finally {
    s.req('DELETE', `/v1/search/jobs/${job.id}`).catch(() => undefined);
  }
}

export async function testSumo(c: SumoCreds) {
  const now = Date.now();
  await runSumoSearch(c, '* | limit 1', now - 5 * 60e3, now, undefined, 60_000);
  return 'Connected: search jobs work';
}
