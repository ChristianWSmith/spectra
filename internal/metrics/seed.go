package metrics

import (
	"database/sql"
	_ "embed"
	"fmt"
)

// seedSQL is the committed synthetic corpus (plan §5 — "synthetic match
// corpus committed as tiny SQL seed — no demo bytes"): 3 matches ×
// 8 players × 24 rounds with hand-computable aggregates (formulas in the
// file header). The same loader feeds the metrics fixture/property tests,
// the SQL console tests, and — via the generated variant in perf_test.go —
// the 100-match preview benchmark.
//
//go:embed testdata/seed.sql
var seedSQL string

// SeedSQL returns the committed synthetic corpus as SQL text.
func SeedSQL() string { return seedSQL }

// LoadSeed executes the synthetic corpus into db (one driver script run).
// The store schema must already be applied (store.Open) and db must be
// able to write — loaders open a second short-lived connection next to the
// store handle, which WAL tolerates.
func LoadSeed(db *sql.DB) error {
	if _, err := db.Exec(seedSQL); err != nil {
		return fmt.Errorf("metrics: load seed: %w", err)
	}
	return nil
}
