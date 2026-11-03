package analytics

import (
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// tradeScenario is one round shared by the gate tests: a teamkill followed
// by a revenge teamkill inside the window (which must NOT pair as a trade),
// plus a plain enemy death traded by a teammate (which must).
//
//	tick 100  V (t) teamkills X (t)
//	tick 200  K (t) teamkills V (t)   — revenge, inside every window
//	tick 300  Y (t) kills A (ct)
//	tick 400  B (ct) kills Y (t)      — the one real trade (256+… ≤ 320)
func tradeScenario() ([]models.Event, []RoundInfo, []PlayerRef) {
	players := []PlayerRef{
		{SteamID: "A", Name: "Alice", Side: "ct"},
		{SteamID: "B", Name: "Bob", Side: "ct"},
		{SteamID: "K", Name: "Ken", Side: "t"},
		{SteamID: "V", Name: "Val", Side: "t"},
		{SteamID: "X", Name: "Xim", Side: "t"},
		{SteamID: "Y", Name: "Yara", Side: "t"},
	}
	rounds := []RoundInfo{{Number: 1, Winner: "ct"}}
	events := []models.Event{
		ev(0, 100, 1, models.EventKill, "V", "X"), // teamkill
		ev(1, 200, 1, models.EventKill, "K", "V"), // revenge teamkill
		ev(2, 300, 1, models.EventKill, "Y", "A"),
		ev(3, 400, 1, models.EventKill, "B", "Y"), // trade: Y killed A (ct)
	}
	return events, rounds, players
}

// TestEngagementsTeamkillsNeverTrade pins the extractor's enemy-kill gate
// on the ONE trade rule: neither the teamkill death (anchor) nor the
// revenge teamkill (answer) may pair, while the enemy control still does.
func TestEngagementsTeamkillsNeverTrade(t *testing.T) {
	events, rounds, players := tradeScenario()
	got := Engagements(events, rounds, testCfg, players, nil)

	var trades []Engagement
	for _, e := range got {
		if e.Kind == KindTrade {
			trades = append(trades, e)
		}
	}
	if len(trades) != 1 {
		t.Fatalf("trade rows = %+v, want exactly the enemy pair B→Y", trades)
	}
	if trades[0].ASteam != "B" || trades[0].BSteam != "Y" {
		t.Errorf("trade row = %+v, want aSteam=B bSteam=Y", trades[0])
	}
}

// TestPlayerRoundsTeamkillDeathNotTraded pins the mirror direction: a
// teamkill death is never "traded" (even when a teammate kills the
// teamkiller inside the window), so KAST "T" stays bijective with
// player_stats.trade_kills; the enemy control death still trades.
func TestPlayerRoundsTeamkillDeathNotTraded(t *testing.T) {
	events, rounds, players := tradeScenario()
	got := PlayerRounds(events, rounds, players, testCfg, nil)
	byID := map[string]PlayerRound{}
	for _, r := range got {
		byID[r.SteamID] = r
	}
	if x := byID["X"]; x.Traded {
		t.Errorf("X (teamkill death) traded = true, want false (KAST T = %v)", x.KAST)
	}
	if a := byID["A"]; !a.Traded {
		t.Errorf("A (enemy death) traded = false, want true (B answered within the window)")
	}
}

// TestComputeTradeKillsDefaultAndConfigurable is the end-to-end proof for
// the trade-window unification: on a fixture whose events yield exactly
// one trade 4 s after the teammate's death, analytics.Compute at the
// DEFAULT window (5 s) must leave player_stats.trade_kills equal to the
// extractor's stored output (the import-time 5 s rule), while a narrower
// TradeWindowS must change the recomputed value — configurability
// proven through Compute → store → scoreboard/career.
func TestComputeTradeKillsDefaultAndConfigurable(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	id, err := st.CreateMatchRow("/d/trade.dem", "sha-trade-recompute", 1)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	if err := st.SaveExtracted(id, tradeFixture()); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}

	// The fixture carries the extractor's import-time output (hardcoded
	// 5 s): B traded once, nobody else.
	if b := boardTrade(t, st, id)["B"]; b != 1 {
		t.Fatalf("stored (extractor) trade_kills[B] = %d, want 1", b)
	}

	base := func(window float64) Config {
		return Config{TradeWindowS: window, EcoFullBuy: 20000, EcoForce: 10000, RuleVersion: 1}
	}
	// Default config: recomputed == extractor's stored output.
	if err := Compute(st, id, base(5.0)); err != nil {
		t.Fatalf("Compute(5s): %v", err)
	}
	at5 := boardTrade(t, st, id)
	if at5["B"] != 1 || at5["A"] != 0 || at5["X"] != 0 {
		t.Errorf("trade_kills@5s = %v, want {A:0 B:1 X:0} (equal to the extractor's stored output)", at5)
	}
	// Career rollup aggregates the fresh column (update runs BEFORE
	// RebuildCareer inside Compute).
	career, err := st.GetCareer("B")
	if err != nil {
		t.Fatalf("GetCareer(B): %v", err)
	}
	if career.Trades != 1 {
		t.Errorf("career trades[B] = %d, want 1", career.Trades)
	}

	// Narrow window: the 4 s gap falls outside 1 s → the value changes.
	if err := Compute(st, id, base(1.0)); err != nil {
		t.Fatalf("Compute(1s): %v", err)
	}
	at1 := boardTrade(t, st, id)
	if at1["B"] != 0 {
		t.Errorf("trade_kills@1s = %v, want B=0 (4 s gap outside the 1 s window)", at1)
	}
	career, err = st.GetCareer("B")
	if err != nil {
		t.Fatalf("GetCareer(B) after 1s: %v", err)
	}
	if career.Trades != 0 {
		t.Errorf("career trades[B] after 1s = %d, want 0", career.Trades)
	}
}

// boardTrade projects the scoreboard's trade_kills column per player.
func boardTrade(t *testing.T, st *store.Store, id int64) map[string]int {
	t.Helper()
	rows, err := st.GetScoreboard(id, "", false)
	if err != nil {
		t.Fatalf("GetScoreboard: %v", err)
	}
	out := map[string]int{}
	for _, r := range rows {
		out[r.SteamID] = r.TradeKills
	}
	return out
}

// tradeFixture is a synthetic extract: one counted round where X kills A
// (ct) at tick 100 and B (ct) kills X at tick 356 (4 s later — inside the
// default 320-tick/5 s window, outside a 64-tick/1 s window). The
// PlayerStats rows mimic the extractor's import-time rule (hardcoded 5 s):
// only B gets TradeKills = 1.
func tradeFixture() *models.ExtractedMatch {
	return &models.ExtractedMatch{
		Match: models.Match{
			Path: "/d/trade.dem", SHA256: "sha-trade-recompute", Size: 1,
			Map: "de_cache", TickRate: 64, RealRounds: 1,
			ScoreCT: 1, ScoreT: 0, ParserVersion: "v6", ExtractedAt: time.Now(),
		},
		Players: []models.Player{
			{SteamID: "A", Name: "Alice", Side: "ct", FinalStatePresent: true},
			{SteamID: "B", Name: "Bob", Side: "ct", FinalStatePresent: true},
			{SteamID: "X", Name: "Xim", Side: "t", FinalStatePresent: true},
		},
		PlayerStats: []models.PlayerStats{
			{SteamID: "A", Side: "ct", Name: "Alice", Deaths: 1, RoundsPlayed: 1},
			{SteamID: "B", Side: "ct", Name: "Bob", Kills: 1, TradeKills: 1, RoundsPlayed: 1},
			{SteamID: "X", Side: "t", Name: "Xim", Kills: 1, Deaths: 1, RoundsPlayed: 1},
		},
		Rounds: []models.Round{
			{Number: 1, Winner: "ct", StartTick: 0, EndTick: 7200, FreezeEndTick: 64},
		},
		RoundSides: []models.RoundPlayerSide{
			{Round: 1, SteamID: "A", Side: "ct"},
			{Round: 1, SteamID: "B", Side: "ct"},
			{Round: 1, SteamID: "X", Side: "t"},
		},
		Events: []models.Event{
			{Tick: 100, Round: 1, Kind: models.EventKill, Attacker: "X", Victim: "A", Weapon: "ak47"},
			{Tick: 356, Round: 1, Kind: models.EventKill, Attacker: "B", Victim: "X", Weapon: "ak47"},
		},
	}
}
