# War Room wiki

War Room is a self-hosted space for running IT and security incidents: voice rooms with screen sharing, chat, sheets, notes, files and evidence, a shift schedule and a timeline for every incident, with Okta / Microsoft Entra ID sign-in and safe guest access.

This wiki explains each feature and setting in depth. For a short overview with screenshots, see the **[showcase](../SHOWCASE.md)**.

## Pages

| Page | What's in it |
|---|---|
| [Getting started](Getting-Started.md) | Try it locally, install it permanently, or stand up a temporary War Room; the first admin |
| [Running an incident](Running-an-Incident.md) | Declaring, severity and status, roles, Incident Command, room admins, voice and screen share, channels, mentions, assignments, tasks, away, sounds |
| [Sheets, notes, files and the timeline](Working-Together.md) | The spreadsheet and its templates, Markdown notes, files and evidence, the in-app viewer, the timeline, the shift schedule, the postmortem export |
| [People and access](People-and-Access.md) | Responders, guests, single-use invites, asking to join from the room link, codes, getting people back in, who can do what |
| [Sign-in and provisioning](Sign-in-and-Provisioning.md) | Okta, Entra ID (OIDC and SAML), SCIM, sign-in with an emailed code, how accounts are matched, admins |
| [Settings reference](Settings-Reference.md) | Every field in Admin → Settings, and the few environment variables that remain |
| [Integrations](Integrations.md) | Okta, Sumo Logic and CrowdStrike in the Investigate view, live watches, tracked endpoints, who can search; outbound webhooks to Slack, Discord, Mattermost, Teams |
| [AI agents (MCP)](AI-Agents.md) | Connecting Claude and other agents with sign-in or a room key, the tools they get, who sees and disconnects them, security |
| [Operations](Operations.md) | Docker deployment, ports and DNS, backups, moving rooms between servers, setup and recovery links, upgrades, troubleshooting |
| [Security model](Security-Model.md) | What's protected and how: guests, sign-in, codes and links, files, secrets, audit trail, known limits |

## Words used here

| Term | Meaning |
|---|---|
| **Incident** / **room** / **war room** | One incident and everything in it. Each has a key such as `INC-0004`. |
| **Incident Commander (IC)** | The person in charge of the incident. Runs the room. |
| **Room admin** | Someone the IC appoints to help run the room. |
| **App admin** | A War Room administrator (Admin console). Can run any room. |
| **Responder** | A full member of your team with a War Room account. Sees the whole room. |
| **Guest** | Someone from outside (vendor, outside IR firm, counsel) who sees only what their invite grants, for a limited time. |
| **Main Bridge** / **breakout** | The incident's main voice room, and any extra voice rooms. |
| **AI agent** | An app such as Claude connected over MCP. It acts for one person, and what it writes shows that person's name with an *AI agent* tag. |
| **War Room NOW** | A temporary War Room for one incident, with no identity provider (`WARROOM_MODE=now`). |

## Other documents

- [README](../../README.md): features, install and licensing
- [War Room NOW guide](../WARROOM_NOW.md): a temporary War Room in ten minutes
- [Design brief](../CLAUDE_DESIGN_PROMPT.md): screens and states for designers
