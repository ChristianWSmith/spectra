// Package budget is the machine-wide work-token pool: ONE shared budget
// sized to the machine's execution parallelism, out of which every
// sustained heavy unit (an import job, an asset map job, a rules
// recompute) takes exactly ONE token for its duration. Alone, a
// subsystem still gets ALL tokens (no throughput loss); overlapping,
// the subsystems share the machine deterministically instead of
// stacking (owner ruling 2026-11-13: per-subsystem thread ladders let
// the SUM of heavy work stack to ~9 runnable units on a 4-way machine).
// Chan-backed, no dependencies.
package budget

import "runtime"

// MachineTokens is THE thread-ladder helper — the one place the ladder
// is documented (owner's thread ladder, 2026-11-12; consolidated here
// 2026-11-13 from the three former runtime.NumCPU copies:
// library.workerCount, mappack.poolSize, prefs.maxConcurrentImports):
//
//  1. Threads: runtime.GOMAXPROCS(0) — Go's actual execution
//     parallelism, rung 1. It honors a GOMAXPROCS env var or a
//     container CPU quota where runtime.NumCPU would over-allocate the
//     host's logical CPUs.
//  2. Cores: unreachable portably — Go exposes no physical-core API
//     (SMT makes threads ≠ cores), so this rung stays documented
//     rather than taken.
//  3. Single-threaded: the floor — the n < 1 guard below (GOMAXPROCS
//     is ≥ 1 in practice; the guard keeps a degenerate answer from
//     ever sizing a pool or clamp at 0).
//
// Callers that size a concurrency pool OR clamp a concurrency pref use
// THIS — never a second spelling of the ladder.
func MachineTokens() int {
	if n := runtime.GOMAXPROCS(0); n >= 1 {
		return n
	}
	return 1 // single-threaded rung (defensive — see the ladder above)
}

// Budget is a pool of n work tokens: a PRE-FILLED buffered channel of
// struct{} (New seeds it with n tokens) — Acquire takes one out,
// Release puts one back.
//
// NIL RECEIVER = UNBUDGETED, and every method is a deliberate no-op on
// it: Acquire/AcquireWait return immediately (AcquireWait reports true
// = "proceed"), Release does nothing. This is load-bearing, not
// incidental — every existing test constructs its subsystem WITHOUT a
// budget and must stay green unchanged; production wiring (main.go
// hands ONE budget to every consumer) is the invariant the nil path
// must never mask. Never "fix" a nil check away.
//
// Lock order (the invariant, pinned by
// library.TestTokenWaitPrecedesComputeLock): a token is ALWAYS
// acquired BEFORE a compute lock (the import pipeline's computeLock,
// the recompute runner's slot), never reversed — every compute-lock
// holder already owns a token, so the two can never cycle.
//
// Pairing: every Release must follow a successful Acquire (Release is
// a plain channel send — a stray Release on a full pool blocks,
// surfacing the pairing bug as a hang rather than silently growing the
// bound).
type Budget struct {
	toks chan struct{}
}

// New returns a Budget seeded with n tokens; n ≤ 0 falls back to
// MachineTokens() (a caller that doesn't size the budget gets the
// whole machine).
func New(n int) *Budget {
	if n <= 0 {
		n = MachineTokens()
	}
	b := &Budget{toks: make(chan struct{}, n)}
	for range n {
		b.toks <- struct{}{}
	}
	return b
}

// Acquire blocks until a token is taken out of the pool. No-op on a
// nil Budget (unbudgeted — see the type doc).
func (b *Budget) Acquire() {
	if b == nil {
		return
	}
	<-b.toks
}

// AcquireWait blocks until a token is taken, and returns false WITHOUT
// taking one if done fires first — the cancel/shutdown path (a
// token-waiting import job's ctx, so Shutdown/Cancel unblocks its
// worker; see library.worker). nil Budget reports true immediately.
//
// When done has ALREADY fired and a token is also free, the select
// choice is random: a true result means the caller got a token it must
// Release, and it must still respect done itself (the import pipeline
// does — its parse aborts on the cancelled ctx).
func (b *Budget) AcquireWait(done <-chan struct{}) bool {
	if b == nil {
		return true
	}
	select {
	case <-b.toks: // a token is free: take it out of the pool
		return true
	case <-done:
		return false
	}
}

// Release hands a held token back to the pool (a waiter parked in
// Acquire takes it). No-op on a nil Budget.
func (b *Budget) Release() {
	if b == nil {
		return
	}
	b.toks <- struct{}{}
}
