import { useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { humanSize } from '../lib/upload';
import { Icons, Modal } from './ui';

interface ExportResult {
  name: string;
  size: number;
  sha256: string;
  encrypted: boolean;
  download: string;
}

/** Export one room to a .warroom archive (encrypted with a passphrase unless you insist otherwise). */
export function ExportRoomDialog({ incidentId, incidentKey, onClose }: { incidentId: string; incidentKey: string; onClose: () => void }) {
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [plain, setPlain] = useState(false);
  const [includeFiles, setIncludeFiles] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<ExportResult | null>(null);

  const ok = plain || (pass.length >= 10 && pass === pass2);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<ExportResult>(`/api/incidents/${incidentId}/archive`, plain ? { plain: true, includeFiles } : { passphrase: pass, includeFiles });
      setDone(r);
      // Start the download straight away.
      const a = document.createElement('a');
      a.href = r.download;
      a.download = r.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : 'Export failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Export ${incidentKey}`}
      onClose={onClose}
      footer={
        done ? (
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button className="btn ghost" onClick={onClose} type="button">
              Cancel
            </button>
            <button className="btn primary" form="export-room" disabled={!ok || busy}>
              {busy ? 'Exporting…' : 'Export room'}
            </button>
          </>
        )
      }
    >
      {done ? (
        <div className="form">
          <div className="alert info">
            <div>
              <strong>{done.name}</strong> is downloading ({humanSize(done.size)}, {done.encrypted ? 'encrypted' : 'not encrypted'}).
            </div>
          </div>
          <label>
            SHA-256 of the archive (keep it with the file to prove it wasn’t changed)
            <code className="mono hash-full">{done.sha256}</code>
          </label>
          <p className="small">
            To bring this room back: on any War Room, an admin opens the dashboard → <strong>Restore a room</strong> (or on a new quick War Room, the setup page offers it)
            and uploads this file{done.encrypted ? ' with the passphrase' : ''}.
          </p>
          <a className="btn ghost sm" href={done.download} download={done.name}>
            {Icons.download} Download again (link works for an hour)
          </a>
        </div>
      ) : (
        <form id="export-room" className="form" onSubmit={submit}>
          <p className="small">
            Everything in this room goes into one file: messages, timeline, sheets, notes, files and screenshots (with their hashes), schedule, roles, assignments
            and investigation results. Import it into any War Room to carry on, for example after tearing down a temporary server.
          </p>
          {!plain && (
            <>
              <label>
                Passphrase
                <input type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="At least 10 characters" autoFocus />
              </label>
              <label>
                Repeat it
                <input type="password" autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} />
              </label>
              {pass2 && pass !== pass2 && <div className="warn-text small">The passphrases don’t match.</div>}
              <p className="hint">The archive is encrypted (AES-256-GCM). Without the passphrase nobody can open it — including you, so keep it somewhere safe.</p>
            </>
          )}
          <label className="check">
            <input type="checkbox" checked={includeFiles} onChange={(e) => setIncludeFiles(e.target.checked)} /> Include files and screenshots
          </label>
          <label className="check">
            <input type="checkbox" checked={plain} onChange={(e) => setPlain(e.target.checked)} /> Don’t encrypt (anyone with the file can read the whole incident)
          </label>
          {plain && <div className="alert warn">Unencrypted exports are recorded on the timeline. Only use this if the file will be protected some other way.</div>}
          {err && <div className="alert error">{err}</div>}
        </form>
      )}
    </Modal>
  );
}

interface Summary {
  incident: { key: string; title: string };
  exportedAt: string;
  source: string;
  counts: Record<string, number>;
  people: number;
  files: number;
}
interface ImportResult {
  incidentId: string;
  key: string;
  title: string;
  originalKey: string;
  people: { matched: number; created: number };
  files: number;
  warnings: string[];
}

/** Upload a .warroom archive, check it (passphrase, what's inside), then import it as a new room. */
export function ImportRoom({ onImported }: { onImported: (r: ImportResult) => void }) {
  const picker = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [needsPass, setNeedsPass] = useState(false);
  const [pass, setPass] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const upload = (f: File) => {
    setFile(f);
    setErr(null);
    setSummary(null);
    setToken(null);
    setProgress(0);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/archives/upload');
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && setProgress(e.loaded / e.total);
    xhr.onload = () => {
      setProgress(null);
      let d: { uploadToken?: string; needsPassphrase?: boolean; summary?: Summary; error?: string } = {};
      try {
        d = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 300 || !d.uploadToken) return setErr(d.error ?? `Upload failed (${xhr.status})`);
      setToken(d.uploadToken);
      setNeedsPass(Boolean(d.needsPassphrase));
      if (d.summary) setSummary(d.summary);
    };
    xhr.onerror = () => {
      setProgress(null);
      setErr('Upload failed: the connection dropped');
    };
    xhr.send(f);
  };

  const check = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      setSummary((await api.post<{ summary: Summary }>('/api/archives/check', { uploadToken: token, passphrase: pass })).summary);
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : 'Could not open the archive');
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    setBusy(true);
    setErr(null);
    try {
      onImported(await api.post<ImportResult>('/api/archives/import', { uploadToken: token, passphrase: pass }));
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : 'Import failed');
      setBusy(false);
    }
  };

  const total = (c: Record<string, number>, k: string) => c[k] ?? 0;
  return (
    <div className="import-room form">
      {!file || (!token && progress === null && err) ? (
        <div className="drop-zone" role="button" tabIndex={0} onClick={() => picker.current?.click()} onKeyDown={(e) => e.key === 'Enter' && picker.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files[0];
            if (f) upload(f);
          }}
        >
          {Icons.download}
          <span>
            <strong>Choose a .warroom archive</strong> — or drop it here
          </span>
        </div>
      ) : (
        <div className="small">
          <strong>{file.name}</strong> <span className="muted">({humanSize(file.size)})</span>
        </div>
      )}
      <input ref={picker} type="file" accept=".warroom,application/octet-stream" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      {progress !== null && (
        <div className="progress" aria-label="Upload progress">
          <div style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      {token && needsPass && !summary && (
        <form className="form" onSubmit={check}>
          <label>
            This archive is encrypted. Passphrase
            <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoFocus />
          </label>
          <button className="btn secondary" disabled={busy || !pass}>
            {busy ? 'Checking…' : 'Unlock'}
          </button>
        </form>
      )}
      {summary && (
        <div className="import-summary">
          <div>
            <span className="mono muted">{summary.incident.key}</span> <strong>{summary.incident.title}</strong>
          </div>
          <div className="muted small">
            Exported {summary.exportedAt.slice(0, 16).replace('T', ' ')} UTC from {summary.source}
          </div>
          <div className="small">
            {total(summary.counts, 'messages')} messages · {total(summary.counts, 'timeline')} timeline entries · {total(summary.counts, 'sheets')} sheets ·{' '}
            {total(summary.counts, 'notes')} notes · {summary.files} files · {summary.people} people
          </div>
          <p className="hint">
            It becomes a new room here with the next incident number. People are matched by username or email; anyone not found is added (guests come back
            without access).
          </p>
          <button className="btn primary" onClick={doImport} disabled={busy}>
            {busy ? 'Restoring…' : `Restore ${summary.incident.key}`}
          </button>
        </div>
      )}
      {err && <div className="alert error">{err}</div>}
    </div>
  );
}

export function ImportRoomDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Restore a room from an archive" onClose={onClose}>
      <ImportRoom onImported={(r) => (location.href = `/incidents/${r.incidentId}`)} />
    </Modal>
  );
}

/** Quick War Rooms are temporary: keep reminding people to export before teardown. */
export function QuickBanner({ onExport }: { onExport?: () => void }) {
  return (
    <div className="quick-banner" role="note">
      <span>
        <strong>Temporary War Room.</strong> This server is meant to be torn down after the incident. Export rooms before that happens.
      </span>
      {onExport && (
        <button className="btn secondary sm" onClick={onExport}>
          {Icons.download} Export this room
        </button>
      )}
    </div>
  );
}
