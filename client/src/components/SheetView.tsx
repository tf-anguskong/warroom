import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { getSocket } from '../lib/socket';
import { colLetter, createEvaluator } from '../lib/formula';
import { userColor } from '../lib/format';
import type { Column, ColumnType, IncidentState, Presence, SheetData } from '../types';
import { Avatar, Icons, Modal } from './ui';

const key = (rowId: string, colId: string) => `${rowId}|${colId}`;
const DEFAULT_WIDTH: Record<ColumnType, number> = { text: 180, number: 110, select: 150, date: 170, person: 160, checkbox: 90 };
const TYPE_LABEL: Record<ColumnType, string> = { text: 'Text', number: 'Number', select: 'Select', date: 'Date/time (UTC)', person: 'Person', checkbox: 'Checkbox' };
const TYPE_GLYPH: Record<ColumnType, string> = { text: 'Aa', number: '#', select: '▾', date: '◷', person: '@', checkbox: '☑' };
const COLORS = ['gray', 'blue', 'teal', 'green', 'yellow', 'orange', 'red', 'purple'];

interface Cursor {
  userId: string;
  displayName: string;
  rowId: string | null;
  colId: string | null;
}

export function SheetView({ sheetId, state, presence }: { sheetId: string; state: IncidentState; presence: Presence[] }) {
  const { users, userById, toast, me } = useApp();
  const [data, setData] = useState<SheetData | null>(null);
  const [cells, setCells] = useState<Map<string, string>>(new Map());
  const [sel, setSel] = useState({ r: 0, c: 0 });
  const [editing, setEditing] = useState<{ r: number; c: number; value: string } | null>(null);
  const [cursors, setCursors] = useState<Map<string, Cursor>>(new Map());
  const [colDialog, setColDialog] = useState<{ col?: Column; insertAfter?: string } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    api.get<SheetData>(`/api/sheets/${sheetId}`).then((d) => {
      setData(d);
      setCells(new Map(d.cells.map((c) => [key(c.rowId, c.colId), c.value])));
    });
  }, [sheetId]);

  useEffect(() => {
    load();
    const s = getSocket();
    const onCells = (e: { sheetId: string; cells: { rowId: string; colId: string; value: string; updatedBy: string }[] }) => {
      if (e.sheetId !== sheetId) return;
      setCells((m) => {
        const n = new Map(m);
        for (const c of e.cells) {
          if (c.value === '') n.delete(key(c.rowId, c.colId));
          else n.set(key(c.rowId, c.colId), c.value);
        }
        return n;
      });
    };
    const onRefresh = (e: { sheetId: string }) => e.sheetId === sheetId && load();
    const onCursor = (c: Cursor & { sheetId: string }) => {
      setCursors((m) => {
        const n = new Map(m);
        if (c.sheetId === sheetId && c.rowId) n.set(c.userId, c);
        else n.delete(c.userId);
        return n;
      });
    };
    s.on('sheet:cells', onCells);
    s.on('sheet:refresh', onRefresh);
    s.on('sheet:cursor', onCursor);
    return () => {
      s.off('sheet:cells', onCells);
      s.off('sheet:refresh', onRefresh);
      s.off('sheet:cursor', onCursor);
      s.emit('sheet:cursor', { sheetId, rowId: null, colId: null });
    };
  }, [sheetId, load]);

  // Drop cursors of people who left this sheet.
  useEffect(() => {
    const here = new Set(presence.filter((p) => p.view === `sheet:${sheetId}`).map((p) => p.userId));
    setCursors((m) => {
      const n = new Map([...m].filter(([uid]) => here.has(uid)));
      return n.size === m.size ? m : n;
    });
  }, [presence, sheetId]);

  const columns = data?.sheet.columns ?? [];
  const rows = data?.rows ?? [];

  useEffect(() => {
    const row = rows[sel.r];
    const col = columns[sel.c];
    if (row && col) getSocket().emit('sheet:cursor', { sheetId, rowId: row.id, colId: col.id });
  }, [sel, rows, columns, sheetId]);

  const raw = useCallback((r: number, c: number) => {
    const row = rows[r];
    const col = columns[c];
    return row && col ? cells.get(key(row.id, col.id)) ?? '' : '';
  }, [rows, columns, cells]);

  const evaluator = useMemo(
    () =>
      createEvaluator(
        (c, r) => {
          const v = raw(r, c);
          const col = columns[c];
          if (!v || v.startsWith('=')) return v;
          if (col?.type === 'person') return userById(v)?.displayName ?? v;
          if (col?.type === 'checkbox') return v === 'true' ? 'TRUE' : 'FALSE';
          if (col?.type === 'date') return v.replace('T', ' ');
          return v;
        },
        columns.length,
        rows.length,
      ),
    [raw, columns, rows.length, userById],
  );

  const cursorByCell = useMemo(() => {
    const m = new Map<string, Cursor[]>();
    for (const c of cursors.values()) {
      if (!c.rowId || !c.colId) continue;
      const k = key(c.rowId, c.colId);
      m.set(k, [...(m.get(k) ?? []), c]);
    }
    return m;
  }, [cursors]);

  const write = useCallback(
    async (edits: { r: number; c: number; value: string }[], rowList = rows) => {
      const payload = edits
        .map((e) => ({ rowId: rowList[e.r]?.id, colId: columns[e.c]?.id, value: e.value }))
        .filter((e) => e.rowId && e.colId) as { rowId: string; colId: string; value: string }[];
      if (!payload.length) return;
      setCells((m) => {
        const n = new Map(m);
        for (const e of payload) {
          if (e.value === '') n.delete(key(e.rowId, e.colId));
          else n.set(key(e.rowId, e.colId), e.value);
        }
        return n;
      });
      try {
        await api.put(`/api/sheets/${sheetId}/cells`, { cells: payload });
      } catch (err) {
        toast({ text: 'Could not save cell — reloading sheet', tone: 'error' });
        load();
      }
    },
    [rows, columns, sheetId, toast, load],
  );

  const commit = (value: string, move: 'down' | 'right' | 'none' = 'down') => {
    if (!editing) return;
    const { r, c } = editing;
    setEditing(null);
    if (value !== raw(r, c)) void write([{ r, c, value }]);
    if (move === 'down') setSel({ r: Math.min(rows.length - 1, r + 1), c });
    if (move === 'right') setSel({ r, c: Math.min(columns.length - 1, c + 1) });
    gridRef.current?.focus();
  };

  const startEdit = (r: number, c: number, initial?: string) => {
    const col = columns[c];
    if (!col) return;
    if (col.type === 'checkbox') {
      void write([{ r, c, value: raw(r, c) === 'true' ? '' : 'true' }]);
      return;
    }
    setEditing({ r, c, value: initial ?? raw(r, c) });
  };

  const addRows = async (count = 1, afterRowId?: string) => {
    await api.post(`/api/sheets/${sheetId}/rows`, { count, afterRowId });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing || !columns.length || !rows.length) return;
    const { r, c } = sel;
    const move = (dr: number, dc: number) => {
      e.preventDefault();
      setSel({ r: Math.max(0, Math.min(rows.length - 1, r + dr)), c: Math.max(0, Math.min(columns.length - 1, c + dc)) });
    };
    switch (e.key) {
      case 'ArrowUp':
        return move(-1, 0);
      case 'ArrowDown':
        return move(1, 0);
      case 'ArrowLeft':
        return move(0, -1);
      case 'ArrowRight':
        return move(0, 1);
      case 'Tab':
        return move(0, e.shiftKey ? -1 : 1);
      case 'Enter':
      case 'F2':
        e.preventDefault();
        if (e.key === 'Enter' && r === rows.length - 1 && e.shiftKey) void addRows(1);
        return startEdit(r, c);
      case ' ':
        if (columns[c]?.type === 'checkbox') {
          e.preventDefault();
          return startEdit(r, c);
        }
        break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        return void write([{ r, c, value: '' }]);
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      navigator.clipboard.writeText(raw(r, c).startsWith('=') ? evaluator.display(c, r).text : displayText(r, c));
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const t = columns[c]?.type;
      if (t === 'text' || t === 'number') {
        e.preventDefault();
        startEdit(r, c, e.key);
      } else if (t !== 'checkbox') startEdit(r, c);
    }
  };

  /** Paste tab/newline separated data (from Excel, Sheets, or a SIEM export) starting at the selection. */
  const onPaste = async (e: ClipboardEvent<HTMLDivElement>) => {
    if (editing) return;
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map((l) => l.split('\t'));
    const needed = sel.r + lines.length - rows.length;
    let rowList = rows;
    if (needed > 0) {
      await addRows(needed);
      const fresh = await api.get<SheetData>(`/api/sheets/${sheetId}`);
      setData(fresh);
      rowList = fresh.rows;
    }
    const edits: { r: number; c: number; value: string }[] = [];
    lines.forEach((cols, i) =>
      cols.forEach((v, j) => {
        const col = columns[sel.c + j];
        if (!col) return;
        let value = v.trim();
        if (col.type === 'person') value = users.find((u) => u.displayName.toLowerCase() === value.toLowerCase() || u.email === value)?.id ?? '';
        if (col.type === 'checkbox') value = /^(true|yes|x|1|✓)$/i.test(value) ? 'true' : '';
        edits.push({ r: sel.r + i, c: sel.c + j, value });
      }),
    );
    void write(edits, rowList);
  };

  function displayText(r: number, c: number): string {
    const v = raw(r, c);
    const col = columns[c];
    if (!v) return '';
    if (v.startsWith('=')) return evaluator.display(c, r).text;
    if (col?.type === 'person') return userById(v)?.displayName ?? '(unknown user)';
    if (col?.type === 'date') return v.replace('T', ' ');
    if (col?.type === 'checkbox') return v === 'true' ? 'TRUE' : 'FALSE';
    return v;
  }

  const exportCsv = () => {
    const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const lines = [columns.map((c) => esc(c.name)).join(',')];
    rows.forEach((_, r) => {
      const vals = columns.map((_, c) => displayText(r, c));
      if (vals.some(Boolean)) lines.push(vals.map(esc).join(','));
    });
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.incident.key}-${data?.sheet.name ?? 'sheet'}.csv`.replace(/[^\w.-]+/g, '_');
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // Column resize
  const resize = useRef<{ colId: string; startX: number; startW: number } | null>(null);
  const [liveWidth, setLiveWidth] = useState<{ colId: string; w: number } | null>(null);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const r = resize.current;
      if (r) setLiveWidth({ colId: r.colId, w: Math.max(60, r.startW + e.clientX - r.startX) });
    };
    const onUp = (e: MouseEvent) => {
      const r = resize.current;
      if (!r) return;
      resize.current = null;
      const w = Math.max(60, r.startW + e.clientX - r.startX);
      void api.patch(`/api/sheets/${sheetId}/columns/${r.colId}`, { width: w }).finally(() => setLiveWidth(null));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [sheetId]);
  const widthOf = (c: Column) => (liveWidth?.colId === c.id ? liveWidth.w : c.width ?? DEFAULT_WIDTH[c.type]);

  if (!data) return <div className="skeleton tall" />;

  const viewers = presence.filter((p) => p.view === `sheet:${sheetId}` && p.userId !== me.id);
  const selCol = columns[sel.c];
  const selRaw = raw(sel.r, sel.c);

  return (
    <div className="sheet-view">
      <div className="view-head">
        {renaming ? (
          <input
            className="title-input"
            autoFocus
            defaultValue={data.sheet.name}
            onBlur={(e) => {
              setRenaming(false);
              if (e.target.value.trim() && e.target.value !== data.sheet.name) api.patch(`/api/sheets/${sheetId}`, { name: e.target.value });
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <h2 onClick={() => setRenaming(true)} title="Click to rename">
            {Icons.grid} {data.sheet.name}
          </h2>
        )}
        <div className="avatar-stack">
          {viewers.map((v) => (
            <Avatar key={v.userId} id={v.userId} name={`${v.displayName} is viewing`} size={24} />
          ))}
        </div>
        <div className="spacer" />
        <button className="btn ghost sm" onClick={() => setColDialog({})}>
          {Icons.plus} Column
        </button>
        <button className="btn ghost sm" onClick={exportCsv}>
          {Icons.download} CSV
        </button>
        <button
          className="icon-btn"
          title="Delete sheet"
          onClick={() => confirm(`Delete sheet “${data.sheet.name}”? This cannot be undone.`) && api.del(`/api/sheets/${sheetId}`)}
        >
          {Icons.trash}
        </button>
      </div>

      <div className="formula-bar">
        <span className="cell-ref mono">{selCol ? `${colLetter(sel.c)}${sel.r + 1}` : ''}</span>
        <span className="fx">fx</span>
        <input
          className="mono"
          value={editing ? editing.value : selRaw}
          disabled={!selCol || selCol.type === 'checkbox'}
          placeholder={selCol ? `${selCol.name} — type a value or =SUM(B1:B10), =COUNTIF(C1:C50,"Blocked")` : ''}
          onFocus={() => !editing && selCol && setEditing({ ...sel, value: selRaw })}
          onChange={(e) => setEditing({ ...(editing ?? sel), value: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
            if (e.key === 'Escape') {
              setEditing(null);
              gridRef.current?.focus();
            }
          }}
          onBlur={(e) => editing && commit(e.target.value, 'none')}
        />
      </div>

      <div className="grid-wrap" ref={gridRef} tabIndex={0} onKeyDown={onKeyDown} onPaste={onPaste}>
        <table className="grid">
          <colgroup>
            <col style={{ width: 48 }} />
            {columns.map((c) => (
              <col key={c.id} style={{ width: widthOf(c) }} />
            ))}
          </colgroup>
          <thead>
            <tr className="letters">
              <th />
              {columns.map((c, ci) => (
                <th key={c.id} className={sel.c === ci ? 'sel' : ''}>
                  {colLetter(ci)}
                </th>
              ))}
            </tr>
            <tr className="names">
              <th className="corner" />
              {columns.map((c) => (
                <th key={c.id} className="col-head">
                  <button className="col-name" onClick={() => setColDialog({ col: c })} title={`${TYPE_LABEL[c.type]} column — click to edit`}>
                    <span className="type-glyph">{TYPE_GLYPH[c.type]}</span>
                    {c.name}
                  </button>
                  <span
                    className="col-resize"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      resize.current = { colId: c.id, startX: e.clientX, startW: widthOf(c) };
                    }}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={row.id}>
                <th className={`row-num ${sel.r === r ? 'sel' : ''}`}>
                  <span>{r + 1}</span>
                  <button
                    className="row-del"
                    title="Delete row"
                    onClick={() => {
                      const hasData = columns.some((_, c) => raw(r, c));
                      if (!hasData || confirm(`Delete row ${r + 1}?`)) api.del(`/api/sheets/${sheetId}/rows/${row.id}`);
                    }}
                  >
                    ×
                  </button>
                </th>
                {columns.map((col, c) => {
                  const isSel = sel.r === r && sel.c === c;
                  const isEdit = editing?.r === r && editing?.c === c;
                  const others = cursorByCell.get(key(row.id, col.id));
                  return (
                    <td
                      key={col.id}
                      className={`cell t-${col.type} ${isSel ? 'sel' : ''} ${others ? 'remote' : ''}`}
                      style={others ? ({ '--remote': userColor(others[0].userId) } as React.CSSProperties) : undefined}
                      onMouseDown={() => {
                        if (!isEdit) {
                          if (editing) commit(editing.value, 'none');
                          setSel({ r, c });
                        }
                      }}
                      onDoubleClick={() => col.type !== 'checkbox' && startEdit(r, c)}
                      onClick={() => col.type === 'checkbox' && isSel && startEdit(r, c)}
                    >
                      {others && <span className="remote-tag">{others.map((o) => o.displayName.split(' ')[0]).join(', ')}</span>}
                      {isEdit ? (
                        <CellEditor col={col} value={editing.value} users={users} onChange={(v) => setEditing({ ...editing, value: v })} onCommit={commit} onCancel={() => { setEditing(null); gridRef.current?.focus(); }} />
                      ) : (
                        <CellDisplay col={col} raw={raw(r, c)} display={() => evaluator.display(c, r)} userName={(id) => userById(id)?.displayName} />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="grid-foot">
          <button className="btn ghost sm" onClick={() => addRows(1)}>
            {Icons.plus} Row
          </button>
          <button className="btn ghost sm" onClick={() => addRows(10)}>
            {Icons.plus} 10 rows
          </button>
          <span className="muted small">Tip: paste rows straight from Excel or a SIEM export. Enter edits, arrows move, Delete clears.</span>
        </div>
      </div>

      {colDialog && (
        <ColumnDialog
          sheetId={sheetId}
          col={colDialog.col}
          onClose={() => setColDialog(null)}
        />
      )}
    </div>
  );
}

function CellDisplay({
  col,
  raw,
  display,
  userName,
}: {
  col: Column;
  raw: string;
  display: () => { text: string; error: boolean; numeric: boolean };
  userName: (id: string) => string | undefined;
}) {
  if (!raw) return col.type === 'checkbox' ? <span className="cb" aria-label="unchecked" /> : null;
  if (raw.startsWith('=')) {
    const d = display();
    return <span className={`formula ${d.error ? 'err' : ''} ${d.numeric ? 'num' : ''}`}>{d.text}</span>;
  }
  switch (col.type) {
    case 'select': {
      const opt = col.options?.find((o) => o.value === raw);
      return <span className={`chip c-${opt?.color ?? 'gray'}`}>{raw}</span>;
    }
    case 'person': {
      const name = userName(raw);
      return name ? (
        <span className="person">
          <Avatar id={raw} name={name} size={18} /> {name}
        </span>
      ) : (
        <span className="muted">(unknown)</span>
      );
    }
    case 'checkbox':
      return <span className={`cb ${raw === 'true' ? 'on' : ''}`} aria-label={raw === 'true' ? 'checked' : 'unchecked'}>{raw === 'true' ? '✓' : ''}</span>;
    case 'date':
      return <span className="mono">{raw.replace('T', ' ')}</span>;
    case 'number':
      return <span className="num mono">{raw}</span>;
    default:
      return <span className="txt">{raw}</span>;
  }
}

function CellEditor({
  col,
  value,
  users,
  onChange,
  onCommit,
  onCancel,
}: {
  col: Column;
  value: string;
  users: { id: string; displayName: string }[];
  onChange: (v: string) => void;
  onCommit: (v: string, move?: 'down' | 'right' | 'none') => void;
  onCancel: () => void;
}) {
  const keys = (e: KeyboardEvent<HTMLInputElement | HTMLSelectElement>) => {
    e.stopPropagation();
    if (e.key === 'Escape') onCancel();
    else if (e.key === 'Enter') {
      e.preventDefault();
      onCommit((e.target as HTMLInputElement).value);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      onCommit((e.target as HTMLInputElement).value, 'right');
    }
  };
  if (col.type === 'select' && !value.startsWith('=')) {
    return (
      <select autoFocus className="cell-input" value={value} onChange={(e) => onCommit(e.target.value, 'none')} onKeyDown={keys} onBlur={(e) => onCommit(e.target.value, 'none')}>
        <option value="">—</option>
        {col.options?.map((o) => (
          <option key={o.value} value={o.value}>
            {o.value}
          </option>
        ))}
      </select>
    );
  }
  if (col.type === 'person' && !value.startsWith('=')) {
    return (
      <select autoFocus className="cell-input" value={value} onChange={(e) => onCommit(e.target.value, 'none')} onKeyDown={keys} onBlur={(e) => onCommit(e.target.value, 'none')}>
        <option value="">—</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.displayName}
          </option>
        ))}
      </select>
    );
  }
  if (col.type === 'date' && !value.startsWith('=')) {
    return (
      <input
        autoFocus
        type="datetime-local"
        className="cell-input"
        value={value || new Date().toISOString().slice(0, 16)}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={keys}
        onBlur={(e) => onCommit(e.target.value, 'none')}
      />
    );
  }
  return (
    <input
      autoFocus
      className={`cell-input ${col.type === 'number' ? 'num' : ''}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={keys}
      onBlur={(e) => onCommit(e.target.value, 'none')}
    />
  );
}

function ColumnDialog({ sheetId, col, onClose }: { sheetId: string; col?: Column; onClose: () => void }) {
  const [name, setName] = useState(col?.name ?? '');
  const [type, setType] = useState<ColumnType>(col?.type ?? 'text');
  const [options, setOptions] = useState(col?.options ?? []);
  const [newOpt, setNewOpt] = useState('');

  const save = async () => {
    const body = { name: name || 'Column', type, options: type === 'select' ? options : undefined };
    if (col) await api.patch(`/api/sheets/${sheetId}/columns/${col.id}`, body);
    else await api.post(`/api/sheets/${sheetId}/columns`, body);
    onClose();
  };

  const addOpt = () => {
    const v = newOpt.trim();
    if (!v || options.some((o) => o.value === v)) return;
    setOptions([...options, { value: v, color: COLORS[options.length % COLORS.length] }]);
    setNewOpt('');
  };

  return (
    <Modal
      title={col ? `Edit column “${col.name}”` : 'Add column'}
      onClose={onClose}
      footer={
        <>
          {col && (
            <button
              className="btn ghost danger-text"
              onClick={async () => {
                if (!confirm(`Delete column “${col.name}” and all its values?`)) return;
                await api.del(`/api/sheets/${sheetId}/columns/${col.id}`);
                onClose();
              }}
            >
              Delete column
            </button>
          )}
          <div className="spacer" />
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="form">
        <label>
          Name
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
        </label>
        <label>
          Type
          <select value={type} onChange={(e) => setType(e.target.value as ColumnType)}>
            {(Object.keys(TYPE_LABEL) as ColumnType[]).map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        {col && type !== col.type && <p className="hint">Existing values are kept as text; cells that don't fit the new type will show as-is.</p>}
        {type === 'select' && (
          <fieldset>
            <legend>Options</legend>
            {options.map((o, i) => (
              <div key={o.value} className="opt-row">
                <span className={`chip c-${o.color}`}>{o.value}</span>
                <div className="swatches">
                  {COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={`swatch c-${c} ${o.color === c ? 'on' : ''}`}
                      aria-label={c}
                      onClick={() => setOptions(options.map((x, j) => (j === i ? { ...x, color: c } : x)))}
                    />
                  ))}
                </div>
                <button type="button" className="icon-btn sm" onClick={() => setOptions(options.filter((_, j) => j !== i))} aria-label={`Remove ${o.value}`}>
                  ×
                </button>
              </div>
            ))}
            <div className="row">
              <input value={newOpt} onChange={(e) => setNewOpt(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addOpt())} placeholder="New option" />
              <button type="button" className="btn secondary" onClick={addOpt}>
                Add
              </button>
            </div>
          </fieldset>
        )}
      </div>
    </Modal>
  );
}
