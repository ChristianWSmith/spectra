# Spectra

A powerful, feature-rich CS2 demo viewer and match analysis toolkit.

## Features

- Interactive 2D tactical replay of entire matches — no CS2 install required
- Comprehensive match, player, round, economy, and utility statistics
- Universal searchable event timeline with drill-down to the underlying data
- Voice and chat review synchronized with the replay (when available in the demo)
- Local-first: demos and extracted data stay on your machine, fully offline

## Download

Grab the latest release for your platform from the
[Releases page](https://github.com/ChristianWSmith/spectra/releases/latest):

- `spectra-linux-amd64` (run it directly, or `chmod +x` first)
- `spectra-windows-amd64.exe`
- `spectra-darwin-arm64.zip` (unzip, then move the `.app` to Applications)

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
