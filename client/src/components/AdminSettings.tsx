import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useApp } from '../lib/app';
import { Icons, Modal } from './ui';

type Kind = 'string' | 'url' | 'number' | 'bool' | 'enum' | 'list' | 'text' | 'secret';
interface FieldView {
  key: string;
  kind: Kind;
  label: string;
  help?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  showIf?: { key: string; in: string[] };
  source: 'saved' | 'environment' | 'default';
  readOnly: string | null;
  value?: unknown;
  isSet?: boolean;
}
interface SectionView {
  id: string;
  label: string;
  description: string;
  status: 'on' | 'off' | 'incomplete';
  info: { label: string; value: string; showIf?: { key: string; in: string[] } }[];
  testable: boolean;
  fields: FieldView[];
}
interface SettingsView {
  production: boolean;
  bundledLiveKit: boolean;
  sections: SectionView[];
}

const STATUS_TEXT = { on: 'On', off: 'Off', incomplete: 'Incomplete' } as const;

/** Draft value for a field as the form holds it (lists as text, secrets as "" = keep). */
const toDraft = (f: FieldView): unknown =>
  f.kind === 'secret' ? '' : f.kind === 'list' ? ((f.value as string[]) ?? []).join(', ') : f.kind === 'number' ? String(f.value ?? '') : f.value ?? '';

export function AdminSettings({ onChanged }: { onChanged?: () => void }) {
  const { toast } = useApp();
  const [view, setView] = useState<SettingsView | null>(null);
  const [params, setParams] = useSearchParams();
  const sectionId = params.get('section') ?? 'general';

  useEffect(() => {
    api.get<SettingsView>('/api/admin/settings').then(setView).catch((e) => toast({ text: e instanceof Error ? e.message : 'Could not load settings', tone: 'error' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!view) return <div className="skeleton" />;
  const section = view.sections.find((s) => s.id === sectionId) ?? view.sections[0];

  return (
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">
        {view.sections.map((s) => (
          <button key={s.id} className={s.id === section.id ? 'on' : ''} onClick={() => setParams({ tab: 'settings', section: s.id })}>
            <span>{s.label}</span>
            {s.id !== 'general' && <span className={`dot dot-${s.status}`} title={STATUS_TEXT[s.status]} />}
          </button>
        ))}
      </nav>
      <SectionForm
        key={section.id}
        section={section}
        view={view}
        onSaved={(v) => {
          setView(v);
          onChanged?.();
        }}
      />
    </div>
  );
}

function SectionForm({ section, view, onSaved }: { section: SectionView; view: SettingsView; onSaved: (v: SettingsView) => void }) {
  const { toast } = useApp();
  const initial = useMemo(() => Object.fromEntries(section.fields.map((f) => [f.key, toDraft(f)])), [section]);
  const [draft, setDraft] = useState<Record<string, unknown>>(initial);
  const [clear, setClear] = useState<string[]>([]);
  const [busy, setBusy] = useState<'save' | 'test' | 'reset' | 'token' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);

  const dirty = clear.length > 0 || section.fields.some((f) => (f.kind === 'secret' ? draft[f.key] !== '' : draft[f.key] !== initial[f.key]));
  const set = (k: string, v: unknown) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setResult(null);
  };
  const visible = (f: FieldView) => !f.showIf || f.showIf.in.includes(String(draft[f.showIf.key]));

  const payload = () => {
    const values: Record<string, unknown> = {};
    for (const f of section.fields) {
      if (f.readOnly) continue;
      const v = draft[f.key];
      if (f.kind === 'secret') {
        if (v) values[f.key] = v;
      } else if (f.kind === 'number') values[f.key] = Number(v);
      else if (f.kind === 'list') values[f.key] = String(v ?? '').split(/[\s,;]+/).filter(Boolean);
      else values[f.key] = v;
    }
    return { values, clear };
  };

  const save = async () => {
    setBusy('save');
    try {
      const r = await api.put<SettingsView & { saved: number }>(`/api/admin/settings/${section.id}`, payload());
      toast({ text: r.saved ? `${section.label} saved. It’s in effect now.` : 'Nothing changed' }, 4000);
      onSaved(r);
    } catch (e) {
      toast({ text: e instanceof ApiError ? e.message : 'Could not save', tone: 'error' }, 8000);
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy('test');
    setResult(null);
    try {
      setResult(await api.post<{ ok: boolean; message: string }>(`/api/admin/settings/${section.id}/test`, payload()));
    } catch (e) {
      setResult({ ok: false, message: e instanceof ApiError ? e.message : 'Test failed' });
    } finally {
      setBusy(null);
    }
  };

  const reset = async () => {
    setBusy('reset');
    try {
      onSaved(await api.post<SettingsView>(`/api/admin/settings/${section.id}/reset`));
      toast({ text: `${section.label} reset` }, 3000);
      setConfirmReset(false);
    } finally {
      setBusy(null);
    }
  };

  const generateToken = async () => {
    setBusy('token');
    try {
      const r = await api.post<{ token: string; view: SettingsView }>('/api/admin/settings/scim/token');
      setNewToken(r.token);
      onSaved(r.view);
    } finally {
      setBusy(null);
    }
  };

  const anySaved = section.fields.some((f) => f.source === 'saved' && !f.readOnly);

  return (
    <section className="settings-panel">
      <header className="settings-head">
        <div>
          <h2>{section.label}</h2>
          <p className="muted small">{section.description}</p>
        </div>
        {section.id !== 'general' && <span className={`status ${section.status === 'on' ? 'status-monitoring' : section.status === 'incomplete' ? 'status-investigating' : 'status-resolved'}`}>{STATUS_TEXT[section.status]}</span>}
      </header>

      {section.id === 'voice' && view.bundledLiveKit && (
        <div className="alert info">
          <div>War Room is running with its own LiveKit server, so the API key pair is created and shared with it automatically.</div>
        </div>
      )}

      {section.info.length > 0 && (
        <div className="settings-info">
          <div className="muted small">Copy these into your identity provider</div>
          {section.info.filter((i) => !i.showIf || i.showIf.in.includes(String(draft[i.showIf.key]))).map((i) => (
            <CopyRow key={i.label} label={i.label} value={i.value} />
          ))}
        </div>
      )}

      <form
        className="form settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty) void save();
        }}
      >
        {section.fields.filter(visible).map((f) =>
          section.id === 'scim' && f.key === 'scim.token' ? (
            <div key={f.key} className="setting-field">
              <div className="setting-label">
                {f.label} <SourceTag f={f} />
              </div>
              <div className="row gap-sm">
                <span className={f.isSet ? 'ok-text small' : 'muted small'}>{f.isSet ? '✓ A token is set' : 'No token yet: provisioning is off'}</span>
                <button type="button" className="btn secondary sm" onClick={generateToken} disabled={busy !== null}>
                  {f.isSet ? 'Generate a new token' : 'Generate token'}
                </button>
              </div>
              {f.isSet && <div className="muted small">A new token replaces the old one at once; update your identity provider straight after.</div>}
              {f.help && <div className="muted small">{f.help}</div>}
            </div>
          ) : (
            <Field
              key={f.key}
              f={f}
              value={draft[f.key]}
              cleared={clear.includes(f.key)}
              onChange={(v) => set(f.key, v)}
              onClear={(on) => {
                setClear((c) => (on ? [...c, f.key] : c.filter((k) => k !== f.key)));
                setResult(null);
              }}
            />
          ),
        )}

        {result && <div className={`alert ${result.ok ? 'info' : 'error'}`}>{result.ok ? '✓ ' : ''}{result.message}</div>}

        {section.id !== 'scim' && (
          <div className="settings-actions">
            {anySaved && (
              <button type="button" className="btn ghost sm" onClick={() => setConfirmReset(true)} disabled={busy !== null}>
                Reset to defaults
              </button>
            )}
            <span className="grow" />
            {section.testable && (
              <button type="button" className="btn secondary" onClick={test} disabled={busy !== null}>
                {busy === 'test' ? 'Testing…' : dirty ? 'Test these values' : 'Test'}
              </button>
            )}
            {dirty && (
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  setDraft(initial);
                  setClear([]);
                  setResult(null);
                }}
                disabled={busy !== null}
              >
                Discard
              </button>
            )}
            <button className="btn primary" disabled={!dirty || busy !== null}>
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </form>

      {confirmReset && (
        <Modal
          title={`Reset ${section.label}?`}
          onClose={() => setConfirmReset(false)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setConfirmReset(false)}>
                Cancel
              </button>
              <button className="btn danger" onClick={reset} disabled={busy !== null}>
                Reset
              </button>
            </>
          }
        >
          <p>Everything saved in this section is removed, and the defaults apply straight away. Saved secrets are deleted.</p>
        </Modal>
      )}

      {newToken && (
        <Modal
          title="New SCIM token"
          onClose={() => setNewToken(null)}
          footer={
            <button className="btn primary" onClick={() => setNewToken(null)}>
              I’ve copied it
            </button>
          }
        >
          <p className="small">This is the only time the token is shown. Paste it into your identity provider’s provisioning settings as the bearer token (API token).</p>
          <CopyRow label="Bearer token" value={newToken} />
        </Modal>
      )}
    </section>
  );
}

function SourceTag({ f }: { f: FieldView }) {
  if (f.source === 'environment') return <span className="tag" title="Comes from a server environment variable. Saving here overrides it.">from environment</span>;
  return null;
}

function Field({
  f,
  value,
  cleared,
  onChange,
  onClear,
}: {
  f: FieldView;
  value: unknown;
  cleared: boolean;
  onChange: (v: unknown) => void;
  onClear: (on: boolean) => void;
}) {
  const id = `set-${f.key}`;
  const disabled = Boolean(f.readOnly);
  const help = f.readOnly ?? f.help;

  if (f.kind === 'bool') {
    return (
      <div className="setting-field">
        <label className="check">
          <input type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
          <span>
            {f.label} <SourceTag f={f} />
          </span>
        </label>
        {help && <div className="muted small setting-help">{help}</div>}
      </div>
    );
  }

  let input;
  if (f.kind === 'enum') {
    input = (
      <select id={id} value={String(value)} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {f.options!.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  } else if (f.kind === 'text') {
    input = <textarea id={id} rows={6} className="mono" value={String(value ?? '')} placeholder={f.placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} spellCheck={false} />;
  } else if (f.kind === 'secret') {
    input = (
      <div className="row gap-sm">
        <input
          id={id}
          type="password"
          autoComplete="new-password"
          value={String(value ?? '')}
          disabled={disabled || cleared}
          placeholder={cleared ? 'Will be removed when you save' : f.isSet ? '•••••••• saved; type to replace' : 'Not set'}
          onChange={(e) => onChange(e.target.value)}
        />
        {f.isSet && !disabled && (
          <button type="button" className="btn ghost sm" onClick={() => onClear(!cleared)}>
            {cleared ? 'Keep' : 'Remove'}
          </button>
        )}
      </div>
    );
  } else {
    input = (
      <input
        id={id}
        type={f.kind === 'number' ? 'number' : 'text'}
        min={f.min}
        max={f.max}
        inputMode={f.kind === 'url' ? 'url' : undefined}
        value={String(value ?? '')}
        placeholder={f.placeholder}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  return (
    <div className="setting-field">
      <label htmlFor={id} className="setting-label">
        {f.label} <SourceTag f={f} />
      </label>
      {input}
      {help && <div className="muted small setting-help">{help}</div>}
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-row">
      <span className="muted small">{label}</span>
      <code className="mono">{value}</code>
      <button
        type="button"
        className="btn ghost sm"
        onClick={() => {
          void navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? 'Copied' : Icons.link}
      </button>
    </div>
  );
}
