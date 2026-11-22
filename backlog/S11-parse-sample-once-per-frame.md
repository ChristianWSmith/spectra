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
