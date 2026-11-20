# Integrations

[← Wiki home](Home.md)

Connect integrations in **Admin → Integrations**, then use them from **Investigate** in any war room. Every search is shared with the room and recorded on the incident timeline with who ran it.

| Integration | Credentials | What it does |
|---|---|---|
| **Okta** | Org URL + API token from a **Read-Only Administrator** service account | Person lookup, System Log search, live watch of a person's activity |
| **Sumo Logic** | Deployment API endpoint + Access ID / Key for a role that can search | Log searches from editable starter queries |
| **CrowdStrike Falcon** | Falcon cloud + API client ID / secret with **Hosts: Read** and **Alerts: Read** | Host lookup, alerts, tracked endpoints |
| **Email (SMTP)** | Set in Settings → Email | Status card and a **Send test email** field |

## Read-only by design

Integrations only need read scopes, and **nothing is written back**: War Room never suspends a user, clears a session or contains a host. Containment you do in Falcon shows up in the room within a minute.

Anything a responder types that goes into a provider query (an Okta filter, a Falcon FQL filter) is validated and quoted, never pasted in raw. Links from provider data are only shown if they're `https://`.

## Who can search

Per integration, choose who can run searches:

- everyone in the war room
- **incident role holders and admins** (default)
- admins only

Searches can expose a person's activity, which is why each one goes on the timeline.

## Okta

- **Person:** status, MFA factors, groups, last sign-in, last password change.
- **System Log search** with quick filters: failures, MFA changes, password resets, admin privilege changes, SSO.
- **Live watch:** follow a person's Okta activity. War Room polls every 30 seconds and posts new events into `#okta-watch`.

## Sumo Logic

- Runs searches through the Search Job API, returning up to 500 rows.
- **Starter queries** with placeholders `{{ip}}`, `{{user}}`, `{{hash}}`, `{{host}}`, `{{domain}}`, filled with suggestions taken from the incident's sheets (for example the IOC Tracker).
- Queries marked **auto-run** start when an incident is declared.
- Results can be copied into a sheet or posted to a channel.

## CrowdStrike Falcon

- Find hosts by name, IP or device ID; list alerts by host, severity and time.

### Tracking endpoints

In **Investigate → CrowdStrike**, enter a hostname, IP or device ID (hosts and IPs from the incident's sheets are suggested) and click **Track endpoint**. If the name matches several hosts, you pick one. Each tracked endpoint can have an **owner** and a **note**.

- Every minute War Room reads each tracked endpoint. Changes (online/offline, network containment, last signed-in user, IP addresses, reduced functionality mode) and new alerts are posted to `#crowdstrike-watch` in plain words, naming the owner.
- When tracking starts, the last 24 hours of alerts are summarised in one message instead of posted one by one.
- High and critical alerts, containment changes, tracking started or stopped and owner changes go on the timeline.
- The endpoint panel shows the host's details and every alert seen while tracked (description, command line, hash, link back to Falcon). The history stays after tracking stops.

## Pollers stop on their own

Okta watches and tracked endpoints stop when the incident is resolved or the integration is turned off. They cap how much they post per poll, and record errors on the watch instead of failing.

## Credentials

Stored encrypted with AES-256-GCM, using a key derived from the server's generated session secret (or `INTEGRATIONS_KEY` if set), and never returned to browsers.

AI agents can run these searches too, if the person approving them allows it; see [AI agents](AI-Agents.md).

Next: [AI agents (MCP)](AI-Agents.md).
