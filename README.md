# wails-template

A batteries-included starter template for [Wails v3](https://wails.io)
desktop apps in Go, with a [Svelte](https://svelte.dev) frontend. It ships a
working hello-world window plus the plumbing that's painful to bolt on later:
a multi-platform CI build, a semver release pipeline driven by an agent
skill, and the framework's GitHub-Releases-powered in-app auto-updater.

## What's included

- **Minimal Wails v3 app** — Go services model (no context threading),
  single window with persisted size, Svelte 5 + Vite 8 frontend embedded at
  compile time, `build/` platform assets with your icon and metadata
- **In-app auto-updater** — wired to this repo's GitHub Releases via
  Wails' built-in updater: silent check on launch (only surfaces when an
  update exists), Help → Check for Updates… always reports an outcome,
  `SHA256SUMS` digest verification, atomic swap with rollback, and the
  framework's themed update window (Install / Skip This Version / Remind Me
  Later)
- **Preferences persistence** (`prefs.go`) — window-size restore backed by
  the v3 `kvstore` service (a JSON file under the OS config directory)
- **CI** (`.github/workflows/ci.yml`) — PR validation plus on-demand
  `workflow_dispatch` builds that stamp a version into the binary and
  produce the Linux, Windows, and macOS release assets via the same `make`
  targets used locally
- **Lint** (`.github/workflows/lint.yml`) — `make lint` (golangci-lint) on
  every push/PR
- **Release skill** (`.opencode/skills/release/SKILL.md`) — agent-driven
  pipeline: checks → commit → dispatch CI → tag-after-green → publish GitHub
  release with the artifacts and `SHA256SUMS` attached
- **Branding skill** (`.opencode/skills/branding/SKILL.md`) — agent-driven
  one-shot conversion of this template into your app repo: gathers the app
  identity, renames every token, rewrites this README for your users, gates
  on a green build, and self-deletes. **Never commits — you review and
  commit.**
- **Makefile** — the single source of build commands, shared with CI
- **Dependabot** — weekly Go and GitHub Actions updates, with automerge on
  green

## Requirements

- **Go 1.26+**
- **Node.js 22+** (the frontend is a Vite project; `npm install` runs as
  part of the build)
- **`wails3` CLI + Node check** — `make deps` (run automatically by
  `make build` / `make dev`) installs the `wails3` version pinned in
  `go.mod` into `$(go env GOPATH)/bin` and verifies Node is recent enough
- **Linux only:** GTK4 + WebKitGTK 6.0 dev packages (Ubuntu 24.04+ /
  Debian 13+) — `make linux-deps` installs them. Distributions that ship
  only WebKit2GTK 4.1 build with `-tags gtk3` (supported through v3.0.x).

## Getting started

```sh
make run            # build + run
make dev            # hot reload (Go rebuilds + Vite dev server)
make build          # production build → bin/wails-template
make test           # go test -short ./...
make lint           # golangci-lint
make package        # platform release payload (.app bundle on macOS)
make artifact       # the exact release asset the updater downloads
```

## Renaming the template

The identity tokens are `wails-template` (app name, asset prefix, module
tail) and `ChristianWSmith` (owner). Grep both and update:

- `go.mod` (module path)
- `main.go` (`appName`, `updateRepo`)
- `build/config.yml` (`productName`, `productIdentifier`, …), then run
  `make build-assets` to regenerate the platform metadata
- `Taskfile.yml` (`APP_NAME`)
- `frontend/index.html` (title) and `frontend/src/App.svelte` (bindings
  import path — it contains the module path)
- `Makefile` (`APP`), `.gitignore`, `.opencode/skills/release/SKILL.md`
- `build/appicon.png` — replace with your icon (512×512 PNG); the next
  `make build` regenerates the `.ico`/`.icns`

`appName` must equal `build/config.yml`'s `productName` and Taskfile's
`APP_NAME` — packaging, the window title, the prefs file, and the updater
all key off the same string. The updater derives release asset names from
`GOOS`/`GOARCH` substrings, so keep the `make artifact-name` convention when
changing them.

## Release process

Driven by the release skill. Short version: bump `build/config.yml`'s
version, commit, dispatch the build workflow with the same `X.Y.Z` version
input (CI stamps it into `version.go`), tag the green build, publish a
GitHub release with the three platform assets plus a `SHA256SUMS` file. The
in-app updater picks the asset matching the running platform and verifies
the download against `SHA256SUMS`.

## License

MIT — see [LICENSE](LICENSE).
