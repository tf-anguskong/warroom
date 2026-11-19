# War Room — notes for working on the code

An incident-response "war room": per-incident voice rooms (LiveKit), chat channels that can be shared across incidents, a native spreadsheet, a timeline, roles and assignments, screen share, guest access by one-time link, and Okta / Microsoft Entra ID sign-in with SCIM. The README covers features and deployment; this file covers how the code is put together and the rules to keep.

## Commands

```powershell
npm install
npm run livekit:dev    # local LiveKit in Docker (devkey / secret)
npm run dev            # API on :3000 (tsx watch) + Vite on :5173, proxied
npm run build          # client (vite) then server (tsc → server/dist)
npm run typecheck
npm run setup-link -w server   # print a one-time admin link (first admin / recovery)
```

- Open http://localhost:5173. In development, **developer sign-in** (name + email, no password) is on; the first user becomes an admin.
- Dev data: `server/data/warroom.db` (SQLite) plus generated keys (`.session-secret` / `.dev-session-secret`). Delete the folder for a clean slate.
- There is no unit-test runner. Changes are verified with end-to-end scripts that drive a throwaway server (`DATA_DIR=<temp>`, `--port 3100`) over HTTP, plus a pass in the browser. Run `npm run build` before calling something done.

## Layout

```
server/src/
  index.ts        Express app, router order, startup (applySettings → listen → setup link)
  config.ts       env-derived starting values (envDefaults) and the live `config` object
  settings.ts     Admin → Settings: field registry, DB storage, validation, Test, live apply
  setup*.ts       one-time setup/recovery links (setup-token.ts has no app imports: used by the CLI)
  db.ts           node:sqlite schema + additive migrations, `q` helpers, `tx`
  auth.ts         sessions (JWT cookie), OIDC (Okta, Entra), SAML (Entra), dev login, requireAuth
  sso.ts          provider list and SSO → user matching
  users.ts        user rows, admin sources, audit log (logAdminAction)
  scim.ts         SCIM 2.0 (Okta / Entra provisioning)
  api.ts          incidents, channels, messages, voice, roles, assignments, sheets, export, admin
  notes.ts        Markdown notes; saves carry the version they started from (409 on conflict)
  files.ts        uploads to DATA_DIR/files with SHA-256; downloads; Files view API
  archive.ts      room export/import (.warroom: tar.gz + manifest, optional AES-256-GCM); archive-routes.ts, room-cli.ts
  email-login.ts  sign-in with emailed or admin-issued codes for accounts without SSO
  shifts.ts       shift schedule; a 30 s ticker sends reminders and start/end notices (flags on each row so each fires once)
  guests.ts       guest invites, scopes, deny-by-default route allowlist, email codes, sweeper
  join-requests.ts  "Ask to join" from the room link (public /auth/rooms routes); admitting makes a normal invite.
                  Requests are short-lived, so they're deliberately not in archives
  mail.ts         nodemailer transport (TLS required), dev outbox
  realtime.ts     Socket.IO: presence, incident rooms, guest-aware broadcast
  mentions.ts     <@user> / <@role:x> / <@here> tokens
  integrations/   Okta, Sumo Logic, CrowdStrike for the Investigate view; tracked endpoints and
                  their poller live in index.ts; secrets.ts = AES-256-GCM
client/src/
  pages/          Login, Join (guest), Setup, Dashboard, IncidentRoom, Admin
  components/     views and dialogs (AdminSettings, AdminIntegrations, Guests, Sidebar, ...)
  lib/            api, app context, socket, voice (LiveKit), format, formula
  styles.css      all styling; colour tokens on :root
docs/CLAUDE_DESIGN_PROMPT.md   design brief for Claude Design; update it when screens change
```

## Rules that matter

**Configuration lives in Admin → Settings, not in `.env`.**
- `config` is a single mutable object. `applySettings()` writes saved values into it (saved > environment > default) at startup and after every save. Read `config.x` at the moment you need it; never copy it into a module-level constant.
- Anything that caches a client built from config (OIDC discovery, SAML, the SMTP transport) must reset it in `onSettingsChanged`.
- New setting: add a field to `FIELDS` in `settings.ts` (section, kind, label, help, `base`, `apply`); the admin page renders it automatically. Add a Test case in `runTest` if it reaches an external system. Update the README Settings table.
- Secrets use kind `secret`: encrypted at rest, never returned to the browser (only `isSet`), never written to the audit log. An empty secret in a save means "keep".
- Only process-level values stay in the environment: `PORT`, `DATA_DIR`, `NODE_ENV`, `CLIENT_DIST`, `LIVEKIT_KEY_FILE`, and the optional `SESSION_SECRET` / `INTEGRATIONS_KEY` overrides.
- Development sign-in can never be on in production.

**Guests are deny-by-default.**
- `requireAuth` runs `guestAllowed`. A new `/api` route is closed to guests unless it is added to `RULES` in `guests.ts` with a scope check.
- Realtime: `emitToIncident` drops events for guests unless they are in `GUEST_EVENTS` or pass a per-socket `canSee` check (`timeline:*`, `sheet:*` with `sheetId`, `note:*` with `noteId`). New events that carry content need that check.
- Guest users can't be admins, IC or room admins, and lose access when it expires, when the incident resolves, or when it's revoked.

**Identity.**
- Entra accounts are matched by object ID, then UPN. Never use Entra's `email` claim to find an account (users can edit it). Okta email is trusted.
- SAML must stay strict: signed assertions, `InResponseTo` required (no IdP-initiated), tenant-specific issuer.
- `returnTo` redirects go through `safeReturnTo` (same-origin paths only).

**Room control and accountability.**
- `canControl` = not a guest AND (app admin OR IC OR room admin OR the room has no IC and no admins). Gate moderation routes with it.
- Anything that changes who does what (roles, command handoff, assignments, tasks, guests, moves) writes a timeline entry, so the export can answer "who did what".

**Database.**
- `node:sqlite` (Node 24+). Migrations are additive and idempotent: `CREATE TABLE IF NOT EXISTS`, then add missing columns one at a time after checking `PRAGMA table_info`. `tsx watch` can restart halfway through an edit, so never assume a table was created with its newest columns.
- Store only hashes of tokens and codes (invites, setup links, email codes).
- Admin actions go through `logAdminAction`.

**Integrations.**
- Read-only by design: credentials should only need read scopes, and nothing writes back to the provider.
- Anything typed by a responder that goes into a provider query (Okta filter, Falcon FQL) is validated and quoted; never splice raw input into a query.
- Pollers (Okta watches, tracked endpoints) stop when the incident resolves or the integration is disabled, cap how much they post per poll, and record errors on the row instead of throwing.
- Links from provider data shown in the browser must be checked (https only).

**Files.**
- Uploads are raw bytes (`application/octet-stream`, real type in `X-File-Type`) so `express.json` never parses them; they stream to disk while hashing and stop at the size limit.
- Only images recognised by magic bytes are served inline; everything else is `application/octet-stream` + `attachment`, always with `nosniff` and a sandbox CSP. Never serve uploaded content as HTML/SVG.
- Notes only display images from `/api/files/<id>`; external images are not loaded.
- The viewer (`components/FileViewer.tsx`, lazy-loaded) renders from raw bytes fetched with `?download`/`?preview`: pdf.js with `isEvalSupported: false`, mammoth + DOMPurify for .docx, plain text for the rest. Never hand a file to the browser to render natively, and never inject unsanitised HTML from a file.

**Client.**
- React 18 + Vite, plain CSS with tokens (no UI framework). Make controls the viewer can't use visibly read-only, with a short reason, instead of hiding them.
- Text is plain and specific: say what happened and what to do next.

## Gotchas

- On Windows, Vite's watcher sometimes misses files written by scripts (Python, sed). If the browser keeps serving an old module, `touch` the file.
- The Vite dev server proxies `/api`, `/auth`, `/scim` and `/socket.io` to `:3000`. Pages that call the API must use those prefixes.
- Voice features (mute, move, remove) call LiveKit's server API at `config.livekit.apiUrl`; with `npm run livekit:dev` that's `http://localhost:7880`.
- In Docker, War Room writes the LiveKit key pair to `LIVEKIT_KEY_FILE` on the shared `livekit-keys` volume, and LiveKit starts after the app is healthy.

**Quick mode and archives.**
- `WARROOM_MODE=now` (config.mode) is the temporary-instance mode used by `warroom-now.sh`: email sign-in on, responder invites by whoever runs the room, export banner.
- Every invite needs a code when it can (`needsCode`): emailed if SMTP works, otherwise shown once to the inviter (`code_mode = 'manual'`).
- New tables that belong to a room must be added to `SPECS` in `archive.ts` (with ID columns marked) or they won't survive export/import. Bump `VERSION` for incompatible format changes.
- Shell files must keep LF line endings (`.gitattributes`).

## Don't

- Don't commit `.env`, `server/data/`, or any key, certificate or token.
- Don't log or return secrets, codes or full tokens.
- Don't add configuration that requires editing a file on the server; add a setting instead.
