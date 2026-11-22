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
