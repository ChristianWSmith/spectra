# Spectra

A powerful, feature-rich CS2 demo viewer and match analysis toolkit.

## Features

- Import `.dem` / `.dem.zst` demos (picker or drag-and-drop) with background
  parsing, progress, and duplicate detection — originals are never modified
- Searchable match library: reprocess, delete extracted data (optionally the
  file too), per-match parser version and extraction warnings
- Match overview, sortable scoreboard (K/D/A, ADR, HS%, K/D, KDA, entries,
  trades, openings, streaks, multi-kills, utility, MVPs…), round browser with
  economy + kill feed, player chat, raw game-event histogram + payload viewer
- Universal event timeline with round/player/type filters and drill-down to
  the underlying event payloads
- Interactive 2D tactical replay of entire matches — no CS2 install required
- Comprehensive match, player, round, economy, and utility statistics
- Voice and chat review synchronized with the replay (when available in the demo)
- Local-first: demos and extracted data stay on your machine, fully offline

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
