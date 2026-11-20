package metrics

import (
	"context"
	"errors"
	"testing"
)

// TestRunPreviewCancel: a preview runs on the metric path under its
// context — a cancelled run returns the cancellation and no rows.
func TestRunPreviewCancel(t *testing.T) {
	st := seededStore(t)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	pv, perr, err := RunPreview(ctx, st, Def{Expr: "from events: count()"}, "", 0)
	if perr != nil {
		t.Fatalf("compile: %v", perr)
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if len(pv.Rows) != 0 {
		t.Errorf("cancelled preview returned %d rows", len(pv.Rows))
	}
}

// TestRunPreviewDisplayLimit: the grouped preview shows at most limit
// rows and reports the rest as truncated; the statement itself is not
// capped (the full set computes, the display is cut).
func TestRunPreviewDisplayLimit(t *testing.T) {
	st := seededStore(t)
	full, _, err := RunPreview(t.Context(), st, Def{Expr: "from events: count()"}, "", 100000)
	if err != nil {
		t.Fatalf("full preview: %v", err)
	}
	if full.Truncated || len(full.Rows) < 3 {
		t.Fatalf("full preview = %d rows (truncated %v), want ≥ 3 untruncated", len(full.Rows), full.Truncated)
	}
	cut, _, err := RunPreview(t.Context(), st, Def{Expr: "from events: count()"}, "", 2)
	if err != nil {
		t.Fatalf("limited preview: %v", err)
	}
	if len(cut.Rows) != 2 || !cut.Truncated {
		t.Fatalf("limited preview = %d rows (truncated %v), want 2 truncated", len(cut.Rows), cut.Truncated)
	}
	for i := range cut.Rows {
		if cut.Rows[i] != full.Rows[i] {
			t.Errorf("row %d = %+v, want the full preview's %+v", i, cut.Rows[i], full.Rows[i])
		}
	}
}
