# AGENTS.md

Guide for AI agents (and humans) working in this repository. This is a
Wails v3 desktop app (*A powerful, feature-rich CS2 demo viewer and match
analysis toolkit.*; Go services + Svelte 5 frontend): single Go
module in `src/`, GitHub Releases distribution, framework in-app
auto-updater.

**The project root is `src/`: all relative paths and raw
`go`/`npm`/`wails3`/`golangci-lint` commands in this document are
relative to `src/`; `make` targets run from the repo root via the
forwarding Makefile.**

Product vision, philosophy, and feature policy: see `PRODUCT.md` at the
repo root — it is the authority on what Spectra is and isn't. The
roadmap execution plan (with per-item research reports and completion
checkboxes) is `roadmap/PATH.md`.

**Roadmap work happens only on explicit request.** Assume any ad-hoc
request does NOT pertain to the roadmap unless the product owner says
otherwise: do not search `roadmap/` to check whether the change maps to
a roadmap item, do not tick `PATH.md` checkboxes, and do not fold a
request into roadmap execution. When it is time to work the roadmap,
they will be explicit about it.

Supported platforms: **Linux, Windows** (desktop only). The stock
Wails mobile scaffolding (iOS/Android) is removed from `build/` and
gitignored — `wails3 update build-assets` may re-extract it locally; do
not commit or wire it up.

## Commands

```sh
make build          # wails3 build → src/bin/spectra (bootstraps pinned wails3 CLI)
make run            # build + run
make dev            # hot reload: wails3 dev (Go rebuilds + Vite dev server)
make build-assets   # regenerate platform metadata from build/config.yml
make test           # go test -short ./...   (CI's test command)
make lint           # golangci-lint via go tool; version lives in go.mod
make fmt            # gofmt -w .
make vet            # go vet ./...
make package        # platform release payload (binary on Linux/Windows — `package` is `build` there; see Makefile)
make artifact       # produce the release asset the updater downloads for this OS
make artifact-name  # print that asset's name (CI uses it for the artifact name)
make deps           # ensure dev toolchain: wails3 CLI at go.mod's pin, Node 22+
make linux-deps     # apt install GTK4 + WebKitGTK 6.0 build deps (Linux only)
make cs2find ARGS='find --prefix sounds/weapons/c4/'  # in-repo dev tool (read-only VPK search/decode; cs2find --help)
make deep-clean CONFIRM=1   # DESTRUCTIVE: wipes the XDG-selected instance's data+config dirs (library DB included); prints a dry-run listing and refuses without CONFIRM=1 or while spectra runs
```

`make test` / `make vet` / `make lint` create a stub `frontend/dist/` when
missing so `//go:embed` compiles on a fresh clone; the first real build
replaces it. The `wails3` CLI is required on PATH for build/package (the
stock Taskfiles shell out to it) — `make deps` handles that (it also checks
Node is 22+ and warns on missing Linux WebKitGTK libs), and
the Makefile prepends `$(go env GOPATH)/bin` to PATH.

### Visual smoke tests (Linux/KDE)

**GUI testing is only done on request — never by default.** The human
runs live-app checks; agents verify with builds and unit tests only
(`npm run build`, `node --test`, `make test`/`vet`/`lint`) unless the
user explicitly asks them to drive the GUI. The reason: several agents
typically work on this repo in parallel (worktrees on one machine); a
launched app steals focus, and `xdotool`/`spectacle` will click and
screenshot whichever window is frontmost — usually another agent's. So
even when asked, only run GUI checks in a solo pass after any parallel
agents have finished.

Interactive UI checks (on request) drive the live app with `xdotool`
and screenshot with `spectacle`. On KDE the app must run on
**X11** (native Wayland windows are invisible to xdotool), detached
(tool runners kill background process groups when a command times out):

```sh
REPO=$(git rev-parse --show-toplevel)
export XDG_CONFIG_HOME=$REPO/.xdg/config
export XDG_DATA_HOME=$REPO/.xdg/data
export XDG_CACHE_HOME=$REPO/.xdg/cache     # per-worktree instance — see "Instance isolation (XDG)"
setsid -f env GDK_BACKEND=x11 ./src/bin/spectra >/tmp/spectra.log 2>&1
sleep 5
WID=$(xdotool search --class "spectra" | head -1)
xdotool windowactivate "$WID"
xdotool mousemove X Y click 1            # X11 logical coords
xdotool type --delay 60 "text"
xdotool key Return
spectacle -b -n -o /tmp/shot.png         # then Read the PNG
```

- Click targets come from reading a prior screenshot, not window
  geometry: screenshots are physical pixels and the screen scale
  (~1.14× here) makes them drift from xdotool's logical coordinates.
  `xdotool mousemove` is **screen**-absolute: add the window origin
  (`xdotool getwindowgeometry --shell`, which also gives the logical
  size to derive the scale) to in-window coordinates, and mind that
  the screenshot includes the titlebar (~31 logical px at top).
- Input injection needs KWin's EIS permission — the one-time "Remote
  Control" prompt (tick "Always allow") writes
  `XwaylandEisNoPromptApps=xdotool` into `~/.config/kwinrc`.
- Kill with `pkill -x spectra` — never `pkill -f src/bin/spectra`
  (nor the old `pkill -f bin/spectra`, which still substring-matches
  the path but can match the invoking shell's own command line).
- If other instances may be alive, kill by recorded PID instead (e.g.
  `xdotool getwindowpid $WID`, then `kill <pid>`) — bare
  `pkill -x spectra` kills **every** instance (see "Instance isolation
  (XDG)").
- Known quirk: the KWin titlebar can steal the first click after
  activation; verify effects with a screenshot after each step.

All perf figures and visual smoke runs are Linux/X11 only — Windows
timings are unmeasured.

## Instance isolation (XDG)

All runtime state lives in three XDG dirs, resolved exactly like the app
(`adrg/xdg`: env wins, then the defaults):

- `~/.config/spectra/` — `prefs.json` (the only file).
- `~/.local/share/spectra/` — `spectra.db` + `-wal`/`-shm` = **the imported
  library, IRRECOVERABLE**; `demos/` (managed demo copies), `matches/<id>/`
  sidecars, `plugins/`, `tmp/`, WebKitGTK `storage/`+`mediakeys/`;
  `maps/ icons/ sounds/` (~76M) are re-extractable from the CS2 install in
  minutes.
- `~/.cache/spectra/` — WebKitGTK only (no Go code reads it).

The three `XDG_*` env vars relocate a whole instance at once (prefs, db,
sidecars, assets, WebKit profile).

**Convention: every agent-launched instance (GUI smoke, `spectra -import`,
dev runs from a worktree) exports per-worktree dirs first** (`$REPO` =
worktree root):

```sh
export XDG_CONFIG_HOME=$REPO/.xdg/config
export XDG_DATA_HOME=$REPO/.xdg/data
export XDG_CACHE_HOME=$REPO/.xdg/cache
```

`.xdg/` is gitignored. This is what keeps parallel agents from clobbering
each other's prefs (kvstore prefs are last-writer-wins across processes)
and library db.

- **Seed assets once per worktree** so the presence-driven asset prompt
  stays quiet:
  `mkdir -p .xdg/data/spectra && ln -s "$HOME/.local/share/spectra"/{maps,icons,sounds} .xdg/data/spectra/`
  — an isolated instance must **NOT** run extraction (writes go through
  the symlink into the real assets); `cp -r` the three dirs instead when
  extraction is what's being tested.
- **Never open another instance's live db** — `store.Open`'s restart
  repair marks every queued/running job failed, killing the other
  instance's in-flight jobs (`TestOpenMarksStaleJobsInterrupted` pins
  this as deliberate).
- **Coexisting instances:** kill by recorded PID (e.g.
  `xdotool getwindowpid $WID`) — bare `pkill -x spectra` kills every
  instance. `make dev` in a parallel worktree needs `WAILS_VITE_PORT`
  (Vite `strictPort: 9245`).
- **`make deep-clean` composes with this:** it resolves the same env, so
  `XDG_*=… make deep-clean CONFIRM=1` wipes exactly one instance.

## Layout

The table below lists both repo-root entries (`README.md`, `PRODUCT.md`,
`CS2.md`, `golden/`, the root forwarder `Makefile`) and `src/`-relative project
paths (everything else) — resolve project paths against `src/`.

| Path | Role |
|---|---|
| `main.go` | composition root: app + services + window + updater wiring; also `spectra -import <path>` headless CLI smoke import |
| `appservice.go` | `AppService` — frontend-callable methods (`GetVersion`, `SaveWindowSize`) and the update-check flow |
| `libraryservice.go` / `matchservice.go` | `LibraryService` / `MatchService` — the M1 frontend API surface (import/list/jobs/inspectors; match/scoreboard/rounds/events/chat) over `internal/store` |
| `internal/models` | normalized domain types + read DTOs — the contract between extract, store, and the bindings |
| `internal/store` | SQLite (modernc, single-writer, WAL) + embedded baseline schema (`schema.sql`, applied on every Open) + batch writers/queries; scrubs NUL bytes on every write |
| `internal/extract` | demoinfocs v6 engine: handlers → `models.ExtractedMatch`; `Parse(ctx, r, progress)`; unit-tested accumulator |
| `internal/library` | import pipeline: hash/dedupe, zstd sniff, bounded worker pool (FIFO claims; the admission bound reads the shared budget's LIVE size — the `parallel_work` pref via `budget.Size`, so a resize applies to jobs already queued, and `Importer.Wake` pokes parked workers on a grow; every claimed job also takes ONE machine-wide work token from `internal/budget` for its whole body), cancellation, `spectra:*` events |
| `internal/data` | XDG data-dir paths (db, per-match sidecars, tmp) |
| `internal/integration` | golden-demo acceptance test (repo-root `golden/de_cache.dem.zst`, skip-if-absent/pointer, `-update` fixture regen) |
| `internal/mappack` | CS2 radar extraction: Steam install detection → VPK v2 reader → vtex_c decode → map packs in the data dir (Valve IP never ships — see `mappackservice.go` + `frontend/public/maps/README.md`) |
| `cmd/cs2find` + `internal/mappack/devtool.go` | the in-repo dev tool `cs2find` — READ-ONLY search/decode of the local CS2 install and dump of the canonical tables; engine sits beside the mappack internals (no export churn, never a second decoder) |
| `prefs.go` | preference keys + window-size helpers (backed by the v3 `kvstore` service) |
| `version.go` | **stamp-only**: `var version = "dev"` — CI overwrites the whole file on release builds; never put logic here |
| `frontend/` | Svelte 5 + Vite app; built into `frontend/dist` (embedded, gitignored) and `frontend/bindings` (generated per build, gitignored) |
| `Taskfile.yml` + `build/` | stock Wails v3 build system (per-OS tasks, packaging, icons, platform metadata). `build/config.yml` holds product name/ID/version; run `make build-assets` after editing it |
| `build/appicon.png` | the app icon source (512×512 PNG); `wails3 task common:generate:icons` (run automatically by every build) derives `.ico` |
| `Makefile` (in `src/`) | the single source of build/package commands, shared with CI; the repo-root `Makefile` is a thin forwarder (`make -C src <target>`) |
| `README.md` | repo-root front page: player-facing product copy (features, download); the full rule lives in `PRODUCT.md` |
| `CS2.md` | domain-knowledge cache for CS2 facts (formats, mechanics, rules, events); see "CS2 domain knowledge" |
| `golden/` | the demo pool, all tracked via **Git LFS** (`.gitattributes`): `de_cache.dem.zst` is the golden acceptance demo (formerly `donk.dem.zst`), the other `de_*.dem.zst` files are archived map demos not yet onboarded to tests; acceptance tests parse the golden one and skip if absent; regenerate golden fixtures deliberately when extraction changes |

After cloning, run `git lfs pull` if the golden demo is needed.

## Release pipeline

- CI (`.github/workflows/ci.yml`) builds only on `workflow_dispatch` (release)
  and `pull_request`. Pushes never build. The dispatch input `version`
  (`X.Y.Z`) is stamped over `src/version.go` before compiling. Build, test, and
  packaging steps call the Makefile (`make vet`, `make test`,
  `make artifact`) so CI and local flows are the same commands; the uploaded
  artifact name comes from `make artifact-name`.
- Release assets (named for the updater's GitHub provider matcher, which
  picks by GOOS+GOARCH substrings): `spectra-linux-amd64` (raw
  binary), `spectra-windows-amd64.exe` (raw). The release
  skill adds a `SHA256SUMS` sidecar that the updater verifies downloads
  against. These layouts are a contract between `make artifact`,
  `src/build/config.yml`, and `initUpdater` in `src/main.go` — change them together.
- Tags are plain semver `X.Y.Z` (no `v`), created only after the dispatch
  build is green. The `release` skill (`.opencode/skills/release/SKILL.md`)
  is the canonical cut-a-release procedure.
- The updater queries `https://api.github.com/repos/<updateRepo>/releases/latest`
  (`updateRepo` const in `src/main.go`). `version = "dev"` never update-checks.

## Conventions

- **Formatting/lint:** golangci-lint (`.golangci.yml`) + `go vet`; no other
  style tooling. Keep `make lint` green. `build/` is excluded from lint —
  it is stock/regenerated Wails scaffolding, not application code.
- **Tests:** `-short` must skip anything network-bound (`testing.Short()`).
- **`deep-clean` stays opt-in:** never make it a prerequisite of build/test
  targets; it deletes the selected instance's library DB (`spectra.db`) by
  design, gated behind `CONFIRM=1` (see "Instance isolation (XDG)").
- **Services are plain Go:** v3 services take dependencies by hand (see
  `AppService`); never thread a context through them. Frontend calls go
  through generated bindings (regenerated by every build — never edit
  `frontend/bindings` by hand). The framework owns all update UI; do not
  hand-roll dialogs for it.
- **Prefs:** keys live in `prefs.go`; the kvstore is created with
  `AutoSave: true` so every write is durable immediately (a crash must not
  lose state).
- **version.go stays stamp-only.** The CI stamp step replaces the file
  wholesale.
- **`build/config.yml` is the identity file.** After changing `info:`, run
  `make build-assets` and commit the
  regenerated assets. The release skill bumps its `version` in lockstep with
  the dispatch input (two sources, one release).
- **The SQL console is read-only by construction:** `QueryService` /
  `internal/query` validate the statement and run it on a separate
  `mode=ro` + `query_only` connection (timeout + row cap); the write
  handle is never reachable from the console. Keep that layering when
  touching either side.
- **Metrics carry their formula and their N:** every metric documents its
  formula (fallback `Formula: <expr>`), and missing data surfaces as
  value 0 beside `N` (the sample size) — never a fabricated number.
- **`PRD §X.Y` citations in comments are historical:** the product spec
  is retrievable from git history only (it left the tree with the
  reference docs); leave the comments as-is — when a citation encodes a
  durable rule, write the rule here instead of chasing the section.

### Adopting principles (meta)

- **Adoption means migration:** adopting a principle includes converting the
  existing code that violates it — the sweep over current call sites is part
  of the work, not a follow-up someone remembers: it ships in the same change,
  or in an explicitly queued follow-up (recorded with its fence and trigger,
  launched at the first opportunity). **Inconsistent application of a
  principle is worse than no principle at all** — a half-migrated codebase
  shows both patterns, readers can't tell which is canonical, and the stale
  one reproduces by copy-paste. A new rule that doesn't state its migration
  path is incomplete.
- **Differentiate by criterion, not by exception:** when entities that shared
  a common flow must be handled differently, first establish the exact
  general criterion that partitions the category — the property that decides
  which handling any member, present or future, receives — adopt it as the
  principle, and apply it to every member; the entities that triggered the
  fork are just its first instances (precedent: the bot-exclusion split is
  stated as "event-shaped reads keep names / roster reads filter", not as a
  table whitelist; the color-vs-pattern rule partitions by what the medium
  carries). The duty fires on **any** split of a category's handling —
  including a single sanctioned exception — and **inversely**: finding two
  similar entities that appear to have been split with no stated
  justification is itself a trigger to reconstruct the distinction,
  formalize it, and adopt it as a principle. Pin the criterion with a test
  where it's mechanical.

### One canonical way (consolidation conventions)

Adopted by the application-wide consolidation pass. Before adding any
helper, rule, class, or query fragment, check whether a canonical one
already exists — extend it instead of forking it.

Canonical homes (extend these, don't fork them):

| Concern | Canonical home |
|---|---|
| Negative-round filter semantics | `store.queryEvents` — `exactRound` for round detail; `RoundFrom`/`RoundTo` inclusive range with 0 = open bound |
| KAST / K-D expressions | `store/queries.go` consts `kastPerMatchSQL`/`kastCareerSQL`/`kdPerMatchSQL`/`kdCareerSQL` — per-match vs career are deliberate scope variants |
| Player-name joins | `store.playersJoin` — builds the join fragments; LEFT joins carry the empty-steam guard, INNER deliberately do not |
| Column lists | one `<table>Cols` const per table in `internal/store`, pinned to the DDL by `TestColumnListConstsMatchSchema` |
| Delete-then-insert writers | `store.replaceMatchRows` — voice/plugin/`SaveExtracted` keep bespoke tx (atomicity/upsert reasons in code) |
| Single-match lookups | `store.GetMatchSummary` / `GetTeamNames` / `GetPlayerRefs` — never fetch the whole library for one row |
| EventRow → Event | `models.EventFromRow` (payload-free by design); blind-event payloads reach analytics via `store.GetBlindFlashDetails` |
| Read-side cache | `lib/services.js` `cachedRead` — keyed `(method, args)`, flushed on every `spectra:*` event and on mutating wrappers |
| View-local state (non-nav) | `frontend/src/lib/viewstate.svelte.js` `seed`/`remember` — THE process-scoped registry (process-lifetime only; never web storage, never URL state); match-scoped keys `matchKey`, navigation arbitration `arbitrate` (pure, `(prev, route) → next`), test hook `resetViewState()` |
| Generic-payload labels | `eventlabels.go` — THE one labeler (Go only; the JS copy died with Context) |
| Event-row renderer | `lib/components/LandmarkRow.svelte` — the one row for the Replay feed AND CompareRounds' compact sequence |
| Dialogs / popovers | `lib/components/Dialog.svelte`, `lib/components/Popover.svelte` — Escape/outside-click/focus-return; busy-gating stays with the consumer |
| Search suggestions | `lib/components/SuggestInput.svelte` — the ONE suggestion dropdown; sources `store.ListMapNames` + `ProfileService.ListPlayers` |
| Sort headers / stat cells | `lib/components/SortTh.svelte`, `lib/components/StatCard.svelte` — markup only; each view keeps its own sort state and backend |
| Match pickers | `lib/components/MatchPicker.svelte` — Explorer, Reports, Builder all use it |
| Radar coordinate transform | `lib/components/mapxform.js` `makeTransform` — THE pack→transform reader; camera/no-pack bounds fallback stay renderer-only |
| Round-boundary terminators | `lib/replay/roundcut.js` `roundCutTick` — no module scans `roundEnds`/`roundStarts` itself; every transient entity's round-scoped visibility ends at that composition MIN'd with its own terminators (P2 buckets keep the ratified `nextRoundStartTick`-only rule in `ROUND_POLICY`) |
| CS2 asset extraction (families, step order, outcome wording) | `frontend/src/lib/assets.js` `extractAllAssets` — Settings and MapPackPrompt both delegate; views own only their busy/progress/refresh rendering |
| Job progress | `models.Job` — job-wide 0..1 (0 = indeterminate, never "0%") with the stage→range table beside the stage constants in `internal/models`; the emitter is `internal/library`'s progressReporter; render only through `StatusChip` (no second bar) |
| Cross-subsystem concurrency | `internal/budget` — THE resizable work-token pool (counting: one mutex + FIFO waiter hand-off; `SetSize` clamped `[1, MachineTokens()]` — the backend of the ONE machine-level "parallel work" setting) + `MachineTokens()` = THE thread ladder (GOMAXPROCS(0), floor 1; the three former `runtime.NumCPU` copies consolidated there); every sustained heavy unit (import job / asset map job / recompute run) takes ONE token BEFORE the compute lock, never after; nil budget = unbudgeted no-op (the test seam) |
| Progress presentation | `PRODUCT.md` `### Defaults` — THE statement (outside a table cell: centered ring, or spinner when unquantifiable, details underneath; busy buttons exempt; in-cell/list-row progress stays compact inline); never restate it in this file |
| Loading / pre-fetch preference ladder | `PRODUCT.md` `### Defaults` — THE statement; route loading/prefetch preference questions there, never restate the ladder in this file |
| Library-wide index coverage | `internal/store/schema.sql` — the one baseline index block; new library-wide (`steam_id`/`kind`-leading, pending-job) indexes go in the Tier-1 block with their rationale comment, never beside their table alone |
| Bot exclusion (Go) | `store.HumanOnly` / `store.HumanOnlyBySteamID` (`internal/store/queries.go`, beside `playersJoin`) — THE roster/aggregate/selection filter; `playersJoin` itself is NOT a bot filter |
| Bot exclusion (frontend twin) | `frontend/src/lib/players.js` — `isHuman` / `listedPlayers` (+ `isBotId` backstop for flagless rows: synthetic 0xFF ids are 20 digits, real SteamID64s 17) |
| Replay bot presence | `lib/replay/playercard.js` `presentAt` — the ONE card-presence rule; the sole place a bot may list (while covering a disconnected same-side human) |
| Bot identity | `extract.isBotKey` + `players.is_bot` — never the "Bot " name prefix |
| Analysis-rule derived values | every rules-derived value is STORED at analyze time by `internal/analytics` Compute (trade-window counts, trade-opp counts, eco classes/labels in `round_classifications` + `round_side_classes`) — read-time thresholding of rule outputs is forbidden (owner, 2026-11-12); a rules change bumps `analyzed_rule_version` → behind set → `RecomputeAll` |

- **Domain rules live in one place:** side-parity arithmetic in
  `internal/rules` (frontend twin `lib/sideparity.js`, both pinned to
  `internal/rules/testdata/sideparity.json`); the trade window in the analytics pass
  (`analytics.Compute` recomputes `player_stats.trade_kills`); the eco
  buy class in `analytics.buyClass` via `Classify` (stored per round in
  `round_classifications` and per side in `round_side_classes`; the
  retired read-time fill `EconomyRows` survives only as the oracle in
  `internal/analytics/eco_equivalence_test.go`);
  `store.GetCombatStats` SQL is authoritative for combat stats (its
  decisions are pinned by `TestGetCombatStatsSQLDecisions`); counted
  rounds — the ONLY rounds: the extractor discards knife/warmup/
  post-match rounds at ingest (`extract.agg.roundStart`), so every stored
  round is counted and `analytics.CountedRounds` is a documented identity
  over that set (its cross-reference home; the SQL twin
  `warmup = 0 AND pregame = 0` died with the columns; the frontend twin
  `lib/rounds.js isCounted` survived Phase 3 the same way — an identity
  over stored rows that stays THE canonical `number >= 1` guard for a
  pre-reprocess match's legacy negative rows, never re-spelled at a call
  site);
  utility-weapon set in `models.IsUtilityWeapon`; win
  predicate `models.WinFor`; config building `analytics.ConfigFrom`.
  Never re-express a rule in a second layer — add a comment cross-referencing
  the canonical implementation instead.
- **Bot exclusion lives in one place:** `store.HumanOnly` /
  `store.HumanOnlyBySteamID` (Go) and `frontend/src/lib/players.js`
  (`isHuman`/`listedPlayers`, frontend twin) are THE filter; every
  roster/aggregate/selection read routes through it. Event-shaped reads
  (round MVP/first-blood rows, kill-feed attacker/victim cells, chat,
  engagements) deliberately keep bot names — they record what happened.
  The ONE exception is the replay view: `lib/replay/playercard.js`
  `presentAt` lists a bot only while it is covering a disconnected
  same-side human (see the CS2.md bot-substitution entry).
- **The launch asset prompt is presence-driven:** `MapPackPrompt.maybePrompt`
  opens whenever any of the three families is missing (map-pack data
  dir empty / `icons.extracted` / `sounds.extracted`) — every launch,
  until extraction fills them. No suppression pref exists
  (`mappack_prompt_state` is retired, pinned gone by
  `TestRetiredPromptSuppressionPrefGone`); "Not now" and Escape are
  session-only. **Asset extractors serialize:** `internal/mappack.extractMu`
  is locked at the entry of `ExtractMapPacks`/`ExtractIcons`/`ExtractSounds`
  — never add an unlocked extractor (pinned by `TestConcurrentExtractions`).
- **Library queue lifecycle:** `Enqueue` merges a path with a non-terminal
  job into that job (`store.FindPendingJobByPath`), `Reprocess`
  coalesces per match (`FindPendingJobByMatch`) and flips the match row
  to queued with its prior state remembered for the dequeue; a cancel
  never strands a row (queued reprocess → prior state, running →
  failed/openable); `store.Open` repairs matches stuck queued/parsing
  with no live job. Jobs stay on `spectra:job-progress` (100 ms
  throttle) — never a second job event or progress widget. `ListJobs`
  returns the **200 most recent** jobs (display cap only; the `jobs`
  table is never pruned — pruning is Tier 2).
- **Version nothing until the first release — no versioned migrations,
  no versioned contracts, no legacy-data fallbacks** (pre-release
  policy): until we've cut our first release the repo versions NOTHING
  it invented — no format-version constants or keys, no compat gates, no
  "reprocess on version mismatch" branches, no version-history comments.
  Every contract (the DB schema, the sidecar streams, map-pack meta) is
  described ONCE as THE current layout: the schema is one baseline
  `internal/store/schema.sql` applied on every Open — there is no
  `schema_version` table and no upgrade path, so stale local data (a dev
  DB, an old sidecar) is deleted and re-imported, never
  detected-and-branched. Schema-reach problems — a new column (or table
  shape) that cannot reach an existing DB, since the baseline only
  CREATEs — are resolved pre-migration by wipe + re-import
  (`make deep-clean CONFIRM=1`): ALWAYS the answer pre-migration (owner,
  2026-11-12) — never add ensure-column/ALTER paths, and never contort
  the schema to dodge a re-import. Structural corruption guards (mask-legality,
  truncation, monotonicity, frame-count consistency) are NOT version
  machinery — they stay. Reintroducing versioning (migrations, format
  ladders) is a deliberate first-release decision. Data missing a
  required input (exact per-round sides, player final side, stored
  positions) yields unknown/skipped rows — never a guessed
  parity/recovery fallback. Do not reintroduce `RecoverSides`, a
  side-parity guess, or a backfill.
- **State placement — the forward test:** if it should survive a
  restart, is or should be a link, or is shareable ⇒ the route query
  (`lib/router.js` `buildHash`/`parseHash`); if it is view-local working
  state for the current process ⇒ the registry `lib/viewstate.svelte.js`
  (`seed`/`remember`); if it is transient (dialog/modal/popover/busy/
  error/loading/toast) ⇒ neither — it never restores. The URL always
  wins: the registry fills only what the route/query leaves at its
  default, never touches URL-owned state (Replay's filter, Match's tab,
  `?sel=`) and adds no query param of its own. Match-scoped state goes
  through `matchKey(view, id)`. Scroll position per view is
  registry-owned: `captureScroll` records the outgoing view's `.content`
  scrollTop at navigation time (while that view is still rendered),
  `scrollTopFor` returns the incoming view's stored top (0 the first
  time), and `arbitrate` (pure `(prev, route) → next`, pinned in
  `viewstate.test.js`) decides keep (same view — never re-scrolls) vs
  restore (a different view's stored top).
- **Frontend helpers:** errors `errText` → `lib/services.js`; Steam
  profiles/nav actions → `lib/nav.js` (incl. `replayHash`, the one entry
  point into the canonical event browser); formatting → `lib/fmt.js`
  (incl. `chatClock`, the one chat time formatter); CSV and
  downloads → `lib/csv.js` / `lib/download.js` (native save dialogs via
  `lib/save.js`); durable navigation state → the route query
  (`lib/router.js` `buildHash` + `parseHash`) — the one-shot
  sessionStorage hand-offs were retired with the landmark
  consolidation; view-local, NON-navigation state → the process-scoped
  registry `lib/viewstate.svelte.js` (`seed`/`remember`) — the ONE
  sanctioned exception to the module-scoped-view-state rule; WHERE that
  state goes (route query vs registry vs transient) is the **State
  placement** bullet above. Process
  lifetime only (never web storage, never restart durability —
  `webstorage.test.js` scans `src/` and fails on a new reference), and
  tests call the registry's `resetViewState()` hook (required in
  jsdom driver setup — the module instance persists across a suite's
  mounts); metric/definition tooltip
  strings → `lib/definitions.js` (Settings' glossary is rendered from the
  same array); event landmark categories/normalization →
  `lib/replay/landmarks.js` (the ONE categorization — the feed list, the
  scrubber markers and the renderer's world layers all consume its
  pre-bucketed rows; the filter <-> URL shape lives here too);
  landmark feed RUNTIME → `lib/replay/feed.js` (the ONE filter → query
  composer `buildFeedQuery` — no second site may compose feed query
  params from a filter, pinned by feed.test.js — plus the source
  descriptors with their jobs/paging/merge ranks, the `?sel=` resolution
  and the CSV/JSON export shaping); match-static WORLD dataset →
  `lib/replay/world.js` (the once-per-match draw fetch with its side
  channels, the world normalization and the renderer/sfx pushes); radar
  layer assignment + elevation-indicator rules →
  `lib/replay/layers.js` (band convention + the REGION-ONLY threshold
  rules with the optional per-box `z_min`/`z_max` floor scope —
  indicators come only from `elevation_regions` boxes, never a
  per-floor default — the renderer's `flightSplits` owns floor-crossing
  flight splits).
- **CSS:** one unique prefix per component (`mp-` MatchPicker, `pk-`
  MapPackPrompt, `pp-` PlayerPicker, …); concept classes have one spelling
  in `style.css` — `.chip.badge-computed/.badge-inferred`, `.def`,
  `.field-label`, `.note-amber`, `.chip.ok/.bad/.busy/.idle`, `.toolbar`,
  `.view <name>-view`, `--fs-section`. Do not add a prefixed synonym for
  an existing concept.
- **Design language — color vs pattern:** the side pair is "CT blue"
  (`--ct`) / T-orange (`--t`). COLOR = the side at that moment (`--ct` /
  `--t`, swaps at side switches; per-round names via
  `teams.playerSideClassAt`, canvas via `renderer.js` `sideFromFlags`);
  PATTERN = team identity wherever the medium carries one (solid vs
  dashed series lines, solid vs striped bars/swatches, position like the
  round-strip arrow); no pattern possible → fall back to the side the
  team STARTED as (`--team-start-*` via `teams.teamStartClass` /
  `playerStartClass`); never pattern TEXT (no underline/strikethrough
  differentiation); never hard-code the hexes outside `renderer.js`'s
  documented `CT_COLOR`/`T_COLOR`; an unresolvable side stays
  `''`/neutral, never a guessed color. The dashed vocabulary is scoped:
  solid/dashed = team identity IN SERIES LINES; existing border dashes
  (provenance chips, halftime separator, unknown buy-class) keep their
  meanings.
- **View-level aggregates are allowed** only when they are pure functions
  over already-fetched rows, the formula is documented in the card's title
  or tooltip, and the value is not derivable from a stored metric without
  cost. If a view aggregate duplicates a stored metric, relocate it.
- **Probing the install goes through `cs2find`** (`cmd/cs2find` +
  `internal/mappack/devtool.go`, `make cs2find ARGS='…'`): the ONE
  read-only search/decode CLI over `pak01_dir.vpk` and the canonical
  tables (`where · find · get · sound · overview · icon · table · hash ·
  events`). No more `zz_*` scratch harnesses or throwaway VPK probers —
  if a probe is needed, extend `RunDevTool` (it lives beside the
  unexported internals, so there is no export churn and never a second
  decoder). `table` only prints `soundTable`/`iconTable` (they stay THE
  mappings); `events`/`hash --resolve` are exploratory over the local
  install. Valve IP never ships: `-o` defaults to `<tmp>/cs2find/`, a
  working-tree target warns, and tests write only to `t.TempDir()`.
- **Tests:** characterization tests before behavior changes; frontend unit
  tests are `node --test src/lib/*.test.js` (run from `frontend/`),
  DOM tests are the jsdom
  harnesses in `frontend/test/` (jsdom is a declared devDependency — a
  plain `npm ci`/`npm install` in `frontend/` provides it; never install
  test deps `--no-save`, which makes `npm ci` prune them and break every
  parallel agent's DOM runs). Golden
  fixtures may only be regenerated deliberately, with the diff explained —
  a fixture diff without justification is a rejected change.

## CS2 domain knowledge

Anything about Counter-Strike 2 itself — demo/event semantics, game
mechanics, official rules, cvars, third-party tools — must be **looked
up, not guessed**. Do not speculate about CS2 domain facts from memory or
infer them from context.

- First check `CS2.md` (the domain-knowledge cache). If the answer is
  there, use it.
- If it isn't, search the web (official Valve docs, demoinfocs docs,
  community wikis), then **record the finding in `CS2.md`** using the
  format described there — question, distilled answer, source URL(s) and
  retrieval date — so future agents can skip the search.
- If web search is unavailable (e.g. the daily search quota is
  exhausted), fall back to the **`agent-browser` CLI** (installed at
  `/usr/bin/agent-browser`): `agent-browser read <url>` fetches
  agent-readable page text; `agent-browser skills get core` loads its
  workflow guide first. Source requirements are unchanged either way —
  a URL and retrieval date still go in the `CS2.md` entry.
- Keep entries short and sourced; re-verify and update stale entries
  rather than piling on contradicting ones.
