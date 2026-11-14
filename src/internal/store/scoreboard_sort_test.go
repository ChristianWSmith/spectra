package store

import (
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestGetScoreboardKDASorting pins the ORDER BY decision behind the
// scoreboard's KDA column: scoreboardSort maps "kda" to the bare
// identifier `kda`, which resolves ONLY through GetScoreboard's
// result-column alias (`(kills+assists)/max(deaths,1) AS kda`).
// Without the alias SQLite reports "no such column: kda" and sorting by
// it fails outright — the frontend's KDA header was unusable.
//
// There is NO `kd` case any more: the K/D select/sort key left with the
// report read-back (dogfooding W4 — reports render the stored `kd`
// metric rows, no caller sorts by the Go column). The fixture is built
// so the ratio order differs from the kills order (alice leads on kills
// at 10 but has the worst KDA at (10+100)/10), so a query that
// silently fell back to the map's kills default — or ordered by the
// wrong expression — would put the wrong row first. This must fail on a
// dropped alias AND on a wrong ordering. Mirrors TestGetScoreboardSorting
// (store_test.go) with ratio-divergent data.
func TestGetScoreboardKDASorting(t *testing.T) {
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
		// ratio — kda (10+100)/10 = 11.0.
		{SteamID: "100", Name: "alice", Side: "ct", Kills: 10, Deaths: 10, Assists: 100, RoundsPlayed: 2},
		// bob: kda (5+0)/1 = 5.0.
		{SteamID: "200", Name: "bob", Side: "t", Kills: 5, Deaths: 1, RoundsPlayed: 2},
		// carl: kda (8+0)/2 = 4.0.
		{SteamID: "300", Name: "carl", Side: "ct", Kills: 8, Deaths: 2, RoundsPlayed: 2},
	}
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}

	wantOrder := []struct {
		sortKey string
		desc    bool
		want    []string
	}{
		// kda DESC → alice (11.0), bob (5.0), carl (4.0): differs from
		// the kills order (alice first either way for DESC, but ASC
		// below inverts it), so the kda expression is what ordered.
		{"kda", true, []string{"100", "200", "300"}},
		{"kda", false, []string{"300", "200", "100"}},
	}
	for _, c := range wantOrder {
		board, err := s.GetScoreboard(id, c.sortKey, c.desc)
		if err != nil {
			t.Fatalf("GetScoreboard(%s, desc=%v): %v", c.sortKey, c.desc, err)
		}
		if len(board) != len(c.want) {
			t.Fatalf("GetScoreboard(%s) rows = %d, want %d", c.sortKey, len(board), len(c.want))
		}
		for i, sid := range c.want {
			if board[i].SteamID != sid {
				t.Errorf("GetScoreboard(%s, desc=%v) row %d steam = %q, want %q",
					c.sortKey, c.desc, i, board[i].SteamID, sid)
			}
		}
	}

	// The alias is a result column only — the scanned KDA value stays
	// the computed ratio (floored denominator: alice's 10 deaths
	// divide).
	board, err := s.GetScoreboard(id, "kills", true)
	if err != nil {
		t.Fatalf("GetScoreboard(kills): %v", err)
	}
	if len(board) != 3 {
		t.Fatalf("rows = %d, want 3", len(board))
	}
	alice := board[0]
	if alice.SteamID != "100" {
		t.Fatalf("kills desc first = %q, want alice", alice.SteamID)
	}
	if alice.KDA != 11.0 {
		t.Errorf("alice kda = %v, want 11 ((kills+assists)/max(deaths,1))", alice.KDA)
	}

	// A `kd` sort key is unknown now: it must fall back to the map's
	// fixed default (kills DESC) instead of erroring on a dropped alias.
	byKD, err := s.GetScoreboard(id, "kd", true)
	if err != nil {
		t.Fatalf("GetScoreboard(kd): %v", err)
	}
	stems := make([]string, len(byKD))
	for i, r := range byKD {
		stems[i] = r.SteamID
	}
	if len(byKD) != 3 || byKD[0].SteamID != "100" {
		t.Errorf("kd sort key rows = %v, want the kills DESC fallback (alice first)", stems)
	}
}
