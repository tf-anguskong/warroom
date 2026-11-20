// Regenerate the screenshots in docs/images: seeds a throwaway War Room with a fictional incident
// ("Northwind Logistics") and captures each view with headless Chrome.
//   npm run build            (the server serves client/dist)
//   node scripts/capture-showcase.mjs [shot]     e.g. `room` to capture only that one
// Set CHROME to the browser's path if it isn't in the usual place.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { io } = await import(pathToFileURL(join(ROOT, 'node_modules/socket.io-client/build/esm/index.js')).href);
const SCRATCH = mkdtempSync(join(tmpdir(), 'warroom-showcase-'));
const DATA = join(SCRATCH, 'data');
const OUT = join(ROOT, 'docs/images');
const PORT = 3200;
const BASE = `http://localhost:${PORT}`;
const CHROME =
  process.env.CHROME ??
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((p) => existsSync(p));
if (!CHROME) throw new Error('Chrome not found: set CHROME to its path');
const ONLY = process.argv[2]; // optional: capture just one shot by name
rmSync(DATA, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- server ----------
const srv = spawn('node', ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/index.ts', '--port', String(PORT)], {
  cwd: join(ROOT, 'server'),
  env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DATA_DIR: DATA, PUBLIC_URL: BASE },
});
srv.stderr.on('data', (d) => /error/i.test(String(d)) && process.stderr.write(d));
for (let i = 0; i < 80; i++) {
  try {
    if ((await fetch(`${BASE}/healthz`)).ok) break;
  } catch {}
  await wait(250);
}
const client = (cookie) => async (method, path, body) => {
  const res = await fetch(`${BASE}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.getSetCookie().find((c) => /^wr_(session|guest)/.test(c));
  const data = await res.json().catch(() => null);
  if (res.status >= 400) console.warn('!', method, path, res.status, data?.error);
  return { status: res.status, data, cookie: set?.split(';')[0] };
};
const people = {};
const login = async (key, name, email) => {
  const r = await client()('POST', '/auth/dev-login', { name, email });
  const f = client(r.cookie);
  f.cookie = r.cookie;
  f.id = (await f('GET', '/api/me')).data.user.id;
  people[key] = f;
  return f;
};
const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const m = (k) => `<@${people[k].id}>`;

// ---------- people (fictional) ----------
const jordan = await login('jordan', 'Jordan Reyes', 'jordan.reyes@northwind.example'); // first user: admin
await login('priya', 'Priya Shah', 'priya.shah@northwind.example');
await login('marcus', 'Marcus Chen', 'marcus.chen@northwind.example');
await login('elena', 'Elena Volkova', 'elena.volkova@northwind.example');
await login('sam', 'Sam Okafor', 'sam.okafor@northwind.example');
await login('aisha', 'Aisha Bello', 'aisha.bello@northwind.example');
await login('dev', 'Devon Park', 'devon.park@northwind.example');
const P = people;

// ---------- other incidents for the dashboard ----------
const mk = async (who, title, severity, summary, status) => {
  const inc = (await who('POST', '/api/incidents', { title, severity, summary, templates: ['actions'] })).data;
  if (status) await who('PATCH', `/api/incidents/${inc.id}`, { status });
  return inc;
};
await mk(P.aisha, 'Leaked API key in public repository', 'SEV3', 'A deploy key for the staging CI was pushed to a public GitHub repo. Key revoked; checking for use.', 'resolved');
await mk(P.priya, 'Suspicious OAuth app consent in Entra ID', 'SEV2', 'Three users granted Mail.Read to an unverified multi-tenant app after a phishing email.', 'mitigating');
await mk(P.marcus, 'Phishing campaign impersonating payroll', 'SEV3', 'Credential-harvesting emails sent to ~400 staff. Blocking sender infrastructure and resetting exposed accounts.', 'monitoring');

// ---------- the main incident ----------
const inc = (
  await jordan('POST', '/api/incidents', {
    title: 'Ransomware on finance file servers',
    severity: 'SEV1',
    summary:
      'Files on FIN-FS01 and FIN-FS02 are being encrypted (.lockbit extension). Initial access suspected via a compromised VPN account (j.miller). Both servers isolated at 09:42 UTC; EDR containment on 14 hosts. Backups from 02:00 UTC verified clean. Next: scope lateral movement, confirm no exfiltration, legal/comms decision on notification.',
    templates: ['ioc', 'assets', 'actions', 'comms'],
  })
).data;
const I = inc.id;
for (const k of Object.keys(P)) await P[k]('GET', `/api/incidents/${I}`);
await jordan('PATCH', `/api/incidents/${I}`, { status: 'mitigating' });
await jordan('PUT', `/api/incidents/${I}/roles/commander`, { userId: P.jordan.id });
await jordan('PUT', `/api/incidents/${I}/roles/tech`, { userId: P.priya.id });
await jordan('PUT', `/api/incidents/${I}/roles/comms`, { userId: P.marcus.id });
await jordan('PUT', `/api/incidents/${I}/roles/scribe`, { userId: P.elena.id });
await jordan('PUT', `/api/incidents/${I}/roles/security`, { userId: P.aisha.id });
await jordan('PUT', `/api/incidents/${I}/room-admins/${P.priya.id}`, { admin: true });
const titles = { priya: 'SecOps · Detection engineering', marcus: 'Corporate Communications', elena: 'IR Program', sam: 'Network team · Firewall engineer', aisha: 'Identity & Access', dev: 'Infrastructure · Windows servers', jordan: 'Director, Security Operations' };
{
  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(`${DATA}/warroom.db`);
  for (const [k, t] of Object.entries(titles)) d.prepare('UPDATE users SET title = ? WHERE id = ?').run(t, P[k].id);
  d.close();
}

let st = (await jordan('GET', `/api/incidents/${I}`)).data;
const ch = (name) => st.channels.find((c) => c.name === name);
const main = st.voiceRooms.find((v) => v.kind === 'main');
// A breakout room for containment work (gets its own channel).
await jordan('POST', `/api/incidents/${I}/voice-rooms`, { name: 'Containment' });
await jordan('POST', `/api/incidents/${I}/voice-rooms`, { name: 'Exec briefing' });
st = (await jordan('GET', `/api/incidents/${I}`)).data;
const breakout = st.voiceRooms.find((v) => v.name === 'Containment');
const exec = st.voiceRooms.find((v) => v.name === 'Exec briefing');

// Tasks
const task = (k, t) => jordan('PUT', `/api/incidents/${I}/members/${P[k].id}/task`, { task: t });
await task('priya', 'Hunting for lateral movement from j.miller (4624/4648 across FIN subnet)');
await task('sam', 'Blocking C2 IPs at the perimeter; reviewing VPN logs for j.miller');
await task('dev', 'Restoring FIN-FS01 from 02:00 snapshot to isolated VLAN');
await task('aisha', 'Disabled j.miller; forcing reset for finance admin accounts');
await task('marcus', 'Drafting holding statement for staff and exec team');
await task('elena', 'Keeping the timeline; postmortem prep');
await P.marcus('PUT', `/api/incidents/${I}/away`, { away: true, minutes: 20, note: 'In the exec briefing with legal' });

// Chat
const say = (k, channel, body) => P[k]('POST', `/api/channels/${channel.id}/messages`, { body });
const g = ch('general');
await say('priya', g, `EDR shows the encryptor spawned from \`C:\\ProgramData\\svc\\upd.exe\` on FIN-FS01 at 09:31 UTC. Hash added to the IOC tracker.`);
await say('sam', g, `Blocked 185.220.101.47 and 45.142.212.100 at the edge. Both seen beaconing from FIN-FS02 since 08:55.`);
await say('aisha', g, `j.miller is disabled in Entra and Okta, sessions revoked. The VPN login at 08:12 came from an IP in a country he's never logged in from.`);
await say('jordan', g, `Thanks all. ${m('dev')} what's the ETA on the clean restore of FIN-FS01? Finance close is Friday.`);
await say('dev', g, `Snapshot from 02:00 is verified clean. Restore to the isolated VLAN is ~40 min, then we scan before reconnecting.`);
await say('priya', g, `Found 4648 logons from FIN-FS01 to FIN-APP03 using a service account. Looking now, may need to widen containment. ${m('jordan')}`);
await say('jordan', g, `Agreed. Containing FIN-APP03 now; ${m('sam')} please add it to the isolation group.`);
const dec = ch('decisions');
if (dec) {
  await say('jordan', dec, `**Decision:** isolate FIN-FS01, FIN-FS02 and FIN-APP03 from the network. Finance works from read-only replicas until restore is verified.`);
  await say('marcus', dec, `**Decision:** no external statement yet. Internal holding note to finance staff at 11:00 UTC, legal reviewing.`);
}
const bc = st.channels.find((c) => c.voiceRoomIds?.includes(breakout.id) && c.name !== 'general');
if (bc) {
  await say('sam', bc, `Isolation group updated: FIN-FS01, FIN-FS02, FIN-APP03. Confirmed no traffic leaving those three.`);
  await say('dev', bc, `Restore 60% done.`);
}

// Timeline (backdated)
const tl = (k, minsAgo, text, type = 'note') => P[k]('POST', `/api/incidents/${I}/timeline`, { text, type, ts: at(minsAgo) });
await tl('elena', 95, 'Helpdesk ticket: finance staff report files on \\\\FIN-FS01\\Shared renamed to .lockbit', 'finding');
await tl('priya', 88, 'EDR alert: mass file modification on FIN-FS01 by upd.exe (unsigned)', 'finding');
await tl('sam', 70, 'FIN-FS01 and FIN-FS02 isolated at the switch', 'action');
await tl('aisha', 62, 'j.miller disabled; all sessions revoked in Entra and Okta', 'action');
await tl('priya', 45, 'Lateral movement to FIN-APP03 via svc_finbackup (4648)', 'finding');
await tl('jordan', 40, 'Decision: contain FIN-APP03, finance on read-only replicas', 'decision');
await tl('dev', 25, 'Restore of FIN-FS01 from 02:00 snapshot started on isolated VLAN', 'action');

// Sheets
const fill = async (name, rows) => {
  const sheet = st.sheets.find((s) => s.name === name);
  if (!sheet) return console.warn('no sheet', name);
  let sd = (await jordan('GET', `/api/sheets/${sheet.id}`)).data;
  const need = rows.length - sd.rows.length;
  if (need > 0) await jordan('POST', `/api/sheets/${sheet.id}/rows`, { count: need });
  sd = (await jordan('GET', `/api/sheets/${sheet.id}`)).data;
  const col = (n) => sd.sheet.columns.find((c) => c.name === n)?.id;
  const cells = [];
  rows.forEach((r, i) => Object.entries(r).forEach(([k, v]) => col(k) && cells.push({ rowId: sd.rows[i].id, colId: col(k), value: v })));
  await jordan('PUT', `/api/sheets/${sheet.id}/cells`, { cells });
  return sheet.id;
};
const iocId = await fill('IOC Tracker', [
  { Indicator: '185.220.101.47', Type: 'IP', Status: 'Blocked', 'First seen (UTC)': at(110).slice(0, 16), Source: 'Firewall logs', Owner: P.sam.id, Notes: 'C2 beacon from FIN-FS02' },
  { Indicator: '45.142.212.100', Type: 'IP', Status: 'Blocked', 'First seen (UTC)': at(105).slice(0, 16), Source: 'EDR network events', Owner: P.sam.id, Notes: 'Secondary C2' },
  { Indicator: 'upd.exe  9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', Type: 'Hash', Status: 'Blocked', 'First seen (UTC)': at(88).slice(0, 16), Source: 'EDR', Owner: P.priya.id, Notes: 'Encryptor; blocked tenant-wide' },
  { Indicator: 'update-cdn-sync.net', Type: 'Domain', Status: 'Investigating', 'First seen (UTC)': at(80).slice(0, 16), Source: 'DNS logs', Owner: P.priya.id, Notes: 'Resolves to 45.142.212.100' },
  { Indicator: 'j.miller', Type: 'Account', Status: 'Blocked', 'First seen (UTC)': at(130).slice(0, 16), Source: 'VPN logs', Owner: P.aisha.id, Notes: 'Initial access; disabled' },
  { Indicator: 'svc_finbackup', Type: 'Account', Status: 'Investigating', 'First seen (UTC)': at(45).slice(0, 16), Source: 'Windows 4648', Owner: P.aisha.id, Notes: 'Used for lateral movement' },
]);
await fill('Affected Assets', [
  { Asset: 'FIN-FS01', 'IP / FQDN': 'fin-fs01.corp.northwind.example', 'Asset owner': 'Finance IT', Impact: 'High', Containment: 'Isolated', Assignee: P.dev.id, 'Evidence collected': 'true', Notes: 'Restoring from 02:00 snapshot' },
  { Asset: 'FIN-FS02', 'IP / FQDN': 'fin-fs02.corp.northwind.example', 'Asset owner': 'Finance IT', Impact: 'High', Containment: 'Isolated', Assignee: P.dev.id, 'Evidence collected': 'true', Notes: 'Memory image taken' },
  { Asset: 'FIN-APP03', 'IP / FQDN': 'fin-app03.corp.northwind.example', 'Asset owner': 'ERP team', Impact: 'Medium', Containment: 'Isolated', Assignee: P.priya.id, 'Evidence collected': 'false', Notes: 'No encryption seen yet' },
]);
await fill('Action Items', [
  { Action: 'Restore FIN-FS01 from 02:00 snapshot and scan', Owner: P.dev.id, Priority: 'P1', Status: 'In progress', 'Due (UTC)': at(-30).slice(0, 16) },
  { Action: 'Scope svc_finbackup use across the estate', Owner: P.priya.id, Priority: 'P1', Status: 'In progress' },
  { Action: 'Reset credentials for finance admin accounts', Owner: P.aisha.id, Priority: 'P1', Status: 'Done', Done: 'true' },
  { Action: 'Legal review: notification obligations', Owner: P.marcus.id, Priority: 'P2', Status: 'Not started' },
]);
await fill('Comms Log', [
  { 'Sent (UTC)': at(50).slice(0, 16), Audience: 'Executives', Channel: 'Email + bridge', Summary: 'SEV1 declared, finance file servers affected, contained', 'Sent by': P.marcus.id, Approved: 'true' },
]);

// Notes
const tpls = (await jordan('GET', '/api/note-templates')).data.templates.map((t) => t.key);
const note = (await jordan('POST', `/api/incidents/${I}/notes`, { template: tpls.includes('handoff') ? 'handoff' : 'blank', name: 'Shift handoff' })).data;
const noteId = note.note?.id ?? note.id;
const nv = (await jordan('GET', `/api/notes/${noteId}`)).data.note;
await P.elena('PUT', `/api/notes/${noteId}/body`, {
  baseVersion: nv.version,
  body: `# Shift handoff: day → night

**Incident Commander:** Jordan Reyes → Priya Shah at 18:00 UTC

## Where we are
- FIN-FS01, FIN-FS02, FIN-APP03 **isolated**; no traffic out since 09:58 UTC
- Initial access: VPN login as **j.miller** from an unfamiliar country (MFA fatigue suspected)
- Encryptor \`upd.exe\` blocked tenant-wide; C2 IPs blocked at the edge

## Open questions
1. Was anything exfiltrated before encryption? (proxy logs 08:00–09:45 pending)
2. Where else has **svc_finbackup** been used?

## Next steps
- [ ] Finish FIN-FS01 restore and scan (Devon)
- [ ] Scope svc_finbackup (Priya)
- [x] Reset finance admin credentials (Aisha)
- [ ] Legal decision on notification (Marcus)
`,
});

// Shifts (UTC): day / night rotation
// Anchored to now: the day shift started 4 hours ago, the night shift starts in 8.
const day0 = new Date();
day0.setUTCMinutes(0, 0, 0);
day0.setTime(day0.getTime() - 4 * 3600_000);
const iso = (d, h) => new Date(d.getTime() + h * 3600_000).toISOString();
const shift = (k, startH, hours, note, repeatDays = 3) => jordan('POST', `/api/incidents/${I}/shifts`, { userId: P[k].id, startsAt: iso(day0, startH), endsAt: iso(day0, startH + hours), repeatDays, note });
await shift('jordan', 0, 12, 'IC, day');
await shift('priya', 12, 12, 'IC, night');
await shift('dev', 0, 12, 'Restore');
await shift('sam', 2, 10, 'Network');
await shift('aisha', 12, 10, 'Identity');

// A guest from an outside IR firm, with limited access.
const inv = (await jordan('POST', `/api/incidents/${I}/invites`, { label: 'Kate Lindqvist', org: 'Halvard IR (retainer)', note: 'Ransomware negotiation and forensics support', scope: { channels: [g.id], voiceRooms: [main.id], sheets: [iocId], notes: [], timeline: true }, accessHours: 24 })).data;
const gt = inv.url.split('/join/')[1];
const acc = await client()('POST', `/auth/invite/${gt}/accept`, { displayName: 'Kate Lindqvist' });
const kate = client(acc.cookie);
kate.cookie = acc.cookie;
kate.id = (await kate('GET', '/api/me')).data.user.id;
P.kate = kate;
await say('kate', g, `Hi all, Kate from Halvard IR. This matches recent LockBit 3.0 affiliate activity. Please preserve memory from FIN-FS02 before any reboot.`);
await say('priya', g, `Thanks Kate, memory image of FIN-FS02 is already taken and hashed (in Files).`);

// Evidence (made-up contents).
const upload = async (k, name, description, body, type = 'text/plain') => {
  const res = await fetch(`${BASE}/api/incidents/${I}/files?source=evidence&name=${encodeURIComponent(name)}&description=${encodeURIComponent(description)}`, {
    method: 'POST',
    headers: { cookie: P[k].cookie, 'content-type': 'application/octet-stream', 'x-file-type': type },
    body,
  });
  if (!res.ok) console.warn('! upload', name, res.status);
};
await upload('priya', 'FIN-FS02-memory.lime', 'Memory image of FIN-FS02 taken before isolation', Buffer.alloc(3 * 1024 * 1024, 7), 'application/octet-stream');
await upload('sam', 'vpn-auth-2026-11-19.csv', 'VPN authentications for j.miller, 07:00–10:00 UTC', 'time,user,src_ip,country,result\n08:12:04,j.miller,203.0.113.77,??,success\n');
await upload('dev', 'README-LOCKBIT.txt', 'Ransom note recovered from \\\\FIN-FS01\\Shared', 'Your files are encrypted. (demo)\n');
await upload('aisha', 'entra-signins-j.miller.json', 'Entra ID sign-in log export for j.miller', JSON.stringify({ value: [{ userPrincipalName: 'j.miller@northwind.example', ipAddress: '203.0.113.77' }] }), 'application/json');

// Someone asking to join from the room link.
await client()('POST', `/auth/rooms/${I}/join-requests`, { name: 'Ravi Menon', email: 'ravi.menon@northwind.example', org: 'Backup & storage team', note: 'Owns the Veeam backups for finance' });

// Presence: people in voice and in the room.
const sockets = [];
const present = async (k, voiceRoomId) => {
  const s = io(BASE, { extraHeaders: { cookie: P[k].cookie }, transports: ['websocket'] });
  await new Promise((r) => s.on('connect', r));
  s.emit('incident:join', { incidentId: I });
  await wait(80);
  if (voiceRoomId) s.emit('presence:update', { voiceRoomId });
  sockets.push(s);
};
await present('priya', main.id);
await present('aisha', main.id);
await present('kate', main.id);
await present('sam', breakout.id);
await present('dev', breakout.id);
await present('marcus', exec.id);
await present('elena', null);
await wait(500);

// An AI agent (Claude, connected with a room key) posts a catch-up for latecomers.
const agentKey = (await jordan('POST', `/api/incidents/${I}/agent-keys`, { name: 'Claude', scopes: ['write'], hours: 12 })).data.key;
const agent = async (method, path, body) =>
  fetch(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${agentKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
await agent('POST', `/api/channels/${g.id}/messages`, {
  incidentId: I,
  body: 'Catch-up for anyone joining: FIN-FS01 and FIN-FS02 encrypted (.lockbit), both isolated at 09:42 UTC, EDR containment on 14 hosts. Initial access looks like j.miller’s VPN account (now disabled). 02:00 UTC backups verified clean; FIN-FS01 restore under way. Open: lateral movement hunt (Priya), C2 blocking (Sam), staff statement (Marcus).',
});

// Make it look like it's been running for a while: incidents opened earlier, chat spread out.
{
  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(`${DATA}/warroom.db`);
  d.prepare('UPDATE incidents SET created_at = ? WHERE id = ?').run(at(96), I);
  d.prepare("UPDATE incidents SET created_at = ? WHERE id <> ? AND status <> 'resolved' AND number = 2").run(at(60 * 26), I);
  d.prepare("UPDATE incidents SET created_at = ? WHERE id <> ? AND status <> 'resolved' AND number = 3").run(at(60 * 5 + 12), I);
  const msgs = d.prepare('SELECT m.id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.incident_id = ? ORDER BY m.created_at, m.rowid').all(I);
  msgs.forEach((row, i) => d.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(at(90 - Math.round((i * 85) / Math.max(1, msgs.length - 1))), row.id));
  // System entries (declared, roles, status, tasks...) happened when the room opened, not just now.
  const sys = d.prepare("SELECT id, type FROM timeline WHERE incident_id = ? AND type NOT IN ('note','decision','action','finding') AND ts > ? ORDER BY ts, rowid").all(I, at(10));
  sys.forEach((row, i) => d.prepare('UPDATE timeline SET ts = ? WHERE id = ?').run(row.type === 'declared' ? at(84) : at(83 - Math.min(i, 30) * 0.5), row.id));
  d.close();
}

// ---------- screenshots ----------
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${SCRATCH}/chrome-prof`, '--hide-scrollbars', '--no-first-run', '--mute-audio', 'about:blank']);
let target;
for (let i = 0; i < 60 && !target; i++) {
  await wait(250);
  try {
    target = (await (await fetch('http://127.0.0.1:9333/json/list')).json()).find((t) => t.type === 'page');
  } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const cdp = (method, params = {}) =>
  new Promise((r) => {
    const id = ++seq;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
await cdp('Page.enable');
await cdp('Network.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1.5, mobile: false });
await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
const as = async (who) => {
  await cdp('Network.clearBrowserCookies');
  if (who) {
    const [name, value] = who.cookie.split('=');
    await cdp('Network.setCookie', { name, value, domain: 'localhost', path: '/' });
  }
};
const go = async (path, ms = 2500) => {
  await cdp('Page.navigate', { url: `${BASE}${path}` });
  await wait(ms);
};
const js = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true })).result?.result?.value;
const click = (text, sel = 'button') => js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)})); if (b) b.click(); return !!b; })()`);
const shot = async (name) => {
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'));
  console.log('shot', name);
};
const want = (n) => !ONLY || ONLY === n;
const room = `/incidents/${I}`;
const sheetId = (n) => st.sheets.find((s) => s.name === n)?.id;

await as(jordan);
if (want('dashboard')) (await go('/'), await shot('dashboard'));
if (want('room')) (await go(`${room}?view=channel:${g.id}`, 3500), await shot('room'));
if (want('ioc')) (await go(`${room}?view=sheet:${sheetId('IOC Tracker')}`, 3000), await shot('sheet-ioc'));
if (want('dashboard-board')) (await go(`${room}?view=dashboard`, 3500), await shot('dashboard-board'));
if (want('dashboard-wall')) (await go(`${room}/wall`, 3500), await shot('dashboard-wall'));
if (want('timeline')) (await go(`${room}?view=timeline`, 3000), await shot('timeline'));
if (want('note')) (await go(`${room}?view=note:${noteId}`, 3000), await shot('note'));
if (want('roster')) (await go(`${room}?view=roster`, 3000), await shot('roster'));
if (want('schedule')) (await go(`${room}?view=schedule`, 3000), await shot('schedule'));
if (want('files')) (await go(`${room}?view=files`, 3000), await shot('files'));
if (want('invite')) {
  await go(`${room}?view=channel:${g.id}`, 3000);
  await click('Invite');
  await wait(800);
  await shot('invite');
}
if (want('admin')) {
  await go('/admin?tab=settings', 3000);
  await click('Okta');
  await wait(800);
  await shot('admin-settings');
}
if (want('people')) (await go('/admin', 3000), await shot('admin-people'));
if (want('agent-key')) {
  await go(`${room}?view=channel:${g.id}`, 3000);
  await click('AI agents');
  await wait(800);
  await js(`(() => { const i = [...document.querySelectorAll('.modal input[type=checkbox]')][1]; if (i && !i.checked) i.click(); })()`);
  await click('Create key');
  await wait(1000);
  await shot('agent-key');
}
if (want('agent-consent')) {
  const reg = await (await fetch(`${BASE}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['http://localhost:33418/callback'], token_endpoint_auth_method: 'none' }) })).json();
  const qs = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'http://localhost:33418/callback', code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256', scope: 'warroom:read warroom:write warroom:investigate' });
  await go(`/oauth/authorize?${qs}`, 3000);
  await shot('agent-consent');
}
await as(kate);
if (want('guest')) (await go(`${room}?view=channel:${g.id}`, 3500), await shot('guest-view'));
await as(null);
if (want('ask')) (await go(`/ask/${I}`, 2000), await shot('ask-to-join'));
if (want('login')) (await go(`/login?returnTo=${encodeURIComponent(room)}`, 2000), await shot('sign-in'));

const md = await (await fetch(`${BASE}/api/incidents/${I}/export.md`, { headers: { cookie: jordan.cookie } })).text();
writeFileSync(join(SCRATCH, 'export.md'), md);

ws.close();
chrome.kill();
sockets.forEach((s) => s.disconnect());
srv.kill();
await wait(500);
rmSync(SCRATCH, { recursive: true, force: true });
process.exit(0);
