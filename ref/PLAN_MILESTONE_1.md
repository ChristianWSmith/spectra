# Spectra — Implementation Plan: Milestone 1 (Foundation & Core Match Analysis)

**PRD reference:** §5.1 (library), §5.2 (overview/scoreboard), §5.3 (rounds), §5.5 (timeline), §5.17 (raw events, partial), §6–7 (data/architecture), §10 Milestone 1
**Depends on:** nothing — this is the first milestone
**Exit criteria (PRD §10):** a user can import a demo, inspect the match, browse rounds, examine player statistics, and investigate the underlying events without opening CS2.

---

## 1. What exists today

**Repo state** (after branding): stock Wails v3 app — `AppService` (`GetVersion`, `SaveWindowSize`), kvstore prefs, framework updater, embedded Svelte 5 + Vite 8 frontend showing a hello-world. No app functionality yet. Default window 480×270 (too small; bump in this milestone).

**Proven extraction assets** (research phase, outside the repo):

- `ref/extractor/main.go` — 61K working extractor (own nested module, reference only): demoinfocs-golang **v6.0.0-rc.1**, 52 typed event handlers, `SteamID64`-keyed identity aggregator (`getAgg`), round state machine, derived metrics (ADR, trades, entries, clutches, streaks, 3K/4K/ACE, accuracy, HS%, kill distances). Parsed the research demo in **22 s / 224.7 MB with zero parser warnings**. The M1 port moves its handler logic into `internal/extract`.
- `ref/FINAL_REPORT.md` — output of the research parse (de_mirage FACEIT demo: CT 13–6 T, 20 real rounds + 1 warmup, 146 kills, bvcket 23/12/5 @ 133.6 ADR); human reference for extraction techniques.
- `ref/TAXONOMY.md` — what exists in a CS2 demo format vs what that parse found.
- `ref/EXTRACTION_TECHNIQUES.md` — playbook: why v6 (v4 OOM'd), memory-lean parser options, header via `msg.CDemoFileHeader` net-handler (v6 dropped `Parser.Header()`), pitfalls (null bytes in names, warmup gating, bot keys). Probe sources in `ref/extractor/probe/`.
- **`donk.dem.zst` (repo root) — the golden acceptance demo, checked in via Git LFS.** ~190 MB zst → 256.9 MB, PBDEMS2 verified. All automated acceptance targets this file. Its concrete properties (map, tickrate, rounds, rosters, voice presence) are TBD until the first baseline pass (§6); do not assume research-demo numbers.

**Decisions already settled by research:** parser library (v6 RC), SQLite storage (PRD §7.3), pure-Go zstd decompression, SteamID64 as player key, warmup gating, fact/inference separation (PRD §6.1).

## 2. Scope

**In (P0/P1 for M1):**

- Import `.dem` and `.dem.zst` (file dialog + drag-and-drop), background parse queue, progress + errors, duplicate detection (sha256), originals never modified.
- Library: searchable, sortable list; delete extracted data (keep original); reprocess.
- Extraction engine: port the proven extractor into `internal/extract`; persist normalized data to SQLite; parser version + extraction warnings recorded per match.
- Match overview: score, halves, round progression strip, rosters, duration, map/server metadata.
- Scoreboard: sortable; K/D/A, ADR, HS%, K/D, KDA, damage, rounds played, multi-kills, entry kills, trade kills, opening kills/deaths, kill streaks, utility damage, kills/damage by weapon (tab detail).
- Round browser: winner, reason, duration, economy snapshot (equip values), first kill, MVP, bomb site; per-round kill feed; open-in-replay hook (stub for M2).
- Event timeline foundation: normalized kill/damage/bomb/round/utility events, filter by round + player + type; click event → detail (raw payload).
- Raw inspection: generic-game-event histogram (46 types observed in the research parse) + payload viewer.
- Chat capture (plaintext from this demo) into the DB; minimal display in round view.

**Out (deferred):** positions/frames sampling (M2), heatmaps (M3), economy curves & round classification UI (M3), voice (M4), chat decryption (needs `.dem.info`; M4/M5), custom metrics (M5), KAST (needs trade-death + survival tracking — stretch goal, else M3), video export (M5).

## 3. Architecture

### 3.1 Package layout

```
main.go                  composition root (window, menu, services) — exists
appservice.go            existing AppService
prefs.go                 existing prefs
internal/
  models/                normalized domain types (Match, Round, Player, Event…)
  store/                 SQLite open, migrations, queries, batch writers
  extract/               demoinfocs engine: handlers → models (port of demo/main.go)
  library/               import pipeline: scan, hash, zstd, dedupe, job queue
  data/                  XDG data-dir paths (db, temp, future sidecars)
```

Keep extraction presentation-independent (PRD §7.1): `extract` emits `models` values; `store` persists them; services query `store`. No demoinfocs types leak past `internal/extract`.

### 3.2 Dependencies to add

| Dep | Why |
|---|---|
| `github.com/markus-wa/demoinfocs-golang/v6 v6.0.0-rc.1` | proven parser; pin exactly (RC churn risk) |
| `modernc.org/sqlite` | pure-Go driver — keeps `make build`/CI cgo-free (current pipeline has no cgo) |
| `github.com/klauspost/compress/zstd` | in-app `.dem.zst` decompression (P1) |

`adrg/xdg` already present. Expect a `go 1.27` directive bump (v6 requires it; toolchain 1.27.3 installed).

### 3.3 Storage

- DB path: `$XDG_DATA_HOME/spectra/spectra.db` (create dir like `prefsFilename` does for config). WAL mode, `busy_timeout`, foreign keys on.
- Migrations: `schema_version` table + numbered SQL files applied in order; never edit an applied migration.
- Originals: referenced by absolute path + sha256; never written. Import copies nothing by default (library points at user files; a "copy into library" option is a P2 nicety).

**Schema sketch (v1):**

```
matches(id PK, path, sha256 UNIQUE, size, map, tick_rate, duration_ticks,
        playback_time_s, frames, server_name, client_name, game_dir, net_proto,
        is_pov, warmup_rounds, real_rounds, score_ct, score_t,
        half_ct, half_t, side_switches, entity_classes, end_entity_count,
        parser_version, extracted_at, parse_ms, warnings_count,
        status, error)                    -- status: queued|parsing|ready|failed

teams(match_id FK, side, name, flag, score, money_spent, equip_total)
players(match_id FK, steam_id, name, is_bot, clan_tag, crosshair_code,
        rank, rank_type, wins, ping, final_alive)
player_stats(match_id FK, steam_id FK,          -- one row per player per match
        kills, deaths, assists, headshots, teamkills, suicides, mvps, score,
        total_damage, dmg_taken, shots, hits, adr, hs_pct,
        entry_kills, entry_deaths, trade_kills, best_streak,
        three_k, four_k, five_k, utility_dmg, flashes_popped, flashed_times,
        bomb_plants, bomb_defuses, money_spent_total, ...)   -- port of playerAgg
rounds(match_id FK, number, winner, reason, duration_s, start_tick, end_tick,
       warmup, mvp, mvp_reason, equip_ct, equip_t, bomb_site, freeze_end_tick,
       first_kill_steam, first_death_steam)
round_economy(match_id, round, team, equip_value, money_sampled_sum, money_samples)
events(match_id FK, seq, tick, round, kind, attacker, victim, assister,
       weapon, headshot, wallbang, noscope, through_smoke, attacker_blind,
       assisted_flash, distance, hitgroup, dmg, site, detail_json, raw_json)
       -- seq = insertion order; indexes on (match_id, round), (match_id, kind), (match_id, attacker), (match_id, victim)
generic_events(match_id, name, tick, round, payload_json)   -- histogram + raw
chat(match_id, tick, round, steam_id, name, text, kind)
warnings(match_id, seq, message)
jobs(id PK, kind, path, status, progress, stage, error, created_at, started_at, finished_at)
```

Event detail: typed columns for everything the UI filters on; `detail_json`/`raw_json` for full payloads (PRD: never silently discard).

### 3.4 Job model

- `jobs` table is the source of truth (survives restart; on launch, mark stale `parsing` as failed).
- Import flow: accept paths → hash → dedupe → insert `queued` → worker goroutine (single worker initially) → zstd decompress to temp if needed → `extract.Parse(ctx, r, sink)` → batch-insert into store inside one transaction per stage → `ready`.
- Progress: `stage` (decompress|parse|store) + percent (frames/total when known) emitted as Wails events `spectra:job-progress` / `spectra:job-done`; frontend subscribes via `runtime.EventsOn`.
- Cancellation: `context.Context` per job (v6 `ParseToEnd(ctx)`); Cancel button in UI.
- Memory-lean parser options exactly as proven: `option.IgnorePacketEntitiesPanic(true)`, `option.MsgQueueBufferSize(0)`.

### 3.5 Service surface (Wails v3)

New services (registered in `main.go` alongside `AppService`):

- **LibraryService**: `ImportPaths([]string)`, `ImportDialog()`, `ListMatches(query)`, `DeleteMatch(id, deleteOriginal bool)`, `Reprocess(id)`, `CancelJob(id)`, `ListJobs()`, `GetGenericHistogram(id)`, `GetWarnings(id)`.
- **MatchService**: `GetMatch(id)`, `GetScoreboard(id, sortKey, desc)`, `GetRounds(id)`, `GetRoundDetail(id, round)`, `GetEvents(filter)`, `GetEvent(id)`, `GetChat(matchID, round)`.
- Events out: `spectra:job-progress`, `spectra:job-done`, `spectra:library-changed`.

Bindings regenerate per build (never edit `frontend/bindings`). Keep `AppService`; bump default window to 1280×800 and enforce min 900×600.

## 4. Frontend plan (M1)

Svelte 5 (runes), no router dependency — hand-rolled hash routing in `App.svelte` (`#/library`, `#/match/:id`, `#/match/:id/round/:n`, `#/timeline/:id`) so links are deep-navigable.

```
frontend/src/
  App.svelte               shell: sidebar nav + hash router
  lib/
    services.js            thin async wrappers over generated bindings + event glue
    fmt.js                 duration/tick/number formatting
    components/            StatCell, ScoreBadge, RoundStrip, EventRow, JobProgress…
    views/
      Library.svelte       list, import button + drop zone, sort/filter, job progress, errors
      Match.svelte         header (score/halves/map/duration), tabs: Overview | Scoreboard | Rounds | Timeline | Chat | Raw
      RoundDetail.svelte   kill feed, players alive/equip, bomb events, jump-to-tick stub
      Timeline.svelte      virtualized event list, filter bar (type/round/player), detail pane with raw JSON
      Settings.svelte      data dir info, parser version, about
```

Visual language: dark theme default (bracket motif from the icon), dense data tables, monospace for ticks/raw data. Sortable scoreboard columns. Every stat cell is a future drill-down target (PRD §8.2) — wire click → filtered timeline in M1 where cheap (player name → timeline filtered by player).

## 5. Work breakdown (build order)

1. **Skeleton & data dir** — `internal/data`, window defaults, hash router, empty views. `make build` green.
2. **Store** — migrations v1, open/PRAGMA, batch writers for all tables; unit tests with in-memory DB.
3. **Extract port** — move `ref/extractor/main.go` handlers into `internal/extract` emitting `models` (no strings-for-report; real types). Structure the match-state accumulator so handler logic is unit-testable with fabricated events (no parser needed). Add context cancel + progress callback (frames done / total). `ref/extractor` stays as the untouched reference implementation.
4. **Jobs + import** — library service, zstd path, sha256 dedupe, worker, Wails events. CLI smoke: `go run . -import file.dem` dev flag optional.
5. **Library UI** — list + import + progress + error + delete/reprocess.
6. **Match views** — overview, scoreboard (sortable), rounds, round detail, chat, raw histogram.
7. **Timeline** — filters + virtualized list + detail pane; wire stat-cell → timeline links.
8. **Polish & hardening** — null-byte scrubbing on all stored strings (lesson from EXTRACTION_TECHNIQUES §11), failed-parse recovery UX, reprocess after parser bump, warnings surface.
9. **Docs** — README feature section; AGENTS.md package map update.

## 6. Testing & acceptance

Two tiers, deliberately separated:

**Tier 1 — checked-in suite (`make test`, CI):**

- **Synthetic tests (always run, `-short`-safe):** store roundtrips on in-memory SQLite, migrations, null-byte scrubbing, analytics/accumulator state machines fed fabricated event sequences. No demo bytes, no LFS requirement, milliseconds each.
- **Golden-demo integration tests:** a package (e.g. `internal/integration`) parses **`donk.dem.zst` from the repo root**. The test **skips if the file is absent** (shallow clone, LFS not smudged, `-short`) so `make test` never hard-fails on missing LFS content. Full run ≈ 30 s — keep it out of `-short`, run it in CI after a `git lfs pull` step (add that step to `.github/workflows/ci.yml` when this lands).
- **Golden values live in a committed fixture** — `internal/integration/testdata/donk.golden.json`, numbers only: map, tickrate, frames, scores, round counts, per-player headline stats, event histograms, voice presence, parser warnings, parse time. Generated by the harness itself (`go test -run TestGolden -update`), reviewed, committed. Demo *bytes* enter git only through LFS; golden *numbers* are ordinary small files.
- **Baseline regeneration is a deliberate act** (PRD §9.2): when parser/extraction/metric changes legitimately move numbers, re-run `-update` and treat the fixture diff as the review artifact.

**Tier 2 — dev-local only (no test depends on it):**

- The research demo itself was never committed and has been deleted; its findings live on in `ref/FINAL_REPORT.md`, `ref/TAXONOMY.md`, and `ref/EXTRACTION_TECHNIQUES.md`. If a voice-bearing demo is ever needed for manual work (M4), source one at that time — the golden demo's voice presence is whatever the baseline records.

**Baseline to capture on first full donk pass:** map, tickrate, duration, real/warmup round counts, rosters, top-line scoreboard, generic-event histogram, voice presence, zero-warning expectation, parse time. Until that fixture exists, research-demo numbers in this plan are historical context only.

Known data caveat to surface in UI (observed in research demo): 5/10 players disconnected before demo end — final-state fields empty, event-derived stats complete. The PRD §6.1 fact/inference rule applies (label provenance).

## 7. Performance targets

| Metric | Target | Basis |
|---|---|---|
| Parse 224 MB demo | ≤ 30 s wall, < 1 GB RAM | proven 22 s |
| Library list (1 000 matches) | < 50 ms | indexed query |
| Timeline filter (50 k events) | < 100 ms | indexes in §3.3 |
| DB size per match | measure & record; budget < 20 MB for the golden demo | report as success metric |

## 8. Risks & open questions

1. **demoinfocs v6 is an RC** — pin `v6.0.0-rc.1`; parser_version column in DB makes reprocess-after-upgrade explicit (PRD §9.2).
2. **modernc.org/sqlite performance** vs cgo — acceptable for M1 volumes; revisit at M3 benchmarks (PRD §7.3).
3. **Event insert volume** — research demo scale: 566 hurts + 3 213 fires + generic events per match; batch inserts inside transactions; avoid per-event JSON marshal of duplicate data.
4. **Disappearing players** — event-derived vs final-state provenance must be modeled now (column or JSON flag), not retrofitted.
5. **KAST** — stretch in M1 (needs per-round survival + trade-death); otherwise M3.

## 9. Definition of done

- `donk.golden.json` baseline exists and the integration test enforces it; the `-update` regeneration flow documented and exercised once.
- Import of `.dem` and `.dem.zst` via dialog and drag-drop; cancel works; duplicates rejected with message; originals untouched.
- `make lint vet test fmt` green; `make build` produces a working app; CI runs the golden test after `git lfs pull`.
- A stranger can open the app, import the golden demo (`donk.dem.zst`), and answer: who won, who fed, what happened in round 10, and what weapon killed them — without CS2.
