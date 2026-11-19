import nodemailer, { type Transporter } from 'nodemailer';
import { config, smtpEnabled } from './config.js';
import { onSettingsChanged } from './settings.js';

let transport: Transporter | null = null;
onSettingsChanged(() => {
  transport?.close();
  transport = null;
});
function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      // Without implicit TLS, insist on STARTTLS so codes never cross the network in clear text.
      requireTLS: !config.smtp.secure && !config.smtp.allowPlain,
      ignoreTLS: config.smtp.allowPlain && !config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }
  return transport;
}

/** Development only: the last messages "sent" when no SMTP server is configured. */
export const devOutbox: { to: string; subject: string; text: string; at: string }[] = [];

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Send an email. Without SMTP in development, the message is kept in a dev outbox and printed to
 * the server log instead; in production it fails.
 */
export async function sendMail(m: Mail) {
  if (!smtpEnabled()) {
    if (config.production) throw new Error('Email is not set up (Admin → Settings → Email)');
    devOutbox.unshift({ ...m, at: new Date().toISOString() });
    devOutbox.length = Math.min(devOutbox.length, 20);
    console.log(`[mail:dev] to=${m.to} subject="${m.subject}"\n${m.text}`);
    return { dev: true };
  }
  await getTransport().sendMail({ from: config.smtp.from, to: m.to, subject: m.subject, text: m.text, html: m.html });
  return { dev: false };
}

export const mailStatus = () => ({
  configured: smtpEnabled(),
  host: config.smtp.host || null,
  port: config.smtp.port,
  from: config.smtp.from || null,
  tls: config.smtp.secure ? 'implicit TLS' : config.smtp.allowPlain ? 'none (test only)' : 'STARTTLS required',
  requireEmail: smtpEnabled() && config.guestRequireEmail,
  devOutbox: !smtpEnabled() && !config.production,
});

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The guest sign-in code email. Deliberately plain: no links, so it can't be used to phish. */
export function guestCodeMail(o: { to: string; code: string; incidentKey: string; invitedBy: string; minutes: number }): Mail {
  const text = [
    `Your War Room sign-in code for ${o.incidentKey} is:`,
    '',
    `    ${o.code}`,
    '',
    `It expires in ${o.minutes} minutes and works once. ${o.invitedBy} invited you to this incident.`,
    '',
    "If you didn't just open a War Room invite link, ignore this email and tell the person who invited you.",
  ].join('\n');
  const html = `<div style="font-family:system-ui,Segoe UI,sans-serif;font-size:15px;color:#111">
<p>Your War Room sign-in code for <strong>${esc(o.incidentKey)}</strong> is:</p>
<p style="font-family:Consolas,monospace;font-size:28px;letter-spacing:6px;font-weight:700;margin:16px 0">${esc(o.code)}</p>
<p>It expires in ${o.minutes} minutes and works once. ${esc(o.invitedBy)} invited you to this incident.</p>
<p style="color:#666;font-size:13px">If you didn't just open a War Room invite link, ignore this email and tell the person who invited you.</p>
</div>`;
  return { to: o.to, subject: `${o.code} is your War Room code for ${o.incidentKey}`, text, html };
}
