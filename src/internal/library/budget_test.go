package library

// Machine-wide work-token pins for the import pipeline (internal/budget
// through Options.Budget): a budget=1 run SERIALIZES parses even when
// the concurrency seam would admit two (channel/barrier proof, no
// sleeps-as-sync), the token is always taken BEFORE the compute lock
// (the lock-order invariant), and Shutdown unblocks a worker parked in
// AcquireWait (the classic token-pool bug — a hung shutdown). Every
// other library test constructs no budget (nil = unbudgeted no-op) and
// stays green unchanged.

import (
	"context"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/budget"
	"github.com/ChristianWSmith/spectra/internal/extract"
	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestBudgetSerializesParsesAtOne: with Options.Budget = budget.New(1)
// and the concurrency seam at 2 (the admission semaphore WOULD overlap
// two parses — TestParseConcurrency pins that without a budget), the
// machine token is the binding bound: the second claimed job parks
// waiting for the token and never enters parse until the first job's
// Release hands it over. Proof is all channels — the bounded negative
// window only ever waits for an arrival a working budget makes
// impossible, and the post-release arrival proves the run wasn't
// stranded.
func TestBudgetSerializesParsesAtOne(t *testing.T) {
	b := budget.New(1)
	entered := make(chan struct{}, 4)
	block := make(chan struct{})
	release := sync.OnceFunc(func() { close(block) })
	defer release()
	var inFlight, maxInFlight atomic.Int32
	parse := func(ctx context.Context, r io.Reader, opts extract.ParseOptions) (*models.ExtractedMatch, error) {
		n := inFlight.Add(1)
		for {
			old := maxInFlight.Load()
			if n <= old || maxInFlight.CompareAndSwap(old, n) {
				break
			}
		}
		defer inFlight.Add(-1)
		entered <- struct{}{} // announce before parking: the overlap proof
		select {
		case <-block:
		case <-ctx.Done():
		}
		return fakeParse(ctx, r, opts)
	}
	im, st := newTestImporterWith(t, Options{
		Parse:       parse,
		Concurrency: func() int { return 2 }, // would admit two parses — the budget must not
		Budget:      b,
	})
	ids := im.Enqueue([]string{writeDemo(t, "budget-1.dem", "1"), writeDemo(t, "budget-2.dem", "2")})
	if len(ids) != 2 {
		t.Fatalf("Enqueue returned %d ids, want 2", len(ids))
	}

	// One job claims, takes the only token, and parks inside parse.
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("first parse never started — the budget never handed out its token")
	}
	// The other job has a free concurrency slot and is CLAIMED (running)
	// — but the token is held, so it cannot enter parse.
	waitStatus(t, st, ids[1], models.JobRunning)
	select {
	case <-entered:
		t.Fatal("second parse entered while the budget's only token was held — WithBudget is not bounding")
	case <-time.After(100 * time.Millisecond):
	}

	// Let the holder finish: its Release hands the token to the waiter,
	// which then enters (the arrival proves the bound serializes rather
	// than deadlocks; the watchdog only turns a stranded run into a
	// failure instead of a hang).
	release()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("second parse never started after the token was released")
	}

	deadline := time.Now().Add(10 * time.Second)
	for _, id := range ids {
		for jobByID(t, st, id).Status != models.JobDone {
			if time.Now().After(deadline) {
				t.Fatalf("job %d never finished", id)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	if got := maxInFlight.Load(); got != 1 {
		t.Errorf("max concurrent parses = %d, want 1 (budget=1 bounds below the concurrency seam)", got)
	}
}

// TestTokenWaitPrecedesComputeLock pins the LOCK-ORDER invariant
// (internal/budget's type doc): a token is ALWAYS acquired BEFORE the
// compute lock, never reversed. With the test holding the budget's
// only token, the claimed job parks waiting for it — TryLock proves it
// does NOT hold computeLock while parked (a reversed order would have
// taken the lock at claim and be sitting on it here). Deterministic:
// in the correct order the job never touches the lock before its
// token, so TryLock cannot flake.
func TestTokenWaitPrecedesComputeLock(t *testing.T) {
	b := budget.New(1)
	b.Acquire() // the machine's only token is out
	defer b.Release()
	lock := &sync.Mutex{}
	im, st := newTestImporterWith(t, Options{
		Parse:       fakeParse,
		Concurrency: func() int { return 1 },
		Budget:      b,
		ComputeLock: lock,
	})
	id := im.Enqueue([]string{writeDemo(t, "token-order.dem", "x")})[0]
	waitStatus(t, st, id, models.JobRunning) // claimed → parked waiting for the token

	if !lock.TryLock() {
		t.Fatal("job holds computeLock while waiting for a work token — lock order reversed (token must be acquired BEFORE the compute lock)")
	}
	lock.Unlock()
}

// TestShutdownUnblocksTokenWaiter is the classic token-pool bug check:
// every token is held elsewhere (a full import batch), so the claimed
// job is parked in AcquireWait when Shutdown fires. Shutdown cancels
// every ctx in im.cancels — which IS this wait's done channel — so the
// wait aborts through the running-cancel path and the worker exits;
// Shutdown must return without the token ever being released, and the
// job must land terminal (cancelled), never stranded running.
func TestShutdownUnblocksTokenWaiter(t *testing.T) {
	b := budget.New(1)
	b.Acquire() // the pool's only token held by "another subsystem"
	defer b.Release()
	im, st := newTestImporterWith(t, Options{
		Parse:       fakeParse,
		Concurrency: func() int { return 1 },
		Budget:      b,
	})
	id := im.Enqueue([]string{writeDemo(t, "shut-token.dem", "x")})[0]
	waitStatus(t, st, id, models.JobRunning) // claimed → parked in AcquireWait (the token is held, so it cannot proceed)

	done := make(chan struct{})
	go func() {
		im.Shutdown()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("Shutdown hung on a worker parked in AcquireWait — the token wait must abort on the shutdown cancel")
	}
	if j := jobByID(t, st, id); j.Status != models.JobCancelled {
		t.Errorf("token-waiting job after Shutdown = %q, want cancelled (the four-outcome table's running row)", j.Status)
	}
}
