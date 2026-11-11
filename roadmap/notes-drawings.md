# Drawing / telestration — roadmap research

**Unit:** notes-drawings · **Priority tier:** P2 · **Date:** 2026-11-10
**LoE (aggregate):** M — no drawing capability exists anywhere today (greenfield interaction layer), but every input it needs is already client-side: the replay canvas is a single `<canvas>` with a documented world-layer draw pipeline, per-frame player positions/yaw live in the engine's typed-array store, and `worldToScreen` + the sidecar dir + service/bindings patterns cover rendering and persistence. The week goes to: a tool-mode interaction on top of the pan/zoom-only input, a renderer pass with tick/player anchor resolution, a small persistence file + service, and the test churn (`renderer.test.js`, `replay.dom.mjs`). An ephemeral-only v1 (freehand + arrow + tick pin, no save) would be S; persistence, player-pinned anchors, shape tools and edit/select push it to M.
**Feasibility:** high — no blockers or unverified data sources; everything is frontend + one small Go service. The one design-level hazard is storing irreplaceable user drawings inside the extract-owned match dir, which a failed reprocess `RemoveAll`s (see Risks).

## Items in scope

1. **Drawing / telestration** — pens, shapes, paths and arrows over the map, some pinned to the demo clock or to a player and persisted as sidecars

## Current state

- **There is NO drawing tool today.** No tool palette, no stroke/shape model, no drawing pass in the renderer — grep for draw/pen/arrow/telestration across `frontend/src` only hits the renderer's own world-effect painting and the heatmap raster. The "map drawings burned in" phrasing is roadmap copy for the *video* items (`ROADMAP.md` L22–25), not an existing feature; `README.md` L24 promises only "WebM clip recording, PNG snapshots".
- **Single canvas, one draw pipeline.** `views/Replay.svelte` L2876 owns one `<canvas>`; `replay/renderer.js` `createRenderer` (≈4.1k lines) `draw()` runs: radar/grid → world layers (trails, grenades, deaths, drops, bomb, tracers, `drawPlayers`) → gated overlay group (`setOverlaysVisible`: HUD / kill feed / chat). **There is no user-content pass** — a drawings pass slots in as one more world layer (paint-order decision: above/below player dots).
- **Input is pan/zoom only.** `replay/input.js` `attachReplayInput` hardwires left-drag → `renderer.panBy`, wheel → `zoomAt`, plus the transport keymap (`KBD_HINTS`, `S` snapshot). No drawing mode, no hit-testing, and **no screen→world inverse is exported** (`worldToScreen` is; `screenToImage` L1156 is internal; `getCam` is). Pointer handling must be mode-gated or the draw tool and camera fight over left-drag.
- **Everything a "pinned" drawing needs already exists client-side.** Positions arrive over `/api/sidecar/<id>/positions` (raw, frontend-decoded by `engine.js` `parsePositions`), and `engine.lerpAt(slot, out)` / `frameForTick` give the per-tick player transform the follow-camera already uses — tick-pinned visibility and player-pinned offsets are pure functions of `engine.state.tick`, hence seek-correct like every other world effect.
- **Persistence landscape.** Sidecars live in `~/.local/share/spectra/matches/<id>/` (`internal/data.MatchesDir`): `positions.bin/.idx`, `state.bin/.idx`, `meta.json` (JSON self-describing header), `voice/<steamid>.opus+.idx`. They are **binary zstd streams written at extract time** by `internal/sidecar` `Writer`, read through `/api/sidecar/<id>/{positions,state,meta}` routes (`main.go` ~L471–560) — the frontend never decodes zstd, and absence fails soft (`ErrNoSidecar`/`ErrNoState`). **No user-authored per-match data exists at all** (no notes/bookmarks/tags/drawings anywhere in `schema.sql`); the only write-service precedents are SQLite-backed (`saved_filters`, `metrics`, `saved_queries`, `analysis_config`). A drawings file is therefore a *new kind* of sidecar: written by the frontend's service long after import, not by the parser.
- **Lifecycle hazard (load-bearing for the persistence choice):** `internal/library/library.go` L792–810 — a parse failure does `os.RemoveAll(sidecarPath)` on the **whole match dir**, the voice dir is wiped before every reprocess, and `LibraryService.DeleteMatch` RemoveAlls the match dir too. Positions are re-derivable from the demo; **user drawings are not** — storing them there without touching that cleanup contract means a failed reprocess destroys irreplaceable data.
- **Recording burns the canvas.** `startClip` = `canvas.captureStream(30)` + `MediaRecorder`; `snapshot()` (S) = `downloadCanvasPNG`. Whatever is painted on the replay canvas lands in clips/PNGs; a DOM/SVG overlay would NOT. This is the "drawings burned in" contract the video roadmap items assume.

## Implementation path

### 1. Drawing model + geometry module (pure, frontend) — the shared primitive
- New `lib/draw/` (pure, `node --test`-able): shape = world-space point array + style (color/width/opacity) + anchor. Tools: freehand pen (polyline, decimated), line, **arrow** (line + head, `chevronPath`'s angle convention), rect/ellipse (optional v1), path (polyline through waypoints).
- **Anchors:** `global` (always visible) · `tick` `{fromTick, toTick}` (appear/disappear with the playhead) · `player` `{steamId/slot, anchorTick, offset}` — at render time the shape is translated by `lerpAt(slot, anchorTick) → lerpAt(slot, now)`, i.e. it rides the player; dead-frame hold and round transitions follow the follow-camera's documented rules.
- Serialization: plain JSON, **no format-version key** (pre-release policy — this is THE layout; unknown fields tolerated on read).

### 2. Tool mode + interaction
- A draw-mode flag in `Replay.svelte` (toolbar popover: tool, color, width, pin mode, clear/undo) — armed like the existing popovers; while armed, `input.js` pointer handlers route to stroke capture instead of pan (mode gate inside `attachReplayInput`, or a capture-phase listener the mode checks). Esc / re-click exits; pan/zoom keys and transport keys stay live.
- **Screen→world:** export the renderer's inverse (add `screenToWorld` beside `worldToScreen`, deriving from the affine cam) — `mapxform.toWorld` is the *static* map transform (Heatmaps/`HeatmapLayer` click mapping) and does not account for replay pan/zoom, so it is not reusable here. Strokes are captured in world coords → they pan/zoom with the map for free.
- Edit affordances v1: undo last stroke, clear-all, per-stroke delete (hit-test needs the inverse + a distance test — keep minimal; full select/move handles is scope creep).

### 3. Renderer pass
- `setDrawings(list)` + `drawDrawings(tick)` in `draw()`'s world phase, gated by a visibility toggle following the `setDropLayers` pattern (opt-in, session state + frontend-owned kvstore pref). Per frame: filter by anchor window (tick pin), apply player-pinned offset, stroke through `worldToScreen`. Paint before `drawPlayers` (under dots) or after — one ordering decision, documented like the bomb/death precedents.

### 4. Persistence (sidecar)
- New file `matches/<id>/drawings.json` + a small Go surface (extend `MatchService` or a new `AnnotationService`): `GetDrawings(matchID)` / `SaveDrawings(matchID, json)` over generated bindings (regenerated per build), loaded in `Replay.load()`, saved debounced-on-change. Fail-soft read (missing file = no drawings), exactly like a missing sidecar.
- **Deliberate contract fix alongside it:** the parse-failure `cleanupSidecar` (and reprocess wipe) must not destroy user-authored files — either move drawings out of the wiped set, preserve/restore them around reprocess, or accept-and-document that a *failed* parse costs drawings (recommendation: preserve; they cannot be re-imported).
- Alternative rejected-for-now: a SQLite table (precedents exist) — the roadmap says sidecar, the per-match dir is the natural home, and it keeps match delete/deep-clean semantics free; but coordinate with the annotations unit before fixing the home (see Overlaps).

### 5. UI + tests
- Toolbar palette (`Popover.svelte` pattern, unique CSS prefix e.g. `dr-`), layer-visibility toggle, `KBD_HINTS` entry (pinned by `frontend/test/replay.dom.mjs`). Tests: geometry/anchor resolution in `node --test`, palette/mode behavior in the jsdom harness, draw-pass assertions in `renderer.test.js`.

## Existing scaffolding to reuse

- `renderer.js` — `draw()` world-phase structure and paint-order documentation style, `worldToScreen` (+ internal `screenToImage` to expose), `setDropLayers`/`setOverlaysVisible` gating, `chevronPath` (arrowhead/angle convention), exported API block L4110 (where `setDrawings` goes).
- `engine.js` — `lerpAt` (player-pinned transform, dead-frame hold), `frameForTick`, `state.tick` (tick pinning), `parsePositions`.
- `input.js` — keymap/`REPEATABLE`/`KBD_HINTS` wiring and the pointer handlers to mode-gate; `download.js`/`save.js` (PNG export of whatever's painted).
- `Replay.svelte` — toolbar + popover pattern, `load()` pre-engine reads, session-toggle + kvstore-pref pattern (`skip_freeze`, drop layers).
- `internal/sidecar` + `main.go` `/api/sidecar` routes — fail-soft absence semantics and the match-dir file conventions a `drawings.json` joins; service + generated-bindings pattern for the two new methods.
- Tests: `renderer.test.js`, `input.test.js`, `frontend/test/replay.dom.mjs` (toolbar/hints pins), `node --test` pure-function style.

## Dependencies & overlaps

- **Video / clip export (contract):** "drawings burned in" only holds if drawings are painted on the replay canvas — keep them in the renderer pass, never a DOM overlay; and decide explicitly that draw-mode *UI* (cursor, palette) never paints. Co-schedule with the video unit's "which overlays burn in" rule (same coupling the playback/overlays units flagged).
- **Strategic board (drawn paths):** share the **pure geometry/serialization module** (`lib/draw/` primitives, JSON shape, hit-testing) — the board is a different surface (static snapshot, no engine/tick), so only the model transfers, not the interaction layer. Building the primitives as surface-agnostic from day one is cheap; retrofitting is not.
- **Annotations unit (notes / bookmarks / voice notes):** drawings are the visual half of annotation. **Co-design the persistence home** — one per-match user-data store (sidecar file vs SQLite table) should serve drawings *and* notes/bookmarks rather than two divergent homes; the same Go service can own both. Tick-pinned drawings pair naturally with bookmarks (a bookmark jump could arm a drawing's window).
- **Replay overlays unit (vision cones / callout zones):** same `renderer.js` draw pipeline and `Replay.svelte` toggle surface — merge-conflict-prone, no logic overlap; its note to "de-conflict the ONE home for user-authored map data" applies to *per-map* data (zones) while drawings are *per-match* — still worth settling both in one policy (data-dir meta key vs match sidecar vs prefs).
- **Heatmaps view:** `HeatmapLayer` click→world mapping is the static-transform precedent only; replay's zoomable camera needs the renderer inverse (new, small).
- **Statistics / library / metadata / lineups:** no impact — no schema change, no jobs, no extract change (unless lineups later want to reference drawings; no current coupling). **Localization:** new UI strings ride the future localization item; keep them in existing string surfaces.

## Risks & unknowns

- **User data in the extract-owned match dir** — failed reprocess `RemoveAll`s the whole dir; delete-match and `deep-clean` wipe it by design. Drawings are irreplaceable (unlike positions), so the cleanup contract must be adjusted deliberately; this is the top risk and a cross-unit decision (annotations store).
- **Interaction design vs pan:** `input.js` gives left-drag to the camera unconditionally; mode gating, cursor feedback, and not swallowing Space/arrows/zoom mid-stroke are fiddly and are most of the "feel" work. Editing existing strokes (select/move/hit-test) is the classic scope-creep trap — recommend v1 = draw + undo/clear + delete-last, defer handles.
- **Player-pinned semantics undefined:** what a drawing does when its player dies (renderer holds last alive position for the camera), disconnects, or the round resets — needs one documented rule, not per-case patches.
- **Test churn:** `renderer.test.js` and `replay.dom.mjs` pin draw behavior and toolbar contents; both need deliberate updates (no golden-fixture or extract implications).
- **No CS2 domain unknowns** — nothing here needs a lookup; the design questions are interaction/persistence policy, not game facts.
- **Staging:** full item = M; if the owner wants a fast first cut, "freehand + arrow + tick-pin + session-only" is S and persists nothing — the model/anchor shapes above are chosen so adding persistence later is additive, not a rework.
