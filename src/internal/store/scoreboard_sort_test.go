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
// completely for ASC. The `kd` key rides along as the W4-retired twin:
// both names answer the same fallback. Mirrors TestGetScoreboardSorting
// (store_test.go) with ratio-divergent data.
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
		{SteamID: "100", Name: "alice", Side: "ct", Kills: 10, Deaths: 10, Assists: 100, RoundsPlayed: 2},
		// bob: retired kda (5+0)/1 = 5.0.
		{SteamID: "200", Name: "bob", Side: "t", Kills: 5, Deaths: 1, RoundsPlayed: 2},
		// carl: retired kda (8+0)/2 = 4.0.
		{SteamID: "300", Name: "carl", Side: "ct", Kills: 8, Deaths: 2, RoundsPlayed: 2},
	}
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}

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
