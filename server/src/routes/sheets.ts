import { Router } from 'express';
import { newId, now, q, tx } from '../db.js';
import { emitToIncident, refreshIncident } from '../realtime.js';
import type { Column } from '../templates.js';
import { HttpError, mustIncident, mustSheet, type SheetRow } from '../model.js';
import { addTimeline } from '../timeline.js';
import { createSheet } from '../rooms.js';
import { h, str } from './common.js';

/** The native spreadsheet: sheets, columns, rows and cells. */

export const router = Router();

// ---------- sheets ----------

const parseColumns = (s: SheetRow) => JSON.parse(s.columns) as Column[];

function saveColumns(sheetId: string, cols: Column[]) {
  q.run('UPDATE sheets SET columns = ? WHERE id = ?', JSON.stringify(cols), sheetId);
}

const COLUMN_TYPES = ['text', 'number', 'select', 'date', 'person', 'checkbox'];

function sanitizeColumn(input: any, existing?: Column): Column {
  const col: Column = existing ? { ...existing } : { id: newId().slice(0, 8), name: 'Column', type: 'text' };
  if (typeof input?.name === 'string' && input.name.trim()) col.name = input.name.trim().slice(0, 80);
  if (COLUMN_TYPES.includes(input?.type)) col.type = input.type;
  if (typeof input?.width === 'number') col.width = Math.max(60, Math.min(800, Math.round(input.width)));
  if (Array.isArray(input?.options)) {
    col.options = input.options
      .filter((o: any) => o && typeof o.value === 'string' && o.value.trim())
      .slice(0, 50)
      .map((o: any) => ({ value: o.value.trim().slice(0, 60), color: str(o.color, 20) || 'gray' }));
  }
  if (col.type === 'select' && !col.options) col.options = [];
  return col;
}

const sheetRefresh = (s: SheetRow) => emitToIncident(s.incident_id, 'sheet:refresh', { sheetId: s.id });

router.post(
  '/incidents/:id/sheets',
  h((req) => {
    const inc = mustIncident(req.params.id);
    const id = createSheet(inc.id, req.user!.id, str(req.body?.template) || 'blank', str(req.body?.name, 80));
    const s = mustSheet(id);
    addTimeline(inc.id, req.user!.id, 'sheet', `Sheet “${s.name}” created`);
    refreshIncident(inc.id);
    return { id };
  }),
);

router.get(
  '/sheets/:id',
  h((req) => {
    const s = mustSheet(req.params.id);
    return {
      sheet: { id: s.id, incidentId: s.incident_id, name: s.name, columns: parseColumns(s) },
      rows: q.all<{ id: string; position: number }>('SELECT id, position FROM sheet_rows WHERE sheet_id = ? ORDER BY position', s.id),
      cells: q
        .all<{ row_id: string; col_id: string; value: string; updated_by: string | null; updated_at: string }>(
          'SELECT row_id, col_id, value, updated_by, updated_at FROM sheet_cells WHERE sheet_id = ?',
          s.id,
        )
        .map((c) => ({ rowId: c.row_id, colId: c.col_id, value: c.value, updatedBy: c.updated_by, updatedAt: c.updated_at })),
    };
  }),
);

router.patch(
  '/sheets/:id',
  h((req) => {
    const s = mustSheet(req.params.id);
    const name = str(req.body?.name, 80);
    if (name) q.run('UPDATE sheets SET name = ? WHERE id = ?', name, s.id);
    refreshIncident(s.incident_id);
    sheetRefresh(s);
    return { ok: true };
  }),
);

router.delete(
  '/sheets/:id',
  h((req) => {
    const s = mustSheet(req.params.id);
    q.run('DELETE FROM sheets WHERE id = ?', s.id);
    addTimeline(s.incident_id, req.user!.id, 'sheet', `Sheet “${s.name}” deleted`);
    refreshIncident(s.incident_id);
    return { ok: true };
  }),
);

router.post(
  '/sheets/:id/columns',
  h((req) => {
    const s = mustSheet(req.params.id);
    const cols = parseColumns(s);
    const col = sanitizeColumn(req.body);
    const after = str(req.body?.afterColId);
    const idx = after ? cols.findIndex((c) => c.id === after) : -1;
    if (idx >= 0) cols.splice(idx + 1, 0, col);
    else cols.push(col);
    saveColumns(s.id, cols);
    sheetRefresh(s);
    return { column: col };
  }),
);

router.patch(
  '/sheets/:id/columns/:colId',
  h((req) => {
    const s = mustSheet(req.params.id);
    const cols = parseColumns(s);
    const i = cols.findIndex((c) => c.id === req.params.colId);
    if (i < 0) throw new HttpError(404, 'column not found');
    cols[i] = sanitizeColumn(req.body, cols[i]);
    if (typeof req.body?.moveTo === 'number') {
      const [c] = cols.splice(i, 1);
      cols.splice(Math.max(0, Math.min(cols.length, req.body.moveTo)), 0, c);
    }
    saveColumns(s.id, cols);
    sheetRefresh(s);
    return { ok: true };
  }),
);

router.delete(
  '/sheets/:id/columns/:colId',
  h((req) => {
    const s = mustSheet(req.params.id);
    const cols = parseColumns(s).filter((c) => c.id !== req.params.colId);
    tx(() => {
      saveColumns(s.id, cols);
      q.run('DELETE FROM sheet_cells WHERE sheet_id = ? AND col_id = ?', s.id, req.params.colId);
    });
    sheetRefresh(s);
    return { ok: true };
  }),
);

router.post(
  '/sheets/:id/rows',
  h((req) => {
    const s = mustSheet(req.params.id);
    const count = Math.max(1, Math.min(100, Number(req.body?.count ?? 1) || 1));
    const after = str(req.body?.afterRowId);
    let start: number;
    let step: number;
    if (after) {
      const a = q.get<{ position: number }>('SELECT position FROM sheet_rows WHERE id = ? AND sheet_id = ?', after, s.id);
      if (!a) throw new HttpError(404, 'row not found');
      const next = q.get<{ position: number }>(
        'SELECT position FROM sheet_rows WHERE sheet_id = ? AND position > ? ORDER BY position LIMIT 1',
        s.id,
        a.position,
      );
      const end = next ? next.position : a.position + count + 1;
      step = (end - a.position) / (count + 1);
      start = a.position + step;
    } else {
      start = (q.get<{ p: number | null }>('SELECT MAX(position) AS p FROM sheet_rows WHERE sheet_id = ?', s.id)?.p ?? 0) + 1;
      step = 1;
    }
    const ids: string[] = [];
    tx(() => {
      for (let i = 0; i < count; i++) {
        const id = newId();
        ids.push(id);
        q.run(
          'INSERT INTO sheet_rows (id, sheet_id, position, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
          id,
          s.id,
          start + i * step,
          req.user!.id,
          now(),
        );
      }
    });
    sheetRefresh(s);
    return { ids };
  }),
);

router.delete(
  '/sheets/:id/rows/:rowId',
  h((req) => {
    const s = mustSheet(req.params.id);
    q.run('DELETE FROM sheet_rows WHERE id = ? AND sheet_id = ?', req.params.rowId, s.id);
    sheetRefresh(s);
    return { ok: true };
  }),
);

router.put(
  '/sheets/:id/cells',
  h((req) => {
    const s = mustSheet(req.params.id);
    const edits: { rowId: string; colId: string; value: string }[] = Array.isArray(req.body?.cells)
      ? req.body.cells
      : [{ rowId: req.body?.rowId, colId: req.body?.colId, value: req.body?.value }];
    const cols = new Set(parseColumns(s).map((c) => c.id));
    const ts = now();
    const applied: { rowId: string; colId: string; value: string; updatedBy: string; updatedAt: string }[] = [];
    tx(() => {
      for (const e of edits.slice(0, 5000)) {
        const rowId = String(e?.rowId ?? '');
        const colId = String(e?.colId ?? '');
        if (!cols.has(colId) || !q.get('SELECT 1 FROM sheet_rows WHERE id = ? AND sheet_id = ?', rowId, s.id)) continue;
        const value = typeof e.value === 'string' ? e.value.slice(0, 10000) : e.value == null ? '' : String(e.value);
        if (value === '') q.run('DELETE FROM sheet_cells WHERE row_id = ? AND col_id = ?', rowId, colId);
        else
          q.run(
            `INSERT INTO sheet_cells (sheet_id, row_id, col_id, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (row_id, col_id) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
            s.id,
            rowId,
            colId,
            value,
            req.user!.id,
            ts,
          );
        applied.push({ rowId, colId, value, updatedBy: req.user!.id, updatedAt: ts });
      }
    });
    if (applied.length) emitToIncident(s.incident_id, 'sheet:cells', { sheetId: s.id, cells: applied });
    return { applied: applied.length };
  }),
);
