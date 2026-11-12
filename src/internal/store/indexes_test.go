package store

import (
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestTier1IndexesPresent pins the Tier 1 index pass: the baseline schema
// (schema.sql, applied whole on every Open) must actually CREATE each
// index — a dropped or renamed statement would silently degrade the
// library-wide reads it exists for (RebuildCareer's per-group subqueries,
// ListPlayers' bot check, the profile's stored trade-opportunity SUM,
// the pending-job lookups) back into full-table scans. Mirrors the
// column-pin pattern in TestColumnListConstsMatchSchema, against
// sqlite_master so the DDL really applied rather than merely being
// present as text.
func TestTier1IndexesPresent(t *testing.T) {
	s := openMem(t)

	want := []string{
		"idx_players_steam",
		"idx_player_stats_steam",
		"idx_player_round_stats_steam",
		"idx_events_kind_match",
		"idx_jobs_path",
		"idx_jobs_match",
		"idx_match_trade_opps_steam",
	}
	for _, name := range want {
		var n int
		err := s.db.QueryRow(
			`SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?`, name,
		).Scan(&n)
		if err != nil {
			t.Fatalf("sqlite_master(%s): %v", name, err)
		}
		if n != 1 {
			t.Errorf("index %s missing from the applied baseline schema", name)
		}
	}
}

// TestListJobsRecentCap: ListJobs is the Library's display list — it must
// return at most the 200 most recent jobs (created_at DESC, id DESC), not
// the whole append-forever history. The table itself is never pruned
// here; trimming history is Tier 2.
func TestListJobsRecentCap(t *testing.T) {
	s := openMem(t)

	const total = 250
	ids := make([]int64, 0, total)
	for i := 0; i < total; i++ {
		id, err := s.CreateJob("import", "/demos/job.dem")
		if err != nil {
			t.Fatalf("CreateJob #%d: %v", i, err)
		}
		if err := s.UpdateJob(id, models.JobDone, models.StageDone, 1, ""); err != nil {
			t.Fatalf("UpdateJob done #%d: %v", i, err)
		}
		ids = append(ids, id)
	}

	jobs, err := s.ListJobs()
	if err != nil {
		t.Fatalf("ListJobs: %v", err)
	}
	if len(jobs) != 200 {
		t.Fatalf("ListJobs len = %d, want 200 (cap)", len(jobs))
	}
	// Newest first: the cap keeps the tail of the insert order, and ids are
	// strictly descending within the returned window.
	for i, j := range jobs {
		if j.ID != ids[total-1-i] {
			t.Fatalf("jobs[%d].ID = %d, want %d (newest first)", i, j.ID, ids[total-1-i])
		}
		if j.Status != models.JobDone {
			t.Fatalf("jobs[%d].Status = %q, want %q", i, j.Status, models.JobDone)
		}
	}
}
