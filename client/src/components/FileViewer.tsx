import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import mammoth from 'mammoth/mammoth.browser';
import DOMPurify from 'dompurify';
import { useApp } from '../lib/app';
import { humanSize } from '../lib/upload';
import type { FileItem } from '../types';
import { Icons } from './ui';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Bigger than this and we don't try to render PDFs or Word files in the browser. */
const MAX_RENDER_BYTES = 60 * 1024 * 1024;

const KIND_LABEL: Record<string, string> = { image: 'Image', pdf: 'PDF', docx: 'Word document', text: 'Text' };

/**
 * View a file inside War Room without downloading it: images, PDFs (pdf.js, scripting off),
 * Word .docx (mammoth → sanitised HTML) and text files (logs, CSV, JSON, email). Everything is
 * rendered by our own code from the raw bytes; nothing in the file can run.
 */
export default function FileViewer({ file, onClose }: { file: FileItem; onClose: () => void }) {
  const { toast } = useApp();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const tooBig = (file.preview === 'pdf' || file.preview === 'docx') && file.size > MAX_RENDER_BYTES;

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={`Viewing ${file.name}`}>
      <div className="viewer-bar">
        <span className="file-icon">{file.preview === 'image' ? Icons.eye : Icons.paperclip}</span>
        <strong className="viewer-name" title={file.name}>
          {file.name}
        </strong>
        <span className="muted small">
          {KIND_LABEL[file.preview ?? ''] ?? 'File'} · {humanSize(file.size)}
        </span>
        <button
          className="hash-btn mono small"
          title={`SHA-256 ${file.sha256} (click to copy)`}
          onClick={() => {
            void navigator.clipboard.writeText(file.sha256);
            toast({ text: 'SHA-256 copied' }, 1500);
          }}
        >
          SHA-256 {file.sha256.slice(0, 16)}…
        </button>
        <div className="spacer" />
        <a className="btn ghost sm" href={`${file.url}?download`}>
          {Icons.download} Download
        </a>
        <button className="btn secondary sm" onClick={onClose} autoFocus>
          Close
        </button>
      </div>
      <div className="viewer-body">
        {tooBig ? (
          <div className="viewer-msg">This file is too large to preview here ({humanSize(file.size)}). Download it to open it.</div>
        ) : file.preview === 'image' ? (
          <div className="viewer-image">
            <img src={file.url} alt={file.name} />
          </div>
        ) : file.preview === 'pdf' ? (
          <PdfView file={file} />
        ) : file.preview === 'docx' ? (
          <DocxView file={file} />
        ) : file.preview === 'text' ? (
          <TextView file={file} />
        ) : (
          <div className="viewer-msg">This kind of file can’t be previewed. Download it to open it, and treat it as untrusted.</div>
        )}
      </div>
    </div>
  );
}

async function bytes(file: FileItem, preview = false) {
  const res = await fetch(`${file.url}?${preview ? 'preview' : 'download'}`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(res.status === 410 ? 'This file was deleted.' : `Could not load the file (${res.status}).`);
  return { data: await res.arrayBuffer(), truncated: res.headers.get('X-Preview-Truncated') === '1' };
}

function PdfView({ file }: { file: FileItem }) {
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [page, setPage] = useState(1);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let task: pdfjs.PDFDocumentLoadingTask | null = null;
    let alive = true;
    bytes(file)
      .then(({ data }) => {
        // No eval, no XFA forms, no scripting: pdf.js only draws the pages.
        task = pdfjs.getDocument({ data, isEvalSupported: false, enableXfa: false, disableAutoFetch: true });
        return task.promise;
      })
      .then((d) => alive && setDoc(d))
      .catch((e: Error) => alive && setError(/password/i.test(e.message) ? 'This PDF is password-protected. Download it to open it.' : e.message || 'Could not read this PDF.'));
    return () => {
      alive = false;
      void task?.destroy();
    };
  }, [file]);

  // Which page is in view, for the page counter.
  useEffect(() => {
    const el = box.current;
    if (!el || !doc) return;
    const onScroll = () => {
      const pages = [...el.querySelectorAll<HTMLElement>('.pdf-page')];
      const mid = el.scrollTop + el.clientHeight / 3;
      const idx = pages.findIndex((p) => p.offsetTop + p.offsetHeight > mid);
      setPage(idx === -1 ? pages.length : idx + 1);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [doc]);

  if (error) return <div className="viewer-msg">{error}</div>;
  if (!doc) return <div className="viewer-msg">Loading PDF…</div>;
  const pages = Math.min(doc.numPages, 500);
  return (
    <div className="pdf-view">
      <div className="pdf-tools">
        <span className="small">
          Page {page} of {doc.numPages}
          {doc.numPages > pages && ` (showing the first ${pages})`}
        </span>
        <div className="spacer" />
        <button className="btn ghost sm" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))} aria-label="Zoom out">
          −
        </button>
        <span className="small mono">{Math.round(zoom * 100)}%</span>
        <button className="btn ghost sm" onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))} aria-label="Zoom in">
          +
        </button>
        <button className="btn ghost sm" onClick={() => setZoom(1)}>
          Fit width
        </button>
      </div>
      <div className="pdf-pages" ref={box}>
        {Array.from({ length: pages }, (_, i) => (
          <PdfPage key={i} doc={doc} number={i + 1} zoom={zoom} root={box} />
        ))}
      </div>
    </div>
  );
}

/** One page, drawn when it scrolls near the view (big PDFs stay quick). */
function PdfPage({ doc, number, zoom, root }: { doc: pdfjs.PDFDocumentProxy; number: number; zoom: number; root: React.RefObject<HTMLDivElement> }) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(number <= 2);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const el = holder.current;
    if (!el || visible) return;
    const io = new IntersectionObserver((e) => e[0].isIntersecting && setVisible(true), { root: root.current, rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [visible, root]);

  useEffect(() => {
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    void doc.getPage(number).then((p) => {
      if (cancelled) return;
      const width = (root.current?.clientWidth ?? 900) - 48;
      const base = p.getViewport({ scale: 1 });
      const scale = (Math.min(width, 1100) / base.width) * zoom;
      const vp = p.getViewport({ scale });
      setSize({ w: vp.width, h: vp.height });
      if (!visible || !canvas.current) return;
      const dpr = window.devicePixelRatio || 1;
      const c = canvas.current;
      c.width = Math.floor(vp.width * dpr);
      c.height = Math.floor(vp.height * dpr);
      const ctx = c.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      task = p.render({ canvasContext: ctx, viewport: vp });
      task.promise.catch(() => undefined);
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, number, zoom, visible, root]);

  return (
    <div className="pdf-page" ref={holder} style={size ? { width: size.w, height: size.h } : { minHeight: 400 }} aria-label={`Page ${number}`}>
      {visible && <canvas ref={canvas} style={size ? { width: size.w, height: size.h } : undefined} />}
    </div>
  );
}

function DocxView({ file }: { file: FileItem }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    bytes(file)
      .then(({ data }) => mammoth.convertToHtml({ arrayBuffer: data }))
      .then((r) => {
        if (!alive) return;
        // Mammoth gives plain semantic HTML; sanitise anyway, and make links open safely in a new tab.
        const clean = DOMPurify.sanitize(r.value, {
          FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed'],
          FORBID_ATTR: ['style', 'onerror', 'onload'],
          ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|data:image\/(?:png|jpeg|gif|webp);base64,|#)/i,
        });
        const box = document.createElement('div');
        box.innerHTML = clean;
        box.querySelectorAll('a[href]').forEach((a) => {
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noreferrer noopener');
        });
        setHtml(box.innerHTML);
      })
      .catch((e: Error) => alive && setError(`Could not read this Word document: ${e.message}`));
    return () => {
      alive = false;
    };
  }, [file]);
  if (error) return <div className="viewer-msg">{error}</div>;
  if (html === null) return <div className="viewer-msg">Loading document…</div>;
  return (
    <div className="docx-scroll">
      <div className="docx-page md-body" dangerouslySetInnerHTML={{ __html: html || '<p><em>This document is empty.</em></p>' }} />
      <p className="hint docx-hint">Preview shows text, headings, lists, tables and pictures. Layout, fonts and tracked changes may look different from Word.</p>
    </div>
  );
}

function TextView({ file }: { file: FileItem }) {
  const [text, setText] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [find, setFind] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    bytes(file, true)
      .then(({ data, truncated: t }) => {
        if (!alive) return;
        setText(new TextDecoder('utf-8').decode(data));
        setTruncated(t);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [file]);
  if (error) return <div className="viewer-msg">{error}</div>;
  if (text === null) return <div className="viewer-msg">Loading…</div>;
  const all = text.split('\n');
  const MAX_LINES = 20_000;
  const lines = all.length > MAX_LINES ? all.slice(0, MAX_LINES) : all;
  const q = find.trim().toLowerCase();
  const hits = q ? lines.reduce((n, l) => n + (l.toLowerCase().includes(q) ? 1 : 0), 0) : 0;
  return (
    <div className="text-view">
      <div className="pdf-tools">
        <span className="small">
          {all.length > MAX_LINES ? `First ${MAX_LINES.toLocaleString()} of ${all.length.toLocaleString()} lines` : `${all.length.toLocaleString()} lines`}{truncated ? ` · showing the first ${humanSize(text.length)} of ${humanSize(file.size)}; download for the rest` : ''}
        </span>
        <div className="spacer" />
        <input className="text-find" placeholder="Find in file" value={find} onChange={(e) => setFind(e.target.value)} />
        {q && <span className="small muted">{hits} matching lines</span>}
        <label className="check small">
          <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap lines
        </label>
      </div>
      <div className={`text-lines mono ${wrap ? 'wrap' : ''}`}>
        {lines.map((l, i) => (
          <div key={i} className={`text-line ${q && l.toLowerCase().includes(q) ? 'hit' : ''}`}>
            <span className="ln">{i + 1}</span>
            <span className="lc">{l || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
