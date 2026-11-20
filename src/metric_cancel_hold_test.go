package main

import (
	"testing"

	"github.com/ChristianWSmith/spectra/internal/metrics"
	"github.com/ChristianWSmith/spectra/internal/models"
)

// The user's cancel, end to end through the service: a cancelled swept
// metric is failed with "cancelled", writes no rows, is HELD (later sweeps
// leave it and its dependents alone), and only saving it computes it again.

// inSweepIDs reports whether id is among the ids a sweep attempted.
func inSweepIDs(ids []int64, id int64) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

func TestCancelledMetricHoldsUntilSaved(t *testing.T) {
	f := newSeededFixture(t)
	target := f.save(t, models.MetricRow{Name: "hold_target", Expr: "from events: count()"})
	dependent := f.save(t, models.MetricRow{Name: "hold_dependent", Expr: "from events: metric('hold_target')"})
	other := f.save(t, models.MetricRow{Name: "hold_other", Expr: "from events: sum(dmg)"})

	if _, err := f.svc.runSweep(t.Context(), nil); err != nil {
		t.Fatalf("first sweep: %v", err)
	}
	if storedRows(t, f.st, target.ID) == 0 || storedRows(t, f.st, dependent.ID) == 0 {
		t.Fatal("target and dependent have no rows after the first sweep")
	}

	// A semantic save makes the target and its dependent behind, so the
	// next sweep has real work to cancel.
	target.Expr = "from events: count(dmg)"
	target = f.save(t, target)

	// Cancel the target while its statement is processing (the cancel lands
	// before or during the statement; either way no insert runs).
	cancelled := false
	res, err := f.svc.runSweep(t.Context(), func(p metrics.SweepProgress) {
		if p.MetricID == target.ID && p.Stage == metrics.StageCompute {
			cancelled = f.svc.CancelMetric(target.ID)
		}
	})
	if err != nil {
		t.Fatalf("cancelling sweep: %v", err)
	}
	if !cancelled {
		t.Fatal("CancelMetric found no running statement for the target")
	}

	// No partial rows: the target is failed with the cancel reason and has
	// nothing stored; its dependent is skipped and empty too.
	if msg := res.Failed[target.ID]; msg != metrics.CancelledReason {
		t.Errorf("target failure = %q, want %q", msg, metrics.CancelledReason)
	}
	if !inSweepIDs(res.Cancelled, target.ID) {
		t.Errorf("SweepResult.Cancelled = %v, want the target", res.Cancelled)
	}
	if n := storedRows(t, f.st, target.ID); n != 0 {
		t.Errorf("target rows = %d after cancel, want 0 (no partial rows)", n)
	}
	if n := storedRows(t, f.st, dependent.ID); n != 0 {
		t.Errorf("dependent rows = %d, want 0", n)
	}

	// The hold is written: the target is held, its dependent is not (it is
	// only blocked), and the unrelated metric still computed.
	held, err := f.st.HeldMetricIDs()
	if err != nil {
		t.Fatal(err)
	}
	if !held[target.ID] {
		t.Errorf("target not held after its cancel: %v", held)
	}
	if held[dependent.ID] {
		t.Error("dependent was held; only the cancelled metric should be")
	}
	if behind, fresh := coverageOf(t, f.st, other.ID); behind || fresh == 0 {
		t.Errorf("unrelated metric coverage = (behind=%v, fresh=%d), want fresh", behind, fresh)
	}

	// The states read the cancel, and the hold keeps that true after a
	// restart (the in-memory failure map is gone; the stored hold is not).
	if s := stateOf(t, f.svc, target.ID); s.State != MetricStateFailed || s.Error != metrics.CancelledReason {
		t.Errorf("target state = %+v, want failed with %q", s, metrics.CancelledReason)
	}
	if s := stateOf(t, f.svc, dependent.ID); s.State != MetricStateBehind {
		t.Errorf("dependent state = %q, want %q", s.State, MetricStateBehind)
	}
	f.svc.errs = nil
	if s := stateOf(t, f.svc, target.ID); s.State != MetricStateFailed || s.Error != metrics.CancelledReason {
		t.Errorf("target state after restart = %+v, want failed with %q", s, metrics.CancelledReason)
	}

	// Background sweeps do not re-run the held metric or its dependent.
	again, err := f.svc.runSweep(t.Context(), nil)
	if err != nil {
		t.Fatalf("sweep after cancel: %v", err)
	}
	if inSweepIDs(again.Attempted, target.ID) || inSweepIDs(again.Attempted, dependent.ID) {
		t.Errorf("a later sweep attempted a held metric or its dependent: %v", again.Attempted)
	}
	if n := storedRows(t, f.st, target.ID); n != 0 {
		t.Errorf("target rows = %d after a later sweep, want 0", n)
	}
	if n := storedRows(t, f.st, dependent.ID); n != 0 {
		t.Errorf("dependent rows = %d after a later sweep, want 0", n)
	}

	// Saving the metric is the trigger: a non-semantic save (a rename)
	// clears the hold and the next sweep computes it and its dependent.
	target.Title = "Target, renamed"
	target = f.save(t, target)
	if held, err := f.st.HeldMetricIDs(); err != nil || held[target.ID] {
		t.Fatalf("saving did not clear the hold (held=%v, err=%v)", held, err)
	}
	saved, err := f.svc.runSweep(t.Context(), nil)
	if err != nil {
		t.Fatalf("sweep after save: %v", err)
	}
	if !inSweepIDs(saved.Succeeded, target.ID) || !inSweepIDs(saved.Succeeded, dependent.ID) {
		t.Errorf("sweep after save succeeded %v, want the target and its dependent", saved.Succeeded)
	}
	if s := stateOf(t, f.svc, target.ID); s.State != MetricStateFresh {
		t.Errorf("target state after save = %+v, want fresh", s)
	}
}

// TestListRunningMetricsShowsAndCancels: the running-metrics popup's data —
// a saved metric with a statement in flight is listed by id and name, a
// draft (id 0) is not, and the list empties once the run is released.
func TestListRunningMetricsShowsAndCancels(t *testing.T) {
	f := newSeededFixture(t)
	m := f.save(t, models.MetricRow{Name: "running_probe", Title: "Running probe", Expr: "from events: count()"})

	if got, err := f.svc.ListRunningMetrics(); err != nil || len(got) != 0 {
		t.Fatalf("idle list = %v, %v; want empty", got, err)
	}

	ctx, release := f.svc.startRun(t.Context(), m.ID)
	_, draftRelease := f.svc.startRun(t.Context(), 0)
	defer draftRelease()

	got, err := f.svc.ListRunningMetrics()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].MetricID != m.ID || got[0].Name != "Running probe" {
		t.Fatalf("running list = %+v, want only the saved metric by its title", got)
	}

	if !f.svc.CancelMetric(m.ID) {
		t.Fatal("CancelMetric found nothing running for the listed metric")
	}
	if ctx.Err() == nil {
		t.Error("cancelling a listed metric did not cancel its run context")
	}
	release()

	got, err = f.svc.ListRunningMetrics()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Errorf("running list after release = %+v, want empty", got)
	}
}
