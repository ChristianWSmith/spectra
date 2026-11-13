package budget

// Unit pins for the machine-wide token pool: the bound is real (N
// tokens never run N+1 units), Release hands off to a parked waiter,
// AcquireWait aborts on done (the cancel/shutdown path), the nil
// receiver is a no-op (the unbudgeted seam every existing subsystem
// test constructs), and New(0) sizes itself from MachineTokens().

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// arriveTimeout is how long a barrier waits for the pool to hand it
// another in-flight unit before declaring the bound broken — the same
// generous watchdog the mappack pool tests use (the positive signal
// comes in microseconds on a working pool; only a broken bound ever
// waits it out).
const arriveTimeout = 10 * time.Second

// boundWindow is the negative-observation window: with every token
// held, no further unit may start within it. Its absence of activity
// IS the bound (an unbounded pool produces an arrival in
// microseconds), mirroring TestRunJobsSemaphoreBoundsWorkers.
const boundWindow = 100 * time.Millisecond

// trackMax bumps maxActive to the highest concurrent count observed.
func trackMax(maxActive *atomic.Int32, n int32) {
	for {
		old := maxActive.Load()
		if n <= old || maxActive.CompareAndSwap(old, n) {
			return
		}
	}
}

// TestNewSizesFromMachineTokens: New(0) (and any non-positive n) hands
// back a pool with exactly MachineTokens() capacity — same-package
// read of the channel cap, no timing.
func TestNewSizesFromMachineTokens(t *testing.T) {
	for _, n := range []int{0, -3} {
		if got := cap(New(n).toks); got != MachineTokens() {
			t.Errorf("cap(New(%d)) = %d, want MachineTokens() = %d", n, got, MachineTokens())
		}
	}
	if got := cap(New(3).toks); got != 3 {
		t.Errorf("cap(New(3)) = %d, want 3 (an explicit size is honored)", got)
	}
	if got := MachineTokens(); got < 1 {
		t.Errorf("MachineTokens() = %d, want ≥1 (the single-threaded rung)", got)
	}
}

// TestBoundNeverExceedsN pins enforcement: with N tokens, at most N
// units are ever active — a saturated pool admits no N+1th unit (the
// negative window), the cap is REACHED (not merely respected), and
// every unit runs exactly once.
func TestBoundNeverExceedsN(t *testing.T) {
	const n, units = 2, 6
	b := New(n)

	var active, maxActive, ran atomic.Int32
	entered := make(chan struct{}, units)
	release := make(chan struct{})
	released := false
	defer func() {
		if !released {
			close(release)
		}
	}()
	var wg sync.WaitGroup
	for i := 0; i < units; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			b.Acquire()
			ran.Add(1)
			trackMax(&maxActive, active.Add(1))
			entered <- struct{}{}
			<-release
			active.Add(-1)
			b.Release()
		}()
	}

	// Saturate: both tokens go out.
	for k := 0; k < n; k++ {
		select {
		case <-entered:
		case <-time.After(arriveTimeout):
			t.Fatalf("only %d unit(s) ever started, want the pool to reach its %d-token cap", k, n)
		}
	}
	// Every token is held: an unbounded pool would start unit N+1 right
	// now. Its absence within the window is the bound.
	select {
	case <-entered:
		t.Fatalf("an %d+1th unit started while all %d tokens were held — no bound", n, n)
	case <-time.After(boundWindow):
	}
	close(release)
	released = true

	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(arriveTimeout):
		t.Fatal("units never finished after release")
	}
	if got := maxActive.Load(); got != n {
		t.Errorf("max concurrent = %d, want exactly the cap %d (reached, not just respected)", got, n)
	}
	if got := ran.Load(); got != units {
		t.Errorf("ran %d units, want %d (every unit exactly once)", got, units)
	}
}

// TestReleaseHandsOffToWaiter: a waiter parked on Acquire is handed the
// token by Release. The waiter provably parks first (the test holds
// the only token, so it cannot complete), then Release frees it —
// channels, no sleeps-as-sync.
func TestReleaseHandsOffToWaiter(t *testing.T) {
	b := New(1)
	b.Acquire() // the pool's only token is out

	got := make(chan struct{})
	go func() {
		b.Acquire() // must park: the test holds the only token
		close(got)
	}()
	select {
	case <-got:
		t.Fatal("waiter acquired a token while the pool's only token was held")
	default: // deterministic: the token is held, so this cannot fire
	}

	b.Release()
	select {
	case <-got:
	case <-time.After(arriveTimeout):
		t.Fatal("Release never handed the token to the parked waiter")
	}
}

// TestAcquireWaitDonePaths pins both AcquireWait outcomes: a free token
// with an open done grants (and takes the token), while done firing
// while every token is held returns false WITHOUT taking one (the
// cancel/shutdown path a token-waiting import worker rides).
func TestAcquireWaitDonePaths(t *testing.T) {
	b := New(1)

	// Grant path: token free, done open → true, token taken out.
	open := make(chan struct{})
	if !b.AcquireWait(open) {
		t.Fatal("AcquireWait = false with a free token and an open done channel")
	}

	// Abort path: the pool's only token is held, done fires later →
	// false, no token taken. Parked first (the default select cannot
	// fire: token held, done open), closing done is what frees it.
	done := make(chan struct{})
	result := make(chan bool, 1)
	go func() { result <- b.AcquireWait(done) }()
	select {
	case <-result:
		t.Fatal("AcquireWait returned while its only token was held and done was open")
	default: // deterministic: token held, done open — it must be parked
	}
	close(done)
	select {
	case ok := <-result:
		if ok {
			t.Error("AcquireWait = true after done fired while every token was held — want false")
		}
	case <-time.After(arriveTimeout):
		t.Fatal("AcquireWait never returned after done fired")
	}

	// The abort took NO token: Release hands the held token back and a
	// fresh wait grants it again (round trip — a token stolen by the
	// abort would strand the pool at zero).
	b.Release()
	if !b.AcquireWait(make(chan struct{})) {
		t.Error("round trip after an aborted wait did not grant a free token")
	}
}

// TestNilBudgetIsANoOp: a nil *Budget is the unbudgeted seam — every
// method proceeds/returns without panicking, and AcquireWait reports
// true (proceed) so call sites stay uniform.
func TestNilBudgetIsANoOp(t *testing.T) {
	var b *Budget
	b.Acquire()
	b.Release()
	if !b.AcquireWait(make(chan struct{})) {
		t.Error("nil Budget.AcquireWait = false, want true (unbudgeted proceeds)")
	}
	closed := make(chan struct{})
	close(closed)
	if !b.AcquireWait(closed) {
		t.Error("nil Budget.AcquireWait(closed) = false, want true (a nil budget never aborts)")
	}
}
