import { useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { Modal } from './ui';

export interface SignInCodeInfo {
  kind: 'guest' | 'member';
  forName: string;
  code: string;
  url: string;
  email?: string | null;
  expiresInMinutes: number;
}

/** Ask the server for a new way back in for someone in the room (they dropped off, new device, lost code). */
export function useSignInCode(incidentId: string) {
  const { toast } = useApp();
  const [info, setInfo] = useState<SignInCodeInfo | null>(null);
  const request = (userId: string, name: string) => {
    if (!confirm(`Make a new sign-in code for ${name}? Any earlier code stops working, and for a guest so does their old link.`)) return;
    api
      .post<SignInCodeInfo>(`/api/incidents/${incidentId}/people/${userId}/sign-in-code`)
      .then(setInfo)
      .catch((e) => toast({ text: e instanceof Error ? e.message : 'Couldn’t make a code', tone: 'error' }, 6000));
  };
  // Portal: the ⋯ menu that opens this is hidden until hovered, and that would hide the dialog too.
  const dialog = info && createPortal(<SignInCodeDialog info={info} onClose={() => setInfo(null)} />, document.body);
  return { request, dialog };
}

function SignInCodeDialog({ info, onClose }: { info: SignInCodeInfo; onClose: () => void }) {
  const { toast } = useApp();
  const guest = info.kind === 'guest';
  const copy = (text: string, what: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast({ text: `${what} copied` }, 2000),
      () => toast({ text: `Couldn’t copy; select the ${what.toLowerCase()} and copy it yourself`, tone: 'error' }),
    );
  };
  return (
    <Modal title={`Sign-in code for ${info.forName}`} onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      <div className="form">
        <div className="alert warn">
          <div>
            Shown once. Give it to {info.forName} directly (call, text, chat), not where others can see it. It works once, for {info.expiresInMinutes} minutes, and replaces any
            earlier code.
          </div>
        </div>
        <div className="invite-code">
          <div className="code-big mono">{info.code.replace(/(\d{3})(\d{3})/, '$1 $2')}</div>
        </div>
        {guest ? (
          <>
            <p className="small">
              They open this <strong>new link</strong> and enter the code. Their old link no longer works.
            </p>
            <div className="invite-url">
              <input readOnly value={info.url} onFocus={(e) => e.target.select()} className="mono" aria-label="New guest link" />
              <button className="btn primary" onClick={() => copy(info.url, 'Link')}>
                Copy
              </button>
            </div>
          </>
        ) : (
          <p className="small">
            They go to <span className="mono">{info.url}</span>, choose <strong>I already have a code</strong>, and enter their email
            {info.email ? (
              <>
                {' '}
                (<span className="mono">{info.email}</span>)
              </>
            ) : null}{' '}
            and this code.
          </p>
        )}
      </div>
    </Modal>
  );
}
