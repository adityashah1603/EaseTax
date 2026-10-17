# EaseTax — web-native tax workpaper

A workpaper that proves a return is right: where every number came from, what was done to it,
who checked it, and what is still open. Built for the Okafor-Lindqvist 2025 case study.

**Live demo:** https://easetax.onrender.com · **Video:** _link to be added_

## Hand-in
1. The working workpaper: the live link above. Pick a role with the role switcher in the top bar.
2. [Core idea and data model](docs/ONE_PAGER.md)
3. [Errors found and how the design surfaced them](docs/ERRORS.md)
4. Video walkthrough: link above. How AI was used: [docs/AI_USAGE.md](docs/AI_USAGE.md)

## Demo notes
- **No real login.** The role switcher sets who you are (preparer, reviewer, partner, administrator, client). The server enforces each role's rights.
- **Data resets.** The free host keeps saved work in a temporary SQLite file. Everything you do is saved, but a redeploy or a sleep after about 15 minutes of no traffic resets it to the packet. The first visit after a sleep takes about a minute to wake up.

## Run locally
Requires Node 24 or later (uses `node:sqlite`).
```bash
npm install
npm run dev        # API on :8787, web on :5173
npm test           # server tests
```
Production: `npm run build && npm start` serves the SPA and API from one process (port `PORT`, default 8787).

The packet `okafor_lindqvist_2025_packet.json` is loaded exactly as delivered and never modified.
All human work is stored as append-only events in SQLite (`var/easetax.db`, override with `DB_PATH`).

## Layout
- `shared/` — packet types, node-id grammar, events, API contract, tax-effect mapping
- `server/` — baseline loader, provenance graph, event store, projections, policy, checks, REST + SSE
- `web/` — React review UI
- `docs/` — hand-in documents
