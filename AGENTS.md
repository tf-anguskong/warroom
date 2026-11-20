# AGENTS.md

Instructions for AI assistants and coding agents working in this repository.

Read **[CLAUDE.md](CLAUDE.md)** before changing code. It has the commands, the layout, and the rules. In short:

- TypeScript throughout: Node 24 + Express + Socket.IO + `node:sqlite` on the server, React 18 + Vite on the client, plain CSS in `client/src/styles.css`.
- `npm install`, `npm run livekit:dev`, `npm run dev`, then open http://localhost:5173 (developer sign-in is on in dev). Check work with `npm run build` and an end-to-end run.
- Server configuration lives in **Admin → Settings** (`server/src/settings.ts`), not in `.env`. New settings are fields there; read `config` live, and reset cached clients in `onSettingsChanged`.
- Guests are deny-by-default: new API routes and realtime events are closed to guests unless explicitly allowed in `server/src/guests.ts` / `realtime.ts`.
- AI agents (the MCP server at `/mcp`) are deny-by-default as well: bearer-token requests reach only routes in `AGENT_RULES` (`server/src/agents.ts`), and never get room control.
- Secrets are encrypted at rest and never sent to browsers or written to logs.
- When screens change, update `docs/CLAUDE_DESIGN_PROMPT.md`; when setup or settings change, update the README.
- Never commit `.env`, `server/data/`, or keys, certificates and tokens.

## Setting it up for someone

Temporary War Room for one incident: follow `docs/WARROOM_NOW.md` (`bash warroom-now.sh up`). Permanent install: point an A record at the host, `APP_DOMAIN=… docker compose up -d` (pulls `ghcr.io/tf-anguskong/warroom`), open the one-time setup link from `docker compose logs app`, finish in Admin → Settings. See the README's Deploy section.

## License

PolyForm Small Business 1.0.0 (`LICENSE.md`, `COMMERCIAL.md`). Keep the `Required Notice` line with every copy, including built images.
