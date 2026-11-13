package mappack

// Pool pins for ExtractMapPacks' per-map worker pool (runJobs /
// poolSize / extractJobHook in extract.go): the pool really runs maps
// CONCURRENTLY (a barrier through the real entry point — not a sleep),
// the worker count is the semaphore that bounds it, and the worker
// count follows the owner's thread ladder. The progress and output
// contracts are pinned separately (progress_test.go, mappack_test.go,
// extract_concurrent_test.go).

import (
	"os"
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/budget"
)

// arriveTimeout is how long a barrier waits for the pool to hand it
// another in-flight job before declaring the pool serial. Generous —
// the positive signal (a second arrival) comes in microseconds on a
// working pool; only a broken (serialized) pool ever waits this out.
const arriveTimeout = 10 * time.Second

// trackMax bumps maxActive to the highest concurrent count observed.
func trackMax(maxActive *atomic.Int32, n int32) {
	for {
		old := maxActive.Load()
		if n <= old || maxActive.CompareAndSwap(old, n) {
			return
		}
	}
}

// TestRunJobsRunsJobsConcurrently pins the pool MECHANISM: runJobs
// really runs fn on several goroutines at once (a barrier of two
// arrivals — a workers=1 implementation can never produce the second
// one), runs every index exactly once, and never exceeds the worker
// count.
func TestRunJobsRunsJobsConcurrently(t *testing.T) {
	const workers, n = 4, 8

	var active, maxActive, ran atomic.Int32
	var mu sync.Mutex
	var seen []int
	arrived := make(chan int, n)
	release := make(chan struct{})
	released := false
	defer func() {
		if !released {
			close(release)
		}
	}()
	finished := make(chan struct{})
	go func() {
		runJobs(workers, n, func(i int) {
			ran.Add(1)
			a := active.Add(1)
			trackMax(&maxActive, a)
			mu.Lock()
			seen = append(seen, i)
			mu.Unlock()
			arrived <- i
			<-release
			active.Add(-1)
		})
		close(finished)
	}()

	// Barrier: two arrivals prove ≥2 jobs in flight. No sleep — the
	// arrival itself is the evidence, and arriveTimeout only fires on a
	// serialized (broken) pool.
	for k := 0; k < 2; k++ {
		select {
		case <-arrived:
		case <-time.After(arriveTimeout):
			t.Fatalf("pool never ran two jobs concurrently (%d arrival(s) of %d jobs) — runJobs is serialized", k, n)
		}
	}
	close(release)
	released = true

	select {
	case <-finished:
	case <-time.After(arriveTimeout):
		t.Fatal("runJobs never finished after release")
	}

	if m := maxActive.Load(); m < 2 {
		t.Errorf("max concurrent = %d, want ≥2 (the pool must actually parallelize)", m)
	} else if m > workers {
		t.Errorf("max concurrent = %d, want ≤ workers (%d) — the semaphore must bound the pool", m, workers)
	}
	if got := ran.Load(); got != n {
		t.Errorf("ran %d jobs, want %d", got, n)
	}
	mu.Lock()
	sort.Ints(seen)
	mu.Unlock()
	for i := 0; i < n; i++ {
		if i >= len(seen) || seen[i] != i {
			t.Fatalf("indexes run = %v, want each of 0..%d exactly once", seen, n-1)
		}
	}
}

// TestRunJobsSemaphoreBoundsWorkers pins the other half of the
// mechanism: with every worker slot held, NO further job starts — the
// worker count IS the semaphore (and the pool does reach the cap).
func TestRunJobsSemaphoreBoundsWorkers(t *testing.T) {
	const workers, n = 2, 6

	var active, maxActive atomic.Int32
	arrived := make(chan int, n)
	release := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		runJobs(workers, n, func(i int) {
			a := active.Add(1)
			trackMax(&maxActive, a)
			arrived <- i
			<-release
			active.Add(-1)
		})
		close(finished)
	}()

	// Take both worker slots.
	for k := 0; k < workers; k++ {
		select {
		case <-arrived:
		case <-time.After(arriveTimeout):
			t.Fatalf("only %d worker(s) ever started, want the pool to reach its %d-worker cap", k, workers)
		}
	}
	// Both slots are held: a pool that did NOT bound at `workers` would
	// start job 3 right now. Wait a window for a third arrival — its
	// absence is the bound (a working pool never produces one; an
	// unbounded one produces it in microseconds).
	select {
	case i := <-arrived:
		t.Errorf("job %d started while all %d worker slots were held — no semaphore", i, workers)
	case <-time.After(100 * time.Millisecond):
	}
	close(release)

	select {
	case <-finished:
	case <-time.After(arriveTimeout):
		t.Fatal("runJobs never finished after release")
	}
	// The cap must be REACHED, not merely respected (workers=8, n=2
	// would otherwise pass vacuously).
	if m := maxActive.Load(); m != workers {
		t.Errorf("max concurrent = %d, want exactly the cap %d", m, workers)
	}
}

// TestExtractMapPacksRunsMapsConcurrently pins the REAL entry point:
// ExtractMapPacks dispatches its map jobs through the pool, observed
// with the extractJobHook barrier — two maps are in flight inside one
// run before the run is allowed to finish (again, no sleep). Skipped
// on a machine the thread ladder reduces to one worker, where the pool
// is single-threaded BY DESIGN and concurrency is vacuous.
func TestExtractMapPacksRunsMapsConcurrently(t *testing.T) {
	if poolSize() < 2 {
		t.Skipf("poolSize() = %d on this machine — the ladder makes the pool single-threaded here, so concurrency is vacuous", poolSize())
	}
	install := t.TempDir()
	csgo := filepath.Join(install, "game", "csgo")
	if err := os.MkdirAll(csgo, 0o755); err != nil {
		t.Fatal(err)
	}
	const w, h = 8, 8
	radar := buildVTex(t, w, h, vtexFormatBGRA8888, bgraPix(w, h), true)
	files := map[string][]byte{}
	for _, m := range []string{"de_alpha", "de_bravo", "de_charlie", "de_delta"} {
		files["panorama/images/overheadmaps/"+m+"_radar_psd.vtex_c"] = radar
	}
	buildVPK(t, csgo, files)
	out := t.TempDir()

	// Hook installed BEFORE the run starts and restored only AFTER the
	// run returns (the pool has drained by then), so the variable is
	// never written while a worker reads it.
	inflight := make(chan string, 4)
	release := make(chan struct{})
	orig := extractJobHook
	extractJobHook = func(mapName string) {
		inflight <- mapName
		<-release
	}
	defer func() { extractJobHook = orig }()

	type outcome struct {
		maps int
		errs []string
		err  error
	}
	done := make(chan outcome, 1)
	go func() {
		maps, errs, err := ExtractMapPacks(install, out)
		done <- outcome{len(maps), errs, err}
	}()

	for k := 0; k < 2; k++ {
		select {
		case <-inflight:
		case <-time.After(arriveTimeout):
			t.Fatalf("ExtractMapPacks never had two maps in flight (%d arrival(s)) — the entry point is not using the pool", k)
		}
	}
	close(release)

	var got outcome
	select {
	case got = <-done:
	case <-time.After(arriveTimeout):
		t.Fatal("ExtractMapPacks never finished after release")
	}
	if got.err != nil || len(got.errs) > 0 {
		t.Fatalf("extract: err=%v errs=%v", got.err, got.errs)
	}
	if got.maps != 4 {
		t.Errorf("extracted %d maps, want 4", got.maps)
	}
}

// TestExtractMapPacksBudgetSerializesMaps pins the machine-wide work
// token (internal/budget through WithBudget): with budget=1 the per-map
// pool never has two maps inside the token region (hook + extractOne)
// at once, even though poolSize() workers would happily overlap them
// (TestExtractMapPacksRunsMapsConcurrently pins the overlap WITHOUT a
// budget — this test is its bounded twin, so it skips on a
// single-worker machine the same way). The first map parks in the hook
// WHILE HOLDING the only token, so a second arrival inside the window
// would mean the budget is not bounding; after the release every map
// still completes (the bound serializes, never deadlocks).
func TestExtractMapPacksBudgetSerializesMaps(t *testing.T) {
	if poolSize() < 2 {
		t.Skipf("poolSize() = %d on this machine — a one-worker pool serializes regardless of the budget", poolSize())
	}
	install := t.TempDir()
	csgo := filepath.Join(install, "game", "csgo")
	if err := os.MkdirAll(csgo, 0o755); err != nil {
		t.Fatal(err)
	}
	const w, h = 8, 8
	radar := buildVTex(t, w, h, vtexFormatBGRA8888, bgraPix(w, h), true)
	files := map[string][]byte{}
	for _, m := range []string{"de_alpha", "de_bravo", "de_charlie", "de_delta"} {
		files["panorama/images/overheadmaps/"+m+"_radar_psd.vtex_c"] = radar
	}
	buildVPK(t, csgo, files)
	out := t.TempDir()

	// Hook INSIDE the token region (see the pool closure): arrivals are
	// counted, and the first one parks until the test releases — with
	// budget=1 a second arrival while parked is the bound failing.
	var active, maxActive atomic.Int32
	inflight := make(chan string, 4)
	release := make(chan struct{})
	released := false
	defer func() {
		if !released {
			close(release)
		}
	}()
	orig := extractJobHook
	extractJobHook = func(mapName string) {
		trackMax(&maxActive, active.Add(1))
		inflight <- mapName
		<-release
		active.Add(-1)
	}
	defer func() { extractJobHook = orig }()

	type outcome struct {
		maps int
		errs []string
		err  error
	}
	done := make(chan outcome, 1)
	go func() {
		maps, errs, err := ExtractMapPacks(install, out, WithBudget(budget.New(1)))
		done <- outcome{len(maps), errs, err}
	}()

	// First map enters and parks holding the only token.
	select {
	case <-inflight:
	case <-time.After(arriveTimeout):
		t.Fatal("ExtractMapPacks never started a map — the budget=1 run never got its first token")
	}
	// No second map may start while the only token is held (the pool
	// has poolSize() ≥ 2 workers ready — without the budget the second
	// arrival comes in microseconds, per the concurrent test above).
	select {
	case name := <-inflight:
		t.Fatalf("map %q entered while the budget's only token was held — WithBudget is not bounding the pool", name)
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	released = true

	select {
	case got := <-done:
		if got.err != nil || len(got.errs) > 0 {
			t.Fatalf("extract: err=%v errs=%v", got.err, got.errs)
		}
		if got.maps != 4 {
			t.Errorf("extracted %d maps, want 4 (the bound serializes, it must not strand jobs)", got.maps)
		}
	case <-time.After(arriveTimeout):
		t.Fatal("ExtractMapPacks never finished after the release")
	}
	if m := maxActive.Load(); m != 1 {
		t.Errorf("max maps inside the token region = %d, want exactly 1 (budget=1)", m)
	}
}

// TestPoolSizeFollowsThreadLadder pins the worker count to the
// canonical ladder rung: poolSize() == budget.MachineTokens() (the one
// thread-ladder home — Go's execution parallelism, floor 1), never
// below 1. Expected-source swap only (consolidation 2026-11-13): the
// value is identical on this box (GOMAXPROCS(0) == NumCPU == 4).
func TestPoolSizeFollowsThreadLadder(t *testing.T) {
	got := poolSize()
	if want := budget.MachineTokens(); got != want {
		t.Errorf("poolSize() = %d, want budget.MachineTokens() = %d (the ladder's threads rung)", got, want)
	}
	if got < 1 {
		t.Errorf("poolSize() = %d, want ≥1 (the ladder's single-threaded fallback)", got)
	}
	t.Logf("poolSize() = %d (budget.MachineTokens() = %d)", got, budget.MachineTokens())
}
