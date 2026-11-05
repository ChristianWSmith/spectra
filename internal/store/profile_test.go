package store

// Profile read-model queries: the Sides card's per-round side splits, the
// Trade rate's opportunity denominator and the two per-match counter
// averages (profileservice.GetProfile). Each pins the decisions its doc
// comment states — no side/proximity/round guess ever produces a count.

import (
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestGetPlayerSideSplits: rows come from player_round_stats ⋈ that
// round's freeze-end side sample ⋈ the round's winner — warmup and
// pregame rounds are dropped even with side samples and player rows
// present, a counted round with no side sample yields NO row (unknown →
// skipped, never guessed), and ADR/KAST are the round-level sums/means
// (player_round_stats.dmg ÷ rounds, 100 × AVG(kast)).
func TestGetPlayerSideSplits(t *testing.T) {
	s := openMem(t)
	id, err := s.CreateMatchRow("/d/sides.dem", "sha-sides", 7)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	em := testExtracted("sha-sides", time.Now())
	// testExtracted already has round 0 (warmup), round 1 (counted, winner
	// ct) and round 2 (pregame). Add a second counted round won by T and
	// a third counted round with NO side sample for the player.
	em.Rounds = append(em.Rounds,
		models.Round{Number: 3, Winner: "t"},
		models.Round{Number: 4, Winner: "ct"},
	)
	em.RoundSides = append(em.RoundSides,
		models.RoundPlayerSide{Round: 0, SteamID: "100", Side: "ct"}, // warmup
		models.RoundPlayerSide{Round: 2, SteamID: "100", Side: "ct"}, // pregame
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
	// ct: only counted round 1 (warmup 0 and pregame 2 dropped; round 4
	// has no side sample). Winner ct → 1 round win.
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

// TestCountPlayerTradeOpportunities pins the definition in the query's
// doc comment, decision by decision, against a 200u gate (the fixtures
// are calibrated to it, not to the 1000u default):
//
// baseline (+1): an enemy kill in a counted round whose victim is this
// player's teammate that round, the player alive at the death tick, and
// detail_json.nearDist inside [0, gate].
//
// rejected: nearDist beyond the gate; the -1 "not measurable" sentinel;
// a kill with no detail_json; the player's OWN death (victim = player);
// a victim or killer with no freeze-end side sample (unknown, never
// guessed); a teamkill; a suicide; a warmup-round kill; and a teammate
// death after the player himself died (a dead player cannot answer).
func TestCountPlayerTradeOpportunities(t *testing.T) {
	s := openMem(t)
	id, err := s.CreateMatchRow("/d/tradeopp.dem", "sha-tradeopp", 7)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	em := testExtracted("sha-tradeopp", time.Now())
	em.Players = []models.Player{
		{SteamID: "100", Name: "alice", Side: "ct"}, // the profile player
		{SteamID: "200", Name: "bob", Side: "t"},    // enemy killer
		{SteamID: "300", Name: "carl", Side: "ct"},  // alice's teammate
		{SteamID: "500", Name: "dave", Side: "ct"},  // alice's teammate
		{SteamID: "400", Name: "zed", Side: "ct"},   // no round-1 sample
		{SteamID: "600", Name: "ghost", Side: "t"},  // no round-1 sample
	}
	em.PlayerStats = []models.PlayerStats{
		{SteamID: "100", Side: "ct", Name: "alice"},
	}
	em.RoundSides = []models.RoundPlayerSide{
		{Round: 1, SteamID: "100", Side: "ct"},
		{Round: 1, SteamID: "200", Side: "t"},
		{Round: 1, SteamID: "300", Side: "ct"},
		{Round: 1, SteamID: "500", Side: "ct"},
		// Warmup sides too, so the warmup FILTER is what rejects #10.
		{Round: 0, SteamID: "100", Side: "ct"},
		{Round: 0, SteamID: "200", Side: "t"},
		{Round: 0, SteamID: "300", Side: "ct"},
	}
	em.Events = []models.Event{
		{Tick: 10, Round: 1, Kind: models.EventKill, Attacker: "200", Victim: "300",
			DetailJSON: `{"nearDist":150}`}, // baseline: +1
		{Tick: 20, Round: 1, Kind: models.EventKill, Attacker: "200", Victim: "300",
			DetailJSON: `{"nearDist":500}`}, // beyond the 200u gate
		{Tick: 30, Round: 1, Kind: models.EventKill, Attacker: "200", Victim: "300",
			DetailJSON: `{"nearDist":-1}`}, // not measurable
		{Tick: 40, Round: 1, Kind: models.EventKill, Attacker: "200", Victim: "300"},
		{Tick: 50, Round: 1, Kind: models.EventKill, Attacker: "200", Victim: "100",
			DetailJSON: `{"nearDist":150}`}, // the player's own death
		{Tick: 60, Round: 1, Kind: models.EventKill, Attacker: "200", Victim: "400",
			DetailJSON: `{"nearDist":150}`}, // victim side unknown
		{Tick: 70, Round: 1, Kind: models.EventKill, Attacker: "600", Victim: "300",
			DetailJSON: `{"nearDist":150}`}, // killer side unknown
		{Tick: 80, Round: 1, Kind: models.EventKill, Attacker: "100", Victim: "300",
			DetailJSON: `{"nearDist":150}`}, // teamkill
		{Tick: 90, Round: 1, Kind: models.EventKill, Attacker: "300", Victim: "300",
			DetailJSON: `{"nearDist":150}`}, // suicide
		{Tick: 5, Round: 0, Kind: models.EventKill, Attacker: "200", Victim: "300",
			DetailJSON: `{"nearDist":150}`}, // warmup round
		{Tick: 110, Round: 1, Kind: models.EventKill, Attacker: "200", Victim: "500",
			DetailJSON: `{"nearDist":150}`}, // alice is dead by then
		// alice's death (makes #11 and everything after unavailable):
		{Tick: 55, Round: 1, Kind: models.EventKill, Attacker: "200", Victim: "100",
			DetailJSON: `{"nearDist":150}`},
	}
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	if _, err := s.SetConfig(models.AnalysisConfig{
		TradeWindowS: 5, EcoFullBuy: 20000, EcoForce: 10000, TradeOppDistance: 200, RuleVersion: 1,
	}); err != nil {
		t.Fatalf("SetConfig (distance 200): %v", err)
	}

	n, err := s.CountPlayerTradeOpportunities("100")
	if err != nil {
		t.Fatalf("CountPlayerTradeOpportunities: %v", err)
	}
	if n != 1 {
		t.Errorf("opportunities @200u = %d, want 1 (only the tick-10 baseline)", n)
	}
	if n, err := s.CountPlayerTradeOpportunities("999"); err != nil || n != 0 {
		t.Errorf("unknown player = %d, %v, want 0, nil", n, err)
	}

	// Widening the gate to the 1000u default admits the tick-20 death
	// (500u) and nothing else — the gate is the configured radius, not a
	// hardcoded one.
	if _, err := s.SetConfig(models.AnalysisConfig{
		TradeWindowS: 5, EcoFullBuy: 20000, EcoForce: 10000, TradeOppDistance: 1000, RuleVersion: 1,
	}); err != nil {
		t.Fatalf("SetConfig (distance 1000): %v", err)
	}
	if n, err := s.CountPlayerTradeOpportunities("100"); err != nil || n != 2 {
		t.Errorf("opportunities @1000u = %d, %v, want 2", n, err)
	}
}

// TestGetPlayerMatchAverages: the per-match means read player_stats
// directly (one row per match) — 3/50 in the first match, 5/100 in the
// second, so 4/75; a player with no rows averages 0 rather than NULL.
func TestGetPlayerMatchAverages(t *testing.T) {
	s := openMem(t)
	saveTestMatch(t, s, "/d/avg1.dem", "sha-avg1", time.Now())
	id2, err := s.CreateMatchRow("/d/avg2.dem", "sha-avg2", 5)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	em := testExtracted("sha-avg2", time.Now().Add(time.Hour))
	em.PlayerStats[0].EnemiesFlashed = 5
	em.PlayerStats[0].UtilityDamage = 100
	if err := s.SaveExtracted(id2, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}

	avg, err := s.GetPlayerMatchAverages("100")
	if err != nil {
		t.Fatalf("GetPlayerMatchAverages: %v", err)
	}
	if avg.EnemiesFlashed < 3.99 || avg.EnemiesFlashed > 4.01 {
		t.Errorf("enemiesFlashed = %v, want 4 ((3+5)/2)", avg.EnemiesFlashed)
	}
	if avg.UtilDamage < 74.9 || avg.UtilDamage > 75.1 {
		t.Errorf("utilDamage = %v, want 75 ((50+100)/2)", avg.UtilDamage)
	}
	empty, err := s.GetPlayerMatchAverages("999")
	if err != nil {
		t.Fatalf("GetPlayerMatchAverages(unknown): %v", err)
	}
	if empty.EnemiesFlashed != 0 || empty.UtilDamage != 0 {
		t.Errorf("unknown player averages = %+v, want 0/0", empty)
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
