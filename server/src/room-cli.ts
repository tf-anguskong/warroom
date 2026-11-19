/**
 * Room archives from the command line (used by scripts/warroom-now.sh before a server is torn down).
 *
 *   room-cli list
 *   room-cli export --all --out /exports            (encrypted with $WARROOM_EXPORT_PASSPHRASE)
 *   room-cli export --incident INC-0003 --out /exports
 *   room-cli export --all --out /exports --plain    (no encryption; only if you must)
 *   room-cli import /path/to/room.warroom           (passphrase from $WARROOM_EXPORT_PASSPHRASE)
 *
 * In the Docker image: node server/dist/room-cli.js …
 */
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { applySettings } from './settings.js';
import { q } from './db.js';
import { exportRoom, importRoom } from './archive.js';

applySettings();
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const passphrase = process.env.WARROOM_EXPORT_PASSPHRASE ?? '';
const key = (n: number) => `INC-${String(n).padStart(4, '0')}`;
const fail = (msg: string) => {
  console.error(`error: ${msg}`);
  process.exit(1);
};

const incidents = () =>
  q.all<{ id: string; number: number; title: string; status: string; created_at: string }>('SELECT id, number, title, status, created_at FROM incidents ORDER BY number');

if (cmd === 'list') {
  for (const i of incidents()) console.log(`${key(i.number)}  ${i.status.padEnd(13)}  ${i.title}`);
  process.exit(0);
}

if (cmd === 'export') {
  const out = resolve(opt('out') ?? './exports');
  const plain = flag('plain');
  if (!plain && passphrase.length < 10) fail('set WARROOM_EXPORT_PASSPHRASE (at least 10 characters), or pass --plain for an unencrypted export');
  const wanted = opt('incident');
  const list = flag('all') ? incidents() : incidents().filter((i) => key(i.number) === wanted?.toUpperCase());
  if (!list.length) fail(flag('all') ? 'there are no rooms to export' : `no room ${wanted ?? '(use --all or --incident INC-0001)'}`);
  mkdirSync(out, { recursive: true });
  const lines: string[] = [];
  for (const i of list) {
    const a = await exportRoom(i.id, { passphrase: plain ? undefined : passphrase, by: null });
    const dest = join(out, a.name);
    copyFileSync(a.path, dest);
    rmSync(a.path, { force: true });
    lines.push(`${a.sha256}  ${a.name}`);
    console.log(`${key(i.number)}  →  ${dest}  (${(a.size / 1048576).toFixed(1)} MB, ${a.encrypted ? 'encrypted' : 'NOT encrypted'})`);
  }
  // Checksums next to the archives, to verify the copies later (sha256sum -c SHA256SUMS).
  writeFileSync(join(out, 'SHA256SUMS'), `${lines.join('\n')}\n`, { flag: 'a' });
  process.exit(0);
}

if (cmd === 'import') {
  const file = args[1];
  if (!file) fail('give the archive file to import');
  const r = await importRoom(resolve(file), { passphrase: passphrase || undefined, by: null }).catch((e: Error) => fail(e.message));
  if (r) {
    console.log(`Imported ${r.originalKey} as ${r.key}: ${r.title}  (${r.people.matched} people matched, ${r.people.created} added, ${r.files} files)`);
    for (const w of r.warnings) console.log(`note: ${w}`);
  }
  process.exit(0);
}

console.log('usage: room-cli list | export (--all | --incident INC-0001) --out DIR [--plain] | import FILE');
process.exit(cmd ? 1 : 0);
