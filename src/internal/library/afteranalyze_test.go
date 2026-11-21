package library

// The post-analyze hook contract (Options.AfterAnalyze): the job only
// REQUESTS the metric pass, so it never waits on a token it holds, and a
// metric failure the hook returns never fails the job.

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/budget"
	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestAfterAnalyzeErrorDoesNotFailJob: the hook fails, the job still ends
// done, and the hook ran exactly once for the job. A budget of one is
// wired, so a hook that waited on a second token would hang here.
func TestAfterAnalyzeErrorDoesNotFailJob(t *testing.T) {
	var calls atomic.Int32
	im, st := newTestImporterWith(t, Options{
		Parse:  fakeParse,
		Budget: budget.New(1),
		AfterAnalyze: func(ctx context.Context) error {
			calls.Add(1)
			return errors.New("metric boom")
		},
	})
	ids := im.Enqueue([]string{writeDemo(t, "after-analyze.dem", "1")})
	if len(ids) != 1 {
		t.Fatalf("Enqueue returned %d ids, want 1", len(ids))
	}
	job := waitStatus(t, st, ids[0], models.JobDone)
	if job.Error != "" {
		t.Fatalf("job error = %q, want none (a metric failure never fails the import)", job.Error)
	}
	if n := calls.Load(); n != 1 {
		t.Fatalf("AfterAnalyze ran %d times, want 1", n)
	}
}
