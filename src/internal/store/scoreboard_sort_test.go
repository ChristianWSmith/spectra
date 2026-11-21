package store

import (
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestGetScoreboardKDASortKeyRetired pins KDA's exit from the store
// (w13d, owner 2026-11-16): the Go-computed KDA expression died with
// the seeded `kda` metric (adoption means migration — GetScoreboard's
// SELECT alias, its KDA scan field and the `kda` sort key all went with
// it; the scoreboard's KDA column is metric-backed now), so `kda` is an
// UNKNOWN sort key and must fall back to the fixed default (kills DESC)
// exactly like `kd` did when the report read-back retired it
// (dogfooding W4) — never ordering by a ratio.
//
// The fixture stays RATIO-DIVERGENT so a reintroduced alias fails here:
// kills DESC is alice(10), carl(8), bob(5), while the retired
// (kills+assists)/max(deaths,1) order was alice(11), bob(5), carl(4) —
// the two orders differ from the first row on for DESC and invert
// completely for ASC. The `kd` key rides along as the W4-retired twin,
// and `deaths` (a raw-field key the store dropped from the whitelist on
// 2026-11-18, when production's only reachable keys turned out to be
// `kills` and the default — every other column sort moved to the
// frontend's client-side fold / `m:` path) answers the same fallback:
// every unknown name behaves identically. Mirrors
// TestGetScoreboardSorting (store_test.go) with ratio-divergent data.
func TestGetScoreboardKDASortKeyRetired(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/kd-sort.dem", "sha-kd-sort", time.Now())
	em := testExtracted("sha-kd-sort", time.Now())
	em.Players = []models.Player{
		{SteamID: "100", Name: "alice", Side: "ct"},
		{SteamID: "200", Name: "bob", Side: "t"},
		{SteamID: "300", Name: "carl", Side: "ct"},
	}
	em.PlayerStats = []models.PlayerStats{
		// alice: the most kills (kills order → first) but the worst
		// retired ratio — kda (10+100)/10 = 11.0.
		{SteamID: "100", Name: "alice", Side: "ct"},
		// bob: retired kda (5+0)/1 = 5.0.
		{SteamID: "200", Name: "bob", Side: "t"},
		// carl: retired kda (8+0)/2 = 4.0.
		{SteamID: "300", Name: "carl", Side: "ct"},
	}
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	// The kills sort reads the stored kills metric (alice 10, carl 8, bob 5).
	insertSeedMetricValue(t, s, "kills", "100", id, 10, true)
	insertSeedMetricValue(t, s, "kills", "300", id, 8, true)
	insertSeedMetricValue(t, s, "kills", "200", id, 5, true)

	// Every retired key falls back to kills DESC — the desc flag is
	// ignored too (the unknown-key arm fixes both order and direction),
	// so the ASC case must NOT invert into the ratio order.
	wantOrder := []struct {
		sortKey string
		desc    bool
	}{
		{"kda", true},
		{"kda", false},
		{"kd", true},
		{"deaths", true}, // retired raw-field key (2026-11-18) — same fallback
	}
	for _, c := range wantOrder {
		board, err := s.GetScoreboard(id, c.sortKey, c.desc)
		if err != nil {
			t.Fatalf("GetScoreboard(%s, desc=%v): %v", c.sortKey, c.desc, err)
		}
		if len(board) != 3 {
			t.Fatalf("GetScoreboard(%s) rows = %d, want 3", c.sortKey, len(board))
		}
		// kills DESC: alice (10), carl (8), bob (5).
		for i, sid := range []string{"100", "300", "200"} {
			if board[i].SteamID != sid {
				t.Errorf("GetScoreboard(%s, desc=%v) row %d steam = %q, want %q (kills DESC fallback)",
					c.sortKey, c.desc, i, board[i].SteamID, sid)
			}
		}
	}
}
