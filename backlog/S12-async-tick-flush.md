# S12 — Asynchronous tick flush with abort handling

**Type:** build
**Depends on:** S08 (clean timing), S11 (sequence the parse changes)
**Source:** `source/PERF.md` (layer 1); `source/PRUNE.md`

## Goal
Move `TickWriter` chunk writes off the parse thread, with safe abort, error
propagation and cleanup.

## Background
Prototype: import 17.5 s → 16.0 s with identical fingerprints. The prototype
has no abort handling; the importer's failure paths never call `Close`, so the
writer goroutine can be left blocked and can write after cleanup deletes the
match's tick rows.

## Work
- A bounded channel and single writer goroutine, with a `Close` that drains.
- An abort path: stop the writer, wait for it, then delete the match's rows.
- Error propagation: a write error reaches the importer, not just a stored field.
- Check that each transaction is short, given the single-connection pool and
  progress writes (the warning in `ticks.go`).

## Acceptance
- Failure-path tests: parse error, cancellation, and write error each leave no
  partial ticks.
- No deadlock under concurrent progress writes.
- Timing measured against the S08 baseline.

## Not covered
Behaviour under a real concurrent import queue is not tested by the prototype.
