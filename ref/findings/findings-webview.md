# WebKitGTK / Wails v3 capability spike — findings

**Environment:** Arch Linux, GTK 4.24.1, **WebKitGTK 2.54.2** (webkitgtk-6.0 API, the runtime Wails v3.0.0 links on Linux — verified from Wails startup log: `GTK=4.24.1 WebKitGTK=2.54.2`), PulseAudio server present, X11 via `GDK_BACKEND=x11`. Probe app: `/tmp/opencode/webvprobe` (hand-rolled Wails v3.0.0 app, `wails3 generate bindings -b`, JS bindings wired manually to `window.go.webvprobe`).

**Important host caveat discovered:** WebKitGTK routes Web Audio through **GStreamer**. This host had `gstreamer` + `gst-plugins-base` but **not `gst-plugins-good`**, so `autoaudiosink` was missing and *every* `resume()` failed with the exact error:

```
resume() WITH user gesture — Failed to start the audio device
GStreamer element autoaudiosink not found. Please install it
```

Fixing it required `gst-plugins-good` (provides `libgstautodetect.so` + `libgstpulseaudio.so`); probe re-ran with `GST_PLUGIN_PATH` pointing at an extracted copy. **Ship-decision consequence: document `gst-plugins-good` as a Linux runtime dependency, or the M4 voice engine silently produces no audio.**

---

## Q1 — Web Audio AudioContext

| Test | Result (observed) |
|---|---|
| `new AudioContext()` | constructs OK — `state=suspended`, `sampleRate=44100` |
| `resume()` **WITHOUT** gesture | FAILS — stays `suspended` (autoplay policy active) |
| `resume()` **WITH** user gesture (click) | PASS — `state after=running` |
| `audioCtx.currentTime` advance rate | **0.9965× and 1.0003× wall clock** over 500 ms (Δctx 0.4992 s / 0.5021 s) — tracks real time accurately |
| oscillator→GainNode→AnalyserNode render, `getFloatTimeDomainData` after 200 ms | **RMS = 0.35339** (440 Hz sine @ gain 0.5 → theoretical RMS ≈ 0.354) — samples flowed, graph renders correctly |
| `AudioBufferSourceNode.start(when)` scheduling precision | **5/5 clicks detected; errors 0.2, 0.2, 0.2, 0.2, 0.2 ms (max abs err = 0.2 ms)**; measurement poll granularity ~±23 ms, actual onsets landed sub-block-accurate — scheduling is reliable to ≲1 ms |

Errors captured verbatim when GStreamer was missing (see caveat above); with plugins present, no errors.

**Verdict M4: AudioContext is USABLE on WebKitGTK 2.54.2 and `start(when)` scheduling is precise (≤0.2 ms observed error) — no need for the one-`<audio>`-element-per-player fallback, PROVIDED the distro has `gst-plugins-good` installed.** Caveats: (1) context starts `suspended` and needs one real user gesture to `resume()` — wire a "Enable voice" gesture (e.g., first click anywhere) into app startup, the same pattern browsers require. (2) Add `gst-plugins-good` (and a working PulseAudio/PipeWire) to Linux runtime requirements; consider a startup self-test (`ctx.resume()` → check `state === 'running'`) with UI messaging. (3) `webkitAudioContext` alias is absent; use `AudioContext` only (fine for WebKitGTK-only Linux target).

## Q2 — Large Go→JS transfer (32 MiB deterministic payload, pattern `byte(i%251)`)

| Path | Wall time | Throughput | Verify |
|---|---|---|---|
| **Bound call** `ProbeService.GetData() []byte` | **2214 ms** (runs: 1949–2214 ms) | **~14–16 MB/s** of raw bytes | payload arrives as **base64 string** (len 44,739,244 ≈ 42.7 MB); atob-decode of 32 MiB costs an extra **277–343 ms**; first/last bytes + 8 KiB samples all match |
| **Asset-server full fetch** `fetch("/blob")` (custom `http.Handler` in `AssetOptions.Handler`, stdlib `http.ServeContent`) | **1290 ms** (runs: 1079–2689 ms under concurrent load; clean run 1290/1079 ms) | **~25–30 MB/s** | status 200, content-length 33,554,432, first/last bytes verified |
| **Range fetch** `bytes=16777216-1825791` (1 MiB @ 16 MiB) | **34–40 ms** (clean runs); 46–534 ms under contention | **~22–29 MB/s** | status **206**, `content-range: bytes 16777216-17825791/33554432`, full slice verified against pattern |

Notes:
- Wails v3.0.0 `application.Options.Assets = AssetOptions{Handler http.Handler, Middleware, DisableLogging}` — a custom handler works exactly as in v2; `http.ServeContent` gives Range/206 for free. Wiring: my handler serves `/blob`, delegates everything else to `application.BundledAssetFileServer(fs)`.
- Bound `[]byte` results are JSON→base64 (generated binding wraps with `$Create.ByteSlice`, which is a no-op for non-null) — so the bound path pays **+33% wire size + a ~300 ms decode** at 32 MiB. It is single-digit-to-low-double-digit MB/s — fine for control-plane data, poor for bulk payloads.
- Prior art ranked against these measurements: EventsEmit >8 KB offloads to the 64 MiB asset-store (same HTTP machinery, so expect asset-server-like ~25 MB/s but with event-queue overhead); GoStream rides the asset-server transport with an 8 MiB/256-frame bounded queue and avoids eval-splicing entirely — designed exactly for sustained Go→JS streaming.

**Verdict M2 — ranked recommendation:**
1. **Asset-server HTTP route (custom `Handler` + Range)** — fastest bulk path measured (32 MiB in ~1.1–1.3 s ≈ 25–30 MB/s; 1 MiB random slice in ~35–40 ms ≈ 25 MB/s), supports partial content so the frontend can page/seek instead of buffering everything, and zero extra Wails machinery. **Use for large blobs (demo data, decoded segments).**
2. **GoStream** — not re-measured in this spike but purpose-built (bounded buffers, no evaluateJavaScript, ordering guaranteed); prefer for **sustained incremental streams** (live parse progress, chunked decode) where per-chunk latency matters more than raw MB/s.
3. **Bound service call `[]byte`** — last resort for bulk: base64 inflation + decode (~2214 ms + ~330 ms at 32 MiB, ~14 MB/s). Acceptable for occasional ≤1 MiB responses.
4. **EventsEmit** — avoid for bulk (>8 KB offload path adds store hop + queue); keep for small notifications.

## Q3 — Bonus checks

| Check | Result |
|---|---|
| `window.webkit?.messageHandlers` | **present** (`window.webkit.messageHandlers` exists, empty — Wails doesn't register named handlers under it; the runtime uses its own transport) |
| Structured clone 32 MiB ArrayBuffer main↔worker (postMessage, no transfer list) | **PASS** — 79–985 ms depending on load; clean runs **79–150 ms ≈ 220–405 MB/s**, verified first/last bytes in worker |
| `OffscreenCanvas` | **present** (`function`) |
| `performance.now()` resolution | **1.0 ms** (min non-zero delta over 20 000 samples = 1.000000 ms) — coarse; don't rely on sub-ms timestamps for audio scheduling math in JS, use `audioCtx.currentTime` instead |
| UA string | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Safari/605.1.15` |

## Artifacts

- Probe source: `/tmp/opencode/webvprobe/` (`main.go`, `frontend/index.html`, `frontend/app.js`, generated `frontend/bindings/`)
- Screenshots: `/tmp/opencode/webvprobe/shot*.png` (shot15 = full passing gesture run)
- Logs: `/tmp/opencode/webvprobe/run.log`, `run2.log`

---

## Round 2 (2026-10-30): MediaRecorder matrix + Compression Streams + plugin dependency

Same probe (`spikes/webvprobe/`), page extended with `exportTests()` (app.js in the spike archive includes it). Screenshots: `shot-auto.png` (no-gesture), `shot-gst2.png` (gesture run with plugins — roundtrip PASS).

### Compression Streams (relevant to M2 sidecar delivery)

| format | `new DecompressionStream(fmt)` |
|---|---|
| `gzip` | constructs OK |
| `deflate` | constructs OK |
| `deflate-raw` | constructs OK |
| `brotli` | allowed by this WebKit (error message lists it) |
| **`zstd`** | **FAILS** — "requires a single argument with the value 'brotli', 'deflate', 'deflate-raw', or 'gzip'" |

⇒ The frontend can never decompress our zstd sidecars natively; serve decompressed / decompress per-block server-side (decision recorded in PLAN_MILESTONE_2.md §6).

### MediaRecorder (Linux leg of M5's per-OS matrix) — capability is gst-plugins-good-DEPENDENT

`isTypeSupported` results, **without** vs **with** `gst-plugins-good` (1.28.8):

| mimeType | no plugins | with plugins |
|---|---|---|
| `audio/webm;codecs=opus` | false | **true** |
| `audio/ogg;codecs=opus` | true | **true** |
| `video/webm;codecs=vp9` | false | **true** |
| `video/webm;codecs=h264` | false | false |
| `video/mp4;codecs=avc1` | false | false |

**Roundtrip (with plugins, user gesture):** oscillator (440 Hz, gain 0.5) → `MediaStreamAudioDestinationNode` → `MediaRecorder('audio/webm;codecs=opus')` → 600 ms record → **blob 16,088 bytes, encoder WORKS** (≈214 kbps — sane opus). Note the roundtrip needs a running AudioContext, so **it inherits the gst-plugins-good + gesture requirements from Q1**.

⇒ M5 in-webview export: WebM (VP9 video + Opus audio) is viable on WebKitGTK **with the documented plugin dep**; mp4/h264 still needs the ffmpeg fallback. The earlier "no-gst" matrix (ogg-only audio) is what a misconfigured distro install sees — ship the startup self-test idea for audio, and treat missing webm support as the same missing-plugin symptom.

### Repro recipe (no root)

```sh
# extract Arch package to /tmp and point GST_PLUGIN_PATH at it (probe run used this):
FN=gst-plugins-good-1.28.8-1-x86_64.pkg.tar.zst   # check archlinux.org/packages JSON for current
curl -sfL "https://geo.mirror.pkgbuild.com/extra/os/x86_64/$FN" -o /tmp/gst.tar.zst
tar -C /tmp/gst -xf /tmp/gst.tar.zst
GST_PLUGIN_PATH=/tmp/gst/usr/lib/gstreamer-1.0 GDK_BACKEND=x11 ./webvprobe
```

(`libgstautodetect.so` + `libgstpulseaudio.so` both live in this package; host already has gstreamer + gst-plugins-base.)

### Version re-check (2026-10-30, end of pre-work)

demoinfocs-golang/v6 → still `v6.0.0-rc.1` (newest; main head unchanged). pion/opus → tag still `v0.1.0` (keep our main pseudo-version pin). wails v3 → still `v3.0.0`. No upgrade actions.
