import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';

/**
 * Integration credentials are encrypted at rest with AES-256-GCM.
 * Set INTEGRATIONS_KEY so rotating SESSION_SECRET doesn't make stored credentials unreadable.
 */
const key = createHash('sha256')
  .update(process.env.INTEGRATIONS_KEY || `warroom-integrations:${config.sessionSecret}`)
  .digest();

export function encryptSecret(plain: Record<string, string>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

export function decryptSecret(blob: string | null): Record<string, string> {
  if (!blob) return {};
  const [v, iv, tag, data] = blob.split('.');
  if (v !== 'v1') throw new Error('unknown secret format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const out = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]);
  return JSON.parse(out.toString('utf8'));
}
