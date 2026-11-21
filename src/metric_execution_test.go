package main

import (
	"context"
	"errors"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/metrics"
	"github.com/ChristianWSmith/spectra/internal/models"
)

// The metric execution path at the service level: metric SQL runs on the
// read-only connection during a sweep (a concurrent import-side write is
// never parked behind it), and a cancelled metric fails with "cancelled"
// and writes no rows, while a cancelled SWEEP leaves its metric behind.

// stmtParkCtx parks the first Err() call made from inside
// store.QueryMetric's row loop until release closes — a deterministic
// "this metric's statement is open on the metric connection right now"
// point. A sweep that ran its SQL anywhere else never parks.
type stmtParkCtx struct {
	context.Context
	once    sync.Once
	parked  chan struct{}
	release chan struct{}
}

// newStmtParkCtx returns an unparented park context: parkingRuns sets
// its parent (the run's registered context) when the metric starts.
func newStmtParkCtx() *stmtParkCtx {
	return &stmtParkCtx{parked: make(chan struct{}), release: make(chan struct{})}
}

func (c *stmtParkCtx) Err() error {
	pc, _, _, ok := runtime.Caller(1)
	if ok && strings.HasSuffix(runtime.FuncForPC(pc).Name(), "store.(*Store).QueryMetric") {
		c.once.Do(func() {
			close(c.parked)
			<-c.release
		})
	}
	return c.Context.Err()
}

// parkingRuns wraps the service's run registry: target's statement runs
// under a stmtParkCtx, every other metric under its plain run context.
func parkingRuns(svc *MetricsService, target int64, park *stmtParkCtx) metrics.MetricContext {
	return func(parent context.Context, id int64) (context.Context, context.CancelFunc) {
		ctx, release := svc.startRun(parent, id)
		if id != target {
			return ctx, release
		}
		park.Context = ctx
		return park, release
	}
}

// TestSweepMetricDoesNotBlockConcurrentWrite: while a sweep's metric
// statement is open mid-iteration, an import-side write (a match row
// and its job — the first rows an import commits) commits at once.
func TestSweepMetricDoesNotBlockConcurrentWrite(t *testing.T) {
	f := newSeededFixture(t)
	m := f.save(t, models.MetricRow{Name: "exec_open_statement", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id"})

	park := newStmtParkCtx()
	sweepDone := make(chan error, 1)
	var res metrics.SweepResult
	go func() {
		var err error
		res, err = metrics.Sweep(t.Context(), f.st, nil, parkingRuns(f.svc, m.ID, park))
		sweepDone <- err
	}()
	select {
	case <-park.parked:
	case err := <-sweepDone:
		t.Fatalf("sweep finished without the metric's statement opening on the metric connection (err %v)", err)
	case <-time.After(15 * time.Second):
		t.Fatal("the metric's statement never opened")
	}

	writeDone := make(chan error, 1)
	go func() {
		if _, err := f.st.CreateMatchRow("/import/concurrent.dem", "sha-concurrent-import", 1); err != nil {
			writeDone <- err
			return
		}
		_, err := f.st.CreateJob("import", "/import/concurrent.dem")
		writeDone <- err
	}()
	select {
	case err := <-writeDone:
		if err != nil {
			t.Fatalf("concurrent write: %v", err)
		}
	case <-time.After(5 * time.Second):
		close(park.release)
		if err := <-sweepDone; err != nil {
			t.Logf("sweep: %v", err)
		}
		t.Fatal("an import-side write waited on a running metric statement — metric SQL is holding the writer")
	}

	close(park.release)
	if err := <-sweepDone; err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if msg, failed := res.Failed[m.ID]; failed {
		t.Fatalf("metric failed: %s", msg)
	}
	if storedRows(t, f.st, m.ID) == 0 {
		t.Error("metric stored no rows after its statement was released")
	}
}

// TestCancelMetricMidStatement: CancelMetric on a metric whose statement
// is open interrupts it — the metric FAILS with "cancelled" (the state
// word is pinned by TestCancelMetricThroughTheService), has no rows
// (its earlier rows were removed and nothing new was written), its
// dependent is skipped, and an unrelated metric still computes.
func TestCancelMetricMidStatement(t *testing.T) {
	f := newSeededFixture(t)
	target := f.save(t, models.MetricRow{Name: "exec_cancel_target", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id"})
	other := f.save(t, models.MetricRow{Name: "exec_cancel_other", Expr: "SELECT '' AS subject_key, '' AS dim, SUM(dmg) AS value FROM events WHERE match_id = :match_id"})

	// First sweep: everything fresh, so the cancel has old rows to lose.
	if _, err := f.svc.runSweep(t.Context(), nil); err != nil {
		t.Fatalf("first sweep: %v", err)
	}
	if storedRows(t, f.st, target.ID) == 0 {
		t.Fatal("target has no rows after the first sweep")
	}
	// Re-save target semantically: it and its dependent go behind.
	target.Expr = "SELECT '' AS subject_key, '' AS dim, COUNT(dmg) AS value FROM events WHERE match_id = :match_id"
	target = f.save(t, target)

	if f.svc.CancelMetric(target.ID) {
		t.Error("CancelMetric reported a run before anything was running")
	}

	park := newStmtParkCtx()
	sweepDone := make(chan error, 1)
	var res metrics.SweepResult
	go func() {
		var err error
		res, err = metrics.Sweep(t.Context(), f.st, nil, parkingRuns(f.svc, target.ID, park))
		sweepDone <- err
	}()
	select {
	case <-park.parked:
	case err := <-sweepDone:
		t.Fatalf("sweep finished before the target's statement opened (err %v)", err)
	case <-time.After(15 * time.Second):
		t.Fatal("the target's statement never opened")
	}
	if !f.svc.CancelMetric(target.ID) {
		t.Error("CancelMetric found no running statement for the target")
	}
	close(park.release)
	if err := <-sweepDone; err != nil {
		t.Fatalf("sweep returned %v — a metric cancel must not cancel the sweep", err)
	}

	if msg := res.Failed[target.ID]; msg != metrics.CancelledReason {
		t.Errorf("target failure = %q, want %q", msg, metrics.CancelledReason)
	}
	if n := storedRows(t, f.st, target.ID); n != 0 {
		t.Errorf("target rows = %d after cancel, want 0 (no partial rows)", n)
	}
	if behind, fresh := coverageOf(t, f.st, other.ID); behind || fresh == 0 {
		t.Errorf("unrelated metric coverage = (behind=%v, fresh=%d), want fresh", behind, fresh)
	}
}

// TestCancelMetricThroughTheService: the user's cancel through the
// service's own sweep — issued while the metric is processing, it lands
// before the statement starts; the state reads failed "cancelled", no
// rows exist, and the next sweep computes it again.
func TestCancelMetricThroughTheService(t *testing.T) {
	f := newSeededFixture(t)
	m := f.save(t, models.MetricRow{Name: "exec_service_cancel", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id"})

	cancelled := false
	res, err := f.svc.runSweep(t.Context(), func(p metrics.SweepProgress) {
		if p.MetricID == m.ID && p.Stage == metrics.StageCompute {
			cancelled = f.svc.CancelMetric(m.ID)
		}
	})
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if !cancelled {
		t.Fatal("CancelMetric found no running statement while the metric was processing")
	}
	if msg := res.Failed[m.ID]; msg != metrics.CancelledReason {
		t.Errorf("failure = %q, want %q", msg, metrics.CancelledReason)
	}
	if n := storedRows(t, f.st, m.ID); n != 0 {
		t.Errorf("rows = %d after cancel, want 0", n)
	}
	if s := stateOf(t, f.svc, m.ID); s.State != MetricStateFailed || s.Error != metrics.CancelledReason {
		t.Errorf("state = %+v, want failed with %q", s, metrics.CancelledReason)
	}
	if f.svc.CancelMetric(m.ID) {
		t.Error("a finished run is still registered as running")
	}

	// A cancelled metric does not re-run on its own: the next sweep leaves
	// it held (still failed, still no rows). Only saving it computes it
	// again — TestCancelledMetricHoldsUntilSaved pins that.
	retry, err := f.svc.runSweep(t.Context(), nil)
	if err != nil {
		t.Fatalf("retry sweep: %v", err)
	}
	for _, id := range retry.Attempted {
		if id == m.ID {
			t.Errorf("the next sweep re-ran the cancelled metric (attempted %v)", retry.Attempted)
		}
	}
	if n := storedRows(t, f.st, m.ID); n != 0 {
		t.Errorf("rows = %d after the retry sweep, want 0", n)
	}
	if s := stateOf(t, f.svc, m.ID); s.State != MetricStateFailed || s.Error != metrics.CancelledReason {
		t.Errorf("state after retry = %+v, want failed with %q", s, metrics.CancelledReason)
	}
}

// TestSweepCancelLeavesMetricBehind pins the other cancellation: the
// SWEEP's context (a cancelled import job, shutdown) interrupts the
// running metric, which is NOT failed — it has no rows and reads behind,
// so the next sweep resumes it.
func TestSweepCancelLeavesMetricBehind(t *testing.T) {
	f := newSeededFixture(t)
	m := f.save(t, models.MetricRow{Name: "exec_sweep_cancel", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id"})

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	res, err := f.svc.runSweep(ctx, func(p metrics.SweepProgress) {
		if p.MetricID == m.ID && p.Stage == metrics.StageCompute {
			cancel()
		}
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("sweep err = %v, want context.Canceled", err)
	}
	if _, failed := res.Failed[m.ID]; failed {
		t.Errorf("an interrupted sweep marked the metric failed: %q", res.Failed[m.ID])
	}
	if n := storedRows(t, f.st, m.ID); n != 0 {
		t.Errorf("rows = %d after an interrupted sweep, want 0", n)
	}
	if s := stateOf(t, f.svc, m.ID); s.State != MetricStateBehind {
		t.Errorf("state = %q, want %q", s.State, MetricStateBehind)
	}
}
