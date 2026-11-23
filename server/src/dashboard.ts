import { Router, type Request, type Response } from 'express';
import { config } from './config.js';
import { q } from './db.js';
import { getUser, type UserRow } from './users.js';
import { presenceFor } from './realtime.js';
import { canSee } from './guests.js';
import { incidentKey } from './model.js';
import { STATUSES } from './templates.js';
import type { Column } from './templates.js';

/**
 * The war room dashboard: a status board (phase, containment, indicators, actions, comms cadence,
 * latest decisions) and people and coverage (who's here, on shift, in voice, workload). Everything
 * is computed from what the room already records: the timeline, the template sheets (found by
 * column name, so renamed or custom sheets simply show "not tracked here"), presence and shifts.
 */

const LABEL: Record<string, string> = {
  investigating: 'Investigating',
  identified: 'Identified',
  mitigating: 'Mitigating',
  monitoring: 'Monitoring',
  resolved: 'Resolved',
};
const BY_LABEL = Object.fromEntries(Object.entries(LABEL).map(([k, v]) => [v.toLowerCase(), k]));

/** Expected minutes between status updates for a severity (0 = no expectation). */
export const commsInterval = (severity: string) => config.comms[severity as keyof typeof config.comms] ?? 0;

interface IncidentRow {
  id: string;
  number: number;
  title: string;
  summary: string;
  severity: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

interface SheetData {
  id: string;
  name: string;
  col: (name: string) => Column | undefined;
  rows: Record<string, string>[]; // colId → value, only rows with something in them
}

const minutes = (a: number, b: number) => Math.max(0, Math.round((b - a) / 60_000));
/** Sheet dates are "YYYY-MM-DDTHH:MM" in UTC. */
const sheetTime = (v: string | undefined) => {
  if (!v) return null;
  const t = new Date(/Z|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`).getTime();
  return Number.isNaN(t) ? null : t;
};
const name = (id: string | undefined) => (id ? getUser(id)?.display_name ?? null : null);

function loadSheets(incidentId: string, viewer: UserRow): SheetData[] {
  return q
    .all<{ id: string; name: string; columns: string }>('SELECT id, name, columns FROM sheets WHERE incident_id = ? ORDER BY position', incidentId)
    .filter((s) => canSee(viewer, incidentId, 'sheet', s.id))
    .map((s) => {
      const cols = JSON.parse(s.columns) as Column[];
      const byRow = new Map<string, Record<string, string>>();
      for (const c of q.all<{ row_id: string; col_id: string; value: string }>('SELECT row_id, col_id, value FROM sheet_cells WHERE sheet_id = ?', s.id)) {
        const r = byRow.get(c.row_id) ?? {};
        r[c.col_id] = c.value;
        byRow.set(c.row_id, r);
      }
      const order = q.all<{ id: string }>('SELECT id FROM sheet_rows WHERE sheet_id = ? ORDER BY position', s.id).map((r) => r.id);
      return {
        id: s.id,
        name: s.name,
        col: (n: string) => cols.find((c) => c.name.trim().toLowerCase() === n.toLowerCase()),
        rows: order.filter((id) => byRow.has(id)).map((id) => byRow.get(id)!),
      };
    });
}

/** Count rows by a select column, in the column's own option order (with its colours). */
function distribution(sheets: { sheet: SheetData; col: Column; key: Column }[]) {
  const counts = new Map<string, { value: string; color: string; count: number }>();
  for (const { col } of sheets) for (const o of col.options ?? []) if (!counts.has(o.value)) counts.set(o.value, { value: o.value, color: o.color, count: 0 });
  let total = 0;
  for (const { sheet, col, key } of sheets) {
    for (const r of sheet.rows) {
      if (!r[key.id]) continue;
      total++;
      const v = r[col.id] || 'Not set';
      const entry = counts.get(v) ?? { value: v, color: 'gray', count: 0 };
      entry.count++;
      counts.set(v, entry);
    }
  }
  return { total, byValue: [...counts.values()] };
}

function phases(inc: IncidentRow, now: number) {
  const changes = q.all<{ ts: string; text: string; ref: string | null }>(
    "SELECT ts, text, ref FROM timeline WHERE incident_id = ? AND type = 'status' ORDER BY ts",
    inc.id,
  );
  const out: { status: string; label: string; start: string; end: string | null; minutes: number }[] = [];
  let current = { status: 'investigating', start: inc.created_at };
  for (const c of changes) {
    let to: string | undefined;
    try {
      to = c.ref ? JSON.parse(c.ref).to : undefined;
    } catch {
      /* older entries have no ref */
    }
    to ??= BY_LABEL[c.text.split('→').pop()?.trim().toLowerCase() ?? ''];
    if (!to || !(STATUSES as readonly string[]).includes(to)) continue;
    out.push({ ...current, label: LABEL[current.status], end: c.ts, minutes: minutes(new Date(current.start).getTime(), new Date(c.ts).getTime()) });
    current = { status: to, start: c.ts };
  }
  const end = current.status === 'resolved' ? current.start : null;
  out.push({ ...current, label: LABEL[current.status], end, minutes: end ? 0 : minutes(new Date(current.start).getTime(), now) });
  // Merge back-to-back repeats (e.g. a status set twice).
  const merged: typeof out = [];
  for (const p of out) {
    const prev = merged.at(-1);
    if (prev && prev.status === p.status) {
      prev.minutes += p.minutes;
      prev.end = p.end;
    } else merged.push({ ...p });
  }
  return merged;
}

export function dashboardFor(incidentId: string, viewer: UserRow) {
  const inc = q.get<IncidentRow>('SELECT * FROM incidents WHERE id = ?', incidentId);
  if (!inc) return null;
  const now = Date.now();
  const sheets = loadSheets(inc.id, viewer);
  const find = (...need: string[]) =>
    sheets
      .map((sheet) => ({ sheet, cols: need.map((n) => sheet.col(n)) }))
      .filter((x) => x.cols.every(Boolean)) as { sheet: SheetData; cols: Column[] }[];

  // Indicators: "Indicator" + "Status"
  const iocSheets = find('Indicator', 'Status');
  const iocs = iocSheets.length ? distribution(iocSheets.map(({ sheet, cols }) => ({ sheet, key: cols[0], col: cols[1] }))) : null;

  // Affected assets: "Asset" + "Containment" (+ "Impact")
  const assetSheets = find('Asset', 'Containment');
  const assets = assetSheets.length ? distribution(assetSheets.map(({ sheet, cols }) => ({ sheet, key: cols[0], col: cols[1] }))) : null;
  const impactSheets = find('Asset', 'Impact');
  const impact = impactSheets.length ? distribution(impactSheets.map(({ sheet, cols }) => ({ sheet, key: cols[0], col: cols[1] }))) : null;

  // Actions: "Action" + "Status" (+ "Priority", "Owner", "Due (UTC)", "Done")
  const actionSheets = find('Action', 'Status');
  let actions = null;
  if (actionSheets.length) {
    const list: { action: string; owner: string | null; ownerId: string | null; priority: string; status: string; due: string | null; overdue: boolean; sheet: string }[] = [];
    for (const { sheet, cols } of actionSheets) {
      const [act, status] = cols;
      const pr = sheet.col('Priority');
      const owner = sheet.col('Owner');
      const due = sheet.col('Due (UTC)') ?? sheet.col('Due');
      const done = sheet.col('Done');
      for (const r of sheet.rows) {
        if (!r[act.id]) continue;
        const st = r[status.id] || 'Open';
        const finished = st.toLowerCase() === 'done' || (done && r[done.id] === 'true');
        if (finished) continue;
        const dueAt = due ? sheetTime(r[due.id]) : null;
        list.push({
          action: r[act.id],
          owner: owner ? name(r[owner.id]) : null,
          ownerId: owner ? r[owner.id] ?? null : null,
          priority: pr ? r[pr.id] || '' : '',
          status: st,
          due: dueAt ? new Date(dueAt).toISOString() : null,
          overdue: dueAt !== null && dueAt < now,
          sheet: sheet.name,
        });
      }
    }
    const all = actionSheets.flatMap(({ sheet, cols }) => sheet.rows.filter((r) => r[cols[0].id]));
    const prRank = (p: string) => (/^p\d$/i.test(p) ? Number(p.slice(1)) : 9);
    list.sort((a, b) => Number(b.overdue) - Number(a.overdue) || prRank(a.priority) - prRank(b.priority) || (a.due ?? '9').localeCompare(b.due ?? '9'));
    const priorities = [...new Set(actionSheets.flatMap(({ sheet }) => sheet.col('Priority')?.options?.map((o) => o.value) ?? []))];
    actions = {
      total: all.length,
      open: list.length,
      overdue: list.filter((a) => a.overdue).length,
      blocked: list.filter((a) => a.status.toLowerCase() === 'blocked').length,
      byPriority: priorities.map((p) => ({ priority: p, open: list.filter((a) => a.priority === p).length })),
      list: list.slice(0, 8),
    };
  }

  // Comms: "Audience" + "Sent (UTC)"
  const commsSheets = find('Audience', 'Sent (UTC)');
  const interval = commsInterval(inc.severity);
  let comms = null;
  if (commsSheets.length) {
    const sent: { audience: string; at: number; by: string | null; summary: string }[] = [];
    for (const { sheet, cols } of commsSheets) {
      const [aud, at] = cols;
      const by = sheet.col('Sent by');
      const sum = sheet.col('Summary');
      for (const r of sheet.rows) {
        const t = sheetTime(r[at.id]);
        if (t === null || t > now) continue; // planned, not sent yet
        sent.push({ audience: r[aud.id] || 'Not set', at: t, by: by ? name(r[by.id]) : null, summary: sum ? r[sum.id] ?? '' : '' });
      }
    }
    const audiences = [...new Set(commsSheets.flatMap(({ cols }) => cols[0].options?.map((o) => o.value) ?? []))];
    const last = (a?: string) => sent.filter((s) => !a || s.audience === a).sort((x, y) => y.at - x.at)[0];
    // The cadence is measured on updates to executives where that audience exists, else any update.
    const execAudience = audiences.find((a) => /exec|leadership/i.test(a));
    const cadenceLast = last(execAudience);
    const since = cadenceLast?.at ?? new Date(inc.created_at).getTime();
    const dueAt = interval && inc.status !== 'resolved' ? since + interval * 60_000 : null;
    comms = {
      intervalMinutes: interval,
      audience: execAudience ?? null,
      last: cadenceLast ? { at: new Date(cadenceLast.at).toISOString(), by: cadenceLast.by, summary: cadenceLast.summary } : null,
      dueAt: dueAt ? new Date(dueAt).toISOString() : null,
      overdue: dueAt !== null && dueAt < now,
      byAudience: audiences.map((a) => {
        const l = last(a);
        return { audience: a, last: l ? new Date(l.at).toISOString() : null, by: l?.by ?? null };
      }),
    };
  }

  const timeline = canSee(viewer, inc.id, 'timeline');
  const latest = timeline
    ? q
        .all<{ ts: string; type: string; text: string; user_id: string | null; agent: string | null }>(
          "SELECT ts, type, text, user_id, agent FROM timeline WHERE incident_id = ? AND type IN ('decision','finding') ORDER BY ts DESC LIMIT 6",
          inc.id,
        )
        .map((e) => ({ ts: e.ts, type: e.type, text: e.text, by: name(e.user_id ?? undefined), agent: e.agent }))
    : null;

  const icId = q.get<{ user_id: string }>("SELECT user_id FROM incident_roles WHERE incident_id = ? AND role = 'commander'", inc.id)?.user_id;

  return {
    incident: {
      id: inc.id,
      key: incidentKey(inc.number),
      title: inc.title,
      summary: inc.summary,
      severity: inc.severity,
      status: inc.status,
      statusLabel: LABEL[inc.status] ?? inc.status,
      createdAt: inc.created_at,
      resolvedAt: inc.resolved_at,
      commander: name(icId),
    },
    phases: phases(inc, now),
    iocs,
    assets,
    impact,
    actions,
    comms,
    latest,
    // The team's whereabouts and schedule are for responders, not guests.
    people: viewer.is_guest ? null : people(inc, sheets, now),
    generatedAt: new Date(now).toISOString(),
  };
}

function people(inc: IncidentRow, sheets: SheetData[], now: number) {
  const presence = new Map(presenceFor(inc.id).map((p) => [p.userId, p]));
  const rooms = new Map(q.all<{ id: string; name: string }>('SELECT id, name FROM voice_rooms WHERE incident_id = ?', inc.id).map((r) => [r.id, r.name]));
  const members = q.all<{ user_id: string; task: string; away_since: string | null; away_until: string | null; away_note: string }>(
    'SELECT user_id, task, away_since, away_until, away_note FROM incident_members WHERE incident_id = ?',
    inc.id,
  );
  const roles = q.all<{ role: string; user_id: string }>('SELECT role, user_id FROM incident_roles WHERE incident_id = ?', inc.id);
  const assignments = q.all<{ user_id: string }>('SELECT user_id FROM assignments WHERE incident_id = ?', inc.id);
  const horizon = now + 24 * 3_600_000;
  const shifts = q
    .all<{ user_id: string; starts_at: string; ends_at: string; note: string }>(
      'SELECT user_id, starts_at, ends_at, note FROM shifts WHERE incident_id = ? AND ends_at > ? AND starts_at < ? ORDER BY starts_at',
      inc.id,
      new Date(now).toISOString(),
      new Date(horizon).toISOString(),
    )
    .map((s) => ({ ...s, start: new Date(s.starts_at).getTime(), end: new Date(s.ends_at).getTime() }));

  // Workload from the sheets: open actions, live indicators and uncontained assets someone owns.
  const load = new Map<string, { actions: number; iocs: number; assets: number }>();
  const bump = (id: string | undefined, k: 'actions' | 'iocs' | 'assets') => {
    if (!id) return;
    const l = load.get(id) ?? { actions: 0, iocs: 0, assets: 0 };
    l[k]++;
    load.set(id, l);
  };
  for (const s of sheets) {
    const owner = s.col('Owner');
    const assignee = s.col('Assignee');
    const status = s.col('Status');
    const action = s.col('Action');
    const indicator = s.col('Indicator');
    const asset = s.col('Asset');
    const containment = s.col('Containment');
    const done = s.col('Done');
    for (const r of s.rows) {
      const st = status ? (r[status.id] ?? '').toLowerCase() : '';
      if (action && owner && r[action.id] && st !== 'done' && !(done && r[done.id] === 'true')) bump(r[owner.id], 'actions');
      if (indicator && owner && r[indicator.id] && !['blocked', 'false positive'].includes(st)) bump(r[owner.id], 'iocs');
      if (asset && assignee && r[asset.id] && !(containment && ['restored'].includes((r[containment.id] ?? '').toLowerCase()))) bump(r[assignee.id], 'assets');
    }
  }

  const ids = new Set<string>([
    ...members.map((m) => m.user_id),
    ...roles.map((r) => r.user_id),
    ...assignments.map((a) => a.user_id),
    ...shifts.map((s) => s.user_id),
  ]);
  const list = [...ids]
    .map((id) => {
      const u = getUser(id);
      if (!u || !u.active || u.deleted) return null;
      const p = presence.get(id);
      const m = members.find((x) => x.user_id === id);
      const shift = shifts.find((s) => s.user_id === id && s.start <= now && s.end > now);
      const next = shifts.find((s) => s.user_id === id && s.start > now);
      return {
        userId: id,
        name: u.display_name,
        title: u.title ?? '',
        guest: Boolean(u.is_guest),
        roles: roles.filter((r) => r.user_id === id).map((r) => r.role),
        inRoom: Boolean(p),
        voice: p?.voiceRoomId ? rooms.get(p.voiceRoomId) ?? 'voice' : null,
        camera: Boolean(p?.camera),
        away: m?.away_since ? { until: m.away_until, note: m.away_note } : null,
        onShift: shift ? { until: new Date(shift.end).toISOString(), note: shift.note } : null,
        nextShift: next ? { start: new Date(next.start).toISOString(), end: new Date(next.end).toISOString() } : null,
        task: m?.task ?? '',
        load: { ...(load.get(id) ?? { actions: 0, iocs: 0, assets: 0 }), assignments: assignments.filter((a) => a.user_id === id).length },
      };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);

  // Shift coverage for the next 24 hours, hour by hour.
  const hourStart = Math.floor(now / 3_600_000) * 3_600_000;
  const coverage = shifts.length
    ? Array.from({ length: 24 }, (_, i) => {
        const a = hourStart + i * 3_600_000;
        const b = a + 3_600_000;
        return { start: new Date(a).toISOString(), people: shifts.filter((s) => s.start < b && s.end > a).map((s) => name(s.user_id)).filter(Boolean) };
      })
    : null;
  const gaps: { start: string; end: string }[] = [];
  for (const h of coverage ?? []) {
    if (h.people.length) continue;
    const prev = gaps.at(-1);
    const end = new Date(new Date(h.start).getTime() + 3_600_000).toISOString();
    if (prev && prev.end === h.start) prev.end = end;
    else gaps.push({ start: h.start, end });
  }

  const people = list;
  return {
    counts: {
      total: people.length,
      inRoom: people.filter((p) => p.inRoom).length,
      inVoice: people.filter((p) => p.voice).length,
      away: people.filter((p) => p.away).length,
      onShift: people.filter((p) => p.onShift).length,
    },
    list,
    coverage,
    gaps,
  };
}

export const dashboardRouter = Router();
dashboardRouter.get('/incidents/:id/dashboard', (req: Request, res: Response) => {
  const d = dashboardFor(req.params.id, req.user!);
  if (!d) return res.status(404).json({ error: 'incident not found' });
  res.json(d);
});
