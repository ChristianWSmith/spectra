package main

import (
	"reflect"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/metrics"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// rawRow is one stored raw row as the tests read it back: the key, the
// value (nil = NULL) and the opaque JSON of the extra columns.
type rawRow struct {
	Match          int64
	Key, Dim, JSON string
	Value          *float64
}

// rawStored reads every stored row of one metric straight from
// metric_values (the internal columns included).
func rawStored(t *testing.T, st *store.Store, metricID int64) []rawRow {
	t.Helper()
	res, err := st.QueryWrite(t.Context(),
		`SELECT match_id, subject_key, dim, value, row_json FROM metric_values WHERE metric_id = ? ORDER BY match_id, subject_key, dim, scope_steam_id, scope_round`,
		[]any{metricID}, 1000)
	if err != nil {
		t.Fatalf("read metric_values: %v", err)
	}
	var out []rawRow
	for _, r := range res.Rows {
		row := rawRow{Match: r[0].(int64), Key: r[1].(string), Dim: r[2].(string), JSON: r[4].(string)}
		if v, ok := r[3].(float64); ok {
			row.Value = &v
		}
		out = append(out, row)
	}
	return out
}

func ruleVersionOf(t *testing.T, st *store.Store) int {
	t.Helper()
	cfg, err := st.GetConfig()
	if err != nil {
		t.Fatal(err)
	}
	return cfg.RuleVersion
}

// TestRawMetricSavesWithTouchedAndRuns: a raw statement saves, its gate's
// touched set is stored, and a sweep writes its three-column result, with
// the extra column kept as JSON.
func TestRawMetricSavesWithTouchedAndRuns(t *testing.T) {
	f := newSeededFixture(t)
	saved := f.save(t, models.MetricRow{
		Name: "raw_humans",
		Expr: "SELECT steam_id AS subject_key, '' AS dim, COUNT(*) AS value, 'tag' AS note\nFROM players WHERE is_bot = 0 GROUP BY steam_id",
	})
	got, err := f.st.GetMetric(saved.ID)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"players"}; !reflect.DeepEqual(got.Touched, want) {
		t.Fatalf("touched = %v, want %v", got.Touched, want)
	}
	res, err := metrics.Sweep(t.Context(), f.st, nil, nil)
	if err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if msg, failed := res.Failed[saved.ID]; failed {
		t.Fatalf("raw metric failed: %s", msg)
	}
	rows := rawStored(t, f.st, saved.ID)
	if len(rows) == 0 {
		t.Fatal("raw metric stored no rows")
	}
	for _, r := range rows {
		// COUNT(*) is the player's rows across the ready matches: at least
		// one, never NULL.
		if r.Value == nil || *r.Value < 1 || r.Dim != "" || r.JSON != `{"note":"tag"}` {
			t.Fatalf("row %+v: want a count >= 1, dim '', extra {\"note\":\"tag\"}", r)
		}
	}
}

// TestRawMetricRefusalWritesNothing: a write statement, an unlisted table,
// a :round without :match_id, mixed career and match binds, a metric()
// reference and two statements are each refused at save, and no row exists.
func TestRawMetricRefusalWritesNothing(t *testing.T) {
	f := newSeededFixture(t)
	refused := map[string]string{
		"write":      "DELETE FROM players",
		"unlisted":   "SELECT 1 AS subject_key, '' AS dim, 1 AS value FROM metrics",
		"round":      "SELECT 1 AS subject_key, '' AS dim, 1 AS value FROM rounds WHERE number = :round",
		"two scopes": "SELECT steam_id AS subject_key, '' AS dim, 1 AS value FROM players WHERE match_id = :match_id AND steam_id = :steam_id",
		"ref":        "SELECT 1 AS subject_key, '' AS dim, 1 AS value FROM players, metric('nope') WHERE 0",
		"two stmts":  "SELECT 1 AS subject_key, '' AS dim, 1 AS value; SELECT 2",
	}
	for name, expr := range refused {
		row := models.MetricRow{Name: "refuse_" + name, Expr: expr, Format: "int"}
		if _, err := f.svc.SaveMetric(row); err == nil {
			t.Errorf("%s: saved %q, want a refusal", name, expr)
		}
		if _, err := f.st.GetMetricByName(row.Name); err == nil {
			t.Errorf("%s: a refused metric row exists", name)
		}
	}
}

// TestRawMissingReservedColumnFails: a result without value fails the run
// with the missing name, and writes nothing.
func TestRawMissingReservedColumnFails(t *testing.T) {
	f := newSeededFixture(t)
	m := f.save(t, models.MetricRow{Name: "raw_no_value", Expr: "SELECT steam_id AS subject_key, '' AS dim, COUNT(*) AS n FROM players"})
	res, err := metrics.Sweep(t.Context(), f.st, nil, nil)
	if err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	msg, failed := res.Failed[m.ID]
	if !failed || !strings.Contains(msg, "missing: value") {
		t.Fatalf("failure = %q (failed %v); want the missing-column message", msg, failed)
	}
	if rows := rawStored(t, f.st, m.ID); len(rows) != 0 {
		t.Fatalf("failed metric kept %d rows", len(rows))
	}
}

// TestRawNullRoundTripsAsNull: a NULL value is stored as NULL, and the
// canonical career read returns it as nil, never 0.
func TestRawNullRoundTripsAsNull(t *testing.T) {
	f := newSeededFixture(t)
	m := f.save(t, models.MetricRow{Name: "raw_null", Expr: "SELECT 'a' AS subject_key, '' AS dim, NULL AS value"})
	if err := metrics.RunRaw(t.Context(), f.st, m.ID, m.Version, ruleVersionOf(t, f.st), m.Expr, store.RawScope{}); err != nil {
		t.Fatalf("RunRaw: %v", err)
	}
	rows := rawStored(t, f.st, m.ID)
	if len(rows) != 1 || rows[0].Value != nil {
		t.Fatalf("rows = %+v, want one NULL value", rows)
	}
	career, err := f.st.GetMetricValuesForPlayer("a", []int64{m.ID})
	if err != nil {
		t.Fatalf("GetMetricValuesForPlayer: %v", err)
	}
	if len(career) != 1 || career[0].Value != nil {
		t.Fatalf("career read = %+v, want one row with a nil value", career)
	}
}

// TestRawMatchScopeReplacesOnlyItsMatch: a :match_id run replaces the rows
// of its own match; the other match's rows are untouched.
func TestRawMatchScopeReplacesOnlyItsMatch(t *testing.T) {
	f := newSeededFixture(t)
	m := f.save(t, models.MetricRow{
		Name: "raw_per_match",
		Expr: "SELECT steam_id AS subject_key, '' AS dim, :match_id AS value FROM players WHERE match_id = :match_id AND is_bot = 0",
	})
	rule := ruleVersionOf(t, f.st)
	ids := readyMatchIDs(t, f.st)
	if len(ids) < 2 {
		t.Fatalf("need two ready matches, have %v", ids)
	}
	one, two := ids[0], ids[1]
	for _, match := range []int64{one, two} {
		if err := metrics.RunRaw(t.Context(), f.st, m.ID, m.Version, rule, m.Expr, store.RawScope{MatchID: match}); err != nil {
			t.Fatalf("RunRaw(match %d): %v", match, err)
		}
	}
	before := rawStored(t, f.st, m.ID)
	oneRows := 0
	for _, r := range before {
		if r.Match == one {
			oneRows++
		}
	}
	if oneRows == 0 || oneRows == len(before) {
		t.Fatalf("expected rows for both matches, got %d of %d for match one", oneRows, len(before))
	}
	// Replace match one's rows with an empty result: match two must keep its.
	if err := f.st.ReplaceRawMetricValues(m.ID, m.Version, rule, store.RawScope{MatchID: one}, nil); err != nil {
		t.Fatalf("replace match one: %v", err)
	}
	after := rawStored(t, f.st, m.ID)
	if len(after) != len(before)-oneRows {
		t.Fatalf("rows = %d, want %d (only match one's removed)", len(after), len(before)-oneRows)
	}
	for _, r := range after {
		if r.Match != two || r.Value == nil || *r.Value != float64(two) {
			t.Fatalf("a row outside match two changed: %+v", r)
		}
	}
}

// TestRawBindNotSuppliedFails: a statement using :match_id, run with no
// match scope, is refused by the run's gate; nothing runs with NULL.
func TestRawBindNotSuppliedFails(t *testing.T) {
	f := newSeededFixture(t)
	m := f.save(t, models.MetricRow{
		Name: "raw_bind_run",
		Expr: "SELECT steam_id AS subject_key, '' AS dim, 1 AS value FROM players WHERE match_id = :match_id",
	})
	err := metrics.RunRaw(t.Context(), f.st, m.ID, m.Version, ruleVersionOf(t, f.st), m.Expr, store.RawScope{})
	if err == nil || !strings.Contains(err.Error(), ":match_id") {
		t.Fatalf("unbound run error = %v, want the unsupplied-bind refusal", err)
	}
	if rows := rawStored(t, f.st, m.ID); len(rows) != 0 {
		t.Fatalf("refused run wrote %d rows", len(rows))
	}
}
