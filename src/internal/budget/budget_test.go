package budget

// Unit pins for the machine-wide token pool: the bound is real (N
// tokens never run N+1 units), Release hands off to a parked waiter,
// AcquireWait aborts on done (the cancel/shutdown path), the nil
// receiver is a no-op (the unbudgeted seam every existing subsystem
// test constructs), New(0) sizes itself from MachineTokens(), and the
// RESIZE path (SetSize — the "parallel work" setting) grows into
// parked waiters, keeps holders through a shrink, and clamps to the
// ceiling.

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
// back a pool with exactly MachineTokens() capacity — Size() read, no
// timing. (Deliberate adjustment 2026-11-13: this test used to read
// cap(New(n).toks), the chan implementation's buffer — Size() is the
// semantic accessor now that the pool is a counting pool, and the
// assertions below are unchanged.)
func TestNewSizesFromMachineTokens(t *testing.T) {
	for _, n := range []int{0, -3} {
		if got := New(n).Size(); got != MachineTokens() {
			t.Errorf("Size(New(%d)) = %d, want MachineTokens() = %d", n, got, MachineTokens())
		}
	}
	if got := New(3).Size(); got != 3 {
		t.Errorf("Size(New(3)) = %d, want 3 (an explicit size is honored)", got)
	}
	if got := MachineTokens(); got < 1 {
		t.Errorf("MachineTokens() = %d, want ≥1 (the single-threaded rung)", got)
	}
}

// parkedWaiters reports how many acquires are queued inside the pool —
// the test-only observation that a waiter has actually PARKED (it locks
// the pool mutex exactly like the implementation, so it can never race
// a grant into a false positive).
func parkedWaiters(b *Budget) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.waiters)
}

// waitForParkers polls until n acquires are queued inside the pool (or
// fails the watchdog) — used to prove a waiter is parked BEFORE the
// event that must wake it, so the test pins a wake-up and not merely a
// fresh acquire that happened to see the new state.
func waitForParkers(t *testing.T, b *Budget, n int, what string) {
	t.Helper()
	deadline := time.Now().Add(arriveTimeout)
	for parkedWaiters(b) != n {
		if time.Now().After(deadline) {
			t.Fatalf("waiters parked = %d, want %d — %s never parked", parkedWaiters(b), n, what)
		}
		time.Sleep(time.Millisecond)
	}
}

// TestSetSizeGrowWakesWaiter pins the resize hand-off: a waiter parked
// for a token at size 1 is granted a slot the moment SetSize grows the
// pool — no Release involved (this IS the Settings path), FIFO, no
// busy-polling. The waiter is proven parked first (waitForParkers), so
// the arrival can only come from the grow's wakeup.
func TestSetSizeGrowWakesWaiter(t *testing.T) {
	b := New(1)
	b.Acquire() // the only token is out

	got := make(chan struct{})
	go func() {
		b.Acquire()
		close(got)
	}()
	waitForParkers(t, b, 1, "the second Acquire")

	b.SetSize(2)
	select {
	case <-got:
	case <-time.After(arriveTimeout):
		t.Fatal("SetSize(grow) never woke the parked waiter")
	}
	if got := b.Size(); got != 2 {
		t.Errorf("Size after SetSize(2) = %d, want 2", got)
	}
}

// TestSetSizeShrinkKeepsHolders pins the other half of the resize
// contract: a shrink NEVER revokes tokens holders already have (no
// killed work, no accounting break) — the bound re-tightens as they
// drain. After the drain the pool enforces the NEW size: one acquire
// succeeds, the next parks until a Release.
func TestSetSizeShrinkKeepsHolders(t *testing.T) {
	b := New(3)
	b.Acquire()
	b.Acquire()
	b.Acquire() // three holders — at the old size
	b.SetSize(1)
	if got := b.Size(); got != 1 {
		t.Fatalf("Size after SetSize(1) = %d, want 1", got)
	}

	// All three holders still hold and can hand back: the shrink did
	// not revoke anything, and the pool accounting stays sane (no
	// negative held, no lost tokens).
	done := make(chan struct{})
	go func() {
		b.Release()
		b.Release()
		b.Release()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(arriveTimeout):
		t.Fatal("Release hung after a shrink — holders were not kept alive")
	}

	// The drain landed at the NEW bound: exactly one token comes back
	// out, the second acquire parks until the holder releases.
	b.Acquire()
	got := make(chan struct{})
	go func() {
		b.Acquire()
		close(got)
	}()
	waitForParkers(t, b, 1, "the acquire above the new size")
	select {
	case <-got:
		t.Fatal("acquired a second token while the shrunk pool held only one")
	default:
	}
	b.Release()
	select {
	case <-got:
	case <-time.After(arriveTimeout):
		t.Fatal("Release never handed the token to the parked waiter")
	}
}

// TestSetSizeClamps pins the ceiling rule in code: SetSize folds any
// request into [1, MachineTokens()] — 0/negative land on the
// single-threaded floor, anything above the machine's parallelism lands
// on the ceiling (the UI can never offer oversubscription), and a nil
// Budget takes the setting as a no-op instead of panicking.
func TestSetSizeClamps(t *testing.T) {
	b := New(1)
	for _, tc := range []struct{ in, want int }{
		{0, 1},
		{-7, 1},
		{MachineTokens() + 5, MachineTokens()},
	} {
		b.SetSize(tc.in)
		if got := b.Size(); got != tc.want {
			t.Errorf("SetSize(%d).Size() = %d, want %d", tc.in, got, tc.want)
		}
	}
	var nilB *Budget
	nilB.SetSize(3) // no panic (unbudgeted no-op)
	if got := nilB.Size(); got != MachineTokens() {
		t.Errorf("nil Size() = %d, want MachineTokens() = %d (unbudgeted reports the machine)", got, MachineTokens())
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
