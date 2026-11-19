import type { FileItem } from '../types';

export interface UploadTarget {
  source: 'chat' | 'note' | 'evidence';
  channelId?: string;
  noteId?: string;
  description?: string;
}

/** Name pasted screenshots something readable instead of "image.png". */
export function nameFor(file: File) {
  if (file.name && file.name !== 'image.png' && file.name !== 'blob') return file.name;
  const ts = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const ext = file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
  return `screenshot-${ts}.${ext}`;
}

/**
 * Upload one file as raw bytes (application/octet-stream, so no body parser touches it). Uses XHR
 * for progress. Resolves with the stored file; rejects with a readable message.
 */
export function uploadFile(incidentId: string, file: File, target: UploadTarget, onProgress?: (fraction: number) => void): Promise<FileItem> {
  const qs = new URLSearchParams({ source: target.source, name: nameFor(file) });
  if (target.channelId) qs.set('channelId', target.channelId);
  if (target.noteId) qs.set('noteId', target.noteId);
  if (target.description) qs.set('description', target.description);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/incidents/${incidentId}/files?${qs}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    if (file.type) xhr.setRequestHeader('X-File-Type', file.type);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data: { file?: FileItem; error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300 && data.file) resolve(data.file);
      else reject(new Error(data.error ?? (xhr.status === 413 ? 'That file is too large' : `Upload failed (${xhr.status})`)));
    };
    xhr.onerror = () => reject(new Error('Upload failed: the connection dropped'));
    xhr.send(file);
  });
}

export const humanSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;

/** Files from a paste or drop event, if any. */
export function filesFrom(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  if (dt.files?.length) return [...dt.files];
  return [...(dt.items ?? [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter((f): f is File => Boolean(f));
}
