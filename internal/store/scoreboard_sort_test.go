package store

import (
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestGetScoreboardKDAndKDASorting pins the ORDER BY decision behind the
// scoreboard's K/D and KDA columns: scoreboardSort maps "kd"/"kda" to the
// bare identifiers `kd`/`kda`, which resolve ONLY through GetScoreboard's
// result-column aliases (`kdPerMatchSQL AS kd` and
// `(kills+assists)/max(deaths,1) AS kda`). Without the aliases SQLite
// reports "no such column: kd" and sorting by either column fails
// outright — the frontend's K/D and KDA headers were unusable.
//
// The fixture is built so the ratio orders differ from the kills order
// (alice leads on kills at 10 but has the worst K/D at 10/10), so a query
// that silently fell back to the map's kills default — or ordered by the
// wrong expression — would put the wrong row first. This must fail on a
// dropped alias AND on a wrong ordering. Mirrors TestGetScoreboardSorting
// (store_test.go) with ratio-divergent data.
func TestGetScoreboardKDAndKDASorting(t *testing.T) {
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
		// ratios — kd 10/10 = 1.0, kda (10+100)/10 = 11.0.
		{SteamID: "100", Name: "alice", Side: "ct", Kills: 10, Deaths: 10, Assists: 100, RoundsPlayed: 2},
		// bob: kd 5/1 = 5.0 (best), kda (5+0)/1 = 5.0.
		{SteamID: "200", Name: "bob", Side: "t", Kills: 5, Deaths: 1, RoundsPlayed: 2},
		// carl: kd 8/2 = 4.0, kda (8+0)/2 = 4.0.
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
		// kd DESC → bob (5.0), carl (4.0), alice (1.0): NOT the kills
		// order (alice first), so the kd expression is what ordered.
		{"kd", true, []string{"200", "300", "100"}},
		{"kd", false, []string{"100", "300", "200"}},
		// kda DESC → alice (11.0), bob (5.0), carl (4.0): differs from
		// both the kills order and the kd order above.
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

	// The aliases are result columns only — the scanned KD/KDA values stay
	// the computed ratios (floored denominator: alice's 10 deaths divide).
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
	if alice.KD != 1.0 || alice.KDA != 11.0 {
		t.Errorf("alice kd/kda = %v/%v, want 1/11 (kdPerMatchSQL, (kills+assists)/max(deaths,1))",
			alice.KD, alice.KDA)
	}
}
