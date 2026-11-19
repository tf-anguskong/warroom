# Security model

[← Wiki home](Home.md)

War Room holds sensitive material during the worst days of an organisation's year. This page summarises how it's protected, and what it doesn't do yet.

## Where data lives

- **Self-hosted.** Chat, sheets, notes, files, the timeline and settings are stored on your server, in SQLite and the data directory. Nothing is sent to a War Room service.
- **Voice** runs on your own LiveKit server, encrypted in transit (WebRTC DTLS-SRTP). Nothing is recorded.
- Stored content is **not encrypted at rest** by War Room; protect the volume, disk snapshots and backups. Secrets in Settings are encrypted (below).

## Sign-in

- Okta and Entra over OIDC with PKCE, or Entra over SAML 2.0.
- **SAML is strict:** assertions must be signed by the configured certificate, come from your tenant, and answer a sign-in War Room started in the last 10 minutes. IdP-initiated sign-in is refused.
- **Entra accounts** are matched by object ID, then UPN, never by the user-editable `email` claim.
- Deactivation in the identity provider (SCIM) **ends live sessions immediately**. When SSO first links an existing account, earlier sessions on it are ended.
- After sign-in, people are only sent back to paths on this site.
- **Developer sign-in can never be on in production.**

## Links and codes

- Invite links, setup links, sign-in codes and join-request secrets are **single-use**, and only their **hashes** are stored.
- Opening an invite link doesn't use it (mail scanners prefetch links); only pressing Join does.
- Every invite needs a 6-digit code as well as the link whenever it can (emailed, or shown to the inviter to pass on by another route).
- Codes expire, lock after 5 wrong tries, and are rate limited. Emails contain no links.
- An invite or join request **never signs anyone in as an existing account**; the account is only added to the room.
- A sign-in code for a responder opens their whole account, so only an app admin can make one. When the address on a new responder account can't be verified (no email), only an app admin can add responders.

## Guests: deny by default

- A guest can reach only API routes on an explicit allowlist, each checked against what their invite granted. Everything else is refused, including other incidents, the directory, integrations, exports and the schedule.
- Realtime events are filtered per guest the same way.
- Guests can never be admins, Incident Commanders or room admins.
- Access ends automatically when it expires or the incident is resolved, and immediately when someone ends it.

## Room control and accountability

- Moderation (roles, severity, status, voice moves, mute, remove, invites, guest access) is limited to the Incident Commander, room admins and app admins.
- Anything that changes who does what goes on the **incident timeline** with who did it; admin actions go in the **admin activity log**.

## Files

- Uploads are hashed (SHA-256) as they stream to disk, and stop at the size limit.
- Only images recognised by their **bytes** are shown inline. Everything else downloads as an opaque file, with `nosniff` and a sandbox content security policy, so a disguised HTML or script file never runs in the browser.
- The viewer renders PDFs with scripting off, sanitises Word documents, and shows everything else as plain text.
- Notes only display images uploaded to this War Room; external images are never loaded.

## Secrets

- Client secrets, the SMTP password, the SCIM token, the LiveKit secret and integration credentials are encrypted with **AES-256-GCM**, never returned to the browser, and never written to logs.
- Server keys are generated on first start and stored in the data directory (or provided with `SESSION_SECRET` / `INTEGRATIONS_KEY`).

## Integrations

- Read-only: credentials need read scopes only, and nothing is written back to Okta, Sumo Logic or CrowdStrike.
- Responder input is validated and quoted before it goes into a provider query.
- Every search is on the timeline; who may search is configurable per integration.

## Known limits

- **Every organisation user can open every incident.** Restricted, need-to-know incidents (for example insider-threat cases) are not implemented yet.
- Guest links are bearer links until used; send them directly to the person and keep link lifetimes short for sensitive incidents.
- The war room link is safe to share widely, because on its own it only lets someone ask, but check who's asking before letting them in, especially without email.
- No TURN relay is included; voice may not work on networks that block UDP.

Report security issues privately to the maintainers rather than in a public issue.

[← Wiki home](Home.md)
