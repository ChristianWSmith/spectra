# Dependency research findings (pre-development)

Research date: 2026-10-30. Scratch module: `/tmp/opencode/depscheck` (Go 1.27.3).
Repo read-only: `go.mod` (wails v3.0.0, `go 1.26.0`), `Taskfile.yml` (stock includes + `wails3 dev`).

---

## 1. github.com/markus-wa/demoinfocs-golang/v6 — **v6.0.0-rc.1 is still the newest**

**Recommended:** keep the pin `v6.0.0-rc.1`; re-check right before development starts (cadence is fast).

Evidence:
- `go list -m -versions .../v6` → `v6.0.0-alpha.0 … alpha.3, rc.0, rc.1`. No rc.2, no final `v6.0.0`.
- `go list -m -json .../v6@latest` → `v6.0.0-rc.1`, Time `2026-10-24T09:14:34Z`.
- `git ls-remote --heads` → `refs/heads/main = 4c79f7b…` which is **exactly the rc.1 tag commit**
  → no unreleased commits on main. Only open PR is #687 (a *v5* backport).
- Releases: https://github.com/markus-wa/demoinfocs-golang/releases
  - rc.1 (24 Oct): one fix — panic in new `InfernoFireOut` tracking aborted parsing with
    `ErrDecodeFailed` on POV demos (#759).
  - rc.0 (22 Oct): self-contained v5→v6 changelog + migration table (functional options,
    `ParseToEnd(ctx)`, concrete types instead of interfaces, errors instead of panics,
    `common.UniqueID`, controller-sourced `Player.Name`, PVS re-entry dedup, ammo off-by-one fix,
    deterministic ordering, protos renamed `msg.File_v6_*`).
- Latest tags for the record: **v4 → v4.5.1**, **v5 → v5.2.0** (v5 branch head `9afbb8f` is ahead of
  the v5.2.0 tag → unreleased v5 fixes exist; v4 branch also has commits after v4.5.1).

API re-verified against the downloaded rc.1 module:
- Options exist: `option.MsgQueueBufferSize(0)` ("parse sequentially"), `option.IgnorePacketEntitiesPanic(bool)`,
  `option.NetMessageDecryptionKey(key)`.
- No `Parser.Header()`; doc says the header is parsed automatically when parsing starts — the
  `msg.CDemoFileHeader` net-handler approach stands.
- Requires **Go 1.27** (`go 1.27.0` in its go.mod).

Risks:
- **Surprise: repo `go.mod` says `go 1.26.0` — adding v6 forces a directive bump to ≥1.27.0**
  (local toolchain is 1.27.3, so builds still work; `ref/extractor` modules already use `go 1.27.3`).
- Pre-release API can still shift before a final v6.0.0 (rc.0→rc.1 was 2 days).
- Options/`Parser` surface should be re-checked on upgrade; import path sed helper is published.

---

## 2. github.com/pion/opus — **tag v0.1.0, but main is 138 commits ahead (decoder fixes!)**

**Recommended:** start on `v0.1.0` (only tag), but treat a `main` pseudo-version
(`v0.1.1-0.20261026214112-e7b8aa55508c`) as the likely upgrade for voice fidelity.

Evidence:
- `go list -m -versions github.com/pion/opus` → `v0.1.0` only. Tag date 2026-06-08;
  `@main` = 2026-10-26, **138 commits ahead** (`compare/v0.1.0...main` → `ahead_by: 138`).
- Repo/README: https://github.com/pion/opus — **MIT** license, pure Go RFC 6716 implementation,
  `go 1.24.0` (both tag and main), only direct dep is testify (tests). 564★.
- README contains **no Steam / game-voice notes** (WebRTC pedigree; "used as part of our WebRTC
  implementation").

Decoder API (from `decoder.go`):
```go
func NewDecoder() Decoder                                        // default: 48000 Hz, 1 channel
func NewDecoderWithOutput(sampleRate, channels int) (Decoder, error)
func (d *Decoder) Init(sampleRate, channels int) error {
    switch sampleRate {
    case 8000, 12000, 16000, 24000, 48000:     // full Opus rate range supported
    default:                                    return errInvalidSampleRate
    }
    switch channels {
    case 1, 2:
    default:                                    return errInvalidChannelCount
    }
    ...
}
func (d *Decoder) Decode(in, out []byte) (bandwidth Bandwidth, isStereo bool, err error) // S16LE PCM
func (d *Decoder) DecodeToInt16(in []byte, out []int16) (int, error)   // returns samples/channel
func (d *Decoder) DecodeFloat32(in []byte, out []float32) (Bandwidth, bool, error)
func (d *Decoder) DecodeToFloat32(in []byte, out []float32) (int, error)
```
- TOC/frame structure handled internally: `tableOfContentsHeader(in[0])`, frame codes 0–3,
  padding, 120 ms packet cap; `isStereo` comes back from the TOC (`tocHeader.isStereo()`).
- Channel down/up-mix and rate conversion to the requested output rate are internal (SILK/CELT
  resamplers, `sampleCountAtRate`).

Known limitations (GitHub issues, `github.com/pion/opus/issues`):
- **#251 (open)** "Decoder transition state diverges from libopus around redundancy and PLC".
- **#240 (open)** SILK NEON resampler has no parity test / no CI job builds it (arm64 risk).
- **#22 / #20 / #9 (open)** test vectors in CI / roadmap / relative lag in SILK decoder.
- **FEC: not implemented.** `internal/silk/decoder.go:2549`: LBRR redundancy is *"intentionally
  discarded for now; exposing FEC recovery is separate from accepting valid packets that carry
  LBRR data."*
- **DTX:** no DTX-specific API or issue exists; decoder just consumes whatever packets it is fed.
- **PLC**: exists only on `main` (PRs #245/#246/#250 merged Sep 2026, i.e. **after** v0.1.0).

Risks:
- v0.1.0 misses notable decoder work now on main: **#247 "Match ordinary Opus decoding to
  libopus exactly"**, **#219 "Support 40 and 60 ms SILK-only packets"**, #182 soft-clip,
  #239 ARM64 decode optimization, #258 packet-frame-parsing allocation removal, #259 stereo
  synthesis speedup, plus all PLC work.
- No exported helper to size the output buffer — size for the worst case (120 ms @ 48 kHz stereo
  S16 = 48000·0.12·2·2 = 23040 B); `Decode` returns `errOutBufferTooSmall` otherwise.
- Confirm CS2 voice frame duration/rate (expect 20 ms; if a demo carries 40/60 ms SILK frames,
  v0.1.0 may fail where main succeeds). Output rates are the five Opus rates only — resample
  downstream if 11025 Hz-style output is ever wanted.
- Container helper `pkg/oggreader` exists but CS2 voice data arrives as raw packets from
  `CSVCMsg_VoiceData`, so it isn't needed.

---

## 3. github.com/klauspost/compress — **v1.20.3**, pure Go, streaming + skippable frames OK

**Recommended:** `v1.20.3` (as a direct dep this also lifts the repo's existing indirect
`v1.18.7`).

Evidence:
- `go list -m -versions` → newest `v1.20.3`; releases page:
  https://github.com/klauspost/compress/releases (v1.20.3, 12 Oct 2026; `@latest` Time
  2026-10-12). go.mod directive `go 1.25` (repo is 1.26.0 — fine).
- **No cgo**: `zstd/README.md:9` — *"This package is pure Go. Use `noasm` and `nounsafe` to
  disable relevant features."* (asm is optional and pure-Go fallbacks exist).
- **v1.20.2 fixed a security issue**: "zstd: Fix DecodeAll crash on specially crafted input"
  (GHSA-fpmh-frq8-7rj8) — being ≥1.20.2 matters.

Streaming decode API (`go doc`):
```go
func NewReader(r io.Reader, opts ...DOption) (*Decoder, error)
// Decoder: Read, WriteTo, DecodeAll, IOReadCloser, Reset, ResetWithOptions, Close
// DOptions: WithDecoderConcurrency(n), WithDecoderMaxMemory, WithDecoderMaxWindow,
//           WithDecoderDicts, WithDecoderLowmem, IgnoreChecksum, WithDecodeAllCapLimit, ...
```
- "Streams are decoded concurrently in 4 asynchronous stages to give the best possible
  throughput" (`zstd/README.md:329`); `WithDecoderConcurrency(n)` bounds concurrent
  stateless decodes. (`WithConcurrentBlocks(true)` is an *encoder* option.)
- **Skippable frames**: supported — `framedec.go` reads the skippable magic (`0x50…`) and skips
  the payload while streaming; `DecodeHeader` exposes `Skippable`, `SkippableID` (0–15),
  `SkippableSize`, `HeaderSize` (`decodeheader.go:37-47`). Encoder can emit them
  (`WithEncoderPadding`, `skippableFrame()`).

Risks:
- The streaming reader **silently discards** skippable-frame payloads — if a sidecar ever stores
  data inside skippable frames, parse it explicitly with `DecodeHeader` instead of relying on
  `NewReader`.
- v1.20.x is very recent (Sept/Oct 2026); low functional risk but it's a jump from v1.18.7.

---

## 4. modernc.org/sqlite — **v1.61.0**, pure Go, no cgo, WAL confirmed

**Recommended:** `v1.61.0`.

Evidence:
- `go list -m -versions` → newest `v1.61.0`; `@latest` Time 2026-10-21.
- **Go requirement: `go 1.26.0`** (identical to the repo directive — no bump needed).
- **License:** package code **BSD-3-Clause** (`LICENSE`); SQLite itself **public domain**
  (`LICENSE-SQLITE`); bundled `sqlite-vec` extension MIT; README "Licensing" section ships a
  machine-readable SBOM + `LICENSE-3RD-PARTY.md`.
- **No cgo:** README title *"Pure-Go SQLite, no cgo"*; `doc.go` — *"a sql/database driver using a
  CGo-free port of the C SQLite3 library"* (SQLite **3.54.1** on the supported platform matrix:
  linux/darwin/windows/freebsd × amd64/arm64, …).
- Driver: `sql.Register(driverName, …)` → open with `sql.Open("sqlite", dsn)`.
- **WAL:** supported and tested — `all_test.go` runs `PRAGMA journal_mode=WAL` and
  `?_pragma=journal_mode(WAL)` / `_journal_mode=wal` DSNs; changelog includes WAL `-shm` fault
  fixes. **FTS:** not needed by us; the repo also auto-registers a `vec` (sqlite-vec) package.
- **mattn/go-sqlite3 compatibility notes** (CHANGELOG, recent releases):
  - Added mattn-compatible shorthand DSN params: `_busy_timeout`/`_timeout`, `_foreign_keys`/`_fk`,
    `_journal_mode`/`_journal`, `_synchronous`/`_sync`, `_auto_vacuum`/`_vacuum`, `_query_only`,
    values validated against mattn's accepted set; DSN validation happens *before* any PRAGMA runs.
  - Caution carried over: a duration-style `_busy_timeout=5s` **fails** the open (use integer
    seconds); `_journal_mode=wal` persistently converts the file.
- Other documented caveats (`doc.go` / README / CONTRIBUTING):
  - **"Fragile modernc.org/libc dependency"** — downstream must pin the *exact* `modernc.org/libc`
    version in this module's go.mod (gitlab.com/cznic/sqlite/-/issues/177).
  - Most of the Go source is generated from C — hand edits are lost on re-vendoring.
  - A caller-constructed `sqlite.Driver` carries none of the package-level functions/collations.
  - Opt-in Linux OFD locking (`MODERNC_SQLITE_OFD_LOCK=1`), off by default.

Risks:
- Binary-size growth from the transpiled C — measure after wiring in (expect single-digit MB).
- Write/read throughput is generally below cgo mattn; the README points at
  https://pkg.go.dev/modernc.org/sqlite-bench for current numbers — worth a quick sanity benchmark
  for bulk demo-index writes (unverified by us).
- Keep `modernc.org/libc` pinned exactly as its go.mod says (enforced by `go mod tidy`, but
  don't hand-edit).

---

## 5. Wails v3 + Svelte — pin `v3.0.0` is current; large Go→JS transfers: asset server / streams, not events

**Repo state (read-only):**
- `go.mod:7` → `github.com/wailsapp/wails/v3 v3.0.0`; `go 1.26.0`; `wails3` CLI comes from the
  `tool` directive. `Taskfile.yml` is stock (includes `./build/Taskfile.yml`, `wails3 dev`).
- `frontend/package.json` → `@wailsio/runtime` **3.0.0**, svelte ^5.46.4, vite ^8.2.4.

**Is there a newer release?**
- `go list -m -versions github.com/wailsapp/wails/v3` → … `v3.0.0`, then
  `v3.1.0-nightly.20261027`, `v3.1.0-nightly.20261028`.
- GitHub releases API: **v3.0.0 published 2026-10-26** is the latest non-prerelease;
  nightlies are `prerelease: true`.
  → **The pin is the current stable.** No upgrade needed. (`@latest` also returns v3.0.0.)

**`EventsEmit` payload guidance (all included in v3.0.0 — verified as ancestors of the tag via
GitHub compare API):**
- PR #5930 "keep oversized event payloads out of evaluateJavaScript" (merged 2026-08-09,
  commit `684d1ce`, `compare/v3.0.0...684d1ce` → status *behind* ⇒ contained).
  - Events whose marshalled JSON exceeds **`maxInlineEventPayload = 8192`** bytes are parked
    host-side under a random id and fetched by the webview from the asset server
    (`event_payload_store.go`, `application.go:123/314`).
  - Motivation: splicing big payloads into eval caused WebKit retention of **11.6 GB (macOS) /
    6.2 GB (WebKitGTK)** at 100 events/s × 1 MB; step function starts at ~8–16 KB.
  - Store limits: one-shot fetch, **30 s TTL**, **64 MiB total cap** (overflow → falls back to
    the inline path), window-bound, released on shutdown.
  - Ordering preserved via per-window queue (PR #5934, in v3.0.0).
- JS→Go service calls: chunked above 512 KB (PR #5369, merged 2026-05-10, in v3.0.0) to bypass
  WebView2's ~2 MB body limit; `/wails/runtime` requests are limited to **64 MiB** (HTTP 413 above).
- ⇒ A single 10–30 MB `Event.Emit` is *possible* (≤64 MiB store, offloaded fetch), but it's
  JSON-marshalled, one-shot, TTL-bound — **don't use events as the transfer mechanism.**

**Large file transfer options (recommended path):**
1. **Asset-server middleware + HTTP Range** — `application.AssetOptions{ Handler, Middleware, ... }`:
   "This middleware injects itself before any of Wails internal middlewares" and can short-circuit
   the default handler (`application_options.go:203-237`). Serve the sidecar route yourself with
   `http.ServeContent` → free Range/206 support. The framework's own file server does the same
   (`internal/assetserver/asset_fileserver.go:138` → `http.ServeContent(...)` with a `fileSeeker`);
   range support dates back to PR #2091 ("streaming audio and videos with range requests if the
   platform webview supports it").
   - Docs: https://v3.wails.io/contributing/asset-server/ — *"Large Assets — embedding bloats the
     binary. Serve big media from a separate origin or stream it through a custom `http.Handler`."*
   - Asset server supports plain `fetch()` from the frontend (same origin/scheme).
2. **GoStream** (new in v3.0.0) — `app.HandleStream(name, handler)` in Go + JS
   `Stream(name)` → `WailsSocket` (WebSocket-like, `binaryType` defaults to `arraybuffer`).
   Rides the asset server, never touches `evaluateJavaScript`, all buffers bounded/ordered
   (`pkg/application/stream.go` docs; `@wailsio/runtime/types/stream.d.ts`). Ideal if the
   sidecar should be *streamed* rather than fetched as a file.

Risks:
- **Windows**: WebView2 buffers whole responses in memory (documented in the #5930 follow-up),
  so server→webview *streaming* can't work there today; Range-prefetch in slices still works but
  peak memory ≈ response size on Windows.
- Asset-server content sniffer historically held back <512-byte chunks — fixed by PR #5931
  (merged 2026-08-09, in v3.0.0).
- Wails v3 has no documented `EventsEmit` size limit per se; the real caps are 8 KB inline
  threshold, 64 MiB payload-store, 64 MiB runtime request, 2 MB WebView2 body (chunked >512 KB).
- If the framework's nightly `v3.1.0-nightly.*` gains features you want, remember nightlies are
  prereleases; stay on v3.0.0 for release builds.

---

## Version summary

| Dependency | Recommended | Newest available | Note |
|---|---|---|---|
| demoinfocs-golang/v6 | `v6.0.0-rc.1` (pin unchanged) | `v6.0.0-rc.1` (2026-10-24) | requires **Go ≥1.27** → bump repo `go` directive |
| pion/opus | `v0.1.0` initially | tag `v0.1.0` (2026-06-08); main 138 commits ahead | main has libopus-exact decode + PLC + 40/60 ms SILK |
| klauspost/compress | `v1.20.3` | `v1.20.3` (2026-10-12) | pure Go; lifts existing indirect v1.18.7 (security fix ≥v1.20.2) |
| modernc.org/sqlite | `v1.61.0` | `v1.61.0` (2026-10-21) | `go 1.26.0`, BSD-3 + public-domain SQLite, no cgo, WAL OK |
| wailsapp/wails/v3 | `v3.0.0` (unchanged) | `v3.0.0` (2026-10-26) | newer: nightlies only |
