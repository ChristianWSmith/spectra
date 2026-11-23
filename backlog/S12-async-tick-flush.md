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

## Result

**Status:** implemented on `worktree-agent-a710eb5f641694cb0`. Not pushed.

### What changed
- `src/internal/store/ticks.go`
  - `TickWriter` now owns one writer goroutine. `AddTicks` buffers rows on the parse thread and hands each full chunk (`tickChunkRows`, 50 000 rows) through a bounded queue (`tickQueueDepth` = 2). The goroutine commits each chunk in its own short transaction.
  - `Close` hands over the remainder, closes the queue, waits for the writer, and returns the first write error.
  - `Abort` (new) stops the writer, waits for it to exit, then calls `DeletePlayerTicks`. It is idempotent and safe after `Close`.
  - Write errors are sticky. The next `AddTicks` returns the error, which aborts the parse, and `Close` returns it too. This replaces the stored-field-only behaviour.
  - `Rows()` is atomic because the writer commits asynchronously.
  - Threading contract in the type comment: `AddTicks`, `Close` and `Abort` are called from one goroutine.
  - Deadlock reasoning, as documented in the type comment: the writer's transaction waits only on the database, the parse thread never holds a transaction while waiting on the writer, and progress writes are single autocommit statements that queue behind a chunk. The `ticks.go` warning about transaction length still holds: one chunk is under a second at this bound.
- `src/internal/library/library.go`: `cleanupPartial` calls `tw.Abort()` when the writer exists (otherwise `DeletePlayerTicks` as before). Every failure path before the match row is saved already goes through `cleanupPartial`, so this covers parse error, cancellation and the save-side failures. Failures after the save (analyze, metrics) keep the rows by design and do not call it. The success path still calls `tw.Close()` before the match row is saved.
- `src/internal/store/ticks_test.go`
  - `TestTickWriterChunksTransactions` no longer assumes synchronous commits; it waits on `Rows()`.
  - New `TestTickWriterAbortLeavesNoPartialTicks` (subtests `parse error` and `cancelled`): no partial rows for the match, the other match untouched, second `Abort` returns nil, `AddTicks` after `Abort` errors.
  - New `TestTickWriterWriteErrorReachesCaller`: a SQLite trigger (`RAISE(ABORT)` on one tick) forces a chunk write to fail. The error reaches the caller from `AddTicks` or `Close`, and `Abort` leaves zero rows.
  - New `TestTickWriterNoDeadlockUnderProgressWrites`: three-plus chunks interleaved with a tight `UpdateJobProgress` loop, with a 60 s timeout.

### Test results
- `go test -count=1 ./internal/store/`: ok (207.6 s, full package).
- `go test -count=1 ./internal/library/`: ok on rerun (247.6 s). The first run had one failure, `TestJobProgressMonotoneAcrossStages` ("job never reached done" within the 5 s `waitStatus` budget), while the machine was heavily loaded. It passes alone 3 of 3 times. Its `fakeParse` never calls the tick sink, so it does not exercise this change. I did not run it against the baseline.
- `go test -count=1 ./internal/extract/`: ok.
- `go test -race -run 'TickWriter|PlayerTicks' ./internal/store/`: ok (132 s).
- `TestGoldenPlayerTicks` (`./internal/integration/`): PASS (133 s). The golden data is present here, so it was not skipped.
- Existing importer tests `TestImportStreamsPlayerTicks` and `TestImportFailureDeletesPlayerTicks` pass.

### Not verified / not done
- **Timing against the S08 baseline was not measured.** The prototype's 17.5 s to 16.0 s figure has not been reproduced.
- Importer-level write-error and cancellation tests were not added. Those paths are covered at the store level. The importer tests cover parse error and the content guard.
- No test covers `Abort` on a panic path. There is no `defer`, so a panic in the parser still leaves the writer goroutine running.
- Behaviour under a real concurrent import queue is untested, as the story notes.
- The full integration package and `go test ./...` were not run.
- Machine note: this box's disk is slow, so the full store package took about 3.5 minutes. A goroutine dump from one stalled run showed a syscall inside a SQLite commit in an unrelated test. I found no evidence of a deadlock in the tick code.

### Open questions
1. **Memory.** The peak is now about four chunks: one filling, two queued, one being written. At ~50k rows per chunk that is roughly 200k buffered rows, up from one chunk before. Lowering `tickQueueDepth` to 1 gives three chunks at the cost of more parse-thread stalls. Which trade-off is wanted?
2. **Error stage.** A write error now surfaces from `AddTicks`, so the parse fails and the importer reports it at `StageParse`. `Close` errors still report at `StageStore`. Is that the intended stage?

### Decisions (2026-11-23, lead)
- Queue depth stays at 2. Peak buffering is about 200k rows, roughly 20 MB, which is negligible. Revisit only if S08 shows memory pressure.
- Write errors reported at StageParse are accepted: they surface while the parse is still producing rows.
- Still open: timing against the S08 baseline, importer-level failure tests, and abort on the panic path.
