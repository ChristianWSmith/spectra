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
| `metricservice.go` | `MetricsService` — metric definitions, the save gate forwarder, sweeps (`scheduleSweep`), metric runs and the metric state reads |
| `componentservice.go` | `ComponentService` — user components, placements (`layout_placements`) and builtin overrides (`builtin_overrides`) |
| `internal/metrics` | the metric gate (`GateSQL`, `CheckRawSave`), the raw-SQL run path and the per-unit sweep pass |
| `internal/models` | normalized domain types + read DTOs — the contract between extract, store, and the bindings |
| `internal/store` | SQLite (modernc, single-writer, WAL) + embedded baseline schema (`schema.sql`, applied on every Open) + batch writers/queries; scrubs NUL bytes on every write |
| `internal/extract` | demoinfocs v6 engine: handlers → `models.ExtractedMatch`; `Parse(ctx, r, progress)`; unit-tested accumulator |
| `internal/library` | import pipeline: hash/dedupe, zstd sniff, bounded worker pool (FIFO claims; the admission bound reads the shared budget's LIVE size — the `parallel_work` pref via `budget.Size`, so a resize applies to jobs already queued, and `Importer.Wake` pokes parked workers on a grow; every claimed job also takes ONE machine-wide work token from `internal/budget` for its whole body), cancellation, `spectra:*` events |
| `internal/data` | XDG data-dir paths (db, per-match sidecars, tmp) |
| `internal/integration` | golden-demo acceptance test (repo-root `golden/de_cache.dem.zst`, skip-if-absent/pointer, `-update` fixture regen) |
| `internal/mappack` | CS2 radar extraction: Steam install detection → VPK v2 reader → vtex_c decode → map packs in the data dir (never ships Valve IP — PRODUCT.md; see `mappackservice.go` + `frontend/public/maps/README.md`) |
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
- **No session leakage** (owner, 2026-11-17): committed file and test
  names describe the DOMAIN they cover, never the ad-hoc wave/session/
  branch that produced them nor a plan-item number (wave/session/plan
  tokens: `w27_…` / `me0_…` / `r13_…` / `m5_…` style is a
  no-no — the name must still mean something in a week). Durable docs
  (this file, agent configs, PRODUCT/README) cite incidents by date and
  description, never by wave/session token — the pattern examples in
  this rule and the worktree-naming convention are shapes, not
  citations. Dated wave references inside code comments (the ledger
  style, e.g. the `driver-liveness.mjs` history comments) are history
  and stay. Pinned mechanically by `TestNoSessionLeakageInFileNames`.
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
- **Metric pipeline (landed 2026-11-21):** metrics are raw SQL, and
  components are Svelte source stored in the database. What the migration
  did not finish is listed in `FOLLOWUP.md`. Where the code still differs
  from a rule in this file, the rule says so. Do not extend the retired
  grammar, and do not add pref keys for layout or ordering.
- **Save gate (one gate):** `internal/metrics` `CheckRawSave` (over
  `GateSQL`, reached from `metricservice.go`) validates a metric's SQL on
  every path: the Builder's live check, save, preview and sweep. It
  accepts exactly one statement whose leading keyword is `SELECT` or
  `WITH`, with no write verb anywhere (so no `CREATE VIEW`). Every table
  it reads, including tables inside subqueries and CTE bodies, must be on
  the metric-readable allowlist (`internal/store/metric_gate.go`, which
  classifies every schema table and is pinned by a test), or be a CTE
  name, a `metric('…')` reference or a pure table-valued function. The
  gate refuses any bind other than the reserved ones, and any reserved
  bind the run does not supply. Saves go through `SaveMetricWithDeps`,
  which re-derives the dependency rows from the current SQL.
- **Scope is the reserved binds.** `:match_id` (match grain), `:steam_id`
  (career grain) and `:round` (round grain, always with `:match_id`) say
  which units a metric's stored rows are keyed by (`internal/store/metric_scope.go`).
  A metric with no binds is library-wide. The `metrics` table still has
  legacy `scope`, `subject` and `partition` columns, and `ValidateExpr`
  still takes them. Their removal is cleanup tracked in `FOLLOWUP.md`; the
  binds are the rule.
- **Touched tables.** The save derives the physical tables the statement
  reads and stores them on the metric row (`metrics.touched`, comma-joined).
  The set is derived from the SQL and never versioned. A builtin's touched
  set is stored at save like any other metric's.
- **Execution and metric runs.** Metric SQL runs on the read-only
  connection, sweeps included, so a slow metric never holds the single
  writer. There is no timeout and no row cap. Each running statement is a
  metric run (`metric_runs`; `ListRunningMetrics`), and `CancelMetric`
  cancels one from the UI.
- **Freshness.** A stored value is behind when a table it touches changes
  for the unit it is keyed by (`markMatchWritesBehind`), or when a metric
  it references through `metric('…')` (`metric_deps`) is behind. The
  change walks the dependency graph with its scope (`invalidateDependents`).
  An analysis-rule value edit fires that rule's builtin stub and reaches
  only the analysis tables the rule owns (`affectedRuleTables`). A code
  change to analysis bumps `analyzed_rule_version`, and only that bump
  marks metrics behind broadly (`RecomputeAll`).
- **Sweeps.** Every trigger (import analyze, save, plugin operation,
  `RecomputeAll` completion, startup) goes through `scheduleSweep`, and
  nowhere else. At most one sweep runs, and at most one follow-up is
  pending: triggers during a run set one flag, so a batch of N imports
  runs one sweep plus at most one follow-up. A running sweep is never
  cancelled. Each sweep re-resolves the behind set when it starts, and
  works per unit (`ClearMetricUnits` per unit). `GetMetricStates(scope, id)`
  answers one match's or one player's states, and another unit being
  behind never marks it.
- **Career and profile metrics** are built from stored per-match
  components through `metric('…')` and combine them as ratios of sums
  (career ADR is total damage over total rounds, never a mean of per-match
  ADRs). Per-match metrics store additive components.
- **Round grain, capped damage, post-match and clutches.** Round-grain
  metrics are keyed by `:round`. Damage metrics read the capped damage
  credit per hit (`capped_dmg`). Events stamped `post_match` are excluded
  from event-derived folds. The clutch family is seeded builtins over the
  `clutches` table, which analysis owns.
- **User metrics (power surface, PRODUCT.md **Power surfaces**):** user
  SQL has no bot filter, no sample-size guarantee, no timeout, and no row
  cap. Nothing is injected into it. Users may read the metric-readable
  tables on the allowlist, which include `players`. Every other table is
  denied, including `metric_values`, `metric_runs`, `metric_deps`,
  `metrics`, `components`, `layout_placements`, `builtin_overrides`,
  `jobs`, `query_history`, `saved_queries`, `saved_filters`,
  `report_templates`, `plugins`, `analysis_config`, `warnings`,
  `player_career`, `voice_presence` (voice stays in the sidecar), and
  `sqlite_*`. Metrics reach other metrics only through `metric('…')`.
- **Builtin conventions (rigid; enforced by the builtin test suite, not
  by a compiler):**
  1. Each builtin's canonical expression is its SQL, seeded in
     `internal/store/schema.sql`.
  2. Every roster, aggregate, or selection read excludes bots: the SQL
     form of `store.HumanOnly` / `HumanOnlyBySteamID` is the one fragment
     a builtin uses. Event-shaped reads keep bot names (PRODUCT.md
     **Event surfaces record what happened**).
  3. No fabricated values. An absent row, an empty pool, or an unresolved
     identity shows a dash. Zero appears only when the query produced a
     zero.
  4. Round-grain statistics are metrics keyed by round. Round records are
     shown as records.
  5. Every builtin is verified against the pre-migration snapshot in
     `~/Programming/spectra-home` (verification notes in `FOLLOWUP.md`). A
     value that differs from the snapshot is a bug, not an accepted
     change. Copy the snapshot before opening it.
  6. A builtin's touched tables are stored at save like any metric, and
     every analysis-rule stub a builtin depends on is declared.
- **Components (power surface).** A component is Svelte 5 source. User
  components are rows in the `components` table. Builtin components ship
  as source, with ids under the `builtin-` prefix (registry:
  `frontend/src/lib/componentbuiltins.js`). Both use the same language and
  runtime. They are written and previewed in the **Component Builder** tab
  (`#/componentbuilder`, beside the Metric and Reports builders). Save is
  gated by `componentruntime/savegate.js`, debounced; while a compile is
  running the Builder shows a background-work indicator with **Cancel**
  beside Save (`cancelCompiles`).
- **Component runtime.** Compilation runs in a Web Worker
  (`componentruntime/compile.worker.js`), lazily on first use.
  `svelte/compiler` is loaded by dynamic import inside that worker, never
  on the main thread or at launch. Compiled modules are cached in memory
  by source hash, and their runtime imports are rewritten to the app's own
  Svelte runtime. The WebKitGTK runtime check is still owed (FOLLOWUP.md).
  Each mounted component receives one read API as the `spectra` prop
  (`componentruntime/readapi.js`): `metric(name, binds)` (stored values
  with the five states), `query(sql, binds)` (a live read-only read with no
  freshness), `context` (the mounting surface's match, steam id and round;
  binds default from it), `navigate`, `guard(fn)` for event and async work,
  `isHuman` and `listedPlayers`, and `<spectra.Child>` to mount a named
  component inside another. A failed `metric()` or `query()` is reported
  into the component's frame and also rejects. Each component renders
  inside its own error boundary. There is no sandbox: components run in the
  webview with the app's bindings.
- **Helper surface.** A builtin may import a curated set of app modules:
  the `BUILTIN_HELPERS` registry in `componentruntime/compile.js` lists
  each module and the names a builtin may take from it. A user component
  may import nothing, and the save gate refuses every import from one. A
  new helper name is a review: add it to the registry with a line on what
  it is for.
- **Builtin registry and generator.** Builtin panels are `.svelte` files
  under `frontend/src/lib/builtins/`, declared in `builtins/panels.js`.
  `frontend/scripts/gen-builtin-sources.mjs` (run by `npm run build` and
  `npm run dev`) writes `builtins/generated/sources.js`, which holds each
  builtin's source text and id list. That file is gitignored, so never
  hand-maintain a builtin id list. `componentbuiltins.js` adds the
  placeholder and the Match, Economy and Utility text panels.
- **Builtin edits are in place, with restore.** A builtin component,
  metric or report is edited in place. Save stores one row per edited
  builtin in `builtin_overrides` (keys `builtin-…`, `metric:<name>`,
  `report:<id>`), and the Builder shows an Edited chip. **Restore to
  default** removes the row and returns the shipped source
  (`DeleteBuiltinOverride`, `RestoreBuiltinMetric`, `RestoreBuiltinReport`).
  Duplicate-to-edit is cancelled for builtins (owner ruling 43). The
  Component Builder's leftover builtin Duplicate action is still present
  and is tracked in `FOLLOWUP.md`.
- **Placements and "use as my view".** A surface renders its stored
  placements (`layout_placements`, read through `ComponentService.ListPlacements`
  and mounted by `components/SurfaceView.svelte`). Two surfaces exist:
  `match-view`, the Match view's area below the header (the tab bar and
  everything under it), and `profile-view`, an individual player's Profile
  view. "Use as my view" places one component on a surface. A surface
  with no rows renders its builtin composition. A hidden row is kept in
  storage but not rendered. **Reset to default** (`ResetPlacements`) removes
  the replacement. The Match header, warnings, round strip and the profiles
  list stay hardcoded.
- **Formatting belongs to components (target).** A metric carries no
  display format. Percent, millisecond, and money formatting live in the
  component that shows the value. The `metrics.format` tag and the Builder's
  Format select still exist in code (`lib/metricformats.js`). Removing them
  is not yet done, and `FOLLOWUP.md` does not list it.
- **View computation (owner, 2026-11-20):** views may compute for
  presentation, from rows they have already fetched. The earlier
  exception list and relocation rule are retired. A statistic another
  surface needs is a metric (see **Shared statistics** above).
- **Metrics are raw SQL, and stored values stay fresh:** a metric is a
  SQL expression, builtin or user-authored. Its stored expression is its
  formula and is shown wherever the metric is shown. PRODUCT.md
  **Freshness** is the statement; the pipeline is in the **Metric
  pipeline** bullets above. Do not reintroduce a sample-size (N) field, a
  sugar grammar, or a second expression language.
- **Shared statistics are metrics (owner, 2026-11-14, restated
  2026-11-20):** a statistic that more than one surface shows is a
  metric — stored, freshness-tracked, and shown through the metrics
  system's state vocabulary and Builder — never a copy in a
  service, store query, or view. Raw event reads stay in
  `internal/extract`, and analysis-rule stored outputs stay in
  `internal/analytics` Compute (canonical rows below). Views may compute
  for presentation (see **View computation** below).
- **`PRD §X.Y` citations in comments are historical:** the product spec
  is retrievable from git history only (it left the tree with the
  reference docs); leave the comments as-is — when a citation encodes a
  durable rule, write the rule here instead of chasing the section.
- **The user guide's mechanics:** PRODUCT.md **The manual stays in
  lockstep** is THE statement — never restate it here. The manual lives
  in `frontend/src/lib/docs/manuals/` (one module per manual,
  registered through `lib/docs/registry.js`, rendered by the help
  popup); a wave that changes user-visible behavior, surfaces or
  wording updates the guide's sections in the SAME wave; a new
  user-visible surface gets a guide section (or an explicit placeholder)
  before merge; guide prose is count-free (names, never hard-coded
  counts) and code-cited — verify each claim against its cited source
  before wording it. Surface→section coverage is pinned by
  `src/lib/docslockstep.test.js` (run from `frontend/`).

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
| KAST / K-D expressions | `store/queries.go` consts — `kastPerMatchSQL`/`kdPerMatchSQL` are RETIRED from production (trend, history and the report read-back serve stored metric rows) and survive only as the reference oracles in `metric_series_read_test.go`; the career-layer twins (`kastCareerSQL`/`kdCareerSQL`) died with the career dual-write removal — `RebuildCareer` writes raw counts only and every derived career number is a stored metric row |
| Player-name joins | `store.playersJoin` — builds the join fragments; LEFT joins carry the empty-steam guard, INNER deliberately do not |
| Column lists | one `<table>Cols` const per table in `internal/store`, pinned to the DDL by `TestColumnListConstsMatchSchema` |
| Delete-then-insert writers | `store.replaceMatchRows` — voice/plugin/`SaveExtracted` keep bespoke tx (atomicity/upsert reasons in code) |
| Single-match lookups | `store.GetMatchSummary` / `GetTeamNames` / `GetPlayerRefs` — never fetch the whole library for one row |
| EventRow → Event | `models.EventFromRow` (payload-free by design); blind-event payloads reach analytics via `store.GetBlindFlashDetails` |
| Read-side cache | `lib/services.js` `cachedRead` — keyed `(method, args)`, flushed on every `spectra:*` event and on mutating wrappers |
| View-local state (non-nav) | `frontend/src/lib/viewstate.svelte.js` `seed`/`remember` — THE process-scoped registry (process-lifetime only; never web storage, never URL state); match-scoped keys `matchKey`, navigation arbitration `arbitrate` (pure, `(prev, route) → next`), test hook `resetViewState()` |
| Generic-payload labels | `eventlabels.go` — THE one labeler (Go only; the JS copy died with Context) |
| User-facing chrome copy | `frontend/src/lib/strings/` — THE catalog (free chrome copy; `index.js` is the only import path, `fill()` the only composer) + mechanical pin `frontend/src/lib/strings-audit.test.js` |
| Event-row renderer | `lib/components/LandmarkRow.svelte` — the one row for the Replay feed AND CompareRounds' compact sequence |
| Dialogs / popovers | `lib/components/Dialog.svelte`, `lib/components/Popover.svelte` — Escape/outside-click/focus-return; busy-gating stays with the consumer |
| Search suggestions | `lib/components/SuggestInput.svelte` — the ONE suggestion dropdown; sources `store.ListMapNames` + `ProfileService.ListPlayers` |
| Sort headers / stat cells | `lib/components/SortTh.svelte`, `lib/components/StatCard.svelte` — markup only; each view keeps its own sort state and backend |
| Match pickers | `lib/components/MatchPicker.svelte` — Explorer, Reports, Builder all use it |
| Radar coordinate transform | `lib/components/mapxform.js` `makeTransform` — THE pack→transform reader; camera/no-pack bounds fallback stay renderer-only |
| AudioContext resume retry | `frontend/src/lib/replay/audioresume.js` — THE gesture-retry home: the document pointerdown/keydown capture listeners, `tryResume`'s `RESUME_MS` race, the bounded gesture-free backoff and the early `primeAudioContext()` (load()-entry construction inside the opening click's activation window); consumed by BOTH engines — `replay/audio.js` (voice) and `replay/sfx.js` (sound effects) — which keep only their outcomes (`onRunning`/`onClosed`/`onFailure`) and guards |
| Round-boundary terminators | `lib/replay/roundcut.js` `roundCutTick` — no module scans `roundEnds`/`roundStarts` itself; every transient entity's round-scoped visibility ends at that composition MIN'd with its own terminators (P2 buckets keep the ratified `nextRoundStartTick`-only rule in `ROUND_POLICY`) |
| CS2 asset extraction (families, step order, outcome wording) | `frontend/src/lib/assets.js` `extractAllAssets` — Settings and MapPackPrompt both delegate; views own only their busy/progress/refresh rendering |
| Job progress | `models.Job` — job-wide 0..1 (0 = indeterminate, never "0%") with the stage→range table beside the stage constants in `internal/models`; the emitter is `internal/library`'s progressReporter; render only through `StatusChip` (no second bar) |
| Cross-subsystem concurrency | `internal/budget` — THE resizable work-token pool (counting: one mutex + FIFO waiter hand-off; `SetSize` clamped `[1, MachineTokens()]` — the backend of the ONE machine-level "parallel work" setting) + `MachineTokens()` = THE thread ladder (GOMAXPROCS(0), floor 1; the three former `runtime.NumCPU` copies consolidated there); every sustained heavy unit (import job / asset map job / recompute run) takes ONE token BEFORE the compute lock, never after; nil budget = unbudgeted no-op (the test seam) |
| Progress presentation | `PRODUCT.md` `### Defaults` — THE statement (Progress presentation); never restate it in this file |
| Loading / pre-fetch preference ladder | `PRODUCT.md` `### Defaults` — THE statement; route loading/prefetch preference questions there, never restate the ladder in this file |
| Library-wide index coverage | `internal/store/schema.sql` — the one baseline index block; new library-wide (`steam_id`/`kind`-leading, pending-job) indexes go in the Tier-1 block with their rationale comment, never beside their table alone |
| Bot exclusion (Go) | `store.HumanOnly` / `store.HumanOnlyBySteamID` (`internal/store/queries.go`, beside `playersJoin`) — THE roster/aggregate/selection filter; `playersJoin` itself is NOT a bot filter. Builtin metric SQL uses the same predicate as its one SQL fragment (Builtin conventions, rule 2); user metric SQL is not filtered |
| Bot exclusion (frontend twin) | `frontend/src/lib/players.js` — `isHuman` / `listedPlayers` (+ `isBotId` backstop for flagless rows: synthetic 0xFF ids are 20 digits, real SteamID64s 17) |
| Replay bot presence | `lib/replay/playercard.js` `presentAt` — the ONE card-presence rule; the sole place a bot may list (while covering a disconnected same-side human) |
| Bot identity | `extract.isBotKey` + `players.is_bot` — never the "Bot " name prefix |
| Analysis-rule derived values | every rules-derived value is STORED at analyze time by `internal/analytics` Compute (trade-window counts, trade-opp counts, eco classes/labels in `round_classifications` + `round_side_classes`) — read-time thresholding of rule outputs is forbidden (owner, 2026-11-12). Editing a rule value fires that rule's builtin metric stub, which recalculates its dependents only; a code change to analysis bumps `analyzed_rule_version` → behind set → `RecomputeAll` (the broad path, reserved for code changes) |
| Stored metric values | value reads `store.GetMetricValuesForMatch`/`GetMetricValuesForPlayer` — THE reads (fresh rows only: a saved, unmodified definition reads stored; an unsaved/dirty draft calculates on demand) + behind predicate `store.MetricCoverage` — ONE spelling (sweep selection, read freshness and `GetMetricComputeState` all derive from it) + state vocabulary `frontend/src/lib/metricstate.js` `metricPresentation` + `GetMetricComputeState` — the five words (processing, failed, fresh, no-data, behind); stamps internal-only, no version ever reaches a render + save graph `store.SaveMetricWithDeps` — deps re-derived wholesale from the current expr, cycle rejection, rename splice, delete-blocked-while-referenced, cascade version bump. Definitions live in the `metrics` table (one baseline in `schema.sql`; `expr` is raw SQL; result storage is by bound scope (`internal/store/metric_scope.go`); touched tables are derived at save — see **Metric pipeline** in the conventions) |
| Metric sequence (every metric list) | `frontend/src/lib/metricorder.js` — THE default sequence: `resolveOrder` over the scope's fixed entries (`@Name`, `@Team`, `@Score`) and the catalog's metric names, by `DEFAULT_RANKS` and `FIXED_RANKS`. `inSequence` (metric-only) and `composedSequence` (merged) are its views, `DEFAULT_CARDS.profile` is the shipped career card set, and `rawItems`/`isRawId` derive the recorded-value offers. There is no user-chosen order, pinning, hiding or economy placement (ruling 33): every list composes through this module, and a view shows what its component shows |
| Metric save gate | `internal/metrics` `CheckRawSave` (over `GateSQL`; `metricservice.go` forwards to it) — THE one validation (one read-only statement, no `CREATE VIEW`, every table on the metric-readable allowlist, touched tables derived), shared by the Builder's live check, save, preview and sweep; no call site re-validates |
| Round-grain statistics | Round-grain statistics are metrics keyed by round (owner ruling 2026-11-18). Round records (`player_round_stats` read through the one `getPlayerRounds` fetch) are displayed as records; a side with no player rows in a round shows a dash, never a guessed 0 |

- **Domain rules live in one place:** side-parity arithmetic in
  `internal/rules` (frontend twin `lib/sideparity.js`, both pinned to
  `internal/rules/testdata/sideparity.json`); the trade window in the analytics pass
  (`analytics.Compute` recomputes `player_stats.trade_kills`); the eco
  buy class in `analytics.buyClass` via `Classify` (stored per round in
  `round_classifications` and per side in `round_side_classes`; the
  retired read-time fill `EconomyRows` survives only as the oracle in
  `internal/analytics/eco_equivalence_test.go`);
  the combat damage conversions live as the `dmg_no_kill` /
  `kill_conversion` builtin seeds (raw SQL after the SQL port; owner,
  2026-11-17); the retired `store.GetCombatStats` SQL survives only as
  the reference oracle in `internal/metrics/combat_equivalence_test.go`;
  counted
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
  (`isHuman`/`listedPlayers`, frontend twin) are THE filter for app
  reads; builtin metric SQL carries the same predicate as its one fragment.
  User metric SQL is not filtered (accepted footgun). Every
  roster/aggregate/selection read routes through it. Event-shaped reads
  (round MVP/first-blood rows, kill-feed attacker/victim cells, chat,
  killTags) deliberately keep bot names — they record what happened
  (stance: PRODUCT.md **Event surfaces record what happened**).
  The ONE exception is the replay view: `lib/replay/playercard.js`
  `presentAt` lists a bot only while it is covering a disconnected
  same-side human (see the CS2.md bot-substitution entry).
- **The launch asset prompt is presence-driven** (stance: PRODUCT.md
  `### Defaults`): `MapPackPrompt.maybePrompt`
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
  no versioned contracts, no legacy-data fallbacks** (the engineering
  application of PRODUCT.md **Breaking changes** — at-will before the
  first release): until we've cut our first release the repo versions NOTHING
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
  strings → `lib/definitions.js` (the tooltip source for the
  Combat/Economy/EconCurve definition constants); event landmark categories/normalization →
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
- **Desktop app, not a web app** (owner, 2026-11-14): Spectra runs on web
  technology (Wails + WebKitGTK) but is a desktop application — user-facing
  copy never describes it with browser chrome (address bars, copied links,
  bookmarks) or as a website. External links (e.g. Steam profiles) open in
  the system browser and may be described as such.
- **User-facing text speaks the user's domain — never implementation
  language** (owner, 2026-11-14): **user-facing** = anything the UI or an
  export renders — labels, titles, tooltips, aria-labels, empty states,
  chips, placeholder/help copy, glossary/definitions prose, seed-doc
  tooltips (metric `doc`), exported report/template prose, and Go error
  strings surfaced through `errText`. **May name:** the user's domain
  (matches, players, rounds, stats, metrics, built-ins,
  processing/behind states) and product vocabulary. **Must NOT name:**
  implementation artifacts — programming languages (Go/golang), database
  tables/columns in prose (expressions exempt), code-level nouns (seeds,
  bindings, stubs, sweeps, commits, worktrees), developer shorthand.
  **Exempt power surfaces:** metric expression text / `Formula:` content,
  the expression editor, the SQL console, test names/comments,
  AGENTS/doc.go/code comments. Mechanical pin:
  `frontend/src/lib/strings-audit.test.js` (denylist + table terms +
  catalog hygiene), catalog home in the canonical table above. Adopted
  2026-11-14 together with its sweep — statement and migration ship as
  one change (see "Adopting principles (meta)" above), so the pre-existing
  copy was reworded in the same wave this rule landed.
- **User-facing text is tiered by length** (owner, 2026-11-15): **tier 1 —
  common locations** (labels, buttons, chips, titles, empty states, status
  copy) ≤ **70 characters**; **tier 2 — hints** (tooltips, footnotes,
  in-place explanatory notes) ≤ **200 characters**; **tier 3 — anything
  longer** must be a help affordance linking to the user guide. Classification
  is mechanical and default-tight: **unclassified copy is tier 1** — a catalog
  key becomes tier 2 only by being referenced from a `title=` attribute in the
  markup or by an explicit `HINT_KEYS` entry (the pin's declaration, each entry
  carrying its `why`); wholesale tier 2 by medium: glossary (`definitions.js`)
  values, seed `doc` tooltips (measured whole, `Formula:` segment included —
  what the user hovers is what counts) and Go error strings surfaced through
  `errText` (measured as their format string). Counts are of the static string:
  templates keep their `{arg}` placeholders. **Exempt:** guide prose in
  `lib/docs/` (the tier-3 destination — never length-capped), exported report
  templates (documents, not chrome), class-4 power surfaces, test files.
  Shortening never lies or misleads — drop redundancy, keep the truth; detail
  that no longer fits belongs in the guide, never dropped silently. Mechanical
  pin: the length test in `frontend/src/lib/strings-audit.test.js`. Adopted
  2026-11-15 together with its sweep — statement, sweep and pin ship as one
  change (see "Adopting principles (meta)" above).
- **Input hints are verb-like** (owner, 2026-11-15): scope = `placeholder=`
  attributes in markup — an input hint. An `aria-label`, a `title` tooltip and
  a select option are other media (labels, tooltips, choices), never checked
  here. The rule: the first whitespace-separated word of the resolved hint text
  must be a member of the pin's closed `VERB_ALLOWLIST` (Search / Filter / Type
  / Enter / Select / Describe / Name / Document — every entry declared with its
  own `why`), and it fails closed: a first word nobody declared is a violation,
  never an implicit pass. Exempt classes live in ONE `HINT_*` block in the pin
  with their criteria (never scattered whitelisting): **power surfaces** — the
  SQL console's placeholders (via `POWER_SURFACES`) and the expression editor's
  `EXAMPLE` (an explicit `HINT_EXEMPT` entry, Builder being outside
  `POWER_SURFACES`); **endpoint markers** — `from`, `to`, `min`, `max`,
  `start`, `stop` (`HINT_NONVERB`), criterion: the placeholder IS the field's
  only visible per-field label (a mini-label, not a hint) — the full name lives
  in the aria-label/sr-only label. `HINT_PASSTHROUGH` holds an unresolvable
  expression; `HINT_SOURCES` holds a hint const that renders as a hint without
  sitting on a placeholder attribute (the owner's own `Search players...`).
  Every `HINT_*`/`HINT_SOURCES` entry must still match a live site and carry a
  non-empty `why`. Length tiers apply independently — a verb-like hint is
  still measured. Mechanical pin: Check E in
  `frontend/src/lib/strings-audit.test.js`. Adopted 2026-11-15 together with
  its sweep — statement, sweep and pin ship as one change (see "Adopting
  principles (meta)" above).
- **View aggregates (owner, 2026-11-20):** views may fold rows they have
  already fetched, for presentation. The formula should be stated in the
  card's title or tooltip. The former exception list and relocation rule
  are retired; the shared-statistics rule above is the only constraint on
  where a statistic lives.
- **Probing the install goes through `cs2find`** (`cmd/cs2find` +
  `internal/mappack/devtool.go`, `make cs2find ARGS='…'`): the ONE
  read-only search/decode CLI over `pak01_dir.vpk` and the canonical
  tables (`where · find · get · sound · overview · icon · table · hash ·
  events`). No more `zz_*` scratch harnesses or throwaway VPK probers —
  if a probe is needed, extend `RunDevTool` (it lives beside the
  unexported internals, so there is no export churn and never a second
  decoder). `table` only prints `soundTable`/`iconTable` (they stay THE
  mappings); `events`/`hash --resolve` are exploratory over the local
  install. cs2find output rules (PRODUCT.md **Valve IP never ships**):
  `-o` defaults to `<tmp>/cs2find/`, a
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
