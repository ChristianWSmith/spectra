# AGENTS.md

Guide for AI agents (and humans) working in this repository. This is a
Wails v3 desktop app (*A powerful, feature-rich CS2 demo viewer and match
analysis toolkit.*; Go services + Svelte 5 frontend): single Go
module at the repo root, GitHub Releases distribution, framework in-app
auto-updater.

## Commands

```sh
make build          # wails3 build → bin/spectra (bootstraps pinned wails3 CLI)
make run            # build + run
make dev            # hot reload: wails3 dev (Go rebuilds + Vite dev server)
make build-assets   # regenerate platform metadata from build/config.yml
make test           # go test -short ./...   (CI's test command)
make lint           # golangci-lint via go tool; version lives in go.mod
make fmt            # gofmt -w .
make vet            # go vet ./...
make package        # platform release payload (.app bundle on macOS; binary elsewhere)
make artifact       # produce the release asset the updater downloads for this OS
make artifact-name  # print that asset's name (CI uses it for the artifact name)
make deps           # ensure dev toolchain: wails3 CLI at go.mod's pin, Node 22+
make linux-deps     # apt install GTK4 + WebKitGTK 6.0 build deps (Linux only)
```

`make test` / `make vet` / `make lint` create a stub `frontend/dist/` when
missing so `//go:embed` compiles on a fresh clone; the first real build
replaces it. The `wails3` CLI is required on PATH for build/package (the
stock Taskfiles shell out to it) — `make deps` handles that (it also checks
Node is 22+ and warns on missing Linux WebKitGTK libs), and
the Makefile prepends `$(go env GOPATH)/bin` to PATH.

### Visual smoke tests (Linux/KDE)

Interactive UI checks drive the live app with `xdotool` and screenshot
with `spectacle`. On KDE the app must run on **X11** (native Wayland
windows are invisible to xdotool), detached (tool runners kill background
process groups when a command times out):

```sh
setsid -f env GDK_BACKEND=x11 ./bin/spectra >/tmp/spectra.log 2>&1
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
- Kill with `pkill -x spectra` — never `pkill -f bin/spectra`, which
  matches the invoking shell's own command line.
- Known quirk: the KWin titlebar can steal the first click after
  activation; verify effects with a screenshot after each step.

## Layout

| Path | Role |
|---|---|
| `main.go` | composition root: app + services + window + menu + updater wiring |
| `appservice.go` | `AppService` — frontend-callable methods (`GetVersion`, `SaveWindowSize`) and the update-check flow |
| `prefs.go` | preference keys + window-size helpers (backed by the v3 `kvstore` service) |
| `version.go` | **stamp-only**: `var version = "dev"` — CI overwrites the whole file on release builds; never put logic here |
| `frontend/` | Svelte 5 + Vite app; built into `frontend/dist` (embedded, gitignored) and `frontend/bindings` (generated per build, gitignored) |
| `Taskfile.yml` + `build/` | stock Wails v3 build system (per-OS tasks, packaging, icons, platform metadata). `build/config.yml` holds product name/ID/version; run `make build-assets` after editing it |
| `build/appicon.png` | the app icon source (512×512 PNG); `wails3 task common:generate:icons` (run automatically by every build) derives `.ico`/`.icns` |
| `Makefile` | the single source of build/package commands, shared with CI |
| `ref/` | project reference docs & sources: `PRD.md`, `PLAN_MILESTONE_*.md`, `EXTRACTION_TECHNIQUES.md`, `FINAL_REPORT.md`, `TAXONOMY.md`, plus `extractor/` (standalone research extractor + probe as nested modules — reference only, never built/linted by the root module) |
| `donk.dem.zst` | the golden acceptance demo, tracked via **Git LFS** (`.gitattributes`); acceptance tests parse it and skip if absent; regenerate golden fixtures deliberately when extraction changes |

`ref/extractor`'s nested `go.mod` files keep it out of root `./...` builds.
After cloning, run `git lfs pull` if the golden demo is needed.

## Release pipeline

- CI (`.github/workflows/ci.yml`) builds only on `workflow_dispatch` (release)
  and `pull_request`. Pushes never build. The dispatch input `version`
  (`X.Y.Z`) is stamped over `version.go` before compiling. Build, test, and
  packaging steps call the Makefile (`make vet`, `make test`,
  `make artifact`) so CI and local flows are the same commands; the uploaded
  artifact name comes from `make artifact-name`.
- Release assets (named for the updater's GitHub provider matcher, which
  picks by GOOS+GOARCH substrings): `spectra-linux-amd64` (raw
  binary), `spectra-windows-amd64.exe` (raw),
  `spectra-darwin-arm64.zip` (the `.app` bundle as the sole
  top-level entry — the updater rejects multi-entry archives). The release
  skill adds a `SHA256SUMS` sidecar that the updater verifies downloads
  against. These layouts are a contract between `make artifact`,
  `build/config.yml`, and `initUpdater` in `main.go` — change them together.
- Tags are plain semver `X.Y.Z` (no `v`), created only after the dispatch
  build is green. The `release` skill (`.opencode/skills/release/SKILL.md`)
  is the canonical cut-a-release procedure.
- The updater queries `https://api.github.com/repos/<updateRepo>/releases/latest`
  (`updateRepo` const in `main.go`). `version = "dev"` never update-checks.

## Conventions

- **Formatting/lint:** golangci-lint (`.golangci.yml`) + `go vet`; no other
  style tooling. Keep `make lint` green. `build/` is excluded from lint —
  it is stock/regenerated Wails scaffolding, not application code.
- **Tests:** `-short` must skip anything network-bound (`testing.Short()`).
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
