package store

// Profile read-model queries: the Sides card's per-round side splits and
// the history row's freeze-end start side. Each pins the decisions its
// doc comment states — no side/proximity/round guess ever produces a
// value. (The counters that used to live here followed their cards into
// the metric reads: GetPlayerMatchAverages in dogfooding W3 and the
// Trade rate's library-wide opportunity denominator,
// CountPlayerTradeOpportunities, in W4 — the cards read career_*/trade
// metric rows now.)

import (
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestGetPlayerSideSplits: rows come from player_round_stats ⋈ that
// round's freeze-end side sample ⋈ the round's winner — a round with no
// rounds row is dropped even with side samples and player rows
// present (the extract discard means knife/warmup rounds never store a
// row; the fixture's rounds 0 and 2 stand in), a counted round with no
// side sample yields NO row (unknown →
// skipped, never guessed), and ADR/KAST are the round-level sums/means
// (player_round_stats.dmg ÷ rounds, 100 × AVG(kast)).
func TestGetPlayerSideSplits(t *testing.T) {
	s := openMem(t)
	id, err := s.CreateMatchRow("/d/sides.dem", "sha-sides", 7)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	em := testExtracted("sha-sides", time.Now())
	// testExtracted already has round 1 (counted, winner ct). Add a
	// second counted round won by T and a third counted round with NO
	// side sample for the player.
	em.Rounds = append(em.Rounds,
		models.Round{Number: 3, Winner: "t"},
		models.Round{Number: 4, Winner: "ct"},
	)
	em.RoundSides = append(em.RoundSides,
		models.RoundPlayerSide{Round: 0, SteamID: "100", Side: "ct"}, // no rounds row
		models.RoundPlayerSide{Round: 2, SteamID: "100", Side: "ct"}, // no rounds row
		models.RoundPlayerSide{Round: 3, SteamID: "100", Side: "t"},
		// round 4: deliberately no sample for 100.
	)
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	if err := s.ReplacePlayerRounds(id, []models.PlayerRoundStat{
		{Round: 0, SteamID: "100", Name: "alice", Kills: 9, Deaths: 9, DMG: 999, KAST: true},
		{Round: 1, SteamID: "100", Name: "alice", Kills: 5, Deaths: 1, DMG: 300, KAST: true},
		{Round: 2, SteamID: "100", Name: "alice", Kills: 7, Deaths: 7, DMG: 777, KAST: true},
		{Round: 3, SteamID: "100", Name: "alice", Kills: 2, Deaths: 0, DMG: 100, KAST: false},
		{Round: 4, SteamID: "100", Name: "alice", Kills: 4, Deaths: 4, DMG: 444, KAST: true},
	}); err != nil {
		t.Fatalf("ReplacePlayerRounds: %v", err)
	}

	rows, err := s.GetPlayerSideSplits("100")
	if err != nil {
		t.Fatalf("GetPlayerSideSplits: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("splits = %+v, want exactly the ct and t rows", rows)
	}
	ct, tr := rows[0], rows[1]
	if ct.Side != "ct" || tr.Side != "t" {
		t.Fatalf("sides = %q/%q, want ct/t (ordered)", ct.Side, tr.Side)
	}
	// ct: only round 1 (the fixture's round-0/round-2 side samples have
	// no rounds row and drop out; round 4 has no side sample). Winner ct
	// → 1 round win.
	if ct.Rounds != 1 || ct.Wins != 1 || ct.Kills != 5 || ct.Deaths != 1 {
		t.Errorf("ct row = %+v, want 1 round / 1 win / 5k / 1d", ct)
	}
	if ct.ADR < 299.9 || ct.ADR > 300.1 || ct.KASTPct < 99.9 || ct.KASTPct > 100.1 {
		t.Errorf("ct ADR/KAST = %v/%v, want 300/100", ct.ADR, ct.KASTPct)
	}
	// t: only counted round 3, won by T.
	if tr.Rounds != 1 || tr.Wins != 1 || tr.Kills != 2 || tr.Deaths != 0 {
		t.Errorf("t row = %+v, want 1 round / 1 win / 2k / 0d", tr)
	}
	if tr.ADR < 99.9 || tr.ADR > 100.1 || tr.KASTPct != 0 {
		t.Errorf("t ADR/KAST = %v/%v, want 100/0", tr.ADR, tr.KASTPct)
	}
}

// TestGetPlayerHistoryStartSide: the history row carries BOTH sides —
// Side (player_stats.side, the final side models.WinFor needs) and
// StartSide (the first counted round's freeze-end sample) — and a match
// with no stored samples yields StartSide "" rather than a guess.
func TestGetPlayerHistoryStartSide(t *testing.T) {
	s := openMem(t)
	id, err := s.CreateMatchRow("/d/startside.dem", "sha-startside", 7)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	em := testExtracted("sha-startside", time.Now())
	// Alice ENDS the match on t (players table) but OPENS counted round 1
	// on ct — the two facts must not overwrite each other.
	em.Players[0].Side = "t"
	em.PlayerStats[0].Side = "t"
	em.RoundSides = []models.RoundPlayerSide{
		{Round: 1, SteamID: "100", Side: "ct"},
	}
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}

	rows, err := s.GetPlayerHistory("100")
	if err != nil {
		t.Fatalf("GetPlayerHistory: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("history = %+v, want 1 row", rows)
	}
	if rows[0].Side != "t" {
		t.Errorf("side = %q, want the final side t", rows[0].Side)
	}
	if rows[0].StartSide != "ct" {
		t.Errorf("startSide = %q, want the first counted round's sample ct", rows[0].StartSide)
	}
	// Win follows the FINAL side (score 1–0: ct won, t lost).
	if rows[0].Win {
		t.Error("win = true for the t side of a 1–0 CT win, want false")
	}

	// No stored samples at all → StartSide stays "" (no guess).
	em.RoundSides = nil
	em.Match.SHA256 = "sha-startside2"
	id2, err := s.CreateMatchRow("/d/startside2.dem", "sha-startside2", 7)
	if err != nil {
		t.Fatalf("CreateMatchRow #2: %v", err)
	}
	if err := s.SaveExtracted(id2, em); err != nil {
		t.Fatalf("SaveExtracted #2: %v", err)
	}
	rows, err = s.GetPlayerHistory("100")
	if err != nil {
		t.Fatalf("GetPlayerHistory: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("history = %+v, want 2 rows", rows)
	}
	for _, r := range rows {
		want := "ct"
		if r.MatchID == id2 {
			want = "" // the sample-less match must not inherit a side
		}
		if r.StartSide != want {
			t.Errorf("match %d startSide = %q, want %q", r.MatchID, r.StartSide, want)
		}
	}
}
