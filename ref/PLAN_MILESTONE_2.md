# Spectra — Implementation Plan: Milestone 2 (2D Tactical Replay)

**Status: implemented 2026-10-31** — sampling in `extract.Parse` (`ParseOptions.Positions`), `internal/sidecar` (q16-v1 layout, 256-frame zstd blocks + idx + meta.json), migration 002 (event positions + match position columns), `ReplayService` + `GET /api/sidecar/<id>/positions` (server-side decompress), map pack `de_cache` (schematic radar + transform constants; site centroids derived in fixture), replay engine/renderer/transport + `pendingSeek` hooks from Match/RoundDetail/Timeline, fixture `internal/integration/testdata/donk.replay.json` (`-update-replay`).

**Measured (golden demo):** sidecar bin **2.3 MB** / idx 8.5 KB (target ≤30 MB ✓); import 24.2 → **35.9 s (+48 %)** with sampling+sidecar (target ≤+50 % ✓); replay smoke on dev machine: radar + players + playback + scrub + 1,726 landmarks verified visually (X11 smoke) — open→first frame observed ≤4.5 s incl. uninstrumented 9 MB fetch; fixture enforces map-bounds at freeze end, plant clustering (eccentricity 225.7 u), and **event↔sidecar kill-position agreement ≤1.35 u across all 170 kills**. Known gaps: radar art is an original schematic (real-art acquisition posture in `ref/findings/findings-mappack.md` §4), fps/first-frame not instrumented, macOS/Windows transfer unmeasured.

**PRD reference:** §5.4 (tactical replay), §5.10 (positional capture), §6.3 (extraction), §10 Milestone 2
**Depends on:** Milestone 1 (import pipeline, store, match/round/event model, timeline UI)
**Exit criteria (PRD §10):** a user can reconstruct and navigate an entire match in 2D, inspect player positioning at arbitrary points in time, and jump directly from an event to the corresponding replay state.

---

## 1. Grounding facts

- Positions are **not** in game events — they live in entity state and must be **sampled during parsing** (PRD §6.3: "cannot be reconstructed later if discarded"). The extractor never sampled; EXTRACTION_TECHNIQUES §13 documents `events.FrameDone` → `Player.Position()` as the proven next step. **Spike (M2-T1) ran 2026-10-30 — measured numbers in §3; code in `ref/findings/spikes/sampler/`.**
- Golden demo: **136,948 frames @ 64 Hz, 35m39s, 10 players, avgAlive 7.56** → **~1.04 M player-records/match** (measured, not estimated).
- Map: first map pack = **`de_cache`** (confirmed by baseline parse — header sniff in `ref/findings/findings-mappack.md`, demoinfocs agrees). Research parse was `de_mirage` — its calibration notes apply to mirage only, when that map pack is added. **PRD open question #8 is answered in `ref/findings/findings-mappack.md`** (transform formula, asset sources, licensing posture, JSON schema) — M2's remaining work is implementing it, not discovering it.
- The M1 event stream already carries: kill/damage positions (where the event struct exposes them), grenade throw/detonation ticks, bomb plant site/tick, smoke/fire start ticks — replay sync anchors.
- Frontend: Svelte 5 in WebKitGTK 6.0 / WebView2 / WKWebView — Canvas 2D is the safe renderer; WebGL exists but is not required for M2's scope (10 markers + trails). Heatmaps (M3) may revisit.

## 2. Scope

**In:**

- Historical position extraction: per-frame (or sampled) position + view angles for all players, gated to real rounds (skip warmup or tag it).
- Sidecar storage per match, outside SQLite blobs (see §4) with an index; DB records format version + tick rate.
- Map asset pack: calibrated radar image + coordinate transform for **`de_cache`** (golden demo), then a process to add maps cheaply.
- Replay canvas: map, player dots (team colors, name labels, alive/dead, health/armor readout, active weapon), view direction cones, movement trails, bomb (carried/planted/site), grenades (projectile + smoke circle + molly area), zoom/pan.
- Playback controls: play/pause, speed (0.25×–8×), tick/frame step, jump to round start, jump to events (kills/plants/defuses/detonations via M1 timeline), scrub, loop interval, reverse (data is fully indexed — trivial).
- Event ↔ replay sync both directions: click event in timeline → replay seeks; click a player moment → timeline filters.
- Player visibility toggles, follow-player mode, snapshot capture (canvas PNG export).
- Basic overlays: view cones, team separation coloring, trails length control.

**Out (deferred):** tactical overlay analytics (site control, rotations, clustering — M3+), split-screen/ghost replay, video/GIF export (M5), drawing/annotation tools (P1 stretch — else M5), per-grenade trajectory reconstruction beyond recorded samples (research), spectator POV.

## 3. Position sampling & engine changes (`internal/extract`)

```go
type FrameSample struct {
    Tick    int32
    Frame   int32
    Players [10]PlayerSample   // slot by entity; 0-filled when absent
}
type PlayerSample struct {
    Pos     [3]float32   // x,y,z
    View    [2]float32   // yaw, pitch
    Health  uint8
    Armor   uint8
    Flags   uint8        // alive, helmet, defuse, onGround…
    Weapon  uint16       // index into weapon table
    SteamID uint64       // resolve slot→player once per round, not per frame
}
```

- Hook `events.FrameDone`; skip warmup frames (flag, don't drop — cheap and useful); one writer goroutine appending to a buffered channel → file writer (never hold a match in RAM).
- Sampling decision (task M2-T1, benchmarked on the golden demo 2026-10-30, code `ref/findings/spikes/sampler/`):

  | buffer (136,948 frames, 10 slots, avgAlive 7.56) | raw | zstd |
  |---|---:|---:|
  | full 64 Hz, f32 (17 B/player) | 18.4 MB | 6.9 MB |
  | full 64 Hz, int16@1.0 u + u8 yaw (8 B/player) | 9.1 MB | **2.5 MB** |
  | half 32 Hz, f32 | 9.2 MB | 3.7 MB |
  | half 32 Hz, q16 | 4.6 MB | 1.4 MB |

  Parse overhead: **28.9 s → 39.8 s (+37.6 %)** for the worst case (four encodings buffered in RAM simultaneously; a real single-encoding writer will be cheaper) — within the ≤+50 % target. **Decision: full 64 Hz, no 32 Hz fallback** (budget was ≤30 MB raw — f32 18.4 MB clears it even uncompressed). Record encoding choice per match in `meta.json`; delta/varint refinement (§4) stays an M2 build task — int16@1.0 u already halves raw and is visually indistinguishable at radar scale (verify visually in M2). Frame records: 6 B header (tick i32 + alive bitmask u16) + per-alive-player payload; bomb/grenade entities add a little on top (not in spike).
- Extend the M1 job pipeline: stage `positions` after `store`; progress events continue to work. Reprocess must regenerate sidecars when format version changes.

## 4. Sidecar storage

```
$XDG_DATA_HOME/spectra/matches/<matchID>/
    positions.bin.zst      # delta-encoded FrameSample stream
    positions.idx          # frame → byte offset index (fixed-width, mmap-able)
    meta.json              # format version, tickrate, sample rate, counts
```

- Rationale: SQLite blobs bloat WAL and complicate streaming; files stream by range (PRD §7.3 "separate efficient storage for high-frequency datasets").
- Encoding sketch: varint delta on tick/pos (quantize positions to **1.0 u by default — measured best size/precision trade in §3; 0.1 u available at int32 cost if calibration needs it**), zstd block-framed (e.g. 256 frames/block) so the frontend can request byte ranges.
- DB: `matches.position_format`, `matches.sample_rate`, `matches.position_frames`; delete/reprocess cascade removes the directory.

## 5. Map asset packs

```
frontend/public/maps/<name>/
    radar.webp           # top-down radar (community asset or extracted)
    meta.json            # transform, bounds, callouts
```

`meta.json`: **linear world→image transform (`pos_x, pos_y, scale` — the 3-parameter Valve overview model, `findings-mappack.md` §2; no homography needed)**, world bounds, bombsites A/B polygons (for plant highlighting), callout label anchors (P1).

- **Transform constants come from Valve's overview txt, not hand-calibration** (`ref/findings/findings-mappack.md` §2): `resource/overviews/de_cache.txt` inside `pak01_dir.vpk` carries `pos_x/pos_y/scale`; community tabulation gives de_cache `pos_x=-2000, pos_y=3250, scale=5.5` — **verify by parsing the game file or a community mirror, don't trust the transcription blindly.** Formula: `px=(wx-pos_x)/scale`, `py=(pos_y-wy)/scale` (inverted Y). M2-T2 calibration view becomes a **verification** step (drag crosshair → log pairs) rather than derivation; the extractor can still print world coords at plant ticks for the bomb-in-site assertion.
- **Radar pixels: tiered acquisition, never bundled in public releases** (posture in `findings-mappack.md` §4): numeric metadata (transform constants, site/spawn fractions) ships in-repo as our own JSON (schema sketch in `findings-mappack.md` §5 — modeled on awpy `map_data.json`); pixels come from (1) extraction from the user's local CS2 install (`overheadmaps/<map>_radar_psd.vtex_c`), or (2) optional runtime download of a community mirror with a "© Valve" notice. Site polygons (bomb-in-site invariant) need nav-mesh `bomb-target` flags or vmap `func_bombsite` extraction — centers from the overview txt suffice for M2 with a distance threshold.
- Format is the contract: adding `de_inferno` later = one image + one JSON + verification, no code change.
- Unknown map in library: replay tab shows "map pack missing" with import-a-pack affordance; everything else in M1 still works.

## 6. Data path to the frontend

Spike run (M2-T3, pre-work 2026-10-30; Linux WebKitGTK 2.54.2 + Wails v3.0.0 — full data `ref/findings/findings-webview.md` Q2, methodology `ref/findings/spikes/webvprobe/`):

| path | 32 MiB measured | note |
|---|---|---|
| **Asset-server HTTP full fetch** (`AssetOptions.Handler` + `http.ServeContent`) | ~1.1–1.3 s ≈ **25–30 MB/s** | Range/206 free |
| Asset-server **Range** slice (1 MiB @ 16 MiB offset) | **34–40 ms** | 206 verified — sliding window without full buffering |
| Bound service call `[]byte` | ~2.2 s + ~0.3 s atob ≈ 14–16 MB/s | **base64 +33 % wire** — control plane only |
| `EventsEmit` | (not re-measured) | >8 KB offloads to 64 MiB one-shot store, 30 s TTL — **never for bulk** (findings-deps §5) |
| GoStream (`app.HandleStream`) | unmeasured, purpose-built | bounded buffers, no eval — consider for sustained streams |

**Decision:** sidecar delivery = **asset-server HTTP route** — B-style whole-sidecar fetch on replay open (zstd sidecar is **2.5–6.9 MB** → <0.5 s at measured rates) with A-style **Range** requests as the sliding-window/fallback path, both on the same mechanism. Frontend keeps the full typed-array view client-side for playback (original B architecture); no per-tick Go calls. `ReplayService.GetPositions` remains available but bulk bytes should ride `fetch()`/Range, not bound `[]byte`. **Still unmeasured: macOS WKWebView and Windows WebView2** (WebView2 buffers whole responses — Range slices fine; peak mem ≈ response size) — validate on first run on those platforms.

**Frontend must not own zstd** (verified pre-work, `findings-webview.md` round 2): WebKitGTK's Compression Streams API constructs only `brotli`/`gzip`/`deflate`/`deflate-raw` — `DecompressionStream('zstd')` throws. So: (a) whole-fetch path serves **decompressed** bytes (Go decompresses once per open — trivial), or even raw `q16` (9.1 MB ≈ 0.4 s, clears budget uncompressed); (b) Range path decompresses the requested block **server-side** (sidecars are block-framed for exactly this). No wasm zstd decoder, no Compression Streams reliance.

Playback engine (frontend `lib/replay/engine.js`): clock-driven `requestAnimationFrame`, frame index = f(t, speed), lerp between samples, render layer redraw. Seeking = binary search on tick. Event sync: M1 event list already has ticks — precompute seek targets.

## 7. Service & UI surface

**ReplayService** (Go): `GetReplayMeta(matchID)` (tickrate, frames, format), `GetPositionWindow(matchID, from, to)` (if A), `GetMapPack(mapName)` availability, `GetTrajectories(matchID)` (grenade throw/detonation positions from events + recorded samples), `CaptureSnapshot` stays frontend-side (canvas → PNG download).

**UI:**

```
frontend/src/lib/replay/
    engine.js             clock, seek, lerp, view state
    renderer.js           canvas layers: map → trails → grenades → players → bomb → HUD
    input.js              pan/zoom, hotkeys (space, ←/→ tick, ,/. speed, F follow)
views/
    Replay.svelte         canvas + transport bar + player toggles + minimap HUD
```

Transport bar: play/pause, speed select, tick scrubber with event markers (kills colored, plants/defuses highlighted), loop-interval handles, jump-to-round menu, snapshot button. Round strip from M1 reused. Keyboard-first (PRD §8.4): documented shortcuts, no mouse-only actions.

Embed points: Match view gets "Watch round" per round (round start seek); Timeline rows get "▶ at tick"; RoundDetail kill feed rows seek to the kill.

## 8. Work breakdown

1. **Sampling spike** — *(pre-work done 2026-10-30: standalone prototype measured sizes/time, results §3; remaining M2 work = implement in `internal/extract` behind the job pipeline with a real single-encoding writer)*.
2. **Sidecar format v1** — writer, idx, reader API + Go unit tests (roundtrip, delta correctness); wire into job pipeline + reprocess.
3. **Frontend transfer spike** — *(pre-work done 2026-10-30 on Linux WebKitGTK; decision recorded §6; remaining = macOS WKWebView / Windows WebView2 validation when those platforms are first run)*.
4. **Map pack: de_cache** — radar asset (tiered acquisition per §5 / `findings-mappack.md`), transform constants verified from overview txt, sites/callouts (M2-T2).
5. **Renderer MVP** — static map + players + labels at a fixed tick; zoom/pan.
6. **Playback engine** — clock, speed, step, scrub, trails, bomb, alive/dead.
7. **Grenades** — projectile points, smoke circles w/ lifetime, molly areas; throw→detonate polyline for selected nades.
8. **Sync** — timeline↔replay both ways; round jump; loop interval.
9. **Polish** — follow mode, visibility toggles, snapshots, missing-pack UX, hotkeys, perf pass.

## 9. Testing & acceptance

- Go: sidecar roundtrip tests; sample-count invariants (frames × players); warmup gating (assert via golden fixture that warmup frames are tagged per design).
- Golden-demo spot-checks (checked-in, same skip-if-absent + fixture pattern as M1 §6). Derive concrete invariants from the donk baseline fixture once it exists — e.g.:
  - A plant tick from the fixture: bomb position inside the corresponding site polygon.
  - At freezetime end of any round: all alive players inside their spawn half (sanity of transform + sampling).
  - A known kill tick from the fixture: killer/victim positions within engagement distance (< 50 u sanity bound).
  Store these as `donk.replay.json` (tick + expected region) next to the M1 golden fixture; regenerate with `-update` when the sidecar format changes.
- Frontend: manual script + AGENTS.md xdotool/spectacle smoke flow (import → open replay → play → click a kill → verify seek). Frame budget: 60 fps idle playback on the golden demo; drop-to-scrub < 50 ms.
- Exit-criteria walkthrough: import the golden demo → open replay → reconstruct its biggest round end-to-end, jump from three timeline events to exact states, inspect positioning at arbitrary ticks.

## 10. Performance targets

| Metric | Target | Notes |
|---|---|---|
| Sidecar size (golden demo) | ≤ 30 MB @ 64 Hz | **measured: 18.4 MB f32 / 9.1 MB q16 raw, 6.9 / 2.5 MB zstd** (§3) — budget cleared, 64 Hz confirmed |
| Sampling overhead on parse | ≤ +50 % over M1 parse (≤ 45 s total) | **measured +37.6 % (28.9 → 39.8 s)** worst case, dual-encoding in RAM; async single writer will be cheaper |
| Replay open → first frame | < 500 ms | includes transfer + map decode — sidecar fetch projects < 100 ms at measured 25–30 MB/s (§6) |
| Playback | 60 fps @ 1×–8× | lerp, not per-tick redraw of map |

## 11. Risks & open questions

1. **Radar licensing/quality** — **posture decided** (`ref/findings/findings-mappack.md` §4): numeric metadata in-repo (facts, not artwork); pixels via user-install extraction or runtime download with "© Valve" notice; never bundled in public releases. Community radar quality varies — prefer Valve-shipped assets.
2. **Big-buffer transfer** — **measured on Linux** (§6): asset-server HTTP + Range is the path; **WKWebView/macOS still unmeasured**, WebView2/Windows buffers whole responses. Validate on first macOS/Windows run; Range slices are the portable fallback everywhere.
3. **Position quantization** — **benchmarked** (§3): int16 @ 1.0 u halves raw (18.4 → 9.1 MB); visual-indistinguishability claim still needs the M2 visual check; 0.1 u fallback available at int32 cost if calibration demands it.
4. **Crouch/air state** — Flags bit for duck changes apparent height; 2D top-down ignores z beyond label priority. Fine for M2.
5. **Multiple demos per map session** — some matches contain knife/warmup/restarts with teleporting entities; keep all samples, tag phases, let playback follow match flow events (MatchStarted etc. already extracted).

## 12. Definition of done

- Import golden demo → replay tab: its map's radar, all players labeled, play the whole match at 8×, scrub to any tick, step frames.
- Click any kill in the timeline → camera at the engagement; click plant → bomb at site.
- Grenades render with smoke lifetimes; bomb state correct through plant/defuse/explode.
- Map pack process documented and used for a second map (pick any) to prove the contract.
- `make lint vet test` green; perf table in §10 measured and recorded here.
