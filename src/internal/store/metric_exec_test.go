package store

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// parkCtx parks the FIRST Err() call until release closes. The metric
// executors check ctx.Err() once per fetched row, so the first Err()
// lands while the statement is open mid-iteration — a deterministic
// "a metric statement is running right now" point, with no timing
// guess and no slow corpus.
type parkCtx struct {
	context.Context
	once    sync.Once
	parked  chan struct{}
	release chan struct{}
}

func newParkCtx(parent context.Context) *parkCtx {
	return &parkCtx{Context: parent, parked: make(chan struct{}), release: make(chan struct{})}
}

func (c *parkCtx) Err() error {
	c.once.Do(func() {
		close(c.parked)
		<-c.release
	})
	return c.Context.Err()
}

// writeWhileParked starts exec with a parking context, waits until the
// statement is open mid-iteration, then attempts an import-side write
// (CreateMatchRow + CreateJob — the first rows an import commits) and
// reports whether it committed within wait. The statement is released
// before returning either way.
func writeWhileParked(t *testing.T, s *Store, wait time.Duration, exec func(ctx context.Context) error) bool {
	t.Helper()
	ctx := newParkCtx(t.Context())
	execDone := make(chan error, 1)
	go func() { execDone <- exec(ctx) }()
	select {
	case <-ctx.parked:
	case err := <-execDone:
		t.Fatalf("statement finished before parking: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("statement never reached its first row")
	}
	writeDone := make(chan error, 1)
	go func() {
		if _, err := s.CreateMatchRow("/import.dem", "sha-concurrent-write", 1); err != nil {
			writeDone <- err
			return
		}
		_, err := s.CreateJob("import", "/import.dem")
		writeDone <- err
	}()
	committed := false
	select {
	case err := <-writeDone:
		if err != nil {
			t.Fatalf("concurrent write: %v", err)
		}
		committed = true
	case <-time.After(wait):
	}
	close(ctx.release)
	if err := <-execDone; err != nil {
		t.Fatalf("statement: %v", err)
	}
	if !committed {
		if err := <-writeDone; err != nil {
			t.Fatalf("concurrent write (after release): %v", err)
		}
	}
	return committed
}

// manyRowsSQL returns more rows than one, so iteration parks mid-statement.
const manyRowsSQL = `WITH RECURSIVE c(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM c WHERE x < 50) SELECT x FROM c`

// TestQueryWriteHoldsTheWriter pins why metric SQL must not run on the
// write handle: the store's writer is ONE connection, so a statement
// open on it parks every import-side write behind it until it finishes.
func TestQueryWriteHoldsTheWriter(t *testing.T) {
	s := openROFileStore(t)
	committed := writeWhileParked(t, s, 300*time.Millisecond, func(ctx context.Context) error {
		_, err := s.QueryWrite(ctx, manyRowsSQL, nil, 1000)
		return err
	})
	if committed {
		t.Fatal("a write committed while a statement was open on the write handle — the writer is no longer single-connection; revisit the metric execution rationale")
	}
}

// TestQueryMetricDoesNotHoldTheWriter: a metric statement open on the
// metric path's read-only connection leaves the writer free — the
// import-side write commits while the statement is still mid-iteration.
func TestQueryMetricDoesNotHoldTheWriter(t *testing.T) {
	s := openROFileStore(t)
	committed := writeWhileParked(t, s, 5*time.Second, func(ctx context.Context) error {
		_, err := s.QueryMetric(ctx, manyRowsSQL, nil)
		return err
	})
	if !committed {
		t.Fatal("an import-side write waited on an open metric statement — metric SQL is holding the writer")
	}
}

// TestQueryMetricHasNoRowCap: every row comes back — more than the
// console's cap — and nothing is marked truncated.
func TestQueryMetricHasNoRowCap(t *testing.T) {
	s := openROFileStore(t)
	want := DefaultRowLimit*2 + 7
	res, err := s.QueryMetric(t.Context(),
		`WITH RECURSIVE c(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM c WHERE x < ?) SELECT x FROM c`,
		[]any{want})
	if err != nil {
		t.Fatalf("QueryMetric: %v", err)
	}
	if len(res.Rows) != want || res.Truncated {
		t.Fatalf("rows = %d (truncated %v), want all %d rows", len(res.Rows), res.Truncated, want)
	}
}

// TestQueryMetricCancelInterruptsTheStatement: an unbounded statement
// (the recursive-CTE bomb — no timeout exists to stop it) is interrupted
// by cancellation, returns context.Canceled and no rows.
func TestQueryMetricCancelInterruptsTheStatement(t *testing.T) {
	s := openROFileStore(t)
	ctx, cancel := context.WithCancel(t.Context())
	time.AfterFunc(200*time.Millisecond, cancel)
	start := time.Now()
	res, err := s.QueryMetric(ctx,
		`WITH RECURSIVE c(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM c) SELECT COUNT(*) FROM c`, nil)
	el := time.Since(start)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if len(res.Rows) != 0 {
		t.Errorf("cancelled statement returned %d rows, want none", len(res.Rows))
	}
	if el > 2*time.Second {
		t.Errorf("cancel took %s to interrupt the statement", el)
	}
}

// TestQueryMetricIsReadOnly: the shared validator refuses writes before
// execution, and the table is untouched.
func TestQueryMetricIsReadOnly(t *testing.T) {
	s := openROFileStore(t)
	matches, _ := seedROData(t, s)
	for _, q := range []string{"DELETE FROM matches", "UPDATE matches SET map = 'x'", "CREATE TABLE x (y)"} {
		if _, err := s.QueryMetric(t.Context(), q, nil); err == nil {
			t.Errorf("QueryMetric(%q) succeeded, want refusal", q)
		}
	}
	if n := roCount(t, s, "matches"); n != matches {
		t.Errorf("matches = %d after refused writes, want %d", n, matches)
	}
}
