# Operations

[← Wiki home](Home.md)

## What runs

`docker-compose.yml` runs three containers behind **one DNS name**:

| Container | Job |
|---|---|
| **app** (`ghcr.io/tf-anguskong/warroom`) | War Room itself: web app, API, realtime, SQLite database, files |
| **livekit** (`livekit/livekit-server`) | Voice and screen-share media (SFU) |
| **caddy** | HTTPS with automatic Let's Encrypt certificates; serves the app and LiveKit signalling (`/rtc`) on the same name |

War Room generates the LiveKit API key pair and shares it with the LiveKit container through the `livekit-keys` volume; LiveKit starts once the app is healthy.

## Network

| Port | Protocol | For |
|---|---|---|
| 80, 443 | TCP | Web, certificates |
| 7881 | TCP | Voice media fallback |
| 50000–50100 | UDP | Voice and screen-share media |

The DNS name must resolve to the server before the first start, or certificate issuance fails. If you use Cloudflare, set the record to **DNS only**: voice traffic can't go through its proxy. Some corporate networks block UDP; there's no TURN relay yet, so people on those networks may get chat but not voice.

Sizing: 2 vCPU / 4 GB RAM is plenty for a few dozen people; add more for heavy screen sharing.

## Data and backups

Everything that matters is on the **`warroom-data`** volume (`/data` in the container):

- `warroom.db`: the SQLite database (incidents, chat, sheets, notes, timeline, settings, users)
- `files/`: uploaded files and evidence
- generated server keys (session signing, encryption of secrets)

**Back up the whole volume.** Losing the keys means stored secrets (SSO client secrets, SMTP password, integration credentials) can't be decrypted and must be entered again. Chat, sheets, notes, files and the timeline are stored unencrypted, so protect the volume and its backups accordingly.

## Moving rooms between servers

**Export room** (room header) makes an encrypted `.warroom` archive of everything in the room: chat, sheets, notes, files, timeline, schedule, members. Admins restore it with **Restore a room** on the dashboard of any War Room; it becomes a new incident there, with people matched by username or email.

From the server:

```
docker compose exec -e WARROOM_EXPORT_PASSPHRASE app node server/dist/room-cli.js export --all --out /data/exports
```

```
docker compose exec app node server/dist/room-cli.js import FILE
```

Archives are encrypted with a key derived from the passphrase (scrypt) and authenticated with AES-256-GCM, so tampering is detected. Keep the passphrase somewhere other than the server.

## Setup and recovery links

- With no admin yet, the server prints a **setup link** at startup (valid 24 hours, works once).
- If sign-in is misconfigured and nobody can get in, get a new one-hour admin link on the server:

  ```
  docker compose exec app node server/dist/setup-link.js
  ```

  (or `npm run setup-link -w server` outside Docker; `bash warroom-now.sh link` for a War Room NOW).
- Only someone with access to the server or its logs can get these links, and each use is in the activity log. Treat shell access to the server as admin access to War Room.

## Upgrades

```
docker compose pull && docker compose up -d
```

Pin a version with `WARROOM_VERSION=1.0.0`. Database changes are applied automatically at startup and are additive, so upgrading doesn't need a manual migration. Back up the volume first anyway.

## War Room NOW commands

| Command | What it does |
|---|---|
| `bash warroom-now.sh up` | First run asks questions and starts; later runs start with the saved answers |
| `bash warroom-now.sh link` | A one-time admin link |
| `bash warroom-now.sh status` | Containers and rooms |
| `bash warroom-now.sh export` | Encrypted archive of every room into `./exports/<time>/` |
| `bash warroom-now.sh import FILE` | Restore a room archive |
| `bash warroom-now.sh firewall` | Change which IP addresses may connect (UFW) |
| `bash warroom-now.sh down` | Offers an export, then destroys containers and data |

Full guide: [War Room NOW](../WARROOM_NOW.md).

## Troubleshooting

| Problem | Check |
|---|---|
| Certificate invalid, or the site doesn't load | The A record points at this server (`dig +short your.domain`); TCP 80 and 443 are open; `docker compose logs caddy`. |
| Voice or screen share won't connect | UDP 50000–50100 and TCP 7881 are open to the internet; the browser is on HTTPS. |
| Codes aren't arriving | Settings → Email → **Test**, then Integrations → **Send test email**; check spam. Meanwhile hand out codes from the room (**New code**, **New sign-in code**). |
| Sign-in fails after an IdP change | Settings → Okta / Entra → **Test**. For SAML, check the certificate's expiry. Locked out: use a recovery link. |
| Moderation (mute, move, remove) fails | Settings → Voice → **Test**; the server must reach LiveKit's API address. |
| Anything else | `docker compose logs app` |

Next: [Security model](Security-Model.md).
