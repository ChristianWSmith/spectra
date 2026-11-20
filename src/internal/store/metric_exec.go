package store

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// Metric execution: THE executor for metric SQL — the background sweep,
// the import-body sweep and the Builder's preview all run their
// statements here, never on the write handle.
//
//   - Read-only connection. The statement runs on a read-only handle
//     (roDSN: mode=ro + query_only), so a slow metric never holds the
//     store's single writer: imports, analysis and the sweep's own value
//     writes keep committing while it runs (WAL readers never block the
//     writer). The handle is the metric path's own pool, separate from
//     the SQL console's single connection, so a long metric does not
//     queue the console and a console statement does not queue a sweep.
//     Unbounded pool: sweeps are serialized by the compute lock, but
//     previews run beside them.
//   - No timeout and no row cap (PRODUCT.md **Power surfaces** — an
//     accepted footgun). The console's limits stay on RunReadOnly.
//   - Cancellation is ctx: the driver interrupts the statement's first
//     step (sqlite3_progress_handler + sqlite3_interrupt — where
//     aggregates, sorts and CTEs run), and every fetched row re-checks
//     ctx. Driver caveat (query_store.go's file doc): stepping AFTER the
//     first row is not interrupted server-side, so a cancel there lands
//     at the next row.
//
// Validation is the shared ValidateReadOnlySQL (defense in depth — the
// connection refuses writes anyway).

// metricROHandles maps a *Store to its metric-path read-only handle
// (the roHandles side-table pattern; CloseRO releases both).
var metricROHandles sync.Map // *Store -> *sql.DB

// QueryMetric executes one metric statement on the metric path's
// read-only handle: every row, no timeout, cancellable through ctx. A
// cancellation returns ctx's error (errors.Is(err, context.Canceled)),
// never a partial result.
func (s *Store) QueryMetric(ctx context.Context, q string, args []any) (ROResult, error) {
	if err := ValidateReadOnlySQL(q); err != nil {
		return ROResult{}, err
	}
	db, err := s.openRO(&metricROHandles, 0)
	if err != nil {
		return ROResult{}, err
	}
	start := time.Now()
	elapsed := func() int64 { return time.Since(start).Milliseconds() }
	fail := func(err error) (ROResult, error) {
		if cerr := ctx.Err(); cerr != nil {
			return ROResult{MS: elapsed()}, cerr
		}
		return ROResult{MS: elapsed()}, fmt.Errorf("couldn't run the query: %w", err)
	}
	rows, err := db.QueryContext(ctx, q, args...)
	if err != nil {
		return fail(err)
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return fail(err)
	}
	out := ROResult{Columns: cols}
	for rows.Next() {
		if cerr := ctx.Err(); cerr != nil {
			return ROResult{MS: elapsed()}, cerr
		}
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return fail(err)
		}
		for i, v := range vals {
			vals[i] = normValue(v)
		}
		out.Rows = append(out.Rows, vals)
	}
	if err := rows.Err(); err != nil {
		return fail(err)
	}
	if cerr := ctx.Err(); cerr != nil {
		return ROResult{MS: elapsed()}, cerr
	}
	out.MS = elapsed()
	return out, nil
}
