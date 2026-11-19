# Settings reference

[← Wiki home](Home.md)

All server configuration lives in **Admin → Settings**, stored in the database. Saving takes effect immediately, with no restart.

- A value saved in Settings wins over an environment variable, which wins over the default. A field whose value comes from the environment is labelled **from environment** until an admin saves over it.
- **Test** checks the values in the form before you save: Okta and Entra discovery, the SAML certificate (and its expiry), an SMTP connection and login, and a LiveKit API call.
- **Secrets** (client secrets, SMTP password, SCIM token, LiveKit secret) are encrypted at rest with AES-256-GCM and never sent back to the browser; the form only shows whether one is saved. Leaving a secret empty when saving keeps the current one.
- Every save is in the admin activity log, with what changed (never secret values).

## General

| Setting | What it does | Default / env |
|---|---|---|
| Public address | The address people use to reach War Room. Sign-in callbacks, invite links and SCIM use it. | `PUBLIC_URL` |
| Sign-in lasts (hours) | How long before people sign in again (1–168). | 12 · `SESSION_HOURS` |
| Make admin on sign-in | Usernames or emails that become admins the next time they sign in. | `BOOTSTRAP_ADMINS` |
| Sign in with an emailed code | Accounts not linked to Okta or Entra sign in with a code sent to their email. Needs email. | off (on in War Room NOW) · `EMAIL_LOGIN` |
| Largest file upload (MB) | Size limit for screenshots, logs and evidence (1–4096). | 100 · `MAX_UPLOAD_MB` |
| Development sign-in | Name and email, no password. Never available in production. | on outside production · `DEV_AUTH` |

## Okta

| Setting | What it does | Env |
|---|---|---|
| Issuer URL | Your Okta authorization server. Empty turns Okta sign-in off. | `OIDC_ISSUER` |
| Client ID / Client secret | From the Okta app integration. | `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` |
| Scopes | Requested scopes (default `openid profile email groups`). | `OIDC_SCOPES` |
| Admin group | Members of this Okta group are War Room admins. | `OIDC_ADMIN_GROUP` |
| Create accounts on first sign-in | Leave off when Okta provisions people over SCIM. | `OIDC_JIT_PROVISIONING` |

## Microsoft Entra ID

| Setting | What it does | Env |
|---|---|---|
| Tenant ID | Directory (tenant) ID. Empty turns Microsoft sign-in off. | `ENTRA_TENANT_ID` |
| Protocol | OIDC or SAML. | `ENTRA_PROTOCOL` |
| Application (client) ID / Client secret / Scopes | OIDC only. | `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`, `ENTRA_SCOPES` |
| Token-signing certificate | SAML only: Certificate (Base64) from Entra, or PEM. | `ENTRA_SAML_CERT`, `ENTRA_SAML_CERT_FILE` |
| Login URL (optional) | SAML only. Empty uses the standard address for your tenant. | `ENTRA_SAML_LOGIN_URL` |
| Identifier (Entity ID, optional) | SAML only. Empty uses this server's metadata address. | `ENTRA_SAML_ENTITY_ID` |
| Admin group or app role | Group object ID or app role value whose members are admins. | `ENTRA_ADMIN_GROUP` |
| Create accounts on first sign-in | Leave off when Entra provisions people over SCIM. | `ENTRA_JIT_PROVISIONING` |

## Provisioning (SCIM)

| Setting | What it does |
|---|---|
| Bearer token | **Generate** makes a token and shows it once; paste it into Okta or Entra. The base URL to copy is `https://<public address>/scim/v2`. |

## Email

| Setting | What it does | Env |
|---|---|---|
| SMTP server / Port | Your mail relay (Microsoft 365, Google Workspace relay, SES, SendGrid, Postfix…). | `SMTP_HOST`, `SMTP_PORT` |
| Encryption | **STARTTLS, required** (port 587: War Room refuses to send unless the server upgrades to TLS), **TLS from the start** (port 465), or **None** (local test servers only). | `SMTP_SECURE`, `SMTP_ALLOW_PLAIN` |
| Username / Password | For authenticated relays. | `SMTP_USER`, `SMTP_PASS` |
| From address | Sender of invite and sign-in codes. | `SMTP_FROM` |
| Guests must verify an emailed code | With email set up, every guest invite needs an email address and the guest enters a code sent there. | `GUEST_REQUIRE_EMAIL` |

Send a test email from **Admin → Integrations → Email (SMTP)**. In development without SMTP, codes go to the server log instead.

## Voice (LiveKit)

| Setting | What it does | Env |
|---|---|---|
| LiveKit address for browsers | `wss://` address browsers connect to. | `LIVEKIT_URL` |
| LiveKit address for the server (optional) | Used to mute, move and remove people. Empty uses the browser address. | `LIVEKIT_API_URL` |
| API key / API secret | Managed automatically with the bundled LiveKit. | `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` |

## What stays in the environment

Only process-level values: `PORT`, `DATA_DIR`, `NODE_ENV`, `CLIENT_DIST`, `LIVEKIT_KEY_FILE`, the optional `SESSION_SECRET` and `INTEGRATIONS_KEY` overrides, and `WARROOM_MODE=now` for a temporary War Room. Server keys (session signing, encryption) are generated into the data directory on first start.

Next: [Integrations](Integrations.md).
