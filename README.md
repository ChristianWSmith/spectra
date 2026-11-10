# Spectra

A powerful, feature-rich CS2 demo viewer and match analysis toolkit.

## Features

**Private by design**

- Fully offline: demos and their data stay on your machine — no account, no
  sign-in, no upload, no subscription
- Import `.dem` / `.dem.zst` demos (picker or drag-and-drop) with background
  parsing, progress, and SHA-256 duplicate detection — originals are never
  modified
- Searchable match library: re-run imports, delete a match’s data (optionally
  the file too), per-match parser version and import warnings

**Replay**

- Interactive 2D tactical replay of entire matches — no CS2 install required
- Multi-floor radar layers with elevation indicators, bullet tracers, in-radar
  kill feed and chat, and gunfire/footstep/C4/announcer sound effects
- Voice and in-demo text chat synchronized with the replay, with per-player
  mute (when available in the demo)
- Playback from 0.25× to 8×, WebM clip recording, PNG snapshots
- Universal event timeline with round/player/type filters, a raw game-event
  histogram, and drill-down to the underlying event payloads

**Analysis**

- Match overview, sortable scoreboard (K/D/A, ADR, HS%, K/D, KDA, entries,
  trades, openings, streaks, multi-kills, utility, MVPs…), round browser with
  economy + kill feed, player chat
- Comprehensive match, player, round, economy, and utility statistics —
  economy curves, combat and engagement analysis, round-by-round comparison,
  cross-match player profiles with career trends
- 15 heatmap kinds (presence, kills, deaths, damage, K/D, and every grenade
  type thrown and detonated), filtered by round, player, team, and map floor
- Every metric documents its formula and its sample size, with an in-app
  glossary of terms

**Power tools**

- Custom metric builder and plugin metrics; templated match, player, and round
  reports
- Read-only SQL console over the whole library — saved queries, history,
  schema sidebar, CSV/JSON export
- CSV/JSON export of the event feed
- Extract radar maps, icons, and sounds from your own CS2 install
- Command palette and saved filter presets

## Download

Supported platforms: Linux and Windows (desktop only).

Grab the latest release for your platform from the
[Releases page](https://github.com/ChristianWSmith/spectra/releases/latest):

- `spectra-linux-amd64` (run it directly, or `chmod +x` first)
- `spectra-windows-amd64.exe`

The app checks GitHub Releases on launch and offers to install updates
itself, verifying downloads against the release's `SHA256SUMS`.

## Developers

Requires Go 1.27+, Node.js 22+, and — on Linux only — the GTK4 +
WebKitGTK 6.0 dev packages:

    make deps         # dev toolchain (wails3 CLI at the pinned version, Node check)
    make linux-deps   # Linux only: apt install the GTK4/WebKitGTK build deps
    make run          # build + run
    make dev          # hot reload
    make package      # distributable for this OS

See [AGENTS.md](AGENTS.md) for development details.

## License

MIT — see [LICENSE](LICENSE).
