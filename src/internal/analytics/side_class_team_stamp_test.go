package analytics

// The analyze-time team stamp (metrics expansion §5): round_side_classes
// is a side-grained row written ONLY by Compute, so its team key lands
// beside the class that owns it — the rule-stamp convention (stored at
// analyze time, rules bump ⇒ recompute). The key is the sideparity
// teamKeyAt vocabulary (the team's FINAL side): with one recorded switch
// the ct side of rounds 1-12 belongs to the team that finished t and the
// ct side of rounds 13+ to the team that finished ct — the exact key the
// Economy view derives client-side, so the stored stamp and the view can
// never disagree. Unknown sides carry '' (excluded from team-subject
// grouping, never a guessed team), and `rounds` — a row containing BOTH
// teams — is never stamped (pinned by the ingest stamp test).

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// sideClassTeamFixture is a regulation-shaped extract: 24 dense counted
// rounds with both sides' freeze-end economy, one recorded side switch,
// and a two-player roster. Classes themselves are not this test's
// subject — every round classifies as a full buy at the seeded
// thresholds, so every (round, side) row exists to carry a team key.
func sideClassTeamFixture() *models.ExtractedMatch {
	em := &models.ExtractedMatch{
		Match: models.Match{
			Path: "/d/side-team.dem", SHA256: "sha-side-team", Size: 1,
			Map: "de_cache", TickRate: 64, RealRounds: 24,
			ScoreCT: 13, ScoreT: 10, SideSwitches: 1,
			ParserVersion: "v6", ExtractedAt: time.Now(),
		},
		Players: []models.Player{
			{SteamID: "100", Name: "alice", Side: "ct", FinalStatePresent: true},
			{SteamID: "200", Name: "bob", Side: "t", FinalStatePresent: true},
		},
		PlayerStats: []models.PlayerStats{
			{SteamID: "100", Side: "ct", Name: "alice"},
			{SteamID: "200", Side: "t", Name: "bob"},
		},
	}
	for n := 1; n <= 24; n++ {
		em.Rounds = append(em.Rounds, models.Round{
			Number: n, Winner: "ct", StartTick: n * 1000, EndTick: n*1000 + 999,
			FreezeEndTick: n*1000 + 32, EquipCT: 25000, EquipT: 20000,
		})
		em.RoundEconomy = append(em.RoundEconomy,
			models.RoundEconomy{Round: n, Side: "ct", EquipValue: 25000, MoneySamples: 5},
			models.RoundEconomy{Round: n, Side: "t", EquipValue: 20000, MoneySamples: 5},
		)
	}
	return em
}

// TestComputeStampsSideClassTeams pins the Compute-side team stamp: both
// sides of every counted round carry the teamKeyAt key of that round's
// side — the half flip at counted round 13 included — and the value is
// read back from the STORED row (the stamp's whole point), not from a
// derivation the test re-runs.
func TestComputeStampsSideClassTeams(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "side-team.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	cfg := ecoCfg(20000, 10000)
	if _, err := st.SetConfig(cfg); err != nil {
		t.Fatalf("SetConfig: %v", err)
	}
	id, err := st.CreateMatchRow("/d/side-team.dem", "sha-side-team", 1)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	if err := st.SaveExtracted(id, sideClassTeamFixture()); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	if err := Compute(st, id, ConfigFrom(cfg, 0)); err != nil {
		t.Fatalf("Compute: %v", err)
	}

	res, err := st.RunReadOnly(
		`SELECT round, side, team FROM round_side_classes WHERE match_id = ? ORDER BY round, side`,
		[]any{id}, 64, 5000)
	if err != nil {
		t.Fatalf("read side classes: %v", err)
	}
	if len(res.Rows) != 48 {
		t.Fatalf("round_side_classes rows = %d, want 48 (24 rounds × 2 sides)", len(res.Rows))
	}
	for _, row := range res.Rows {
		round := int(row[0].(int64))
		side := row[1].(string)
		team := row[2].(string)
		// Independent expectation: one switch flips after counted round
		// 12 — before it the ct side belongs to the team that FINISHED t,
		// from round 13 on the mapping is the identity.
		want := side
		if round < 13 {
			if side == "ct" {
				want = "t"
			} else {
				want = "ct"
			}
		}
		if team != want {
			t.Errorf("round_side_classes team (round %d, %s) = %q, want %q", round, side, team, want)
		}
	}
}
