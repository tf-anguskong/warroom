# Claude Design prompt — IR War Room

Copy everything below the line into Claude Design.

---

Design the full UI for **War Room**, a self-hosted web app where IT and security teams run live incident response. Each incident gets its own "war room": voice bridge, breakout voice rooms, text channels, a built-in spreadsheet for tracking evidence and actions, and an auto-built incident timeline. Think "the bridge of a ship during an emergency": calm, dense, very readable, nothing decorative that competes with information.

## Who uses it and when

- Incident Commanders, security analysts, SREs/sysadmins, network engineers, comms/PR leads, legal, and executives who drop in for status.
- Used under stress, often at 2–4 a.m., for hours at a time, frequently on a second monitor next to terminals, SIEMs and dashboards. Many users are on headsets talking while they type.
- 3–40 people per incident; some arrive mid-incident and need to catch up in under a minute.
- Design goals, in priority order: (1) instant situational awareness (what's the severity, status, who's in charge, who's talking, where should I be); (2) low-friction moving between voice rooms and channels; (3) information density without clutter; (4) zero ambiguity in destructive or status-changing actions.

## Visual direction

- **Dark theme first** (default), with a complete light theme. Low-glare dark neutrals (not pure black), restrained accent color, generous contrast for text (WCAG AA minimum, AAA for body text in dark mode).
- Utilitarian, "mission control" feel — closer to Linear/Grafana/a cockpit than to a consumer chat app. No gradients-for-decoration, no illustrations in the working views.
- Typography: a highly legible sans for UI, a monospace for IDs, IPs, hashes, timestamps, code blocks and spreadsheet cells that hold indicators. Tabular numerals everywhere numbers align.
- Timestamps shown in both local time and UTC (UTC is the canonical incident clock); a small always-visible incident clock and "time since declared" counter.
- **Severity colors** (must stay distinguishable for color-blind users — pair each with a label/shape, never color alone): SEV1 critical (red), SEV2 high (orange), SEV3 moderate (amber/yellow), SEV4 low (blue).
- **Status** values: Investigating → Identified → Mitigating → Monitoring → Resolved. Show as a compact stepper/pill; Resolved should feel visibly "calmer".
- Deliver design tokens as CSS custom properties (colors, spacing, radius, type scale, elevation, z-index, motion) so they can be dropped into `:root` and a `[data-theme="light"]` override.

## Screens to design

1. **Sign-in** — one button per configured identity provider: "Sign in with Okta" and/or "Sign in with Microsoft" (Entra ID; follow Microsoft's sign-in button guidelines). Either may be the only one, so design one-button and two-button versions. A secondary, visually de-emphasized developer name/email login that only appears in dev builds. Error states: not assigned to the app in Okta/Entra, account from a different Entra directory, account deactivated, SSO unavailable, session expired, server unreachable.

2. **Incident dashboard** — list of active incidents as cards or dense rows: incident number (INC-0042), title, severity, status, Incident Commander avatar, age, number of people currently in the room, and a live "people talking now" indicator. Filters: Active / Resolved / All, severity. Prominent **Declare incident** button.

3. **Declare incident modal** — title, severity picker, short summary, and checkboxes for starting spreadsheet templates (IOC Tracker, Affected Assets, Action Items, Comms Log). Should be completable in ~10 seconds.

4. **War room (the core screen)** — three-column layout, resizable/collapsible side panels:
   - **Header bar**: INC number, editable title, severity and status controls, incident clock, IC name, share link, "Export postmortem" action, leave room.
   - **Left sidebar**:
     - *Voice rooms*: "Main Bridge" pinned at top, then breakout rooms (e.g. "Forensics", "Network Containment", "Exec Briefing"). Each shows who's inside (avatars that light up when speaking, mute icon, screen-share icon). One-click join/switch. "+ Breakout room".
     - *Channels*: text channels. A channel can be attached to several voice rooms, and can be **shared from another incident** — show a clear badge like "↗ shared from INC-0039". Unread counts, mention badges.
     - *Sheets*: list of spreadsheets in the incident. "+ New sheet" with template picker.
     - *Timeline* entry.
   - **Center (main view)** shows one of: a channel, a sheet, or the timeline. When anyone in my current voice room shares their screen, a **screen-share stage** appears at the top of the center area (collapsible, can go full-screen, shows who's sharing; handle multiple simultaneous shares as tiles).
   - **Right panel**, tabbed:
     - *Incident*: summary, roles (Incident Commander, Scribe, Comms Lead, Tech Lead, Security Lead — each assignable to a person, "unassigned" should look like a gap that needs filling), people present with which voice room they're in, pinned messages.
     - **Room control**: the IC and appointed **room admins** run the room (assign roles, change severity/status, move people between voice rooms, mute or remove them from voice). Show a "Room admins" list with add/remove, and make controls that the viewer can't use visibly read-only (not hidden) with a short reason. Moderators can **drag a person's avatar onto another voice room** to move them (show a clear drop target) or use a ⋯ menu on the person: Move to…, Mute microphone, Remove from voice. The moved/muted person gets a toast saying who did it.
     - *Chat*: a second chat view so someone can keep a sheet in the center and chat on the right at the same time.
   - **Voice control dock** (bottom of left sidebar or bottom bar, always visible while connected): current room name, connection quality, mute, deafen, screen share, device settings, leave. Muted state must be impossible to misread. Also show a "listen-only (no microphone)" state.

5. **Channel view** — message list optimized for technical content: inline code and multi-line code blocks with copy buttons (people paste logs, commands, hashes), links, **@mentions** (people, roles like `@Incident Commander`, and `@here`; mentions of me are highlighted and the message gets a side marker; the composer shows an autocomplete list with avatars, role holders and who's in which voice room; channels with unread mentions show an @ badge distinct from the unread count), system messages (e.g. "Alex joined Forensics", "Severity raised to SEV1"). Hover actions: pin, **add to timeline** (mark as decision / action / finding), copy link. Composer: Enter sends, Shift+Enter newline, paste-friendly.

6. **Native spreadsheet view** — a real grid, not a form:
   - Column letters (A, B, C…) and row numbers, sticky header row and first column, keyboard navigation (arrows, Tab, Enter to edit, Esc), visible selection.
   - Typed columns: text, number, single-select (colored chips, e.g. IOC status New / Investigating / Blocked / False positive), date-time, person (avatar + name), checkbox. Formulas with `=` (SUM, COUNT, COUNTIF, IF…) — show formula in an edit bar above the grid, result in the cell, and a clear error-cell style (#REF, #DIV/0, #CIRC).
   - **Live multi-user presence**: other people's selected cells shown as colored outlines with their name tag; a row of avatars of who's viewing the sheet.
   - Column header menu: rename, change type, edit select options, delete. Add row / add column affordances. Export CSV.
   - Sheet tabs or a sheet switcher when an incident has several sheets.

7b. **Guests and command** — (a) An **Incident Command** card at the top of the right pane: current IC with avatar, "Hand off" (for the IC) / "Reassign" + "Take command" (for others), opening a dialog with the new IC and a handoff note. (b) A **Guests** section: active guests with org, who invited them, when access ends, what they can see, and Change access / End access; unused invite links with Cancel. (c) **Invite dialog**: name, organization, reason, a checklist of channels / voice rooms / sheets / timeline (nothing included unless ticked), link lifetime, access duration; then a one-time "copy this link now" screen. (d) **Join page** for the guest: incident key, severity, title, who invited them and why, what they'll be able to see, their display name, then an **email code step**: masked address, "Email me a code", a large 6-digit code field (one-time-code autofill), resend with a countdown, clear errors for wrong / expired / locked codes. A returning guest sees a "Welcome back, sign in" variant of the same page. Admin → Integrations gets an "Email (SMTP)" status card with a test-send field. Dead-link states: used, expired, cancelled, incident resolved. (e) Guests must be **unmistakable**: a distinct GUEST tag (with org) next to their name everywhere — chat, voice list, people, roster, mention list — and the guest's own view shows a slim banner with when their access ends; their sidebar only lists what they were granted.

7a. **Who's doing what (accountability view)** — the answer to "who is on what, where are they, and what are they doing right now". Top: workstream cards (each voice room, plus channels with people assigned): objective (a missing objective or lead should read as a gap to fill), lead, assigned people's avatars with the absent ones faded, "3 of 4 here", Assign button for the IC/room admins. Below: a dense people table: person + roles, assignment chips (lead marked), where they are now (voice room / which view), what they're working on (with "set by X, 12m ago", inline edit), and attention flags with a fix button ("In Main Bridge, assigned to Forensics → Move"; "Assigned but not in the war room"; "No assignment"; "Task not updated for 45m"). The sidebar also shows assigned-but-absent people under each voice room, a "lead" tag, a "you" tag on rooms and channels you're assigned to, and the room's objective. The assign dialog: objective, people checklist with where each person is and what else they're on, one Lead radio, "move them now" option.

7. **Timeline view** — vertical chronological log for the postmortem: auto-generated entries (incident declared, severity/status changes, role assignments, breakout rooms opened, people joining) visually quieter than human-added entries (notes, decisions, actions, findings, pinned messages). Each entry: UTC timestamp, author, type icon, text, link back to the source message. Filter by type. "Add entry" inline form that allows back-dating ("this started at 01:12 UTC"). Export to Markdown.

8. **Admin panel** — three tabs (People, Integrations, Settings):
   - *Settings*: all server configuration lives here; there is no config file. Left: section list with an on / off / incomplete dot (General, Okta, Microsoft Entra ID, Provisioning (SCIM), Email, Voice (LiveKit)). Right: one form per section. Each sign-in section has a "copy these into your identity provider" box (redirect URIs, SAML identifier and reply URL) that follows the protocol picked in the form. Secret fields are write-only ("saved; type to replace", plus Remove). A **Test** button checks the values in the form before saving and shows the result inline (reached the issuer, certificate subject and expiry, SMTP login OK, LiveKit reachable). Save says the change is in effect now; Discard and "Reset to defaults" (with a confirm). Fields that came from a server environment variable carry a small "from environment" tag. SCIM: "Generate token" shows the token once in a dialog with copy. Read-only fields explain why (development sign-in in production; LiveKit keys managed automatically).
   - *Setup page* (outside the app, same look as sign-in): reached by a one-time link the server prints on first start or on demand. Name, work email, the public address (prefilled from the browser), "Create admin and continue" → lands on Settings. A recovery variant says it signs you in as an admin to fix sign-in. Dead-link states: used, expired, invalid.
   - *People*: users provisioned from Okta or Entra ID via SCIM (active/deactivated, last sign-in, local vs SSO account). Admins can **make someone an admin / remove admin**, and deactivate local accounts, each behind a confirm dialog. Distinguish admin granted in the app from admin inherited from an Okta or Entra group (the latter can only be changed there). Show which identity providers each person has signed in with. Show an admin activity log. Users are created in the identity provider, so make it obvious this page is not where you add people.
   - *Integrations*: connect **Okta** and **Sumo Logic** (cards for available integrations, a list of connected ones with last connection-test result, enable/disable, edit). The edit dialog has write-only credential fields ("saved — leave blank to keep"), a "who can run searches" setting, and for Sumo Logic an editable list of **starter queries** with placeholders like `{{ip}}` and an "auto-run when an incident is declared" toggle.

9. **Investigate view (in the war room)** — where responders query external systems without leaving the room:
   - Left: a form per integration (tabs: Okta, Sumo Logic). Okta: person field, quick filter (sign-ins, failures, MFA changes, password resets, admin privilege changes), time range, "performed by them / mentions them", buttons for **Search System Log**, **Look up profile**, **Watch live**; a list of live watches. Sumo: starter query cards, variable inputs with **suggestion chips pulled from the incident's IOC sheet**, editable query (monospace), time range, Run.
   - Right: a shared list of **every search run in this incident** (who, when, status: running / done / failed, result count) and a result viewer: dense monospace table with sticky header, filter box, failed-auth rows highlighted; or a **person profile card** (status, last sign-in, password changed — flagged if recent, MFA factors — flagged if newly enrolled, groups). Actions: copy to a new sheet, add to timeline, share to a channel.
   - It must feel safe and accountable: searches expose colleagues' activity, so make it visible that everyone in the room can see who searched what.

## States and edge cases to cover

- Empty states: no active incidents (a good thing — make it feel calm), empty channel, empty sheet, empty timeline.
- Voice: connecting, reconnecting, connection lost, mic permission denied, someone speaking, many people speaking, 30+ people in one room (avatar overflow).
- Severity escalation moment (SEV3 → SEV1): the header should change noticeably without being an alarm that never stops.
- Being removed: user deactivated in Okta or Entra mid-session → graceful "your access was revoked" screen.
- Loading skeletons for channel history and sheets; offline/reconnecting banner for the realtime connection.
- Resolved incidents are read-mostly: the room still opens, but the UI signals it's closed.

## Interaction notes

- Keyboard-first: command palette (Ctrl/Cmd+K) to jump to any room, channel or sheet; push-to-talk key optional; shortcut for mute (Ctrl/Cmd+Shift+M).
- Joining a voice room auto-opens the first channel attached to it.
- Toasts for "IC is calling everyone back to Main Bridge" with a one-click Join.
- Minimum supported width ~1280px for the war room; dashboard and chat must still work on a phone (people join from mobile when paged) — show a mobile layout for dashboard, a channel, and the voice dock.

## Technical constraints for the handoff

- Built in React + TypeScript with plain CSS (CSS custom properties, no Tailwind, no component library). Please specify components in terms of reusable primitives: Button (primary / secondary / ghost / danger), IconButton, Pill/Badge, Avatar + AvatarStack with speaking ring, Select, Modal, Tabs, Tooltip, Toast, Menu, Panel/Sidebar section, Empty state.
- Icons: a single open-source line icon set (e.g. Lucide) at 16/20px.
- Provide: design tokens, the component sheet, high-fidelity mockups of screens 1–9 in dark theme, the war room and spreadsheet in light theme, and the mobile views listed above.
