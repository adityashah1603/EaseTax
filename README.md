# EaseTax — web-native tax workpaper

A workpaper that proves a return is right: where every number came from, what was done to it,
who checked it, and what is still open. Built for the Okafor-Lindqvist 2025 case study.

## Run
```bash
npm install
npm run dev        # API on :8787, web on :5173
npm test           # server core tests
```
Production: `npm run build && npm start` serves the SPA and API from one process (port `PORT`, default 8787).

The packet `okafor_lindqvist_2025_packet.json` is loaded exactly as delivered and never modified.
All human work is stored as append-only events in SQLite (`var/easetax.db`, override with `DB_PATH`).

## Layout
- `shared/` — packet types, node-id grammar, events, API contract, tax-effect mapping
- `server/` — baseline loader, provenance graph, event store, projections, policy, checks, REST + SSE
- `web/` — React review UI
