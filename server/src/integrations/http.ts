import { config } from '../config.js';

export class IntegrationError extends Error {
  constructor(message: string, public status = 502) {
    super(message);
  }
}

/** Integrations only talk to HTTPS endpoints (plain HTTP allowed for localhost outside production, for testing). */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new IntegrationError('Base URL is not a valid URL', 400);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && !config.production)) {
    throw new IntegrationError('Base URL must use https://', 400);
  }
  if (url.username || url.password) throw new IntegrationError('Put credentials in the credential fields, not the URL', 400);
  return url.origin + url.pathname.replace(/\/+$/, '');
}

export async function callApi(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(init.timeoutMs ?? 20_000) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new IntegrationError(`Could not reach ${new URL(url).host}: ${msg}`);
  }
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.text();
      const j = JSON.parse(body);
      detail = j.errorSummary || j.message || j.error || body.slice(0, 200);
    } catch {
      /* body not JSON */
    }
    if (res.status === 401 || res.status === 403) throw new IntegrationError(`Credentials rejected (${res.status})${detail ? `: ${detail}` : ''}`, 502);
    if (res.status === 429) throw new IntegrationError('Rate limited by the provider; try again in a minute', 429);
    throw new IntegrationError(`Provider returned ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res;
}

export interface TableResult {
  columns: string[];
  rows: Record<string, string>[];
  total: number;
  truncated: boolean;
}

export const MAX_ROWS = 500;
