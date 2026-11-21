package main

import (
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// The user's cancel, end to end through the service: a cancelled swept
// metric is failed with "cancelled", writes no rows, is HELD (later sweeps
// leave it and its dependents alone), and only saving it computes it again.

// TestListRunningMetricsShowsAndCancels: the running-metrics popup's data —
// a saved metric with a statement in flight is listed by id and name, a
// draft (id 0) is not, and the list empties once the run is released.
func TestListRunningMetricsShowsAndCancels(t *testing.T) {
	f := newSeededFixture(t)
	m := f.save(t, models.MetricRow{Name: "running_probe", Title: "Running probe", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id"})

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
