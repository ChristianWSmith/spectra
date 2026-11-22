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
