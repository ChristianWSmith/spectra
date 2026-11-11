# Export formats — roadmap research

**Unit:** export-formats · **Priority tier:** P1 · **Date:** 2026-11-10
**LoE (aggregate):** M — one shared export core (table dump + Go-side streaming routes + save plumbing) serves all three items; each item is a format/surface on top, with only PDF layout and non-player entity coverage left open-ended.
**Feasibility:** high — the data (store tables, position sidecar) and the heavy-download plumbing (`DialogService.SaveExport`, `/api/export/*` routes, `lib/save.js`) already exist; blockers are scope decisions (CSDM worth, "entity" beyond players, PDF depth), not architecture.

## Items in scope

1. **Whole-match stats file export** — 34 CSV tables / JSON / CSDM per demo, JSON envelope + flat CSV, and profile export to Markdown/JSON
2. **Position / trajectory export** — per-frame entity positions plus always-on per-second samples
3. **XLSX / PDF / TXT export** — document formats beyond CSV

## Current state

**Export machinery that exists today**

- **SQL console CSV/JSON** — `SqlConsole.svelte` exports the last result via `lib/csv.js` `toCSV` (RFC 4180, CRLF, canonical semantics) → `lib/download.js` → `lib/save.js` (native `SaveFile` + `WriteFile`, bytes cross bindings base64). Caveat: results are capped at `store.DefaultRowLimit = 5000` rows and 5 s (`internal/query`), so the console path **cannot** serve an uncapped whole-match dump.
- **Replay feed CSV/JSON** — `Replay.svelte` export menu (`landmarkExportRows` → `toCSV` / `JSON.stringify`), the one event-feed export.
- **Templated reports** — `internal/report`: Go `text/template` builtins `match.md`, `match.html`, `player.md`, `round.md` (scopes match|player|round), data maps `MatchReport`/`PlayerReport`/`RoundReport` built from store getters, rendered by `PlatformService.RenderReport`; plugin templates can register too. **The Reports view renders in-app only — no save-to-file button exists** (`compositeText()` is displayed, never downloaded), although the Go side has `GET /api/export/<matchID>/report` (attachment) already.
- **Heavy-download routes + save plumbing** — `main.go` `handleExport`: `/api/export/library.db` (WAL-checkpointed DB copy) and `/api/export/<matchID>/report`; `lib/save.js` `saveExportURL` → `DialogService.SaveExport` (native dialog, then Go fetches the URL straight to disk — no base64 round-trip). **As searched, no frontend view currently calls `saveExportURL`** — the pipe is laid but unwired.
- **Not present in Go**: no `encoding/csv`, no `archive/zip`, no xlsx/pdf library anywhere in `go.mod`/`package.json` (frontend deps are codicons + wails runtime only).

**What "34 CSV tables" would add vs. what the store exposes**

- `internal/store/schema.sql` has **26 tables**: 18 match-scoped (`matches, teams, players, player_stats, rounds, round_player_sides, round_economy, events, generic_events, chat, warnings, sound_events, round_classifications, player_round_stats, clutches, engagements, utility_events, voice_presence`) + 8 library-scoped (`jobs, player_career, saved_filters, analysis_config, metrics, query_history, saved_queries, plugins`), plus three sidecar streams (positions, state, voice) outside SQLite.
- The "34" is competitor-derived: the item's format trio **CSV / JSON / CSDM is exactly `cs-demo-analyzer`'s `-format [csv,json,csdm]`** (the CLI behind CS Demo Manager). Exact table-count provenance not pinned; the deliverable should be **our own pinned catalog** of per-demo tables (18 match-scoped + derived/JSON-detail columns), not a race to 34.
- Column lists already exist per table (`playerStatsCols`, `roundCols`, `eventCols`, …, pinned to DDL by `TestColumnListConstsMatchSchema`) — the export catalog should reuse them for stable headers. `ROResult`/`models.QueryResult` rows are row-major JSON scalars → directly CSV/JSON-serializable.

**CSDM — what it is**: not an interchange standard. In `cs-demo-analyzer`'s own source: `CSDM: 'csdm', // Special CSV export dedicated to the application CS Demo Manager`. It is CS Demo Manager's private CSV import layout (its importer runs `csda -format=csdm` internally). Supporting it = reverse-engineering a competitor's import format for interop with that one app. Verdict: **subsumed by "JSON envelope + flat CSV"** — offer it only as an explicit later/optional add if users ask; do not build it now (PRODUCT: feature-parity is evidence, not justification).

**Item 2 — positions today (the key LoE driver): player frames ARE stored; other entities are NOT**

- `internal/sidecar` `positions.bin` is written **on every import** (`internal/library/library.go` `sidecar.NewWriter`): 64 Hz per-frame, per-alive-player x/y/z (int16 @1.0 u), yaw, airborne/duck/side flags, block-zstd + `.idx` range reads, `meta.json` slot table (~9.1 MB raw / ~2.5 MB zstd for the golden demo). Served today via `GET /api/sidecar/<id>/positions?from=&to=`.
- Sparse `state.bin` carries HP/armor/money/helmet/weapon/inventory/ammo/attack/reload per change — exportable as a second table.
- **Coverage gap:** `extract.PositionSink` is players-only ("every alive playing participant", alive-only — dead frames carry no row). Non-player entities (grenades/projectiles, C4, dropped weapons, infernos) have **no per-frame stream**; `analytics/utility.go` documents `TrajectoryRef "" in v1 — M2 sidecar trajectories are streamed, not stored`. Grenade/drop/bomb *anchor* positions (throw, bounce SOS rows, det, drop/pickup) live in `events`/`generic_events`/`utility_events` `detail_json`. Per-frame entity positions beyond players ⇒ new extraction/sidecar fields (+ reimport for old matches) or a streaming re-parse at export time (managed demo copy + `extract.Parse`, minutes per demo).
- **"Always-on per-second samples"**: nothing samples at 1 Hz today; the natural reading is a 1 Hz decimation of the stored 64 Hz stream (every 64th frame — and `sample_rate`/`position_frames` are mirrored in `matches`), always included in a position export so consumers get a cheap baseline even without the full frame dump. Ambiguity noted in Risks.

**Where exports surface today**: SQL console (ad-hoc CSV/JSON), Replay (feed CSV/JSON), Reports view (rendered md/html, in-app). No per-match "export everything" button (Match view has none), no profile save, no library-wide export beyond the unwired `library.db` route (Workspaces owns library-as-unit later).

## Implementation path

**Item 1 — Whole-match stats file export (M)**
1. Go: new `internal/export` (beside `internal/report`) with a **pinned table catalog** for the match-scoped tables, each entry = table name + its `*Cols` const + a `WHERE match_id=?` (or single-row) projection, deterministic `ORDER BY` (seq/tick/round) per table for the determinism preference.
2. Dump on the read-only connection but via a **dedicated uncapped path** (not `RunReadOnly`'s 5000-row console cap); stream rows straight to writers.
3. Writers: (a) **flat CSV set → zip** (`archive/zip` + `encoding/csv` with `UseCRLF=true` to match `lib/csv.js` semantics; JSON columns JSON-encoded as cells), (b) **single JSON envelope** `{"meta":…, "tables":{name:[rows]}}`. Both land through a new `GET /api/export/<matchID>/bundle?format=csv|json` route + `saveExportURL` (multi-MB must not cross bindings base64).
4. Frontend: "Export" button/menu in the Match view (canonical `downloadText` for tiny payloads, `saveExportURL` for the bundle).
5. **CSDM: defer** (see Current state) — one commented seam in the writer enum, no implementation.
6. **Profile export**: profile-scope data map (reuse `getProfile`/`getCareerTrend` getters behind a `report.BuildProfileData` + a `profile.md` builtin template and a JSON serialization), save button on PlayerProfile via `downloadText`/`saveText`. If richer profile content lands with the statistics unit, this inherits it.

**Item 2 — Position / trajectory export (M)**
1. Go route `GET /api/export/<matchID>/positions?step=N&format=csv|json` reading `sidecar.Open` range blocks (already server-side, block-independently decodable); rows = tick, steamid (slot table), x, y, z, yaw, air/duck/side; `step` = frames-per-sample (1 = per-frame, 64 = the always-on 1 Hz sample — export always offers/writes the 1 Hz set plus optional full-rate).
2. Trajectories for non-player entities from existing rows: a small "anchors" export (throw/bounce/det/drop/pickup/plant from `events` `detail_json` + `utility_events.det_x/det_y`) — cheap and honest.
3. **Decision point:** full per-frame grenade/entity positions ⇒ sidecar/`PositionSink` extension (schema note: no versioning — old sidecars simply lack it, fail-soft) or export-time re-parse; scoped as a follow-up, not the v1.
4. Surface: Match/Replay export menu next to the feed export; document alive-only frames and 1-u quantization in the export contract.

**Item 3 — XLSX / PDF / TXT (M)**
1. **TXT (XS)**: aligned-column plain-text rendering of the same dump/report data maps — pure Go, no deps.
2. **XLSX (S)**: one new Go dep (excelize — owner pre-approved); sheets over the same table catalog (CSDM's own sheet set general/players/rounds/kills is a sane subset), new `?format=xlsx` on the bundle route (or a dedicated route), `saveExportURL`.
3. **PDF (M — the driver)**: render the *structured report data maps* (`MatchReport` etc.) with a Go PDF library (gofpdf-class) — title, scoreboard/round tables, metric lists. Do **not** attempt HTML→PDF fidelity (no headless browser; HTML report stays as-is; print-to-PDF via the webview is unverified). Match the existing report templates' content, not pixel layout.

## Existing scaffolding to reuse

- `lib/csv.js` `toCSV`/`csvCell` (canonical RFC 4180 CRLF) — CSV semantics for frontend payloads; Go `encoding/csv` `UseCRLF=true` as its twin.
- `lib/save.js` / `lib/download.js` / `DialogService.SaveFile|WriteFile|SaveExport` — every save path; `saveExportURL` for anything multi-MB (currently unwired — these items are its first real callers).
- `/api/export/*` routes + `handleExport` + `dialogs.go` streaming pattern (asset-server style; tested in `dialogs_test.go`).
- `internal/report` (templates, data maps, `renderReportDoc`) — report/PDF/profile rendering start here; builtin template registry + plugin `ReportTpls` extend for new formats.
- `<table>Cols` consts + `TestColumnListConstsMatchSchema` — pinned, DDL-checked column lists = stable export headers; `st.Schema()` (sqlite_master + PRAGMA) as the fallback enumerator.
- `internal/sidecar` reader (block range reads, `Meta`, slot table) + `/api/sidecar/<id>/positions|state|meta` — item 2 reads the same files server-side.
- `store.RunReadOnly` / ro connection discipline — exports stay on the read-only handle (never the write handle), same layering as the SQL console.
- Store getters already feeding reports (`GetScoreboard`, `GetRounds`, `GetEconomy`, `GetClutches`, `GetUtility`, `GetRoundDetail`, profile getters) for XLSX/PDF/TXT document rendering.

## Dependencies & overlaps

- **YAML metric rules** — owns export/import of *rulesets* (Settings surface, `metrics` table); the whole-match bundle should include the `metrics` table as data but not collide with the ruleset import/export UI.
- **CLI / flag-driven scripting** — a headless export flag would call the *same* Go export functions; keep all dump/writer logic in Go services (never in the frontend views) so CLI reuses it for free.
- **Statistics (ratings, cross-library overview)** — profile export's content richness depends on it (`player_career`, trend getters); kill/damage matrices and side-split tables may later join the bundle catalog.
- **Replay** — feed export already canonical there; position export shares its sidecar-fetch surface; annotations' future exports must reuse the same save plumbing.
- **Library / Workspaces** — library-wide export and "library as an exported unit" are Workspaces' territory; this unit is per-demo + per-profile only (`library.db` copy already exists Go-side).
- **Match metadata** — detection item (share code, played-at, provider) enriches the JSON envelope's `meta`; export whatever `matches` already carries.
- **Localization** — export headers/labels English-only until the localization item lands; keep label strings centralized if cheap.
- **Lineups** — `setpos`/`setang` clipboard export is separate; a positions export could later feed lineup extraction but is not a dependency.

## Risks & unknowns

- **Scope of "entity positions"**: players are stored per-frame; grenades/C4/weapons are not. V1 built on stored data = S–M; requiring full non-player per-frame streams pushes item 2 to L (sidecar extension + reimport of existing libraries). Needs an owner-level scope call.
- **"Always-on per-second samples" ambiguity**: read as a 1 Hz decimation always bundled with position exports; if it means *captured* always-on regardless of sidecar presence, that's an extraction change (all imports already write positions — mostly moot, but dead-player and no-sidecar cases must be documented, never guessed).
- **"34" table count** provenance is competitor-derived and not pinned; publish our own catalog count instead of matching a number, and expect the golden-fixture/`Columns` tests to pin it.
- **CSDM** is a competitor's private import format — recommend defer; re-decide only with concrete interop demand (PRODUCT rubric: parity is evidence, not justification).
- **Row cap / timeout**: bulk dumps must bypass `RunReadOnly`'s 5000-row/5 s console policy — a dedicated export path keeps the console's safety layering intact (read-only, query_only, no write-handle reach).
- **Payload size**: whole-match CSV sets and full-rate position dumps are tens of MB — must stream through `saveExportURL`, never base64 `WriteFile`; zip bundling (stdlib) keeps the save dialog a single file pick.
- **PDF depth**: table-only reports are tractable; charts/sparklines in PDF would balloon it — v1 should mirror the markdown templates' content only.
- **Determinism**: export row order and envelope key order must be pinned (per preference) — deterministic `ORDER BY` + stable table catalog order, fixture-tested against the golden demo.
