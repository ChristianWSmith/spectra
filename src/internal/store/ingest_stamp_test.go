package store

import (
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// The ingest-owned row stamps (metrics expansion §5): SaveExtracted is
// the ONLY writer of round_economy, round_player_sides and player_stats,
// so their stamps travel with the row — a reprocess re-stamps them and a
// rules bump never rewrites them (match facts, not analysis-rule
// outputs). The team key is the sideparity teamKeyAt vocabulary (the
// team's FINAL side — the same key the Economy view derives client-side
// through frontend sideparity.js), unknown sides resolve to '' (the row
// drops out of team-subject grouping, never a guessed team), won comes
// from models.WinFor over the stored score, and map from the match row.

// stampFixture is a regulation-shaped extract: 24 dense counted rounds,
// one side switch, CT winning 13-10, both sides' economy and freeze-end
// side samples per round, and three players — one per final side plus
// one with no recorded side (the unknown-side exclusion case).
func stampFixture(sha string, at time.Time) *models.ExtractedMatch {
	em := testExtracted(sha, at)
	em.Match.Map = "de_cache"
	em.Match.ScoreCT = 13
	em.Match.ScoreT = 10
	em.Match.SideSwitches = 1
	em.Match.RealRounds = 24
	em.Rounds = nil
	em.RoundEconomy = nil
	em.RoundSides = nil
	for n := 1; n <= 24; n++ {
		em.Rounds = append(em.Rounds, models.Round{
			Number: n, Winner: "ct", StartTick: n * 100, EndTick: n*100 + 90,
			FreezeEndTick: n*100 + 30,
		})
		em.RoundEconomy = append(em.RoundEconomy,
			models.RoundEconomy{Round: n, Side: "ct", EquipValue: 25000, MoneySamples: 5},
			models.RoundEconomy{Round: n, Side: "t", EquipValue: 20000, MoneySamples: 5},
		)
		em.RoundSides = append(em.RoundSides,
			models.RoundPlayerSide{Round: n, SteamID: "100", Side: "ct"},
			models.RoundPlayerSide{Round: n, SteamID: "200", Side: "t"},
		)
	}
	// The unknown-side row: no recorded side ⇒ no team key, ever.
	em.RoundSides = append(em.RoundSides, models.RoundPlayerSide{Round: 1, SteamID: "300", Side: ""})
	em.PlayerStats = []models.PlayerStats{
		{SteamID: "100", Side: "ct", Name: "alice"},
		{SteamID: "200", Side: "t", Name: "bob"},
		{SteamID: "300", Side: "", Name: "sideless"},
	}
	return em
}

// teamKeyForRound is the INDEPENDENT expectation: with one recorded
// switch the flip lands after counted round 12, so rounds 1-12 map the
// ct side to the team that FINISHED t (it opened ct) and rounds 13-24
// map it to the team that finished ct — spelled out here rather than
// recomputed through rules.TeamKeyAt, so a stamp bug and a formula bug
// cannot cancel out.
func teamKeyForRound(side string, round int) string {
	if side != "ct" && side != "t" {
		return ""
	}
	if round >= 13 {
		return side // second half: sides and team keys agree again
	}
	if side == "ct" {
		return "t"
	}
	return "ct"
}

// TestIngestRowStamps pins the three ingest-owned stamps end to end.
func TestIngestRowStamps(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/stamps.dem", "sha-stamps", time.Now())
	em := stampFixture("sha-stamps", time.Now())
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}

	// round_economy: every (round, side) row carries the team behind that
	// round's side — the Economy view's per-team key, stored.
	rows, err := s.db.Query(
		`SELECT round, side, team FROM round_economy WHERE match_id = ? ORDER BY round, side`, id)
	if err != nil {
		t.Fatalf("economy rows: %v", err)
	}
	type econKey struct {
		round int
		side  string
	}
	gotEcon := map[econKey]string{}
	for rows.Next() {
		var round int
		var side, team string
		if err := rows.Scan(&round, &side, &team); err != nil {
			rows.Close()
			t.Fatalf("scan economy row: %v", err)
		}
		gotEcon[econKey{round: round, side: side}] = team
	}
	rows.Close()
	if len(gotEcon) != 48 {
		t.Errorf("economy rows = %d, want 48 (24 rounds × 2 sides)", len(gotEcon))
	}
	for round := 1; round <= 24; round++ {
		for _, side := range []string{"ct", "t"} {
			want := teamKeyForRound(side, round)
			if got := gotEcon[econKey{round: round, side: side}]; got != want {
				t.Errorf("round_economy team (round %d, %s) = %q, want %q", round, side, got, want)
			}
		}
	}

	// round_player_sides: the same key per player-side sample, and the
	// unknown-side row carries NO team (excluded, never guessed).
	sideRows, err := s.db.Query(
		`SELECT round, steam_id, side, team FROM round_player_sides WHERE match_id = ? ORDER BY round, steam_id`, id)
	if err != nil {
		t.Fatalf("side rows: %v", err)
	}
	for sideRows.Next() {
		var round int
		var steam, side, team string
		if err := sideRows.Scan(&round, &steam, &side, &team); err != nil {
			sideRows.Close()
			t.Fatalf("scan side row: %v", err)
		}
		want := teamKeyForRound(side, round)
		if team != want {
			t.Errorf("round_player_sides team (round %d, %s, %s) = %q, want %q",
				round, steam, side, team, want)
		}
	}
	sideRows.Close()

	// player_stats: team is the row's final side as the team key (the
	// final side IS the key under the teamKeyAt vocabulary), won is the
	// 0/1 match result (13-10: CT's players won, T's and the sideless
	// player did not), map is the match row's map — for every row.
	statRows, err := s.db.Query(
		`SELECT steam_id, team, won, map FROM player_stats WHERE match_id = ? ORDER BY steam_id`, id)
	if err != nil {
		t.Fatalf("player_stats rows: %v", err)
	}
	wantStats := map[string]struct {
		team string
		won  int
	}{
		"100": {team: "ct", won: 1},
		"200": {team: "t", won: 0},
		"300": {team: "", won: 0}, // unknown side: no team, never a win
	}
	seen := map[string]bool{}
	for statRows.Next() {
		var steam, team, m string
		var won int
		if err := statRows.Scan(&steam, &team, &won, &m); err != nil {
			statRows.Close()
			t.Fatalf("scan player_stats row: %v", err)
		}
		seen[steam] = true
		want, ok := wantStats[steam]
		if !ok {
			t.Errorf("unexpected player_stats row %q", steam)
			continue
		}
		if team != want.team {
			t.Errorf("player_stats(%s).team = %q, want %q", steam, team, want.team)
		}
		if won != want.won {
			t.Errorf("player_stats(%s).won = %d, want %d (WinFor over 13-10)", steam, won, want.won)
		}
		if m != em.Match.Map {
			t.Errorf("player_stats(%s).map = %q, want %q (the match row's map)", steam, m, em.Match.Map)
		}
	}
	statRows.Close()
	for steam := range wantStats {
		if !seen[steam] {
			t.Errorf("player_stats row %q missing", steam)
		}
	}

	// The hard rule: `rounds` — a row that contains BOTH teams — carries
	// no team column at all, so it can never be stamped.
	cols, err := s.schemaColumns("rounds")
	if err != nil {
		t.Fatalf("schemaColumns(rounds): %v", err)
	}
	for _, c := range cols {
		if c.Name == "team" {
			t.Error("rounds carries a team column — a round row contains both teams")
		}
	}
}

// TestIngestWonStampFollowsWinForResult pins the won stamp's source
// semantics at the two score shapes a tie produces: a drawn match is not
// a win for either side (models.WinFor's rule, restated here as the
// stored column), and a real win flips with the score.
func TestIngestWonStampFollowsWinForResult(t *testing.T) {
	s := openMem(t)
	for _, tc := range []struct {
		name            string
		scoreCT, scoreT int
		wantCT, wantT   int
	}{
		{"ct win", 13, 10, 1, 0},
		{"t win", 8, 13, 0, 1},
		{"tie is not a win", 12, 12, 0, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			id, err := s.CreateMatchRow("/d/won-"+tc.name+".dem", "sha-won-"+tc.name, 1)
			if err != nil {
				t.Fatalf("CreateMatchRow: %v", err)
			}
			em := stampFixture("sha-won-"+tc.name, time.Now())
			em.Match.ScoreCT = tc.scoreCT
			em.Match.ScoreT = tc.scoreT
			em.PlayerStats = []models.PlayerStats{
				{SteamID: "100", Side: "ct", Name: "alice"},
				{SteamID: "200", Side: "t", Name: "bob"},
			}
			if err := s.SaveExtracted(id, em); err != nil {
				t.Fatalf("SaveExtracted: %v", err)
			}
			got := map[string]int{}
			rows, err := s.db.Query(`SELECT steam_id, won FROM player_stats WHERE match_id = ?`, id)
			if err != nil {
				t.Fatalf("player_stats rows: %v", err)
			}
			for rows.Next() {
				var steam string
				var won int
				if err := rows.Scan(&steam, &won); err != nil {
					rows.Close()
					t.Fatalf("scan: %v", err)
				}
				got[steam] = won
			}
			rows.Close()
			if got["100"] != tc.wantCT || got["200"] != tc.wantT {
				t.Errorf("won ct/t = %d/%d, want %d/%d (score %d-%d)",
					got["100"], got["200"], tc.wantCT, tc.wantT, tc.scoreCT, tc.scoreT)
			}
		})
	}
}
