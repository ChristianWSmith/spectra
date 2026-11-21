package store

import (
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// Write-side freshness (03-QUERIES §4, dogfood/PLAN.md B4): an import, a
// reprocess or a deletion of one match marks behind the metrics whose touched
// set holds a table that write changed. A library-wide metric goes behind as a
// whole; a per-match metric goes behind for that match only.

const libRawSQL = "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE 1 = 0"
const matchesRawSQL = "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM matches WHERE 1 = 0"
const matchRawSQL = "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id"

// rawRunVersion reads the stored metric_version of a per-match raw run record.
func rawRunVersion(t *testing.T, s *Store, metricID, matchID int64) int {
	t.Helper()
	var v int
	if err := s.db.QueryRow(
		`SELECT metric_version FROM metric_runs WHERE metric_id = ? AND match_id = ? AND scope_steam_id = '' AND scope_round = 0`,
		metricID, matchID).Scan(&v); err != nil {
		t.Fatalf("metric_runs(%d, %d): %v", metricID, matchID, err)
	}
	return v
}

func createRaw(t *testing.T, s *Store, name, expr string, touched []string) models.MetricRow {
	t.Helper()
	m, err := s.CreateMetric(models.MetricRow{
		Name: name, Title: name, Scope: "match", Origin: "user",
		Expr: expr, Touched: touched,
	})
	if err != nil {
		t.Fatalf("CreateMetric(%s): %v", name, err)
	}
	return m
}

// (a) A match import marks behind a library-wide raw metric whose touched set
// includes events, and leaves a metric that touches only matches fresh.
func TestImportMarksLibraryMetricBehindByTouchedTable(t *testing.T) {
	s := mustOpenMemory(t)
	cfg, err := s.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	live := cfg.RuleVersion
	seedReadyMatch(t, s, "import-a-1")
	evt := createRaw(t, s, "import_lib_events", libRawSQL, []string{"events"})
	fact := createRaw(t, s, "import_lib_matches", matchesRawSQL, []string{"matches"})
	for _, m := range []models.MetricRow{evt, fact} {
		if err := s.ReplaceRawMetricValues(m.ID, m.Version, live, RawScope{}, nil); err != nil {
			t.Fatalf("ReplaceRawMetricValues(%s): %v", m.Name, err)
		}
	}
	if c := coverageOf(t, s, evt.ID, live); c.Behind {
		t.Fatalf("events metric before import = %+v, want fresh", c)
	}
	newID, err := s.CreateMatchRow("/d/import-a-2.dem", "import-a-2", 1)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	if err := s.SaveExtracted(newID, &models.ExtractedMatch{Events: []models.Event{{Seq: 0, Kind: "kill"}}}); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	if c := coverageOf(t, s, evt.ID, live); !c.Behind {
		t.Fatalf("events metric after import = %+v, want behind", c)
	}
	if c := coverageOf(t, s, fact.ID, live); c.Behind {
		t.Fatalf("matches-only metric after import = %+v, want fresh", c)
	}
}

// (b) A reprocess of match M marks behind M's per-match values only.
func TestReprocessMarksOnlyItsOwnMatchBehind(t *testing.T) {
	s := mustOpenMemory(t)
	cfg, err := s.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	live := cfg.RuleVersion
	m1 := seedReadyMatch(t, s, "reproc-m")
	n1 := seedReadyMatch(t, s, "reproc-n")
	m := createRaw(t, s, "reproc_per_match", matchRawSQL, []string{"events"})
	for _, id := range []int64{m1, n1} {
		if err := s.ReplaceRawMetricValues(m.ID, m.Version, live, RawScope{MatchID: id}, nil); err != nil {
			t.Fatalf("ReplaceRawMetricValues(%d): %v", id, err)
		}
	}
	if err := s.SaveExtracted(m1, &models.ExtractedMatch{Events: []models.Event{{Seq: 0, Kind: "kill"}}}); err != nil {
		t.Fatalf("SaveExtracted(M): %v", err)
	}
	if got := rawRunVersion(t, s, m.ID, n1); got != m.Version {
		t.Fatalf("match N run version = %d, want %d (untouched)", got, m.Version)
	}
	var mRuns int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM metric_runs WHERE metric_id = ? AND match_id = ?`, m.ID, m1).Scan(&mRuns); err != nil {
		t.Fatalf("count: %v", err)
	}
	if mRuns != 0 {
		t.Fatalf("M's run records = %d, want 0 after reprocess", mRuns)
	}
	if c := coverageOf(t, s, m.ID, live); !c.Behind {
		t.Fatalf("after reprocess of M = %+v, want behind (M has no run)", c)
	}
}

// (c) Deleting a match marks behind the library-wide metrics it fed.
func TestDeleteMarksLibraryMetricBehind(t *testing.T) {
	s := mustOpenMemory(t)
	cfg, err := s.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	live := cfg.RuleVersion
	doomed := seedReadyMatch(t, s, "del-c-1")
	seedReadyMatch(t, s, "del-c-2")
	evt := createRaw(t, s, "delete_lib_events", libRawSQL, []string{"events"})
	if err := s.ReplaceRawMetricValues(evt.ID, evt.Version, live, RawScope{}, nil); err != nil {
		t.Fatalf("ReplaceRawMetricValues: %v", err)
	}
	if c := coverageOf(t, s, evt.ID, live); c.Behind {
		t.Fatalf("before delete = %+v, want fresh", c)
	}
	if err := s.DeleteMatchData(doomed); err != nil {
		t.Fatalf("DeleteMatchData: %v", err)
	}
	if c := coverageOf(t, s, evt.ID, live); !c.Behind {
		t.Fatalf("after delete = %+v, want behind", c)
	}
}

// (d) An import of match N does not change a per-match metric's state for an
// unrelated match M.
func TestImportLeavesUnrelatedMatchStateAlone(t *testing.T) {
	s := mustOpenMemory(t)
	cfg, err := s.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	live := cfg.RuleVersion
	m1 := seedReadyMatch(t, s, "unrel-m")
	m := createRaw(t, s, "unrelated_per_match", matchRawSQL, []string{"events"})
	if err := s.ReplaceRawMetricValues(m.ID, m.Version, live, RawScope{MatchID: m1}, nil); err != nil {
		t.Fatalf("ReplaceRawMetricValues: %v", err)
	}
	before := rawRunVersion(t, s, m.ID, m1)
	newID, err := s.CreateMatchRow("/d/unrel-n.dem", "unrel-n", 1)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	if err := s.SaveExtracted(newID, &models.ExtractedMatch{Events: []models.Event{{Seq: 0, Kind: "kill"}}}); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	if after := rawRunVersion(t, s, m.ID, m1); after != before {
		t.Fatalf("unrelated M run version %d -> %d, want unchanged", before, after)
	}
	if got := rawRunVersion(t, s, m.ID, m1); got != m.Version {
		t.Fatalf("unrelated M run version = %d, want current %d", got, m.Version)
	}
}

// Deleting a match leaves a library-wide metric that reads only matches fresh:
// the career rebuild clears only the career values of metrics whose touched
// set holds a table the delete changed.
func TestDeleteLeavesMatchesOnlyLibraryMetricFresh(t *testing.T) {
	s := mustOpenMemory(t)
	cfg, err := s.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	live := cfg.RuleVersion
	doomed := seedReadyMatch(t, s, "del-b-1")
	seedReadyMatch(t, s, "del-b-2")
	fact := createRaw(t, s, "delete_lib_matches", matchesRawSQL, []string{"matches"})
	if err := s.ReplaceRawMetricValues(fact.ID, fact.Version, live, RawScope{}, nil); err != nil {
		t.Fatalf("ReplaceRawMetricValues: %v", err)
	}
	if err := s.DeleteMatchData(doomed); err != nil {
		t.Fatalf("DeleteMatchData: %v", err)
	}
	if c := coverageOf(t, s, fact.ID, live); c.Behind {
		t.Fatalf("matches-only metric after delete = %+v, want fresh", c)
	}
}

// Reprocessing match M (the write, then the analysis rebuild a reprocess runs)
// does not change the state of a career metric whose touched set holds none of
// the changed tables.
func TestReprocessLeavesUntouchedCareerMetricFresh(t *testing.T) {
	s := mustOpenMemory(t)
	cfg, err := s.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	live := cfg.RuleVersion
	m1 := seedReadyMatch(t, s, "reproc-c-m")
	seedReadyMatch(t, s, "reproc-c-n")
	fact := createRaw(t, s, "reproc_career_matches", matchesRawSQL, []string{"matches"})
	if err := s.ReplaceRawMetricValues(fact.ID, fact.Version, live, RawScope{}, nil); err != nil {
		t.Fatalf("ReplaceRawMetricValues: %v", err)
	}
	if err := s.SaveExtracted(m1, &models.ExtractedMatch{Events: []models.Event{{Seq: 0, Kind: "kill"}}}); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	if err := s.RebuildCareerForMatches([]int64{m1}); err != nil {
		t.Fatalf("RebuildCareerForMatches: %v", err)
	}
	if c := coverageOf(t, s, fact.ID, live); c.Behind {
		t.Fatalf("matches-only career metric after reprocess = %+v, want fresh", c)
	}
}
