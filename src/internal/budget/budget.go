// Package budget is the machine-wide work-token pool: ONE shared budget
// sized to the machine's execution parallelism, out of which every
// sustained heavy unit (an import job, an asset map job, a rules
// recompute) takes exactly ONE token for its duration. Alone, a
// subsystem still gets ALL tokens (no throughput loss); overlapping,
// the subsystems share the machine deterministically instead of
// stacking (owner ruling 2026-11-13: per-subsystem thread ladders let
// the SUM of heavy work stack to ~9 runnable units on a 4-way machine).
// The pool is RESIZABLE (SetSize — the backend of the "parallel work"
// Settings control, 2026-11-13): the size is the user's knob, clamped
// to [1, MachineTokens()] so it can never oversubscribe the machine.
// Counting pool (one mutex + FIFO waiter hand-off), no dependencies.
package budget

import (
	"runtime"
	"sync"
)

// MachineTokens is THE thread-ladder helper — the one place the ladder
// is documented (owner's thread ladder, 2026-11-12; consolidated here
// 2026-11-13 from the three former runtime.NumCPU copies:
// library.workerCount, mappack.poolSize, prefs.clampParallelWork):
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

// waiter is ONE parked acquire, waiting on its own hand-off channel.
// granted records that a slot was handed to it (set under the pool
// mutex before ch closes), which is what lets an AcquireWait whose done
// fired concurrently resolve the race without losing the token.
type waiter struct {
	ch      chan struct{}
	granted bool
}

// Budget is a pool of `size` work tokens: a COUNTING pool guarded by one
// mutex, with waiters parked on their own hand-off channel in FIFO
// order. Acquire takes a token out (held++), Release hands one back
// (held--, then the free slot is granted to the longest-waiting waiter),
// and SetSize resizes the pool. A GROW grants the new slots to parked
// waiters immediately — a waiter blocked while size=1 wakes the moment
// size grows — and a SHRINK never revokes tokens holders already have:
// the bound re-tightens as they drain.
//
// Why a counting pool and not the pre-filled channel this replaced
// (2026-11-13, for SetSize): a fixed-capacity channel cannot resize
// without abandoning waiters parked on it, and a waiter must be able to
// re-evaluate against the NEW size. Here every state change (acquire,
// release, resize, waiter enqueue/removal) happens under the one mutex
// and grants are delivered by closing the waiter's channel while still
// holding it — a closed channel delivers even if the waiter has not
// parked yet, so there are no lost wakeups, and no goroutine ever blocks
// while the mutex is held (the hand-off close never blocks), so the
// pool cannot deadlock on itself. There is no polling: a waiter sleeps
// on its channel until a grant closes it.
//
// NIL RECEIVER = UNBUDGETED, and every method is a deliberate no-op on
// it: Acquire/AcquireWait return immediately (AcquireWait reports true
// = "proceed"), Release and SetSize do nothing, Size reports
// MachineTokens() (an unbudgeted caller imposes no budget of its own —
// a worker pool sizing itself from it gets the whole machine). This is
// load-bearing, not incidental — every existing test constructs its
// subsystem WITHOUT a budget and must stay green unchanged; production
// wiring (main.go hands ONE budget to every consumer) is the invariant
// the nil path must never mask. Never "fix" a nil check away.
//
// Lock order (the invariant, pinned by
// library.TestTokenWaitPrecedesComputeLock): a token is ALWAYS
// acquired BEFORE a compute lock (the import pipeline's computeLock,
// the recompute runner's slot), never reversed — every compute-lock
// holder already owns a token, so the two can never cycle. The pool
// mutex itself is a leaf: it is never held while calling out, so no
// caller's lock can cycle against it either.
//
// Pairing: every Release must follow a successful Acquire. The counting
// pool cannot reproduce the old channel's stray-Release hang (a send on
// a full pool blocks): held never drops below zero, so a stray Release
// on a full pool is simply ignored — it can no longer grow the bound,
// and pairing is pinned by the tests rather than by a hang (deliberate
// change from the chan implementation).
type Budget struct {
	mu      sync.Mutex
	size    int       // total tokens (the parallel-work knob; SetSize clamps [1, MachineTokens()])
	held    int       // tokens currently out (never < 0; exceeds size only until holders drain after a shrink)
	waiters []*waiter // FIFO: parked acquires waiting for a slot
}

// New returns a Budget of n tokens; n ≤ 0 falls back to
// MachineTokens() (a caller that doesn't size the budget gets the
// whole machine). New honors an explicit n as given — it is the wiring
// and test constructor; the USER-facing ceiling rule lives in SetSize
// (and in the pref clamp, prefs.clampParallelWork), both of which
// cannot exceed MachineTokens().
func New(n int) *Budget {
	if n <= 0 {
		n = MachineTokens()
	}
	return &Budget{size: n}
}

// Size reports the pool's current token count — the live value of the
// "parallel work" setting. Production's import admission seam reads it
// per claim (library.Options.Concurrency = b.Size), so a resize applies
// to jobs already queued. A nil Budget reports MachineTokens(): the
// unbudgeted seam imposes no budget, so a pool sized from it runs at
// the machine's parallelism (see the type doc).
func (b *Budget) Size() int {
	if b == nil {
		return MachineTokens()
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.size
}

// SetSize resizes the pool to n, clamped to [1, MachineTokens()] — the
// ceiling rule in code: the user-facing setting can never offer
// oversubscription, and the stored pref (prefs.clampParallelWork)
// clamps to the same bounds, so the two always agree. A GROW hands the
// new slots to parked waiters immediately (FIFO — a waiter blocked
// while size=1 wakes as soon as size grows); a SHRINK never revokes
// tokens holders already have — the bound re-tightens as they drain,
// and no queued work is admitted above the new size. No-op on a nil
// Budget (unbudgeted — see the type doc).
func (b *Budget) SetSize(n int) {
	if b == nil {
		return
	}
	if n < 1 {
		n = 1 // single-threaded floor (a degenerate request never zeroes the pool)
	}
	if max := MachineTokens(); n > max {
		n = max // the ceiling rule: never oversubscribe the machine
	}
	b.mu.Lock()
	b.size = n
	b.grant()
	b.mu.Unlock()
}

// grant hands free slots to the longest-waiting waiters (FIFO), one
// per waiter, while held < size. Called with b.mu held: it only
// touches pool state and closes hand-off channels (a close never
// blocks), so the mutex is never held across a park. A grow wakes
// waiters this way; so does every Release.
func (b *Budget) grant() {
	for b.held < b.size && len(b.waiters) > 0 {
		w := b.waiters[0]
		b.waiters = b.waiters[1:]
		w.granted = true
		b.held++
		close(w.ch)
	}
}

// Acquire blocks until a token is taken out of the pool. No-op on a
// nil Budget (unbudgeted — see the type doc).
func (b *Budget) Acquire() {
	// A nil done never fires, so this IS the plain blocking wait: the
	// fast path takes a free slot, otherwise we park FIFO like every
	// other acquire.
	_ = b.AcquireWait(nil)
}

// AcquireWait blocks until a token is taken, and returns false WITHOUT
// taking one if done fires first — the cancel/shutdown path (a
// token-waiting import job's ctx, so Shutdown/Cancel unblocks its
// worker; see library.worker). nil Budget reports true immediately.
//
// When done has ALREADY fired and a token is also free, the token check
// wins (this reports true): the caller got a token it must Release and
// it must still respect done itself — the import pipeline does (its
// parse aborts on the cancelled ctx). The chan implementation picked
// randomly in that state; either outcome was always legal, and taking
// the token is the cheaper, allocation-free one.
//
// done firing while we are parked resolves under the pool mutex: if a
// grant landed in the same instant (w.granted), the token is already
// ours and this reports true; otherwise we remove ourselves from the
// queue and report false with no token taken — no token can be lost to
// the race because grants and removals serialize on the same mutex.
func (b *Budget) AcquireWait(done <-chan struct{}) bool {
	if b == nil {
		return true
	}
	b.mu.Lock()
	if b.held < b.size {
		b.held++
		b.mu.Unlock()
		return true
	}
	w := &waiter{ch: make(chan struct{})}
	b.waiters = append(b.waiters, w)
	b.mu.Unlock()

	select {
	case <-w.ch: // a slot was granted to us (accounted under the mutex)
		return true
	case <-done:
		b.mu.Lock()
		if w.granted {
			// A grant won the race: the token is already ours — report
			// true (the caller must Release it and still respect done).
			b.mu.Unlock()
			return true
		}
		// Still queued: take ourselves out; no token was taken. Only
		// grant() removes waiters, and granted is false, so we are
		// still in the list.
		for i, x := range b.waiters {
			if x == w {
				b.waiters = append(b.waiters[:i], b.waiters[i+1:]...)
				break
			}
		}
		b.mu.Unlock()
		return false
	}
}

// Release hands a held token back to the pool: the slot is granted to
// the longest-waiting waiter when there is one (held drops, then grant
// hands it straight on), else held simply drops. No-op on a nil Budget.
func (b *Budget) Release() {
	if b == nil {
		return
	}
	b.mu.Lock()
	if b.held > 0 {
		b.held--
	}
	b.grant()
	b.mu.Unlock()
}
