import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useApp } from '../lib/app';
import { getSocket } from '../lib/socket';
import { utcTime } from '../lib/format';
import { filesFrom, humanSize, uploadFile } from '../lib/upload';
import type { FileItem, IncidentState } from '../types';
import { Icons, Modal } from './ui';

const shortHash = (h: string) => `${h.slice(0, 12)}…`;

const FileViewer = lazy(() => import('./FileViewer'));

/** Opens the in-app viewer (loaded on first use, so PDF and Word support don't slow the app down). */
export function Viewer({ file, onClose }: { file: FileItem; onClose: () => void }) {
  return (
    <Suspense fallback={<div className="viewer"><div className="viewer-msg">Opening…</div></div>}>
      <FileViewer file={file} onClose={onClose} />
    </Suspense>
  );
}

/** Attachments under a chat message: image thumbnails and file cards. */
export function Attachments({ files }: { files: FileItem[] }) {
  const [open, setOpen] = useState<FileItem | null>(null);
  if (!files.length) return null;
  return (
    <div className="attachments">
      {files.map((f) =>
        f.deleted ? (
          <div key={f.id} className="file-card deleted">
            <span className="muted small">
              {f.name} was deleted{f.deletedByName ? ` by ${f.deletedByName}` : ''}
            </span>
          </div>
        ) : f.image ? (
          <button key={f.id} className="thumb" onClick={() => setOpen(f)} title={`${f.name} · ${humanSize(f.size)}`}>
            <img src={f.url} alt={f.name} loading="lazy" />
          </button>
        ) : (
          <div key={f.id} className="file-card" title={`SHA-256 ${f.sha256}`}>
            <span className="file-icon">{Icons.paperclip}</span>
            {f.preview ? (
              <button className="grow file-open" onClick={() => setOpen(f)} title="View in War Room">
                <span className="file-name">{f.name}</span>
                <span className="muted small mono">
                  {humanSize(f.size)} · {shortHash(f.sha256)} · <span className="accent-text">View</span>
                </span>
              </button>
            ) : (
              <span className="grow">
                <span className="file-name">{f.name}</span>
                <span className="muted small mono">
                  {humanSize(f.size)} · {shortHash(f.sha256)}
                </span>
              </span>
            )}
            <a className="icon-btn sm" href={`${f.url}?download`} title="Download" aria-label={`Download ${f.name}`}>
              {Icons.download}
            </a>
          </div>
        ),
      )}
      {open && <Viewer file={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** Everything uploaded in this incident: evidence, chat attachments and note images, with hashes. */
export function FilesView({ state, onOpenChannel, onOpenNote }: { state: IncidentState; onOpenChannel: (id: string) => void; onOpenNote: (id: string) => void }) {
  const { toast, me } = useApp();
  const incidentId = state.incident.id;
  const [files, setFiles] = useState<FileItem[] | null>(null);
  const [filter, setFilter] = useState('');
  const [kind, setKind] = useState<'all' | 'evidence' | 'images'>('all');
  const [pending, setPending] = useState<File[]>([]);
  const [description, setDescription] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [open, setOpen] = useState<FileItem | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<FileItem | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api.get<{ files: FileItem[] }>(`/api/incidents/${incidentId}/files`).then((r) => setFiles(r.files));
  }, [incidentId]);
  useEffect(() => {
    load();
    const s = getSocket();
    const on = (e: { incidentId: string }) => e.incidentId === incidentId && load();
    s.on('files:update', on);
    return () => {
      s.off('files:update', on);
    };
  }, [incidentId, load]);

  const upload = async () => {
    const list = pending;
    for (let i = 0; i < list.length; i++) {
      try {
        setProgress(i / list.length);
        await uploadFile(incidentId, list[i], { source: 'evidence', description: description.trim() }, (p) => setProgress((i + p) / list.length));
      } catch (e) {
        toast({ text: `${list[i].name}: ${e instanceof Error ? e.message : 'upload failed'}`, tone: 'error' }, 8000);
      }
    }
    setProgress(null);
    setPending([]);
    setDescription('');
    load();
  };

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (files ?? []).filter(
      (x) =>
        (kind === 'all' || (kind === 'evidence' ? x.source === 'evidence' : x.image)) &&
        (!f || x.name.toLowerCase().includes(f) || x.sha256.startsWith(f) || x.description.toLowerCase().includes(f) || (x.uploadedByName ?? '').toLowerCase().includes(f)),
    );
  }, [files, filter, kind]);

  const where = (f: FileItem) => {
    if (f.source === 'evidence') return <span className="muted">Evidence</span>;
    if (f.channelId) {
      const ch = state.channels.find((c) => c.id === f.channelId);
      return ch ? (
        <button className="link-btn" onClick={() => onOpenChannel(ch.id)}>
          #{ch.name}
        </button>
      ) : (
        <span className="muted">channel</span>
      );
    }
    const n = state.notes.find((x) => x.id === f.noteId);
    return n ? (
      <button className="link-btn" onClick={() => onOpenNote(n.id)}>
        {n.name}
      </button>
    ) : (
      <span className="muted">note</span>
    );
  };

  const copy = (t: string) => {
    void navigator.clipboard.writeText(t);
    toast({ text: 'SHA-256 copied' }, 1500);
  };

  return (
    <div
      className={`files-view ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const list = filesFrom(e.dataTransfer);
        if (list.length) setPending((p) => [...p, ...list]);
      }}
    >
      <div className="view-head">
        <h2>
          {Icons.folder} Files
        </h2>
        <span className="muted small">Evidence, screenshots and attachments in {state.incident.key}. Each file’s SHA-256 is recorded when it’s uploaded.</span>
      </div>

      <div className="files-body">
        <section className="evidence-upload">
          <div className="drop-zone" onClick={() => picker.current?.click()} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && picker.current?.click()}>
            {Icons.paperclip}
            <span>
              <strong>Add evidence</strong> — drop files here or click to choose
            </span>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                setPending((p) => [...p, ...[...(e.target.files ?? [])]]);
                e.target.value = '';
              }}
            />
          </div>
          {pending.length > 0 && (
            <div className="pending-evidence">
              {pending.map((f, i) => (
                <div key={i} className="pending-row">
                  <span className="grow">{f.name}</span>
                  <span className="muted small mono">{humanSize(f.size)}</span>
                  <button className="icon-btn sm" aria-label={`Remove ${f.name}`} onClick={() => setPending((p) => p.filter((_, j) => j !== i))} disabled={progress !== null}>
                    ×
                  </button>
                </div>
              ))}
              <label>
                What is it? <span className="muted">(optional, goes on the timeline)</span>
                <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} placeholder="Phishing email as received by jdoe, exported from Outlook" />
              </label>
              <div className="row">
                {progress !== null && (
                  <div className="progress grow" aria-label="Upload progress">
                    <div style={{ width: `${Math.round(progress * 100)}%` }} />
                  </div>
                )}
                <div className="spacer" />
                <button className="btn primary" onClick={upload} disabled={progress !== null}>
                  {progress !== null ? 'Uploading…' : `Upload ${pending.length} file${pending.length === 1 ? '' : 's'}`}
                </button>
              </div>
            </div>
          )}
          <p className="hint">
            Downloads are never opened in the browser (except recognised images). Treat every file as untrusted. Put malware samples in a password-protected archive
            before uploading.
          </p>
        </section>

        <div className="files-toolbar">
          <div className="seg">
            <button className={kind === 'all' ? 'on' : ''} onClick={() => setKind('all')}>
              All
            </button>
            <button className={kind === 'evidence' ? 'on' : ''} onClick={() => setKind('evidence')}>
              Evidence
            </button>
            <button className={kind === 'images' ? 'on' : ''} onClick={() => setKind('images')}>
              Images
            </button>
          </div>
          <input placeholder="Filter by name, hash, description or person" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <span className="muted small">{shown.length} files</span>
        </div>

        {files === null ? (
          <div className="skeleton" />
        ) : shown.length === 0 ? (
          <div className="empty sm">{files.length ? 'Nothing matches.' : 'No files yet. Screenshots pasted into chat show up here too.'}</div>
        ) : (
          <div className="result-table-wrap">
            <table className="table files-table">
              <thead>
                <tr>
                  <th />
                  <th>File</th>
                  <th>Size</th>
                  <th>SHA-256</th>
                  <th>Uploaded (UTC)</th>
                  <th>By</th>
                  <th>Where</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((f) => (
                  <tr key={f.id} className={f.deleted ? 'deleted' : ''}>
                    <td className="file-thumb-cell">
                      {f.image && !f.deleted ? (
                        <button className="thumb sm" onClick={() => setOpen(f)}>
                          <img src={f.url} alt="" loading="lazy" />
                        </button>
                      ) : (
                        <span className="file-icon">{Icons.paperclip}</span>
                      )}
                    </td>
                    <td>
                      {f.deleted ? (
                        <span className="muted">{f.name}</span>
                      ) : f.preview ? (
                        <button className="link-btn file-name" onClick={() => setOpen(f)} title="View in War Room">
                          {f.name}
                        </button>
                      ) : (
                        <a href={`${f.url}?download`} className="file-name" title="Download">
                          {f.name}
                        </a>
                      )}
                      {f.description && <div className="muted small">{f.description}</div>}
                      {f.deleted && <div className="danger-text small">Deleted by {f.deletedByName ?? '—'} {f.deletedAt ? `${utcTime(f.deletedAt, true).slice(0, 16)}Z` : ''}</div>}
                    </td>
                    <td className="mono small">{humanSize(f.size)}</td>
                    <td>
                      <button className="hash-btn mono small" title={`${f.sha256} (click to copy)`} onClick={() => copy(f.sha256)}>
                        {shortHash(f.sha256)}
                      </button>
                    </td>
                    <td className="mono small">{utcTime(f.uploadedAt, true).slice(0, 16)}</td>
                    <td className="small">{f.uploadedByName ?? '—'}</td>
                    <td className="small">{where(f)}</td>
                    <td className="row-actions">
                      {!f.deleted && (
                        <a className="icon-btn sm" href={`${f.url}?download`} title="Download" aria-label={`Download ${f.name}`}>
                          {Icons.download}
                        </a>
                      )}
                      {!f.deleted && (f.uploadedBy === me.id || state.canControl) && (
                        <button className="icon-btn sm" title="Delete file" aria-label={`Delete ${f.name}`} onClick={() => setConfirmDelete(f)}>
                          {Icons.trash}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {dragging && <div className="drop-overlay">Drop to add as evidence</div>}
      {open && <Viewer file={open} onClose={() => setOpen(null)} />}
      {confirmDelete && (
        <Modal
          title={`Delete ${confirmDelete.name}?`}
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={async () => {
                  try {
                    await api.del(`/api/files/${confirmDelete.id}`);
                  } catch (e) {
                    toast({ text: e instanceof ApiError ? e.message : 'Delete failed', tone: 'error' }, 6000);
                  }
                  setConfirmDelete(null);
                }}
              >
                Delete file
              </button>
            </>
          }
        >
          <p>The file is removed from the server. Its name, size, SHA-256 and who deleted it stay on the list and the timeline.</p>
        </Modal>
      )}
    </div>
  );
}
