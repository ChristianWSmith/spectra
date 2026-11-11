# Replay overlays: vision cones & callout zones — roadmap research

**Unit:** replay-overlays · **Priority tier:** P1 · **Date:** 2026-11-10
**LoE (aggregate):** M — item 1 is a renderer-only S (yaw is already persisted and lerped; the chevron and toggle patterns exist), item 2 is an M (a small resolver + overlay, but zone geometry/names must be authored or extracted, and the extraction path is unverified); true occlusion "could-see" is a separate L-grade format-research spike not counted here.
**Feasibility:** high (as scoped: cones + authored/verified zones) — blockers: no wall/visibility geometry is decoded anywhere today (raw material exists in the per-map VPKs — see Current state), and no callout names exist anywhere in the repo; both halves of the "could-see / extracted names" ambitions are verification-gated.

## Items in scope

1. **Vision cones / could-see lines** — draw where each player is actually looking
2. **Callout zones** — resolve world positions to named places, with a per-team
   zone overlay

## Current state

- **The replay is a 2D radar canvas** — `frontend/src/lib/replay/renderer.js` (≈4.1k lines, one `draw()` with a documented world-layers/overlay split), `engine.js` (rAF clock over a typed-array position store), `components/mapxform.js` `makeTransform` (THE pack→transform reader), `replay/layers.js` (pure layer/elevation box rules), `views/Replay.svelte` (toolbar, toggles, popovers), `LandmarkRow.svelte` (the one event row).
- **Eye angles are ALREADY extracted and persisted — cones need zero new data.** `internal/extract/extract.go` `FrameDone` handler reads `pl.ViewDirectionX()` (yaw, from `m_angEyeAngles`) for every alive playing participant and pushes it into the position sink; `internal/sidecar` encodes it as **1 byte per player per frame** in the positions stream (8 B/player/frame total, **64 Hz, 1:1 with demo frames**; ≈9.1 MB raw / ≈2.5 MB zstd for the golden demo). `engine.js` decodes it into `Float32Array [x, y, z, yaw]` per frame and `lerpAt` interpolates yaw with wrap-around. Pitch is deliberately NOT stored (feeding it into yaw drew garbage — CS2.md "Eye angles"). Data-volume concern: **none** — yaw rides along today, and per-frame angle data for 10 players × full matches is already the shipped cost.
- **A view-direction indicator already exists**: `renderer.js` `chevronPath` (spec 27) draws an open ">" per player at `(-yaw)·π/180` — the canvas-angle convention is settled and tested (`renderer.test.js` yaw fixtures). Vision cones are an extension of this draw, not a new subsystem. (CS2 itself put look-direction arrows on its square radar — CS2.md radar entry.)
- **UserCmd events are not extracted** (CS2.md documents 2.24M/1.72M rows on public HLTV demos with view angles matching eye angles 92–98% within 5°) — irrelevant for 2D cones at 64 Hz lerp; relevant only if sub-frame aim smoothing is ever wanted (see "Per-shot aim telemetry" overlap).
- **No wall / collision / visibility data exists anywhere in the app.** Map packs (`frontend/public/maps/README.md`) are radar PNG + `transform` + per-floor `layers` Z-bands + hand-authored `elevation_regions` boxes + `sites`/`spawns` fraction anchors. `layers.js` `regionAt` is pure XY/Z box matching. Nothing raycasts, nothing knows a wall.
- **Offline raw material for occlusion EXISTS but is undecoded** (read-only probe of the local install today, via VPK directory parse): each map ships its own `game/csgo/maps/<map>.vpk` containing `maps/<map>.nav` (CS2 navmesh, magic `0xFEEDFACE`, version 36, 482 KB dust2 — **verified to carry NO place-name strings**), `maps/<map>.custom.occlusion` (4.3 MB dust2 / 16.5 MB nuke — undocumented), `world_visibility.vvis_c` (3.9 MB — undecoded), plus worldnode/resource files. A community reference parser exists for the nav format (the `cs2-nav` crate, already cited in CS2.md). None of this is reachable by today's `internal/mappack/vpk.go`, which reads `pak01_dir.vpk` only (`cs2find` likewise).
- **No callout names exist anywhere in the repo** (grep over roadmap/docs/src: only this roadmap item). Two unverified candidate sources: (a) demoinfocs v6 `Player.LastPlaceName()` → pawn prop `m_szLastPlaceName` (a per-player named-place string, NOT extracted today; availability in HLTV demos unverified); (b) authored text — the elevation_regions precedent shows bundled hand-authored per-map data is an accepted shape (Valve IP posture: names/numbers are facts, pixels are not).
- **Per-team data is already in the stream**: the position sidecar's flags byte carries per-frame side (bits 2–3: t/ct), and `renderer.js` `sideFromFlags`, `teams.js` `playerSideAt`, `round_player_sides` handle side swaps. Team-colored zone occupancy at the playhead needs no new data.
- **Overlay/toggle scaffolding**: world-layer opt-in pattern (`setDropLayers` — Guns/Utility/Kits popover, off by default), the one coarse HUD gate (`setOverlaysVisible`), session state + frontend-owned kvstore prefs (`skip_freeze` pattern), `HeatmapLayer.svelte` + `AnalyticsService.GetHeatmap` (server-side raster over the sidecar presence stream — the aggregate-stats pattern for zones later).

## Implementation path

### 1. Vision cones / could-see lines — LoE: S (cones) · occlusion = separate L spike

- **Cones (the deliverable):** a renderer draw pass in `drawPlayers`: for each alive slot take `lerpAt`'s `{x, y, yaw}` and stroke a translucent wedge (yaw ± half-angle, fixed world-unit radius, player- or team-tinted) **beneath** the dot/chevron — same paint-order decision the existing "shadow" beneath the dot documents. It rides the player, so per-panel (multi-floor) assignment comes free from the existing panel loop; dead slots are already masked out of the position stream. Pure geometry helper (wedge path in engine-yaw convention) → `node --test`; draw assertions go in the existing `renderer.test.js` harness (yaw fixtures already there).
- **Cone width is a CS2 fact, not a guess:** the half-angle needs the game's default FOV (and whether "cone" should be a fixed ~100° view wedge vs weapon-effective range) — look it up per the CS2.md discipline and record it; render as a documented constant with a formula comment (metrics-carry-formula rule).
- **Toggle:** session state in `Replay.svelte` beside the drop-layers/HUD toggles (world layer, NOT under `setOverlaysVisible` — world layers stay visible when the HUD group is off, matching today's gating), persisted as a frontend-owned kvstore pref; optionally a drop-layer popover entry for consistency.
- **Could-see lines (occlusion) — do NOT commit to this scope yet; L-grade spike with go/no-go:** raw data exists (per-map `.nav` / `.custom.occlusion` / `vvis_c`, see Current state) but every format is undecoded except nav (cs2-nav as reference). The path would be: extend the mappack pipeline with a second VPK reader (`maps/*.vpk` — the format parses in ~20 lines, the content does not) → decode geometry → build per-floor 2D wall/region data stored as a new optional map-pack key → raycast per player per frame (must be cached/precomputed; 10 rays × 64 Hz is fine, visibility *sets* are not). If nav-only approximation (straight line staying inside the walkable mesh) proves good enough, scope shrinks; if `.custom.occlusion` is the only acceptable source, it may be a research dead end. Cones ship regardless of the spike's outcome.

### 2. Callout zones — LoE: M

- **Zone data model (one canonical shape):** world-space boxes with a name, same conventions as `elevation_regions` (min-corner + size, half-open, optional `z_min`/`z_max` floor scope, first-match ordering — Nuke needs the floor scope). Add as an optional additive key in `frontend/public/maps/<map>/meta.json` + the data-dir pack, read through `makeTransform` (the ONE pack reader) exactly like `regions`.
- **Acquisition, in the built-ins + user-extendable shape:**
  1. **Built-in (v1):** hand-authored zone catalogs for the six bundled maps — XY boxes can be read off the radar image offline (no in-game sampling needed except Nuke floor scoping), unlike elevation_regions' `getpos_exact` cost. Bundled copy flows into the data-dir pack on extraction: `mappackservice.go` `bundledMapMeta` + `preserveElevation` already merge a chosen key across refresh — **the allow-list must be extended for zones or a refresh will silently drop them** (today only `elevation_regions` survives).
  2. **User-defined:** the same key in the data-dir pack (user-editable JSON = the data-portability floor) — later, an authoring UI. Overlap: the lineups unit will want this exact catalog; agree on the owner of "user-authored per-map world data" before building either (see Dependencies).
  3. **Extracted names (verify first):** probe the golden demo for `m_szLastPlaceName` (`Player.LastPlaceName()`); if populated, add it as a sparse per-change field to the state stream (interned string table like `weaponNames`, capability marker in `meta.json` — fail-soft for old sidecars, no versioning per pre-release policy; only newly imported demos gain it). This yields *labels for players*, and by clustering samples per label, *derived zone boxes* — but it is a bonus, not the v1 blocker.
- **Resolver:** a pure `zoneAt(x, y, z, zones)` beside `layers.js` (same box-matching discipline — one spelling of the half-open convention), exposed through the pack transform; frontend consumers: a place label on the player card / at the playhead ("Long A"), optional `LandmarkRow` place tags for kills. A Go twin is only needed when statistics want it (keep the rule in one place, cross-reference).
- **Per-team overlay (two readings — confirm with owner):**
  - **Occupancy (computable today, zero new data):** at the playhead, tint/label each zone by which side's players are inside it, using the flags-byte side (already decoded client-side) — a live "who holds which zone" map.
  - **Static assignment (authoring):** each zone carries `side: t|ct|neutral` (or a per-team interest list) for a fixed tactical overlay — pure authoring, drawn like the boxes with a side tint.
  Either way the drawing is a world-layer pass over the panel loop (elevation-indicator precedent: boxes → per-player decision), seek-correct and cheap.

## Existing scaffolding to reuse

- `engine.js` `lerpAt` (yaw interpolation, alive mask), position sidecar (yaw byte, side bits) — **zero extraction/schema work for cones and for occupancy tinting**.
- `renderer.js` `chevronPath` + the `(-yaw)` canvas convention + `drawPlayers` paint order + `sideFromFlags`; toggle precedents `setDropLayers` / `setOverlaysVisible`.
- `components/mapxform.js` `makeTransform` (additive optional keys), `replay/layers.js` `regionAt`/`elevationFor` (the box-matching template for `zoneAt`), panel loop + `layerIndexForZ` (floor scoping).
- `mappackservice.go` `bundledMapMeta` + `internal/mappack` `preserveElevation` (bundled→data-dir merge pattern; extend the key allow-list), `frontend/public/maps/README.md` (contract documentation home).
- `HeatmapLayer.svelte` / `AnalyticsService.GetHeatmap` (sidecar-stream → aggregate raster: the future "time in zone / zone control" stats path), `LandmarkRow.svelte`, `teams.js` `playerSideAt`.
- Tests: `renderer.test.js` (yaw/angle draw assertions), `nuke-elevation.test.js` (bundled-vs-data-dir meta pinning — the template for pinning zone catalogs), `mappackservice_test.go`, `node --test` pure-function style.

## Dependencies & overlaps

- **Video tier (contract):** the WebM recorder burns the canvas — cone/zone visibility must be part of exported frame state (same "what's on the canvas gets recorded" coupling the playback unit flagged). Co-schedule which overlays burn in.
- **Annotations/drawing + lineups (de-conflict ownership):** both want user-authored per-map world geometry/names. Decide ONE home for user-authored map data (data-dir meta key vs sidecar vs prefs) — recommend the meta key (elevation precedent, human-readable, survives re-extract via the allow-list). Lineups will consume the zone catalog for labels/filtering; zones should ship the catalog shape, lineups the authoring UI.
- **Statistics:** a canonical `zoneAt` enables time-in-zone, zone duels, retake-split stats — keep the resolver pure and imported by both front and (later) back end, per the canonical-homes rule.
- **Per-shot aim telemetry (metadata unit):** wants per-shot yaw/pitch — a separate event stream; do NOT overload the fixed 8 B/frame positions layout (pre-release: no versioned formats; layout changes are breaking for existing sidecars).
- **Smart Mode / damage numbers (sibling unit):** same `renderer.js` draw loop and `Replay.svelte` toggle surface — merge-conflict-prone but no logic overlap (already noted by that unit).
- **Export & scripting "Position / trajectory export":** same sidecar stream; cones are its first replay-side consumer — no conflict, shared guarantees (yaw fidelity, 64 Hz).
- **Localization:** zone names are text; bundle English-first, keep them in key-based surfaces for the later localization item.
- **Library/parse pipeline:** only item 2's optional extraction path touches it (new sparse stream = fail-soft capability marker, old demos simply lack it — no re-import mandate, consistent with the pre-release no-versioning policy).

## Risks & unknowns

- **Occlusion formats are undecoded** (`.custom.occlusion`, `vvis_c`); nav has no place strings (verified) and nav-as-2D-LOS is an approximation whose quality is unknown. The honest verdict: "could-see" is *not* infeasible offline (the data ships in the user's install), but it is an L-grade research spike — scope item 1's delivery to cones and gate occlusion behind a go/no-go.
- **`m_szLastPlaceName` unverified** — does CS2 still network it, and do HLTV demos carry it? One cheap probe of the golden demo decides whether the "extracted names" tier exists at all; until then, authored zones are the only certain source.
- **Cone half-angle is a CS2 domain fact** (default FOV / display convention) — must be looked up and recorded in CS2.md, not guessed.
- **"Per-team zone overlay" is ambiguous** (live occupancy vs static side assignment) — a one-line owner question changes what "per-team" means; occupancy is free, static is authoring.
- **Zone authoring scale:** six bundled maps × ~15–30 boxes; radar-coordinate authoring is fast but it is still hand work (the elevation_regions precedent shows the cost is real and accepted).
- **Refresh-drop hazard:** any new meta key not added to the preserve allow-list is silently wiped by "Extract all CS2 assets" — pinned by a test in the elevation precedent; copy it.
- **Multi-floor correctness:** zones need floor scoping like `elevation_regions` (Nuke), and cones must stay inside their player's panel — both follow existing conventions but need Nuke fixtures.
