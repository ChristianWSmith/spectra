package integration_test

// Snapshot sameness: the metric corpus recomputed against a real library.
//
// Set SPECTRA_SNAPSHOT_DB to a copy of a library's spectra.db (the WAL and
// SHM beside it are copied too). The test copies that library, deletes its
// stored metric values, recomputes every metric through the real sweep, and
// compares the recomputed rows with the rows the snapshot stored before the
// run. Any difference fails the test. The copy is what gets written, so the
// source library is only read.
//
// Set SPECTRA_SAMENESS_OUT to also write the recomputed rows as JSON, so two
// code states can be diffed on disk. Skipped when SPECTRA_SNAPSHOT_DB is
// unset, and in -short mode.

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/metrics"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// sameRow is one stored metric row, keyed by everything that addresses it.
type sameRow struct {
	Metric   string   `json:"metric"`
	MatchID  int64    `json:"match_id"`
	Subject  string   `json:"subject_key"`
	Dim      string   `json:"dim"`
	ScopeID  string   `json:"scope_steam_id"`
	Round    int64    `json:"scope_round"`
	Value    *float64 `json:"value"`
	ValueKey string   `json:"value_key"`
	RowJSON  string   `json:"row_json"`
}

func (r sameRow) key() string {
	return fmt.Sprintf("%s|%d|%s|%s|%s|%d", r.Metric, r.MatchID, r.Subject, r.Dim, r.ScopeID, r.Round)
}

func sameCopy(t *testing.T, src, dst string) {
	t.Helper()
	for _, suffix := range []string{"", "-wal", "-shm"} {
		in, err := os.Open(src + suffix)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			t.Fatalf("open %s: %v", src+suffix, err)
		}
		out, err := os.Create(dst + suffix)
		if err != nil {
			_ = in.Close()
			t.Fatalf("create %s: %v", dst+suffix, err)
		}
		if _, err := io.Copy(out, in); err != nil {
			t.Fatalf("copy %s: %v", src+suffix, err)
		}
		_ = in.Close()
		if err := out.Close(); err != nil {
			t.Fatalf("close %s: %v", dst+suffix, err)
		}
	}
}

// sameDump reads every stored metric row of the database at path.
func sameDump(t *testing.T, path string) map[string]sameRow {
	t.Helper()
	db, err := sql.Open("sqlite", path+"?mode=ro&_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer func() { _ = db.Close() }()
	rows, err := db.Query(`SELECT m.name, mv.match_id, mv.subject_key, mv.dim,
		mv.scope_steam_id, mv.scope_round, mv.value, mv.value_key, mv.row_json
		FROM metric_values mv JOIN metrics m ON m.id = mv.metric_id`)
	if err != nil {
		t.Fatalf("query metric_values: %v", err)
	}
	defer func() { _ = rows.Close() }()
	out := map[string]sameRow{}
	for rows.Next() {
		var r sameRow
		var v sql.NullFloat64
		if err := rows.Scan(&r.Metric, &r.MatchID, &r.Subject, &r.Dim, &r.ScopeID, &r.Round,
			&v, &r.ValueKey, &r.RowJSON); err != nil {
			t.Fatalf("scan metric_values: %v", err)
		}
		if v.Valid {
			x := v.Float64
			r.Value = &x
		}
		out[r.key()] = r
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate metric_values: %v", err)
	}
	return out
}

func sameClose(a, b *float64) bool {
	if a == nil || b == nil {
		return a == b
	}
	if *a == *b {
		return true
	}
	return math.Abs(*a-*b) <= 1e-9*math.Max(1, math.Max(math.Abs(*a), math.Abs(*b)))
}

func TestSnapshotMetricSameness(t *testing.T) {
	src := os.Getenv("SPECTRA_SNAPSHOT_DB")
	if src == "" {
		t.Skip("SPECTRA_SNAPSHOT_DB unset")
	}
	if testing.Short() {
		t.Skip("skipping snapshot recompute in -short mode")
	}

	before := sameDump(t, src)
	dir := t.TempDir()
	dst := filepath.Join(dir, "spectra.db")
	sameCopy(t, src, dst)

	// Apply the builtin seed text of THIS code state to the copy. Seeds are
	// INSERT OR IGNORE, so an existing library keeps its old text; the harness
	// reads the current text from a fresh store and writes it onto the copy, so
	// a changed builtin statement is what gets recomputed.
	sameRefreshBuiltins(t, dir, dst)

	// Mark every stored value behind (bump every metric's version),
	// then recompute them all through the sweep.
	raw, err := sql.Open("sqlite", dst+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("open copy: %v", err)
	}
	// A metric is behind when a stored row was stamped under an older metrics.version
	// (metric_values.metric_version < metrics.version, MetricCoverage). Bumping every
	// definition's version marks all stored values behind, so the sweep recomputes all of
	// them; setting the stamps to 0 would leave metrics at version 0 untouched.
	if _, err := raw.Exec(`UPDATE metrics SET version = version + 1`); err != nil {
		t.Fatalf("mark metrics behind: %v", err)
	}
	_ = raw.Close()

	st, err := store.Open(dst)
	if err != nil {
		t.Fatalf("store.Open copy: %v", err)
	}
	res, err := metrics.Sweep(context.Background(), st, nil, nil)
	if err != nil {
		_ = st.Close()
		t.Fatalf("metrics.Sweep: %v", err)
	}
	// A metric that failed to compute is a difference too: its rows may be gone or
	// stale, and the comparison below would not say which.
	for id, reason := range res.Failed {
		t.Errorf("metric %d failed to compute: %s", id, reason)
	}
	_ = st.CloseRO()
	_ = st.Close()

	after := sameDump(t, dst)
	if out := os.Getenv("SPECTRA_SAMENESS_OUT"); out != "" {
		keys := make([]string, 0, len(after))
		for k := range after {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		rows := make([]sameRow, 0, len(keys))
		for _, k := range keys {
			rows = append(rows, after[k])
		}
		b, err := json.MarshalIndent(rows, "", " ")
		if err != nil {
			t.Fatalf("marshal dump: %v", err)
		}
		if err := os.WriteFile(out, b, 0o600); err != nil {
			t.Fatalf("write dump: %v", err)
		}
	}

	var diffs []string
	for k, want := range before {
		got, ok := after[k]
		switch {
		case !ok:
			diffs = append(diffs, "missing  "+k)
		case !sameClose(want.Value, got.Value) || want.ValueKey != got.ValueKey || want.RowJSON != got.RowJSON:
			diffs = append(diffs, fmt.Sprintf("changed  %s stored=%v recomputed=%v", k, fmtVal(want.Value), fmtVal(got.Value)))
		}
	}
	for k := range after {
		if _, ok := before[k]; !ok {
			diffs = append(diffs, "extra    "+k)
		}
	}
	sort.Strings(diffs)
	t.Logf("rows stored=%d recomputed=%d differences=%d", len(before), len(after), len(diffs))
	for i, d := range diffs {
		if i >= 60 {
			t.Errorf("... %d more differences", len(diffs)-i)
			break
		}
		t.Error(d)
	}
}

func fmtVal(v *float64) string {
	if v == nil {
		return "NULL"
	}
	return fmt.Sprintf("%.12g", *v)
}

// sameRefreshBuiltins copies the seeded builtin metric text (expr, title,
// format, doc) of a fresh store into the library copy at dst, by name.
func sameRefreshBuiltins(t *testing.T, dir, dst string) {
	t.Helper()
	fresh, err := store.Open(filepath.Join(dir, "fresh.db"))
	if err != nil {
		t.Fatalf("open fresh store: %v", err)
	}
	rows, err := fresh.ListMetrics()
	_ = fresh.CloseRO()
	_ = fresh.Close()
	if err != nil {
		t.Fatalf("list fresh metrics: %v", err)
	}
	raw, err := sql.Open("sqlite", dst+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("open copy: %v", err)
	}
	defer func() { _ = raw.Close() }()
	for _, m := range rows {
		if m.Origin != "builtin" {
			continue
		}
		if _, err := raw.Exec(`UPDATE metrics SET expr = ?, title = ?, format = ?, doc = ? WHERE name = ? AND origin = 'builtin'`,
			m.Expr, m.Title, m.Format, m.Doc, m.Name); err != nil {
			t.Fatalf("refresh builtin %s: %v", m.Name, err)
		}
	}
}
