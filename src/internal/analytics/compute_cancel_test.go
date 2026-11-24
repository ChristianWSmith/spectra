package analytics

import (
	"context"
	"errors"
	"testing"
)

// A pass cancelled before its first write stops at the step boundary: it returns the cancel,
// writes nothing that stamps the rule version, and leaves the match behind.
func TestComputeContextCancelledDoesNotStamp(t *testing.T) {
	st, id := seedStampedMatch(t)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := ComputeContext(ctx, st, id, stampCfg(7))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("ComputeContext(cancelled) err = %v, want context.Canceled", err)
	}
	if v, err := st.GetMatchRuleVersion(id); err != nil || v != 0 {
		t.Fatalf("stamp after a cancelled pass = %d, %v; want 0 (the match stays behind)", v, err)
	}
	// A live context completes the same pass and stamps it: the stopped pass is retryable.
	if err := ComputeContext(context.Background(), st, id, stampCfg(7)); err != nil {
		t.Fatalf("retry: %v", err)
	}
	if v, err := st.GetMatchRuleVersion(id); err != nil || v != 7 {
		t.Fatalf("stamp after retry = %d, %v; want 7", v, err)
	}
}
