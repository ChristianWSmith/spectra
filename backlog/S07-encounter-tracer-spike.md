# S07 — Spike: encounter tracer, BSP reachability and CS2 map format

**Type:** spike (research, gate G7)
**Source:** `source/ENCOUNTER-MANIFESTO.md` §10 (spike batch), §7.2; `source/PRUNE.md` (research item 11)

## Goal
Run the manifesto's pre-implementation spike batch, which gates the encounter
fact and sizes its coverage.

## Work
- **Tracer benchmark:** traces per second on real geometry, times expected
  covered ticks. Pathological results (milliseconds per trace) change the
  design.
- **Coverage fraction:** from weapon-fire seeds in the snapshot, estimate the
  share of ticks covered by expansion. The owner expects encounters to be far
  smaller than `player_ticks` (short time-to-kill; windows last seconds), which
  contradicts the manifesto's "same order" sizing. Measure it.
  - Inputs: match 4 has 3,880 weapon-fire events and 162 kills.
  - Merging decides the answer. Unmerged, one 2-second window per shot is about
    1 M rows. One window per kill is about 41,000 rows (about 3% of the tick
    table). Measure the merged union of windows per round.
- **BSP reachability and format:** can map `.bsp` files be read from a CS2
  install through the existing VPK reader, and does `bsp-tracer` (CS:GO format)
  apply to CS2? Record the answer in `CS2.md` with a source.

## Acceptance
- Benchmark numbers, coverage fraction, and a recorded format verdict.
- Go / no-go recommendation for S18 (encounter build).

## Unblocks
G7: S18.

## Not covered
The owner expects the map files to be available but this is unverified. The
format question may be a no-go, which would end S18 as written.

## BSP format verdict (2026-11-21): no-go for `bsp-tracer`

`saiko-tech/bsp-tracer` (MIT, last updated 2024-03-22) reads Source 1 `.bsp`
files (CS:GO), via `galaco/bsp`. CS2 maps are Source 2 compiled vmaps
(`maps/<map>.vmap_c`) inside `game/csgo/maps/<map>.vpk`, with embedded physics
(`embedded_physics`, `phys_data_block`). There are no `.bsp` files in the
install. So `bsp-tracer` does not apply to CS2 maps as it stands. A tracer
needs a Source 2 vmap reader plus the embedded-physics decode.

Recorded in `CS2.md`. S18 (encounter build) is blocked on that reader, not on
the tracer's speed. The tracer benchmark and the coverage fraction are still
unmeasured.

## Options for CS2 geometry (2026-11-22)

Owner asked for a web search. Options, with verification status:

1. **ValveResourceFormat (C#, MIT, updated 2026-11-21).** Decodes `vmap_c` and
   `vphys`. Usable by shelling out from Go (or porting the physics decode).
   Strongest candidate. Pros: mature, maintained, covers CS2. Cons: a C#
   dependency or a port; tracing would be a separate tool step.
2. **Port a DMX/KV3 reader to Go.** Pros: pure Go. Cons: large, and the
   half-edge mesh decode is extra work. Only if (1) is ruled out.
3. **atomicbool/cs2-map-parser (C++, no license).** Reference only.
4. **awpy / cs2-nav.** Navmesh, not collision. Not for tracing LOS.
5. **galaco/bsp, bsp-tracer.** CS:GO only. Not applicable.

Not verified here: the exact VRF API and output fidelity on a CS2 map. The
next step, if the owner wants S18 explored, is a spike: export `de_cache`
collision with VRF, count triangles, and time one ray-cast batch.

## Result: pure-Go DMX/KV3 reader works on CS2 (2026-11-22)

Owner ruled out shelling out to VRF. Built a pure-Go reader in
`src/internal/source2/` (container, binary KV3 v5, uncompressed/LZ4/zstd,
physics mesh extraction). End-to-end test on the local install
(`src/internal/mappack/source2_spike_test.go`):

- `maps/de_cache.vmap_c`: manifest in RED2 lists 803 children, including
  `maps/de_cache/world_physics.vmdl`.
- `world_physics.vmdl_c` PHYS block (22.7 MB, zstd): 11 triangle meshes,
  853,728 vertices, 1,543,751 triangles. All indices in range, all vertices
  inside their bounds.

Not done: the tracer benchmark (traces per second) and coverage fraction.
Next step if the owner wants S18 explored: build a kd traversal over
`m_Nodes` (32-byte nodes) and time a ray batch on the 1.5 M triangles.
Scope of the spike: only v5 KV3, no z3, no embedded tooling.

## Result: visibility raycasts (2026-11-22)

Implemented the segment query over the PHYS kd-tree (`src/internal/source2/raycast.go`)
and checked it against a brute-force reference (`src/internal/mappack/source2_raycast_test.go`):

- Validation: 150 random segments × 11 world meshes = 1,650 mesh queries.
  Disagreements with brute force: **0**. Blocked mesh hits found: 217.
- Timing: 20,000 random segments against all 11 meshes, first hit ends a segment.
  **≈330,000 segments/s** (about 3 µs each), mixed.
  Unblocked-only segments (6,419 of them, every mesh walked): **≈516,000/s**.
  The mixed figure is the conservative one. (An earlier note said unblocked
  rays would be slower. Measured: they are not.)

Scope limits: world geometry only (no prop hulls, no entity colliders), a
single segment-vs-any-mesh query, no BVH build time (it is in the file).

Gate reading for G7 (tracer speed): the tracer is fast enough to be useful for
per-event visibility. The coverage fraction is still unmeasured. The format
question (S07 BSP) is answered: the reader works and no CS:GO BSP is needed.

## Coverage update (2026-11-22, later)

- **Anubis, Inferno, Vertigo now extract.** The manifest omits
  `world_physics.vmdl`, but the VPK holds `maps/<map>/world_physics.vmdl_c`. The
  extractor falls back to that conventional path. Meshes: anubis 9, inferno 9,
  vertigo 11.
- **KV3 version 4 added** (single-buffer pre-v5 layout, from VRF's version-4
  branch). The four version-4 maps extract: ar_pool_day (12 meshes), cs_italy (8),
  lobby_mapveto (3), workshop_preview_ancient / _dust2 / _inferno.
- **Index validation.** The extractor rejects output whose triangles point outside
  their vertices. All extracted maps pass.
- **Sweep:** all 26 install maps (ex. vanity/retake variants) extract, and
  `graphics_settings` is correctly refused (not a map).

Still unverified: whether geometry is right on maps other than de_cache. Index
validity and mesh counts are consistent, but the only visibility check is
de_cache's brute-force comparison. A radar-overlay check per map would be the
next validation.
