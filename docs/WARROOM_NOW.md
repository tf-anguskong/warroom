# War Room NOW: a temporary War Room in ten minutes

War Room NOW stands up a complete War Room (voice rooms, chat, sheets, notes, timeline, files, schedule) on any Linux server, for one incident. When the incident is over you export the rooms to an encrypted file, destroy the server, and nothing is left behind. Later you can restore those rooms on any other War Room.

There's no identity provider to connect. You become the admin with a one-time link; everyone else joins with an invite link plus a 6-digit code.

```
curl -fsSLO https://raw.githubusercontent.com/tf-anguskong/warroom/main/warroom-now.sh
bash warroom-now.sh up
```

---

## 1. What you need

| | |
|---|---|
| **A Linux server** with a public IP address | Any cloud VM works. 2 vCPU / 4 GB RAM is plenty for a few dozen people; add more for heavy screen sharing. |
| **Docker** with the Compose plugin | `curl -fsSL https://get.docker.com \| sh` on most distributions. Check with `docker compose version`. |
| **A DNS name pointing at the server** | An **A record** for e.g. `warroom.example.com` → the server's public IPv4 address (and an AAAA record if it has IPv6). Caddy uses it to get a free HTTPS certificate from Let's Encrypt automatically. **Browsers only allow microphones and screen sharing over HTTPS**, so this isn't optional. No DNS name? See [No domain?](#no-domain) below. |
| **Open firewall ports** | TCP **80** and **443** (web and certificate), TCP **7881** and UDP **50000–50100** (voice and screen-share media). Open them in your cloud provider's security group or network firewall. The script sets up the server's own firewall (UFW) for you; see [Firewall and IP allowlist](#firewall-and-ip-allowlist). |
| **Email (optional)** | An SMTP account (Microsoft 365, Google Workspace relay, Amazon SES, SendGrid, Mailgun, Postmark…) lets War Room email the 6-digit codes itself. Without it, the codes are shown to whoever sends the invite and they pass them on. See [Codes without email](#3-inviting-people). |

### Setting the DNS record

In your DNS provider (Cloudflare, Route 53, GoDaddy, …) add:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `warroom` (or the full `warroom.example.com`) | your server's public IPv4, e.g. `203.0.113.10` | 300 |

If you use **Cloudflare**, set the record to **DNS only** (grey cloud), not proxied: the voice traffic can't go through Cloudflare's proxy.

Check it before starting: `dig +short warroom.example.com` (or `nslookup`) should print the server's IP. Certificates fail if the name doesn't resolve to this server yet, or if port 80 is blocked.

### No domain?

The script offers `203-0-113-10.sslip.io` (your IP with dashes). [sslip.io](https://sslip.io) is a free public DNS service that answers with the IP written in the name, so it works immediately and Caddy can get a real certificate for it. Good for a quick test or an emergency. Trade-offs: the name reveals your server's IP, it depends on a third-party service, and Let's Encrypt limits how many certificates are issued for shared names like this. Use your own domain for anything that matters.

---

## 2. Start it

On the server, in an empty folder:

```
curl -fsSLO https://raw.githubusercontent.com/tf-anguskong/warroom/main/warroom-now.sh
bash warroom-now.sh up
```

(Or clone the repository and run `./warroom-now.sh up` from it; then it can also build the image from source if the registry is unreachable.)

The script asks:

1. **Domain**: the DNS name from step 1 (it suggests the sslip.io name).
2. **Your email**: pre-filled on the admin setup page; also how you'll sign back in later.
3. **SMTP server** (press Enter to skip): host, port (587 for STARTTLS, 465 for TLS), username, password, from address.
4. **Firewall (UFW)**: turns UFW on if it's off (keeping SSH open), then asks **which IP addresses may connect**: a comma-separated list of addresses or ranges, or blank for everyone. See below.

It then downloads the three files Docker needs (`docker-compose.yml`, `Caddyfile`, `livekit.yaml`), pulls the War Room image from `ghcr.io/tf-anguskong/warroom`, starts War Room, LiveKit (voice) and Caddy (HTTPS), waits until it's healthy, and prints:

```
War Room is up: https://warroom.example.com
One-time admin link (works once, until 2026-11-19 11:42Z):

  https://warroom.example.com/setup/Qm9...
```

### Firewall and IP allowlist

The allowlist lives in the server's own firewall, **UFW** (it needs `sudo`):

1. **UFW on.** If UFW isn't installed, the script offers to install it. If it's off, it offers to turn it on, after allowing the SSH port you're connected on so you can't lock yourself out. Incoming connections are blocked by default from then on.
2. **Who can connect.** The script asks:

   ```
   Allowed addresses: 203.0.113.7, 198.51.100.0/24, 2001:db8::/32
   ```

   - **Blank** (the default): War Room's ports are open to everyone. People still need an invite link *and* a code to get in.
   - **A list:** only those addresses (single IPs or CIDR ranges, IPv4 or IPv6) can reach War Room's web pages and voice. Everyone who joins, guests included, must come from a listed address, so include your office or VPN egress ranges and any outside firm's addresses. The script shows the address you're connected from, as a reminder to include it.
   - **Port 80 stays open to everyone**, because Let's Encrypt has to reach it to issue and renew the certificate. It only redirects to HTTPS.

The result is ordinary UFW rules, each tagged `warroom-now`, so you can see them with `sudo ufw status` and UFW keeps them across reboots:

```
80/tcp                     ALLOW       Anywhere          # warroom-now
443/tcp                    ALLOW       203.0.113.7       # warroom-now
7881/tcp                   ALLOW       203.0.113.7       # warroom-now
50000:50100/udp            ALLOW       203.0.113.7       # warroom-now
443/tcp                    ALLOW FWD   203.0.113.7       # warroom-now
…
50000:50100/udp            DENY FWD    Anywhere          # warroom-now
```

Change the list any time with `bash warroom-now.sh firewall`: press Enter to keep it, type a new list, or type `all` to allow everyone again. An invalid address changes nothing.

**Why there are "FWD" rules.** Docker's published ports normally bypass UFW completely, so a plain UFW rule wouldn't stop anyone. The script adds the widely used [ufw-docker](https://github.com/chaifeng/ufw-docker) block to `/etc/ufw/after.rules` (marked, with a backup at `after.rules.warroom-now.bak`), which sends Docker's traffic through UFW's *route* (FWD) rules. That's why each allowed address has both a normal rule and a FWD rule. Side effect: other Docker containers on this server also need UFW `route allow` rules for their published ports, which is fine on a dedicated War Room server.

**On `down`**, the script removes every `warroom-now` rule and the after.rules block. UFW stays on, and the SSH rule stays.

**firewalld instead of UFW?** The script won't change firewalld; allow the ports there yourself and put the allowlist in your cloud firewall.

Your cloud provider's firewall or security group is separate and the script can't change it. Open the same ports there; you can also put the same allowlist there for a second layer.

Your answers are kept in `.warroom-now` next to the script (readable only by you) so later commands know the domain. The SMTP password is in there too; it's deleted by `down`.

### Become the admin

Open the admin link. Enter your name and email and you're signed in as the admin. The link works once; if you lose it before using it, run `bash warroom-now.sh link` for a new one.

> **Why a link and not "first person to sign in is admin"?** Your server is on the internet from the moment it starts. Anyone who found the address before you (scanners do this within minutes) would become the admin. The link is printed only on your server's console, so only you can use it.

### Start or restore a room

After setup you land on **War Room is ready**:

- **Start a new room**: what's happening and the severity. The room opens with an IOC tracker and action items sheet.
- **Restore a room**: upload a `.warroom` archive exported from any War Room, enter its passphrase, check what's inside, and restore it. See [Bring a room back](#6-bring-a-room-back).

If you skipped email, a notice reminds you that codes will be shown to you instead of emailed. You can add SMTP any time under **Admin → Settings → Email** (the **Test** button checks it before saving).

---

## 3. Inviting people

In the room's top bar, **Invite** creates a single-use link. For a responder you can add their team or title (for example "Network team · Firewall engineer"); it shows under their name in the room's People list. Choose:

| | **Responder** | **Guest** |
|---|---|---|
| For | your own team | vendors, outside IR firms, counsel |
| Sees | the whole room | only the channels, voice rooms, sheets and notes you tick |
| Account | a War Room account (their email) that can sign in again later | temporary; access ends after 2–72 hours, or when the room is resolved, or when you end it |
| Can | take roles and tasks, run the room if made IC or room admin | chat, talk and edit what they were given |

The Incident Commander and room admins can invite responders as well as the admin. Every invite is its own single-use link, so make one per person.

### The room link: asking to join

The room's own link (*Copy war room link* in the top bar) can go anywhere: a chat channel, a bridge invite, an email to a group. On its own it only lets someone **ask**:

1. People with an account sign in and go straight into the room.
2. Anyone else chooses **Ask to join** and gives their name, email, team and why. Their page waits.
3. You see the request at the top of the right pane, with a sound. Choose **Let in as responder**, **As guest…** (tick what they can see and for how long), or **Turn down**.
4. Their page moves on by itself to their own single-use invite. With email set up they confirm their address with a code; without email they go straight in.

The page shows only the incident key, not the title. Requests expire after 30 minutes. Who you let in or turned down is on the timeline. If you can't tell who's asking, check with them another way before letting them in.

### How people prove it's them

Every invite needs **the link plus a 6-digit code**, so a forwarded or intercepted link alone gets nobody in.

- **With email set up:** they open the link, click *Email me a code*, and type the code from the email. Codes last 10 minutes, work once, and lock after 5 wrong tries.
- **Without email:** when you create the invite, War Room shows you the code along with the link. **Send them by different routes**: for example the link by email or chat and the code by text message or a phone call. The code lasts as long as the link and locks after 5 wrong tries. Lost it? Click **New code** next to the invite.

Invites, joins and new codes are all recorded on the incident timeline.

### Signing back in later

Sessions last 12 hours by default (Admin → Settings → General). To get back in:

| Who | With email | Without email |
|---|---|---|
| **Responder** | Sign-in page → *Email me a sign-in code* | The IC or a room admin opens **⋯ → New sign-in code** on them in the room's People list (or an admin uses **Admin → People → Sign-in code**). They choose *I already have a code* on the sign-in page. |
| **Guest** | Open the original invite link again → *Email me a code* | The IC or a room admin opens **⋯ → New sign-in code** on them in People (or **Sign-in code** in Guests). That gives a **new link** and a code; the old link stops working. |
| **You (admin)** | Sign-in page → email code | `bash warroom-now.sh link` on the server prints a one-time admin link. |

Codes from the room work once, for 30 minutes, and replace any earlier code. They're for people who dropped off (network trouble, a closed laptop, a new device) and can't get back in alone. Only an app admin can make one for an admin or for the Incident Commander, so a room admin can't take over those accounts. Every code made is on the timeline.

The timeline also records **comings and goings**: who came into the room, joined, moved between or left voice rooms, and left. A change is written once it has lasted 20 seconds, so a page reload isn't logged, but a real drop is (at the time it happened). Use the timeline's **Comings & goings** filter to see them; they're in the export too.

---

## 4. During the incident

Everything in War Room works as usual: voice rooms and breakouts, chat with mentions and screenshots, sheets, Markdown notes, files and evidence (with SHA-256 hashes), the timeline, the shift schedule, and **Who's doing what**.

A yellow banner reminds everyone this server is temporary. **Export early and often**, not just at the end: an export is a snapshot, and you can make as many as you like.

- In the room: **Export room** (top bar or the banner). Choose a passphrase (at least 10 characters). The file downloads to your computer, and its SHA-256 is shown and recorded on the timeline.
- On the server, every room at once: `bash warroom-now.sh export`.

---

## 5. Tear it down

```
bash warroom-now.sh down
```

1. It offers to **export every room** first. Answer yes unless you already have current exports.
2. It asks you to **type the domain** to confirm.
3. It deletes the containers **and all War Room data on the server** (database, files, settings, certificates) and the `.warroom-now` file.

Your exports stay in `./exports/<time>/` on the server, with a `SHA256SUMS` file. **Copy them off before you destroy the server**, for example from your own machine:

```
scp -r user@warroom.example.com:~/warroom/exports/20261119-104200Z ./warroom-exports
cd warroom-exports && sha256sum -c SHA256SUMS
```

Then delete the server in your cloud console and remove the DNS record.

### Keep the passphrase

Exports are encrypted with AES-256-GCM using your passphrase. **Without it nobody can open them, including you.** Store it in your password manager next to where you keep the files. (An unencrypted export exists, `export --plain`, for when the files will be protected some other way; it's flagged on the timeline.)

---

## 6. Bring a room back

On any War Room (a new War Room NOW, or a permanent install):

- **In the browser:** admin → dashboard → **Restore a room** (or the *Restore a room* card right after setup). Upload the `.warroom` file, enter the passphrase, check the summary (incident, when and where it was exported, how many messages, files and people), and click **Restore**.
- **On the server:** `bash warroom-now.sh import ROOM.warroom` (asks for the passphrase).

The room comes back as a new incident with the next number on that server, with everything in it: chat (with mentions and attachments), timeline, sheets, notes (with their images), files and evidence (hashes checked), schedule, roles, assignments and investigation results. People are matched by username or email; anyone not found gets an account (responders can sign in with a code; guests come back without access). The timeline records where the room was restored from.

If the archive was changed in any way, or the passphrase is wrong, nothing is imported.

---

## Command reference

| Command | What it does |
|---|---|
| `bash warroom-now.sh up` | First run: asks questions and starts. Later runs: starts again with the saved answers (and pulls a newer image if there is one). |
| `bash warroom-now.sh link` | Prints a one-time admin link (for the first admin, or to get back in). |
| `bash warroom-now.sh status` | Shows the containers and the rooms. |
| `bash warroom-now.sh export` | Encrypted archive of every room into `./exports/<time>/`. `export --plain` for unencrypted. |
| `bash warroom-now.sh import FILE` | Restores a room archive. |
| `bash warroom-now.sh firewall` | Changes which IP addresses may connect (UFW rules tagged `warroom-now`). |
| `bash warroom-now.sh down` | Offers an export, then destroys containers and data, and offers to remove War Room's UFW rules (UFW and SSH stay on). |

Pin a release with `WARROOM_VERSION=1.0.0 bash warroom-now.sh up` (default `latest`).

---

## Troubleshooting

| Problem | Check |
|---|---|
| Browser says the certificate is invalid, or the site doesn't load | The A record must point at this server (`dig +short your.domain`) and TCP 80 and 443 must be open. Caddy's log: `docker compose -p warroom-now logs caddy`. Let's Encrypt can take a minute; after several failures it pauses for a while. |
| Someone gets "can't connect" or a timeout | If you set an IP allowlist, their public address must be on it: they can check it at a site like ifconfig.me. Add it with `bash warroom-now.sh firewall`. Blocked attempts show in the system log as `[UFW DOCKER BLOCK]` or `[UFW BLOCK]`. |
| Voice or screen share won't connect, or connects with no sound | UDP 50000–50100 and TCP 7881 must be open to the internet. Some corporate networks block UDP entirely; War Room NOW doesn't include a TURN relay yet, so people on those networks may not get voice (chat and everything else still work). |
| Codes aren't arriving | Admin → Settings → Email → **Test**, then Admin → Integrations → **Send test email**. Check spam. Meanwhile use **New code** / **Sign-in code** to hand codes out yourself. |
| Lost the admin link / locked out | `bash warroom-now.sh link` on the server. |
| `up` says the image can't be pulled | The server needs outbound HTTPS to `ghcr.io`. From a clone of the repository, `up` builds the image locally instead. |
| Something else | `docker compose -p warroom-now logs app` shows War Room's log. |

---

## Security notes

- Everything is served over HTTPS; voice media is encrypted by WebRTC (DTLS-SRTP).
- Invite links are single-use, are stored only as hashes, and need a code as well. Codes are hashed, expire, and lock after 5 wrong attempts. Guests are deny-by-default.
- Exports are encrypted with a key derived from your passphrase (scrypt) and authenticated, so any change to the file is detected.
- `down` deletes the data volumes. If your cloud provider snapshots disks, delete the snapshots too. For high-sensitivity incidents, destroy the whole VM rather than reusing it.
- The admin link and `.warroom-now` (which holds the SMTP password) only exist on the server. Treat shell access to the server as admin access to War Room.

---

## Status: what's done and what isn't

**Done and tested** (automated end-to-end tests on a production-mode server):

- quick mode with no SMTP: setup link → admin → start page → responder and guest invites with codes shown to the inviter → joining → new codes → admin sign-in codes → signing back in (33 checks)
- room export and import across two servers: encryption, wrong passphrase, tamper detection, people matching, files and hashes, re-importing (25 checks)
- command-line export of every room and import on a fresh server
- emailed codes against a real SMTP server with STARTTLS and login (from the guest-email work)

**Not done yet:**

- **The firewall step on a real server.** Turning UFW on with SSH kept, the ufw-docker link, the allowlist rules (IPv4 and IPv6), keeping and clearing the list, rejecting bad input, and cleanup on `down` are tested in an Ubuntu container (19 checks). Blocking real traffic to Docker on a cloud VM hasn't been tried yet.
- **A full `warroom-now.sh` run on a real cloud server** with real DNS and Let's Encrypt. The image builds and the pieces are tested individually, but the whole script hasn't been run end to end on a public server.
- **Emailed codes for responders and email sign-in** use the same email code path as guests, but haven't been run against a real mail provider in quick mode.
- **TURN relay** for networks that block UDP (see Troubleshooting).
- **Scheduled automatic exports** (for example every hour to an S3 bucket). Today exports are manual.
- **One-click teardown from the browser.** Teardown is `bash warroom-now.sh down` on the server.
- **Restricted rooms** and **pre-built playbooks** for common incident types.
