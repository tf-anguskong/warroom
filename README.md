# War Room

A self-hosted collaboration space for IT and security incident response: voice rooms, chat, sheets, notes, a timeline, files and evidence, and a shift schedule for every incident, on your own server.

**Need a war room right now?** Stand one up on any Linux server with Docker, use it for the incident, export it, tear it down:

```
curl -fsSLO https://raw.githubusercontent.com/tf-anguskong/warroom/main/warroom-now.sh
bash warroom-now.sh up
```

Step-by-step guide (DNS, ports, inviting people, exporting, teardown): **[docs/WARROOM_NOW.md](docs/WARROOM_NOW.md)**.

Prebuilt image (linux/amd64, linux/arm64): `ghcr.io/tf-anguskong/warroom`.

Free for individuals, non-profits and small companies; larger companies need a commercial license. See [License](#license).

## What's in a war room

- **Voice**: a Main Bridge plus any number of **breakout rooms**, with speaking indicators, mute/deafen, and **screen sharing**. Runs on a self-hosted [LiveKit](https://livekit.io) SFU, so 50+ people per room is fine.
- **Text channels** that can be **attached to several voice rooms** and **shared across incidents** (both war rooms see and post to the same channel).
- A **native spreadsheet** per incident: typed columns (text, number, select, date, person, checkbox), formulas (`=SUM`, `=COUNTIF`, `=IF`, …), live cursors of other editors, paste from Excel or SIEM exports, and CSV export. Templates: IOC Tracker, Affected Assets, Action Items, Comms Log.
- **Shift schedule** for long-running war rooms: the **Schedule** view shows who is on now (flagging anyone on shift who isn't in the room), the next handoff, and a UTC timeline (24 hours, 3 days or 7 days) with everyone's shifts and a "now" line. Anyone can add their own shifts; the Incident Commander and room admins can schedule anyone, with "repeat daily" for 8- or 12-hour rotations. People get a reminder 15 minutes before their shift, and the room gets a notice when a shift starts and when it ends (naming who is on now, so handoffs aren't missed). Scheduling changes go on the timeline, *Who's doing what* shows each person's shift, and the postmortem export includes the schedule. Overlapping shifts for one person and shifts over 24 hours are refused. Guests don't see the schedule.
- **Files and screenshots**: paste a screenshot straight into chat (or drop files, or use the paperclip); images show inline and open full size. Paste or drop images into notes too. Every file's **SHA-256** is recorded when it's uploaded. The **Files** view lists everything in the incident (evidence, chat attachments, note images) with size, hash, who and when, and is where you add **evidence** with a description; evidence uploads and every deletion go on the timeline, and the postmortem export lists all files with their hashes. Only images recognised by their bytes are shown in the browser; everything else downloads as an opaque file (with `nosniff` and a sandbox policy), so a disguised HTML or script file never runs. Deleting removes the bytes but keeps the record and hash. Guests can see and attach files only in the channels and notes they were given. The size limit is in Settings → General (100 MB by default); files live in `DATA_DIR/files`.
- **In-app viewer**: open images, **PDFs**, **Word (.docx)** and **text files** (logs, CSV, JSON, email, scripts) without downloading. PDFs are drawn by pdf.js with scripting off, Word documents are converted to sanitised HTML (layout may differ from Word), and text shows with line numbers, wrapping and find (first 2 MB; download for the rest). What can be previewed is decided from the file's bytes, not its name, so a binary renamed `.pdf` stays download-only and an HTML file only ever shows as text.
- **Notes**: Markdown notepads next to the sheets (headings, lists, checklists you can tick in the preview, tables, code blocks, links). Edit, preview or both side by side; saves automatically and updates live for everyone. If two people edit at once, the second save is caught and they choose *Use theirs* or *Keep mine* instead of silently overwriting. Templates: Working notes, Shift handoff, Call notes. Notes are included in the postmortem export and can be downloaded as `.md`.
- An **incident timeline** built automatically (declared, severity/status changes, roles, breakouts, joins, searches, and **comings and goings**: who came into or left the room and each voice room, logged once a change has lasted 20 seconds so reloads aren't noise; see the *Comings & goings* filter) plus human entries (notes, decisions, actions, findings, pinned messages), with back-dating and a **Markdown postmortem export**.
- **Roles and status**: Incident Commander, Scribe, Comms Lead, Tech Lead, Security Lead; SEV1–SEV4; Investigating → Identified → Mitigating → Monitoring → Resolved.
- **Room control**: the Incident Commander and any **room admins** they appoint run the room: assign roles and room admins, change severity and status, **drag people between voice rooms** (or use the ⋯ menu), mute someone's mic, remove them from voice, close breakouts and call everyone back. Everyone else can still chat, edit sheets, add timeline entries, open breakouts and run searches. App admins can always run any room; if a room has no IC and no room admins, anyone in it can.
- **Assignments and accountability**: the IC and room admins assign people to any voice room or channel, name a **lead**, and give each voice room an **objective**. Everyone can set what they're **working on** (room admins can set it for others). The sidebar shows who's assigned to each room, including people who are elsewhere ("→ Main Bridge", "away"). **Who's doing what** lists every workstream (objective, lead, how many assigned people are actually there) and every person (assignments, where they are now, current task and who set it), and flags problems: assigned to one room but in another (with a one-click Move), assigned but not in the war room, present with no assignment, task not updated for 30 minutes. Every assignment, lead, objective and task change is on the timeline with who made it, and the postmortem export gets a "Who did what" table.
- **Incident Command handoff**: the Incident Commander, room admins and app admins hand off or reassign command from the right pane, with an optional handoff note. Anyone else can take command only when nobody holds it; otherwise they **request** it (with a note), and the IC and room admins get a notice and a sound plus **Hand over** / **Decline** in the panel. Handoffs, requests and declines are announced and on the timeline. Whoever holds command runs the room (severity, status, roles, voice moves).
- **Away (AFK)**: **Step away** in the top bar marks you away, with a "back in" time (5, 15, 30 or 60 minutes, or until you're back) and an optional note. It mutes your microphone, shows a clock badge on your avatar in the voice list, the room panel and *Who's doing what* (flagged when overdue), and shows in @mention suggestions. It's kept on the server, so it survives reloads and closed laptops. **I'm back** clears it and leaves your mic muted.
- **Notification sounds**: a soft chime when someone joins or leaves your voice room, a three-note call when you're called back to a room or moved, and a ping for @mentions and requests for command. The bell in the top bar turns them off for that browser.
- **Guest links**: the IC or a room admin creates a **single-use** invite for someone outside your identity provider (vendor, outside IR firm, counsel) and ticks exactly which **channels, voice rooms, sheets and notes** they can see, and whether they can read the timeline. Opening the link doesn't use it (mail scanners prefetch links); pressing *Join* does, once. Only a hash of the link is stored. Guests get a time-limited session (2–72 h) that also ends when the incident is resolved or someone ends it; they're tagged **GUEST** everywhere, can't see other incidents, the company directory, integrations, exports or anyone else's tasks, and every invite, join, access change and revocation is on the timeline and in the admin activity log. Access can be widened or narrowed while they're in the room.
- **Email-verified guests** (with SMTP configured): the invite carries the guest's email. Opening the link shows a masked address and an *Email me a code* button; the guest must enter the 6-digit code to join. Codes expire after 10 minutes, work once, are replaced when a new one is sent, lock after 5 wrong tries, and are limited to one send per 30 s and 5 per hour per invite. The same link plus a fresh code lets that guest sign back in (new device, cleared cookies) while their access lasts; nobody else can use it. The email contains no links. Admins can check settings and send a test email in **Admin → Integrations → Email (SMTP)**.
- **@mentions**: `@name`, `@Incident Commander` (or any role, reaching whoever holds it), and `@here` (everyone in the war room now), with autocomplete. Mentions are highlighted, show an @ badge on the channel and the dashboard card, stay unread until you open the channel, and pop up a toast wherever you are in the app.
- **Investigate** with integrations: look up a person in **Okta**, search the Okta System Log, and **live-watch** someone's Okta activity (streams into `#okta-watch`); run **Sumo Logic** searches from editable starter queries whose `{{ip}}`/`{{user}}`/`{{hash}}`/`{{host}}`/`{{domain}}` placeholders are suggested from the incident's sheets. Results are shared with the room, can be copied into a sheet or posted to a channel, and every search is logged on the timeline. Queries marked auto-run start when an incident is declared.
- **Admin panel**: grant/remove admin, deactivate local accounts, connect and test integrations, and an admin activity log.
- **Temporary War Rooms** (`WARROOM_MODE=now`): no identity provider needed. Invite **responders** (full team accounts) or **guests** with a single-use link plus a 6-digit code, emailed by War Room or, without email, handed to the inviter to pass on. People sign back in with emailed codes, or with a code (and for guests a fresh link) that the IC or a room admin makes from the room's People list when someone drops off. **Export** any room to an encrypted `.warroom` file and **restore** it on any War Room.
- **Single sign-on** with **Okta (OIDC)** and **Microsoft Entra ID (OIDC or SAML 2.0)**, together or on their own, plus **SCIM 2.0 provisioning** from either (users and groups). Deactivating someone in the identity provider disconnects their live session immediately.

## Stack

| Part | Tech |
|---|---|
| Client | React 18 + TypeScript + Vite, plain CSS (tokens in `client/src/styles.css`) |
| Server | Node 24, Express, Socket.IO, built-in `node:sqlite` |
| Voice/screen share | LiveKit server + `livekit-client`; `livekit-server-sdk` for tokens and moderator mute/remove |
| Auth | `openid-client` (OIDC + PKCE), `@node-saml/node-saml` (SAML), signed session cookie, SCIM bearer token |

```
server/src/
  index.ts      HTTP server, static client, routers
  config.ts     environment variables
  db.ts         SQLite schema + helpers
  auth.ts       OIDC (Okta, Entra) and SAML (Entra) sign-in, dev login, sessions, bootstrap admins
  sso.ts        identity providers, mapping SSO identities onto users
  scim.ts       SCIM 2.0 /Users and /Groups for Okta or Entra provisioning
  api.ts        incidents, roles, room control, voice rooms, channels, messages, timeline, sheets, export, admin
  mail.ts       SMTP (nodemailer) and the guest code email; dev outbox when SMTP isn't set
  guests.ts     single-use guest invites, guest scope checks and the guest route allowlist, expiry sweeper
  mentions.ts   @mention tokens: parsing, resolving roles and @here, plain-text export
  notes.ts      Markdown notes: storage, versioned saves, templates, export section
  files.ts      uploads (streamed, hashed), safe downloads, evidence list, guest access
  shifts.ts     shift schedule, reminders and start/end notices
  realtime.ts   Socket.IO presence, live updates, sheet cursors
  templates.ts  sheet templates, roles, severities, statuses
  integrations/
    index.ts    integration storage, access rules, investigation runs, live watches, routes
    okta.ts     Okta users + System Log client
    sumo.ts     Sumo Logic Search Job API client + starter queries
    secrets.ts  AES-256-GCM encryption for stored credentials
    http.ts     outbound HTTP helpers (HTTPS-only, timeouts, error mapping)
client/src/
  pages/        Login, Dashboard, IncidentRoom, Admin
  components/   Sidebar, RoomHeader, VoiceDock, ScreenStage, ChatView, SheetView, TimelineView,
                InvestigateView, DetailsPanel, AdminIntegrations, dialogs
  lib/          api, socket, voice (LiveKit), formula engine, formatting
```

## Run locally

Requires Node 24+ and Docker (for LiveKit).

```powershell
npm install
```

```powershell
npm run livekit:dev
```

```powershell
npm run dev
```

Open http://localhost:5173. With no Okta settings, the login page offers a **developer sign-in** (name + email, no password). The first user becomes an admin. To try multi-user features, use a second browser profile or a private window.

Data lives in `server/data/warroom.db` in dev.

## Deploy

**Temporary, for one incident:** see [docs/WARROOM_NOW.md](docs/WARROOM_NOW.md).

**Permanent install:**

1. Point a DNS name at the host with an **A record**, e.g. `warroom.example.com` → the server's public IP. Caddy uses it to get a Let's Encrypt certificate automatically. HTTPS is required: browsers only allow microphone and screen capture on secure pages.
2. Open TCP 80, 443, 7881 and UDP 50000–50100.
3. Get `docker-compose.yml`, `Caddyfile` and `livekit.yaml` from this repository (or clone it), then run `APP_DOMAIN=warroom.example.com docker compose up -d`. It pulls `ghcr.io/tf-anguskong/warroom`; add `--build` to build from your clone instead. Pin a version with `WARROOM_VERSION=1.0.0`.
4. `docker compose logs app` prints a **one-time setup link**. Open it, create the first admin, and you land in **Admin → Settings**.

There is no `.env` file. Everything else is configured in **Admin → Settings** (below). Caddy obtains certificates automatically and serves both the app and LiveKit's signalling (`/rtc`) on the one name. The LiveKit API key pair is generated by War Room and shared with the LiveKit container through the `livekit-keys` volume. The SQLite database, uploaded files and the generated server keys are on the `warroom-data` volume — back it up.

### Moving rooms between servers

**Export room** (room header) makes an encrypted `.warroom` archive of everything in the room. Admins restore it with **Restore a room** on the dashboard of any War Room; it becomes a new incident there, with people matched by username or email. From the server: `docker compose exec -e WARROOM_EXPORT_PASSPHRASE app node server/dist/room-cli.js export --all --out /data/exports` and `… room-cli.js import FILE`.

## Settings

**Admin → Settings** holds all server configuration, stored in the database. Saving takes effect immediately; no restart.

| Section | What's there |
|---|---|
| General | Public address, how long a sign-in lasts, people to make admin on their next sign-in, development sign-in (never in production) |
| Okta | Issuer, client ID and secret, scopes, admin group, create accounts on first sign-in |
| Microsoft Entra ID | Tenant, OIDC or SAML, client ID and secret or signing certificate, admin group or app role |
| Provisioning (SCIM) | Generate the bearer token (shown once); base URL to copy |
| Email | SMTP server, port, encryption, username and password, from address, require emailed codes for guests |
| Voice (LiveKit) | Browser and server addresses, API key and secret (managed automatically with the bundled LiveKit) |

- Each sign-in section shows the redirect URIs and identifiers to paste into the identity provider.
- **Test** checks the values in the form before you save: Okta and Entra discovery, the SAML certificate (and its expiry), an SMTP connection and login, and a LiveKit API call.
- Secrets (client secrets, SMTP password, SCIM token, LiveKit secret) are encrypted at rest with AES-256-GCM and never sent back to the browser; the form only shows whether one is saved.
- Every save is recorded in the admin activity log with what changed (secret values are never logged).
- Environment variables with the old names (`OIDC_*`, `ENTRA_*`, `SMTP_*`, `LIVEKIT_*`, `PUBLIC_URL` and so on) still work as starting values; a field set that way is labelled *from environment* until an admin saves over it.

### Setup and recovery links

With no admin yet, the server prints a setup link at startup (valid 24 hours, works once). If sign-in is ever misconfigured and nobody can get in, run this on the server for a new one-hour link that signs you in as an admin:

```powershell
npm run setup-link -w server
```

In the Docker image: `docker compose exec app node server/dist/setup-link.js`. Only someone with access to the server or its logs can get these links; each use is in the activity log.

Server keys (session signing, encryption) are generated into the data directory on first start. Optional process settings (`PORT`, `DATA_DIR`, `SESSION_SECRET`, `INTEGRATIONS_KEY`) are listed in `.env.example`.

## Okta setup

### Sign-in (OIDC)

1. Okta Admin → Applications → **Create App Integration** → OIDC → **Web Application**.
2. Sign-in redirect URI: `https://warroom.example.com/auth/callback`. Sign-out redirect: `https://warroom.example.com/login`.
3. Grant type: Authorization Code (PKCE is used automatically).
4. In **Admin → Settings → Okta**, enter the issuer (your authorization server, e.g. `https://your-org.okta.com/oauth2/default`), client ID and secret. Click **Test**, then **Save**.
5. Optional: add a **groups** claim to the ID token (Security → API → Authorization Servers → Claims, filter e.g. "Starts with `WarRoom`") and set **Admin group** in the same section.

### Provisioning (SCIM)

1. In the app integration → General → App Settings → enable **SCIM provisioning**.
2. Provisioning → Integration:
   - SCIM connector base URL: `https://warroom.example.com/scim/v2`
   - Unique identifier field for users: `userName`
   - Supported actions: Push New Users, Push Profile Updates, Push Groups
   - Authentication mode: **HTTP Header**, token from **Admin → Settings → Provisioning → Generate token**
3. Provisioning → To App: enable Create Users, Update User Attributes, Deactivate Users.
4. Assign people/groups to the app. Use **Push Groups** for the admin group if you prefer it over the groups claim.

With SCIM on, leave **Create accounts on first sign-in** off: only users Okta has provisioned can sign in, and Okta is the source of truth for names and email.

## Microsoft Entra ID setup

In **Admin → Settings → Microsoft Entra ID**, enter the **Directory (tenant) ID** GUID and pick a protocol. Okta and Entra can both be on; the sign-in page shows a button for each. Only accounts from that one tenant can sign in.

### OIDC (recommended)

1. Entra admin center → App registrations → **New registration**. Single tenant. Redirect URI (Web): `https://warroom.example.com/auth/callback`.
2. Certificates & secrets → New client secret. Enter the Application (client) ID and secret in the settings, **Test**, **Save**.
3. Token configuration → **Add optional claim** → ID token → `email` (shown in the app; never used to match accounts).
4. For admins, either add a **groups claim** (Token configuration → Add groups claim → Security groups) and set **Admin group or app role** to the group's **object ID**, or define an **app role** such as `WarRoom.Admin`, assign it, and enter `WarRoom.Admin`. App roles are better for people in more than ~200 groups, where Entra stops listing groups in the token.

### SAML

1. Enterprise applications → New application → **Create your own application** → non-gallery. Single sign-on → **SAML**.
2. Basic SAML configuration: Identifier (Entity ID) `https://warroom.example.com/auth/saml/metadata`, Reply URL `https://warroom.example.com/auth/saml/acs`. Or upload the metadata from that URL.
3. SAML Certificates → download **Certificate (Base64)** and paste it into **Token-signing certificate**; **Test** shows its subject and expiry. The default login URL `https://login.microsoftonline.com/<tenant>/saml2` is used unless you enter another.
4. Attributes & Claims: the defaults are enough (UPN, object ID, name, email). For admins, add a group claim and enter the group's object ID as the admin group, or use an app role as above.

Responses must be signed by that certificate, come from your tenant, and answer a sign-in War Room started in the last 10 minutes. IdP-initiated sign-in (clicking the tile in My Apps) is not accepted; set the app's Sign-on URL to `https://warroom.example.com/login` so the tile starts a normal sign-in.

### Provisioning (SCIM)

Enterprise application → Provisioning → Automatic. Tenant URL `https://warroom.example.com/scim/v2`, Secret token from **Admin → Settings → Provisioning**. Keep the default mapping (`userPrincipalName` → `userName`) so provisioned users match their sign-ins. Groups pushed by Entra are matched to the Entra admin group by object ID or name.

### How accounts are matched

Entra users are linked by their **object ID** after the first sign-in, and matched to SCIM-provisioned or existing accounts by **UPN**. The Entra `email` claim can be edited by users, so it is never used to find an account. The same person can sign in through Okta and Entra into one account if their Okta login and Entra UPN are the same.

## Admins

- The first admin comes from the setup link the server prints. After that, list people under **Settings → General → Make admin on sign-in**, or put them in the Okta or Entra admin group set in Settings.
- Admins then grant or remove admin for others in **Admin → People**. Admin that comes from an identity-provider group can only be removed there. The last admin can't be removed.
- SCIM-provisioned users are deactivated in Okta or Entra; local accounts can be deactivated in the admin panel.
- Every admin change and integration change is recorded in the admin activity log.

## Email (SMTP)

Set it up in **Admin → Settings → Email**, use **Test** to check the connection and login, then **Send test email** under Integrations. With STARTTLS (port 587) War Room refuses to send unless the server upgrades to TLS; port 465 uses TLS from the start. Any authenticated relay works (Microsoft 365 / Exchange Online SMTP AUTH, Google Workspace SMTP relay, SES, SendGrid, Postfix). With email set up, guest invites require an email unless **Guests must verify an emailed code** is off. In development without SMTP, codes are printed in the server log.

## Integrations

Connect them in **Admin → Integrations**, then use them from **Investigate** in any war room.

| Integration | Credentials | What it does |
|---|---|---|
| Okta | Org URL + API token created by a **Read-Only Administrator** service account | Person profile (status, MFA factors, groups, last sign-in, password change), System Log search with quick filters (failures, MFA changes, password resets, admin privilege changes, SSO), live watch polling every 30 s into `#okta-watch` |
| Sumo Logic | Deployment API endpoint + Access ID/Key for a role that can search | Search Job API with starter queries, template placeholders filled from the incident's sheets, auto-run on declare, results up to 500 rows |
| CrowdStrike | Falcon cloud + API client ID/secret with **Hosts: Read** and **Alerts: Read** | Find hosts by name, IP or device ID; list alerts by host, severity and time; **track endpoints** in an incident (below) |

### Tracking endpoints (CrowdStrike)

In **Investigate → CrowdStrike**, enter a hostname, IP or device ID (hosts and IPs from the incident's sheets are offered as suggestions) and click **Track endpoint**. If the name matches several hosts, you pick one. Each tracked endpoint can have an **owner** (who's handling it) and a note (why it's tracked).

- Every minute War Room reads each tracked endpoint from Falcon. Changes (online/offline, network containment, last signed-in user, IP addresses, reduced functionality mode) and new alerts are posted to **#crowdstrike-watch** in plain words, with the owner named.
- When tracking starts, the last 24 hours of alerts are pulled in and summarised in one message rather than posted one by one.
- High and critical alerts, containment changes, tracking started/stopped and owner changes go on the incident timeline.
- The endpoint panel shows the host's details and every alert seen while it was tracked (description, command line, hash, link back to Falcon). The history stays after tracking stops or the incident is resolved; resolving the incident stops tracking.
- Read-only: War Room never contains hosts or changes anything in Falcon. Containment done in Falcon shows up in the room within a minute.

Per integration, choose who can run searches: everyone in the war room, **incident role holders and admins** (default), or admins only. Searches can expose a person's activity, so each one is recorded on the incident timeline with who ran it.

Credentials are encrypted with AES-256-GCM using a key derived from the server's generated session secret (or `INTEGRATIONS_KEY` if set). They are never returned to browsers.

Integrations are read-only: nothing is changed in Okta or Sumo Logic. Response actions (clear sessions, suspend user) are a possible next step.

## Security notes

- `DEV_AUTH` defaults to on outside production and off when `NODE_ENV=production`. Never enable it on a reachable server.
- Every organization user can open every incident; guests are limited to what their invite grants. Restricted incidents (need-to-know, e.g. insider-threat cases) are not implemented yet.
- Guest links are bearer links until used: send them directly to the person. Use short link lifetimes for sensitive incidents.
- Chat, sheets, notes, uploaded files, search results and the timeline are stored unencrypted in SQLite; protect the volume and its backups accordingly.
- Voice is not recorded.

## License

War Room is source-available under the [PolyForm Small Business License 1.0.0](LICENSE.md): free to use, change and share for individuals, non-profits, public bodies, and companies with fewer than 100 people and under USD 1,000,000 in revenue. Larger companies need a commercial license. Keep the `Required Notice` line from [LICENSE.md](LICENSE.md) with any copy you give out. Details and how to ask about a commercial license: [COMMERCIAL.md](COMMERCIAL.md).

## Design

`docs/CLAUDE_DESIGN_PROMPT.md` is a ready-to-paste brief for Claude Design covering users, screens, states and the handoff format. The current UI is a functional baseline; swap in the delivered tokens and components when the design is ready.
