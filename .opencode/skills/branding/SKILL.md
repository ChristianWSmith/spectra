---
name: branding
description: Use when converting this template repo into a real app repo — e.g. "brand this repo", "convert the template to my app", "set up the app identity", "rename the template", "this is no longer a template". Gathers the app identity (name, GitHub repo, app ID, description, feature bullets), renames every identity token across code and config, regenerates the Wails build assets, rewrites README.md as a user-facing doc, updates AGENTS.md and the release skill, gates on fmt/lint/vet/test/build, then deletes this skill. Never commits.
---

# Brand the Repo

Convert this repository from the Wails app template into a real app repo:
adopt the app's identity everywhere, regenerate the platform build assets,
rewrite the docs for the new audience, and remove this skill once the
conversion is verified. Nothing is committed — the user reviews and
commits themselves.

Two confirmation checkpoints (identity table, README draft). Everything
else runs autonomously. The repo must stay buildable and green at every
phase; the final gate must pass before this skill deletes itself.

## Phase 0 — Gather identity (checkpoint #1)

Ask the user for all of these in one round:

1. **App name** — the binary/package name, kebab-case. Must match
   `^[a-z0-9][a-z0-9-]*$`; reject uppercase/spaces (it becomes asset
   names, file names, and a module path segment).
2. **GitHub repo** — `owner/name`. Verify it exists:
   ```sh
   gh repo view <owner>/<name>
   ```
   If gh can't reach it (not created/pushed yet), warn the user and ask
   whether to continue anyway.
3. **App ID** — reverse-DNS, default `com.<owner-lowercased>.<app-name>`.
   Must match `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$`.
4. **One-line description** — what the app does, for AGENTS.md, the
   window's `Description` option, and the README tagline.
5. **Feature bullets** — 3–6 short, user-facing bullets for the README.

State up front: the icon (`build/appicon.png`) and LICENSE are left
alone, and **no commit will be made**. Show the gathered values as a
table and **ask the user to confirm** before touching any file. A wrong
identity is expensive to unwind; don't start renames on an unconfirmed
table.

Record the confirmed values as you go: `<name>`, `<owner>/<repo>`, `<id>`.

## Phase 1 — Code and config renames

Make exactly these edits (tests need no changes — they read `appName`
only through pure helpers):

1. `go.mod` — module path → `github.com/<owner>/<repo>`
2. `main.go` — the identity consts and metadata:
   - `appName = "<name>"`
   - `updateRepo = "<owner>/<repo>"`
   - `Description: "<description>"` option
3. `build/config.yml` — `info:` block: `productName: "<name>"`,
   `productIdentifier: "<id>"`, `description: "<description>"`, plus
   `companyName`/`copyright` if the user gave them (leave `version`)
4. `Taskfile.yml` — `APP_NAME: "<name>"`
5. `Makefile` — `APP := <name>` (every other target derives from it)
6. `frontend/index.html` — `<title><name></title>`
7. `frontend/src/App.svelte` — the bindings import path contains the
   module path **with its original casing**:
   `../bindings/github.com/<owner>/<repo>` (match go.mod's casing
   exactly; the generator preserves it)

**Consistency rule:** `appName` (main.go), `build/config.yml`
`productName`, and `Taskfile.yml` `APP_NAME` must all be the same string —
packaging, the window title, the prefs file, and the updater all key off
it, and the `Makefile`'s `APP` must agree so `make artifact` names match
what the updater downloads. A mismatch ships an updater that can't find
its own assets.

**App ID rule:** `build/config.yml` `productIdentifier` is the macOS
`CFBundleIdentifier` and Windows identity — keep it in one place only.

**Then regenerate the platform assets** (plists, version resources,
`.desktop`, nfpm metadata) from the edited config and rebuild the icons
if the identity changed:

```sh
make build-assets
```

Verify Phase 1 before moving on — these greps must print nothing:

```sh
grep -rn "wails-template\|ChristianWSmith" \
  --include="*.go" --include="*.yml" --include="*.json" \
  --include="*.html" --include="*.svelte" \
  --include="Makefile" --include="go.mod" --include=".gitignore" .
grep -rn "template" --include="*.go" .
```

(`LICENSE` says "Christian Smith" — the license holder, not an identity
token; it stays.)

## Phase 2 — Update the release skill

`.opencode/skills/release/SKILL.md`: replace every occurrence of
`wails-template` with `<name>`. Every occurrence in that file is app
identity (asset names, `/tmp/wails-template-release` scratch dirs,
sanity-check examples), so a plain token replace is safe:

```sh
sed -i 's/wails-template/<name>/g' .opencode/skills/release/SKILL.md
```

(Substitute the real name for `<name>`; don't run it literally.)

## Phase 3 — Update AGENTS.md (targeted edits)

1. **Intro** — change "This is a Wails v3 desktop-app template (Go
   services + Svelte 5 frontend):" to "This is a Wails v3 desktop app
   (*<description>*; Go services + Svelte 5 frontend):" keeping the rest
   of the sentence (single Go module, GitHub Releases distribution,
   framework in-app auto-updater).
2. **Layout** — the `main.go` row mentions no name; the `build/` rows
   are generic. Leave unless a token remains.
3. **Release pipeline** — the three asset names → `<name>-linux-amd64`
   (raw binary), `<name>-windows-amd64.exe` (raw), and for macOS
   `<name>-darwin-arm64.zip` (the GOOS substring is what the updater's
   asset matcher greps for — never rename `darwin` to `macos`).
4. **Delete the entire "## Renaming the template" section** (this skill
   just performed it).
5. Leave commands, conventions, and gotchas alone unless they still name
   the template — if a `wails-template` reference remains after steps
   1–4, fix it.

## Phase 4 — Rewrite README.md (checkpoint #2)

The README becomes **user-facing**: written for people who downloaded the
app, not for people hacking on it. Draft the full file from this skeleton,
filling in the Phase 0 values, then **show the draft to the user and ask
for confirmation** before writing it:

```markdown
# <App Name>

<One-line description.>

## Features

- <feature bullet>
- ...

## Download

Grab the latest release for your platform from the
[Releases page](https://github.com/<owner>/<repo>/releases/latest):

- `<name>-linux-amd64` (run it directly, or `chmod +x` first)
- `<name>-windows-amd64.exe`
- `<name>-darwin-arm64.zip` (unzip, then move the `.app` to Applications)

The app checks GitHub Releases on launch and offers to install updates
itself, verifying downloads against the release's `SHA256SUMS`.

## Building from source

Requires Go 1.26+, Node.js 22+, and — on Linux only — the GTK4 +
WebKitGTK 6.0 dev packages (Ubuntu 24.04+ / Debian 13+):

    sudo apt-get install build-essential pkg-config libgtk-4-dev \
      libwebkitgtk-6.0-dev

    make run      # build + run
    make dev      # hot reload
    make package  # distributable for this OS

See [AGENTS.md](AGENTS.md) for development details.

## License

MIT — see [LICENSE](LICENSE).
```

Rules for the draft:

- **No** mention of templates, this branding skill, CI internals, the
  release skill, or agent workflows — end users don't care.
- Feature bullets are plain language; no implementation details.
- Keep it short — this is a landing page, not a manual.

## Phase 5 — Gate

All must pass; fix failures before continuing. Never delete this skill
on a red tree.

```sh
gofmt -l .        # must print nothing
make lint
make vet
make test
make build
make clean        # the build just produced a binary whose embedded source
                  # paths can still contain the old directory name — don't
                  # let it pollute the grep pass below
```

Then confirm no identity or skill references survive anywhere:

```sh
grep -rn "wails-template\|ChristianWSmith" --exclude-dir=.git --exclude-dir=branding .
grep -rn "skills/branding" --exclude-dir=.git --exclude-dir=branding .
```

Both must print nothing. (`LICENSE` says "Christian Smith" — that's the
license holder, not an identity token; it stays. Ordinary prose uses of
the word "branding" — e.g. in an app description — are fine; what must
not survive is any reference to *this skill*.)

If `grep` still hits, the rename missed a spot — find it, fix it, re-run
the full gate. Do not proceed with a known leftover.

## Phase 6 — Self-delete and report

Only after a green Phase 5:

1. Delete this skill:
   ```sh
   rm -rf .opencode/skills/branding
   ```
2. Report to the user:
   - the adopted identity (name, repo, app ID)
   - files changed per phase (renames, regenerated assets, release skill,
     AGENTS.md, README)
   - gate results (fmt/lint/vet/test/build all green)
   - **the changes are uncommitted** — review with `git status` /
     `git diff`, then commit when ready

If anything in Phase 5 failed and couldn't be fixed, stop before the
delete and report — the skill must remain available to retry.

## Gotchas

- **The name match** (`appName` = `build/config.yml` `productName` =
  `Taskfile.yml` `APP_NAME` = `Makefile` `APP`) is the single most
  important invariant; the whole packaging and update pipeline silently
  depends on it. Double-check it in Phase 5's grep pass, not just
  Phase 1.
- **The bindings import in `App.svelte` is case-sensitive** and must
  match the go.mod module path exactly as the generator emits it — a
  casing mismatch fails the frontend build with "Failed to resolve
  import".
- **Never skip checkpoint #1.** Renaming on a wrong or unvalidated repo
  name produces a module path and updater that point at a repo that
  doesn't exist — the app will never find its own releases.
- The README is for **end users**. If a sentence would only make sense
  to someone reading the source, cut it; development details live in
  AGENTS.md (which this skill edits, not replaces).
- This skill deletes itself — that's intentional and only happens on a
  green gate. If the run is interrupted before Phase 6, the skill file is
  still on disk and the whole run can simply be repeated (Phases are
  idempotent: re-grepping and re-replacing an already-branded repo is a
  no-op, except the README checkpoint will re-confirm the draft).
- No commit, ever: the user asked to review branding changes themselves.
  Don't stage, commit, or push — not even "just the renames".
