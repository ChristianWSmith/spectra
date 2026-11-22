# S11 — Sample once per frame across parse sinks

**Type:** build (production from prototype)
**Depends on:** none (ships first)
**Source:** `source/PERF.md` (layer 1); `source/PRUNE.md` (parse cost)

## Goal
Productionise the prototype that reuses per-frame position rows and state
samples in the tick sink, instead of recomputing them.

## Background
Prototype: import 19.1 s → 17.5 s on the golden demo, with identical tick
fingerprints. The state and tick sinks both walk the players per frame; the
position block's results are reused.

## Work
- Replace the prototype with a clean design: sample once per frame, pass the
  result to each sink (sinks keep their gating and error handling).
- Keep the sink call order unchanged. `takeover.go` and the state sink's
  comment say slot-table locking depends on it.
- Add a test: tick and sidecar output identical with and without the change.

## Acceptance
- Golden acceptance test passes (`git lfs pull` first; extraction-touching).
- Tick fingerprint and sidecar output unchanged.
- Measured import saving recorded (S08 gives the clean baseline).

## Not covered
Saving is measured on one demo. Parse-time gains on other maps are not known.

## Result (2026-11-21, implemented)

Implemented in `src/internal/extract/extract.go` (FrameDone handler). Per frame,
the target walk (`appendTargets`), the position rows (`positionRow`) and the
state samples (`sampleStatePlayer`) are read once, and each sink uses the shared
buffers. The sink call order is unchanged: positions, then state, then ticks,
then voice. Sink gating and error handling are unchanged. Positions are read
only when the position or tick sink needs them, and state only when the state
or tick sink needs them.

Verification:
- `go vet ./internal/extract/` and `go test ./internal/extract/ ./internal/store/`: pass.
- `TestGoldenPlayerTicks` (golden demo, `de_cache`): PASS.
- Output identity, `de_cache`, baseline binary vs new binary (separate XDG
  instances):
  - `player_ticks` fingerprint (SHA-256 of an ordered dump of tick, steam_id,
    round, side, alive, hp, money, in_air, speed, weapon): identical.
  - Sidecar `positions.bin`, `positions.idx`, `state.bin`, `state.idx`,
    `voice/`: byte-identical. `meta.json` differs only in `createdAt`.

**Not measured.** The import-time saving was not measured. The machine was
busy (the 7-demo import ran in parallel), so timings are not comparable, and
S08 (the clean scale and timing baseline) is blocked on data.

**Not run.** `internal/integration` in full: a run was killed by my 580 s
timeout with no output, so the full package takes longer than that. Only
`TestGoldenPlayerTicks` was run (PASS, 466 s).
