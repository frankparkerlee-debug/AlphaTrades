# Launch Control v3 — Build Instructions

## Project
Options trading intelligence system for Nasdaq 100. Full spec in LaunchControl_v3_ClaudeCode_BuildSpec.docx.

## Stack
- Node.js 20+ backend worker (src/main.js entry point)
- PostgreSQL 15 on Render (existing DB, v3 schema — all tables prefixed with v3_ or in schema "lc_v3")
- React 18 + Vite frontend dashboard
- Alpaca Markets API (Algo Trader Plus — SIP + OPRA + News)

## Commands
- Start: node src/main.js
- Test: node --test tests/
- DB migrate: node scripts/migrate.js
- DB seed: node scripts/seed.js

## Critical Rules
- IMPORTANT: Run node scripts/verify-db.js after any DB change
- IMPORTANT: Never hardcode credentials — always use .env
- IMPORTANT: All v3 tables live in the "lc_v3" schema — never touch public schema tables from v1
- IMPORTANT: composite_raw must always be >= 0 — enforce MAX(0, MIN(110, raw))
- IMPORTANT: Volume scoring uses per-window baseline, never daily average
- IMPORTANT: Direction determined BEFORE scoring — never score both CALL and PUT
- YOU MUST verify each build step passes before proceeding to the next
- YOU MUST NOT modify anything outside the launch-control-v3 directory

## Code Style
- ES modules (import/export) not CommonJS
- Async/await not callbacks
- All DB queries use parameterized statements — no string interpolation
- Log every signal write and every error to console with timestamp

## Architecture
- src/scoring/ — all 5 pillar functions + composite assembly
- src/cluster/ — propagation engine + confluence detection
- src/data/ — Alpaca streams + in-memory state + DB client
- src/jobs/ — nightly profile update + premarket scan
- src/api/ — REST endpoints for dashboard
- dashboard/ — React frontend (separate Vite project)
