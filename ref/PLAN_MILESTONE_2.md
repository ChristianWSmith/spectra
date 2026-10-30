# Spectra — Implementation Plan: Milestone 2 (2D Tactical Replay)

**PRD reference:** §5.4 (tactical replay), §5.10 (positional capture), §6.3 (extraction), §10 Milestone 2
**Depends on:** Milestone 1 (import pipeline, store, match/round/event model, timeline UI)
**Exit criteria (PRD §10):** a user can reconstruct and navigate an entire match in 2D, inspect player positioning at arbitrary points in time, and jump directly from an event to the corresponding replay state.

---

## 1. Grounding facts

- Positions are **not** in game events — they live in entity state and must be **sampled during parsing** (PRD §6.3: "cannot be reconstructed later if discarded"). The extractor never sampled; EXTRACTION_TECHNIQUES §13 documents `events.FrameDone` → `Player.Position()` as the proven next step (~4.5 B/tick/player estimate there; budget differently below).
- Reference demo: 120 736 frames @ 64 Hz, ~31.5 min, 10 players → raw per-player-frame record ≈ 120k × 10 = **1.2 M samples/match**.
- Map: first map pack = **whatever map the golden demo is on** (known after the M1 baseline pass). The research parse was on `de_mirage` — its calibration notes in `ref/` apply if the golden demo matches; otherwise calibrate fresh. PRD open question #8 (map assets/coordinate transforms) is this milestone's core research task.
- The M1 event stream already carries: kill/damage positions (where the event struct exposes them), grenade throw/detonation ticks, bomb plant site/tick, smoke/fire start ticks — replay sync anchors.
- Frontend: Svelte 5 in WebKitGTK 6.0 / WebView2 / WKWebView — Canvas 2D is the safe renderer; WebGL exists but is not required for M2's scope (10 markers + trails). Heatmaps (M3) may revisit.

## 2. Scope

**In:**

- Historical position extraction: per-frame (or sampled) position + view angles for all players, gated to real rounds (skip warmup or tag it).
- Sidecar storage per match, outside SQLite blobs (see §4) with an index; DB records format version + tick rate.
- Map asset pack: calibrated radar image + coordinate transform for `de_mirage` (then a process to add maps cheaply).
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
- Sampling decision (task M2-T1, benchmark on the golden demo): **full 64 Hz first**, measure sidecar size after delta+zstd; if > ~50 MB/match, offer half-rate (32 Hz) fallback and record choice per match. Frontend interpolates between samples anyway. (If the golden demo's tickrate differs from 64, scale targets accordingly.)
- Extend the M1 job pipeline: stage `positions` after `store`; progress events continue to work. Reprocess must regenerate sidecars when format version changes.

## 4. Sidecar storage

```
$XDG_DATA_HOME/spectra/matches/<matchID>/
    positions.bin.zst      # delta-encoded FrameSample stream
    positions.idx          # frame → byte offset index (fixed-width, mmap-able)
    meta.json              # format version, tickrate, sample rate, counts
```

- Rationale: SQLite blobs bloat WAL and complicate streaming; files stream by range (PRD §7.3 "separate efficient storage for high-frequency datasets").
- Encoding sketch: varint delta on tick/pos (quantize positions to 0.1 u ≈ mm), zstd block-framed (e.g. 256 frames/block) so the frontend can request byte ranges without full decompress.
- DB: `matches.position_format`, `matches.sample_rate`, `matches.position_frames`; delete/reprocess cascade removes the directory.

## 5. Map asset packs

```
frontend/public/maps/<name>/
    radar.webp           # top-down radar (community asset or extracted)
    meta.json            # transform, bounds, callouts
```

`meta.json`: affine or homography world→image (`pos.x, pos.y → px, py`), world bounds, bombsites A/B polygons (for plant highlighting), callout label anchors (P1).

- **Calibration process (M2-T2):** derive the mirage transform from known landmark correspondences (spawn points / bomb sites vs radar pixels) — the extractor can print world coords at plant ticks (bomb site positions) to bootstrap; hand-tune visually in a dev calibration view (dev-only route, drag crosshair → log pairs).
- Format is the contract: adding `de_inferno` later = one image + one JSON + verification, no code change.
- Unknown map in library: replay tab shows "map pack missing" with import-a-pack affordance; everything else in M1 still works.

## 6. Data path to the frontend

Spike early (M2-T3): two candidates — benchmark both on the golden demo, pick one, record decision here.

- **A. Range API:** `ReplayService.GetPositions(matchID, startFrame, endFrame) → []byte` (raw, decompressed server-side or ship zstd blocks + `DecompressionStream` in webview). Frontend keeps a sliding window; memory bounded; chatty.
- **B. Full sidecar stream:** one `ArrayBuffer` (~5–25 MB after compression for the golden demo) transferred once on replay open; all playback client-side; simplest and likely fine for desktop webviews.

Recommendation: **B**, with A as fallback if webview transfer stalls (WKWebView IPC can be slow with big payloads — measure on macOS early if practical). Playback, interpolation, trails, scrubbing all run in the frontend against the typed-array view; no per-tick Go calls.

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

1. **Sampling spike** — add FrameDone sampling to the extractor behind a flag; dump sidecar for the golden demo; measure size/time at full/half rate (M2-T1).
2. **Sidecar format v1** — writer, idx, reader API + Go unit tests (roundtrip, delta correctness); wire into job pipeline + reprocess.
3. **Frontend transfer spike** — A vs B on the golden demo; decide; document in §6 (M2-T3).
4. **Map pack: mirage** — radar asset, transform via calibration view, sites/callouts (M2-T2).
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
| Sidecar size (golden demo) | ≤ 30 MB @ 64 Hz | measure; fall back to 32 Hz if over |
| Sampling overhead on parse | ≤ +50 % over M1 parse (≤ 45 s total) | writer is async |
| Replay open → first frame | < 500 ms | includes transfer + map decode |
| Playback | 60 fps @ 1×–8× | lerp, not per-tick redraw of map |

## 11. Risks & open questions

1. **Radar licensing/quality** — community radars vary; prefer Valve-shipped radar assets extracted locally by the user, or hand-drawn packs. Keep packs out of git until licensing is checked.
2. **Big-buffer transfer on WKWebView** — validate early (M2-T3); fall back to range API.
3. **Position quantization** — 0.1 u grid is likely over-precise; benchmark 1.0 u (visually indistinguishable at radar scale) if size is a problem.
4. **Crouch/air state** — Flags bit for duck changes apparent height; 2D top-down ignores z beyond label priority. Fine for M2.
5. **Multiple demos per map session** — some matches contain knife/warmup/restarts with teleporting entities; keep all samples, tag phases, let playback follow match flow events (MatchStarted etc. already extracted).

## 12. Definition of done

- Import golden demo → replay tab: its map's radar, all players labeled, play the whole match at 8×, scrub to any tick, step frames.
- Click any kill in the timeline → camera at the engagement; click plant → bomb at site.
- Grenades render with smoke lifetimes; bomb state correct through plant/defuse/explode.
- Map pack process documented and used for a second map (pick any) to prove the contract.
- `make lint vet test` green; perf table in §10 measured and recorded here.
