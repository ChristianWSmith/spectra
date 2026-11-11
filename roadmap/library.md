# Workspaces & storage management — roadmap research

**Unit:** library · **Priority tier:** P3 · **Date:** 2026-11-10
**LoE (aggregate):** L — Workspaces is a cross-cutting session-lifecycle refactor (Wails services bind once at `App.Run`, so every service + HTTP closure needs an indirection layer); storage tools are mostly additive over existing free-copy primitives but the aggregate rides Workspaces.
**Feasibility:** high — no blockers; single-active-workspace design sidesteps the single-writer / never-open-another-instance's-db conflict, and export shares its core with the export-formats unit.

## Items in scope

1. **Workspaces** — the library reconceptualized as a unit that can be opened, modified, closed, exported
2. **Storage management tools** — manual self-management plus eventual automation, extending the existing free-copy idea

## Current state

**Library model = one directory, one db, one process.**
- `src/internal/data/data.go` — all durable paths are package funcs over `$XDG_DATA_HOME/spectra/`: `DBPath()` (spectra.db + WAL), `MatchesDir()` (`<id>/` sidecars), `DemosDir()` (content-addressed managed copies), `TempDir()`, plus app-global `MapsDir/IconsDir/SoundsDir` (~76M, re-extractable) and WebKit `storage/`/`mediakeys/`, `plugins/` (`internal/plugin.DefaultDir`).
- `src/internal/store/store.go` `Open` — baseline schema on every open + restart repair (queued/running jobs and orphaned queued/parsing matches → failed "interrupted by restart"; deliberate, pinned by tests). Single connection (`SetMaxOpenConns(1)`), WAL, busy timeout. `query_store.go` `roDSN` derives the SQL-console's read-only DSN from the store's own path — automatically workspace-aware once the store swaps.
- Wiring is all at startup: `src/main.go:110` `store.Open(data.DBPath())`, then `library.New` (single worker, `Options.SidecarDir`/`CopyDir` default to the data dirs — **already parameterized**), `library.NewScanner` (`ScannerOptions.DataRoot` **already parameterized**), and ~12 services registered with `st` as a struct field (main.go:180–195). The asset HTTP handler closures (`handleSidecar`/`handleExport`/`handleVoice`, main.go:123–145) capture `st` and `data.MatchesDir()` directly.
- **Confirmed hard constraint:** Wails v3 `App.RegisterService` (module source) logs an error and discards the service if called after `App.Run` — services **cannot be re-registered at runtime**; a workspace switch must go through an indirection (mutable session holder), not re-registration.
- Process-global besides the store: kvstore prefs (`src/prefs.go`: `demo_dirs`, `copy_on_import`, window, font…), the importer worker + its event emitter, the scanner's path/size/mtime hash cache, `data.*Dir()` call sites (~12 across `libraryservice/voiceservice/replayservice/analyticservice/platformservice` + `main.go` handlers), updater, WebKit profile.

**Free-copy machinery (the seed of item 2) already exists:**
- `src/internal/library/copy.go` — `CopyState*` (copied/external/missing, fs-derived per read), `RemoveManagedDemo` (only ever deletes inside `DemosDir`), `resolveDemoFile` (copy → stored path fallback).
- `src/libraryservice.go` — `EvictDemoCopy(id)` (per-match "Free copy"), `FreeAllDemoCopies()` (Settings → Data bulk sweep), `DeleteMatch(id, deleteDemo)` (data + optional managed copy; sidecar dir `RemoveAll`), `GetDataInfo()` (paths + one-readdir count/bytes of `DemosDir` only), `ListMatchesPage` stamps `CopyState` per row.
- UI: `Library.svelte` (Size column via `fmtBytes(m.size)`, Free copy + delete prompts, import-dir "Delete from disk"), `Match.svelte` Free copy button, `Settings.svelte` "Data" section (paths, `Free all demo copies`, copy-on-import toggle). `DeleteDemoFile` for scanner rows.
- Honest-UX gap already documented in code: after a free, Reprocess fails fast on "Demo file not found" when the stored source is gone too (`CopyStateMissing`); re-import needs the file in hand. The roadmap "parse cache" item (skip-reparse) does **not** exist yet and would be the only future mitigation.
- Measured instance sizes (2026-11-10, this machine; total 376M): `demos/` **279M** (dominant), `sounds/` 58M, `maps/` 17M, `matches/` **15M for a single match** (positions ~2.5M zstd + state stream + per-player opus voice — voice dominates and grows linearly per imported match), `spectra.db` 8.4M, `icons/` 736K, `tmp/` ~0. No `VACUUM` anywhere (SQL console allows `VACUUM INTO` only on the ro connection) — deletes never shrink the db file.

**Export overlap:** `main.go` `handleExportLibraryDB` (WAL-checkpoint + stream `Spectra-library.db`) exists Go-side; `roadmap/export-formats.md` explicitly defers library-wide export to this unit ("Workspaces owns library-as-unit later") and notes the `saveExportURL` → `DialogService.SaveExport` pipe is laid but unwired in the frontend.

## Implementation path

**1. Workspaces — L**
1. **Shape:** a workspace = a directory bundle `{spectra.db(+wal), demos/, matches/}`; assets (maps/icons/sounds), plugins files, prefs and WebKit state stay app-global (shared, re-extractable). **Default workspace = today's layout untouched** — zero migration, no format ladder; open failure = clear error + re-import (no-versioning policy). Registry of known workspaces = a kvstore pref (paths + last active).
2. **Single-active only** — one open workspace at a time: close (drain/cancel queue via existing job-cancel state machine → `imp.Shutdown()` → `st.Close()`, LIFO order as in main.go) then `store.Open(newPath)` (restart repair runs per open — correct for single-active). Multi-db (two live workspaces) is flagged as conflicting with the single-writer design, the never-open rule, and one-frontend-one-library assumptions — reject it.
3. **Indirection layer (the bulk):** introduce a session holder (pointer to current `store`/`Importer`/`Scanner`/paths) that the ~12 services and the asset-handler closures read through — mandatory because Wails refuses service re-registration after `Run`. Either re-point package-level `data.*Dir()` roots at switch time (precedent: tests mutate `xdg.DataHome`) or thread an explicit `Paths` struct; resolve paths per-request so in-flight sidecar fetches can't race a switch.
4. **Frontend flush:** new `spectra:workspace-changed` event added to `services.js`'s invalidation listener list (the `invalidate()` export already exists), plus navigate to the Library route (router hash resets view-local state on remount) and cancel any visible job progress. Prefs/global UI state intentionally survive.
5. **Actions/UI:** Settings → Data section (existing "Data" panel pattern) or a Library header menu: Open / Create / Close / Export. Export = bundle copy to a user-chosen directory or streaming zip via `saveExportURL`/`DialogService.SaveExport` (multi-GB — never over bindings); reuse `handleExportLibraryDB`'s checkpoint-then-stream as the db leg. Import into an open workspace = the existing pipeline unchanged.

**2. Storage management tools — M**
1. **Inventory:** extend `DataInfo` with db+WAL bytes and sidecar-root bytes; per-match sidecar size (stat `matches/<id>/`, bounded readdir — same pattern as `CopyState` stamping) surfaced in the Match view detail and/or a Library column/tooltip. Settings → Data becomes the dashboard: totals per category (demos / sidecars / db / re-extractable assets) with the "re-extractable" note.
2. **Extend the free-copy idea:** filtered bulk frees building on `FreeAllDemoCopies`/`EvictDemoCopy` (selected rows, older-than-N, "free only copies whose source still exists" = safe mode where reprocess keeps working); a per-match "drop sidecar" is data loss for replay (positions/voice) and should be deferred/labeled loudly if ever offered.
3. **Honest UX:** confirm dialogs state consequences per `CopyState` (copied → external → missing; reprocess/re-import impossible once both files are gone); no fabricated recoverability.
4. **Automation (cron-less):** retention pref mirroring `copy_on_import`'s per-job read — e.g. auto-free copies older than N days or when `DemosDir` exceeds X bytes, evaluated at app start + on `spectra:job-done` (no scheduler goroutine). Optional "Compact database" (VACUUM on the write handle) for post-delete reclamation.
5. Follow canonical patterns: new `LibraryService` methods + Settings sections + `Dialog.svelte` confirms; metrics/rows documented with what they measure (bytes, N).

## Existing scaffolding to reuse

- Free-copy core: `library.CopyState*`, `RemoveManagedDemo`, `EvictDemoCopy`, `FreeAllDemoCopies`, `DeleteMatch(deleteDemo)`, `DeleteDemoFile`, `countManagedDemoFiles` (one-readdir size counting).
- Parameterized dirs: `library.Options.SidecarDir/CopyDir`, `ScannerOptions.DataRoot` — tests already run the whole pipeline against temp bundles, which is exactly what workspace tests need.
- Export pipe: `handleExportLibraryDB` (WAL checkpoint + stream), `DialogService.SaveExport` + `saveExportURL`, `save.js`/`Dialog.svelte` native dialogs; `chooseDirectory` folder picker (shared with MapPackService) for workspace location.
- Frontend: `services.js` `invalidate()` + event-listener list, `fmtBytes`, Settings "Data" panel, Library row actions/confirm pattern, `CopyState` chips.
- Store: `Open` per-path lifecycle + repair, `roDSN` path derivation, `store.Close` ordering discipline (main.go LIFO comments).

## Dependencies & overlaps

- **Export formats unit** (`roadmap/export-formats.md`): shares the library-db export core; it explicitly scopes itself to per-demo/per-profile exports and leaves "library as an exported unit" here. Coordinate the `saveExportURL` wiring.
- **No-versioning policy:** workspaces carry no format/version marker; a bundle from a broken/older build = open error → re-import, never a migration branch. `store.Open`'s baseline schema applies on every open.
- **Statistics:** `player_career`, `metrics`, `saved_queries`, `query_history` live in the db → they move per workspace; the cross-library overview item assumes "the library" — with multiple workspaces, "cross-library" semantics must be scoped to the open one (flag when that item lands).
- **Annotations/drawings, lineups, voice notes** (future sidecars under `matches/<id>/`) — bundle export of whole directories picks them up automatically; storage tools must treat unknown sidecar files as sacred (never sweep them).
- **Metadata** item: per-match metadata lives in the db → travels with the workspace.
- **Replay:** positions/state/voice sidecars dominate per-match storage; voice is the growth driver for item 2's retention rules.
- **Parse cache item** (Export & scripting section, not built): the only future mitigation for "freed demo can't reprocess" — cross-link when it lands.
- **Localization:** new Settings/workspace strings are new UI text (Later item — don't hardcode assumptions about translation).
- **XDG instance isolation / deep-clean:** workspace dirs must stay test-safe (`t.TempDir`); `deep-clean` keeps targeting one XDG instance only.

## Risks & unknowns

- **Wails binding immutability** (verified in `wails/v3@v3.0.0` source): the session-indirection refactor touches every service, the HTTP closures and the `data.*` call sites — this is the L-scale driver for item 1, and a wrong split (re-register attempt, path captured early) fails only at runtime.
- **Never-open-another-instance's-db becomes user-reachable:** "Open workspace" can point at another running instance's live data dir; SQLite/WAL allows it silently and `Open`'s repair would fail the other instance's jobs. Need a refusal/guard (lock probe or `-wal` + liveness heuristic) — how to detect cleanly under modernc sqlite is unknown and should be prototyped first.
- **Quiescing on switch:** in-flight import jobs, sidecar HTTP fetches and the scanner cache must drain/reset before the store closes; races here are the likeliest source of subtle bugs (mitigated by single-active + existing cancel state machine, but needs characterization tests).
- **Export bundle size** (GBs of demos+sidecars): must stream to disk via the native-dialog pipe; zip CPU/time cost for huge bundles is unmeasured (folder-copy alternative may be the honest v1).
- **Size accounting cost:** per-row sidecar stats at list scale (50 rows × readdir) is probably fine but unmeasured; db/WAL bytes during active WAL writes fluctuate.
- **Automation scope creep:** retention rules are easy to over-design; the cron-less hook points (startup + job-done) keep it bounded but the rule surface (age vs. bytes vs. per-map) is an owner decision, not an engineering one.
