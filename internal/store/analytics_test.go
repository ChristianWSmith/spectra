package store

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestAnalyticsTablesFreshOpen: a fresh Open creates the analytics
// tables; a second Open re-applies the baseline as a no-op (no error) and
// the stored rows survive.
func TestAnalyticsTablesFreshOpen(t *testing.T) {
	s, path := openFileStore(t)
	analyticsTables := []string{
		"round_classifications", "player_round_stats", "clutches", "engagements",
		"utility_events", "player_career", "saved_filters", "analysis_config",
	}
	for _, table := range analyticsTables {
		var name string
		if err := s.db.QueryRow(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table,
		).Scan(&name); err != nil {
			t.Errorf("table %s missing on fresh Open: %v", table, err)
		}
	}
	id := saveTestMatch(t, s, "/d/analytics.dem", "sha-analytics", time.Now())
	if err := s.ReplaceRoundClassifications(id, []models.RoundClassification{
		{Round: 1, Label: "pistol", Confidence: 1, RuleVersion: 1, Explanation: "half start"},
	}); err != nil {
		t.Fatalf("ReplaceRoundClassifications: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	s2, err := Open(path) // second Open: baseline re-applies as a no-op
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer func() { _ = s2.Close() }()
	for _, table := range analyticsTables {
		var name string
		if err := s2.db.QueryRow(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table,
		).Scan(&name); err != nil {
			t.Errorf("table %s missing after reopen: %v", table, err)
		}
	}
	rows, err := s2.GetRoundClasses(id)
	if err != nil {
		t.Fatalf("GetRoundClasses after reopen: %v", err)
	}
	if len(rows) != 1 || rows[0].Label != "pistol" {
		t.Errorf("rows after reopen = %+v, want the pistol row", rows)
	}
}

func TestConfigSeedAndSet(t *testing.T) {
	s := openMem(t)
	c, err := s.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	if c.TradeWindowS != 5.0 || c.EcoFullBuy != 20000 || c.EcoForce != 10000 || c.RuleVersion != 1 {
		t.Errorf("seeded config = %+v, want defaults 5/20000/10000/v1", c)
	}
	if c.TradeOppDistance != 1000 {
		t.Errorf("seeded tradeOppDistance = %d, want the 1000u default", c.TradeOppDistance)
	}
	// Second Get returns the seeded row (idempotent).
	if c2, err := s.GetConfig(); err != nil || c2 != c {
		t.Errorf("second GetConfig = %+v, %v", c2, err)
	}
	// Round-trip the new field with the rest of the config.
	saved, err := s.SetConfig(models.AnalysisConfig{
		TradeWindowS: 3.5, EcoFullBuy: 3500, EcoForce: 1800, TradeOppDistance: 350, RuleVersion: 2,
	})
	if err != nil {
		t.Fatalf("SetConfig: %v", err)
	}
	if saved.TradeWindowS != 3.5 || saved.RuleVersion != 2 {
		t.Errorf("saved = %+v", saved)
	}
	if saved.TradeOppDistance != 350 {
		t.Errorf("saved tradeOppDistance = %d, want 350 (round-trip)", saved.TradeOppDistance)
	}
	if c3, err := s.GetConfig(); err != nil || c3.TradeOppDistance != 350 {
		t.Errorf("re-read tradeOppDistance = %d, %v, want 350", c3.TradeOppDistance, err)
	}
}

func TestAnalyticsReplaceAndGetters(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/m3b.dem", "sha-replace", time.Now())

	cls := []models.RoundClassification{{Round: 1, Label: "pistol", Confidence: 1, RuleVersion: 1, Explanation: "why\x00nul"}}
	prs := []models.PlayerRoundStat{{
		Round: 1, SteamID: "100", Name: "al\x00ice", Kills: 2, Assists: 1, Deaths: 0,
		Traded: false, Survived: true, KAST: true, DMG: 130, UtilDmg: 30,
		MoneyStart: 800, Equip: 2000, Spent: 1200, RuleVersion: 1,
	}}
	clutches := []models.Clutch{{
		Round: 1, Size: 2, SteamID: "100", Name: "alice", StartTick: 150, EndTick: 300,
		BombState: "planted", HPLeft: 40, Equip: 2000, Won: true,
		KillTicks: "[200,250]", ReplayAnchor: 150,
	}}
	engs := []models.Engagement{{
		Tick: 100, Round: 1, Kind: "opening", ASteam: "100", AName: "alice",
		BSteam: "200", BName: "bob", Distance: 12.5, WonBy: "ct",
	}}
	utils := []models.UtilityEvent{{
		Tick: 120, Round: 1, Thrower: "100", ThrowerName: "alice", Kind: "he",
		DetX: pf(1.5), DetY: pf(-2.5), Damage: 45, FlashMs: 0,
		Affected: `["200"]`, Site: "", TrajectoryRef: "",
	}}

	for _, step := range []struct {
		name string
		fn   func() error
	}{
		{"classifications", func() error { return s.ReplaceRoundClassifications(id, cls) }},
		{"player rounds", func() error { return s.ReplacePlayerRounds(id, prs) }},
		{"clutches", func() error { return s.ReplaceClutches(id, clutches) }},
		{"engagements", func() error { return s.ReplaceEngagements(id, engs) }},
		{"utility", func() error { return s.ReplaceUtility(id, utils) }},
	} {
		if err := step.fn(); err != nil {
			t.Fatalf("%s: %v", step.name, err)
		}
	}

	gotCls, err := s.GetRoundClasses(id)
	if err != nil || len(gotCls) != 1 || gotCls[0].Explanation != "whynul" {
		t.Errorf("GetRoundClasses = %+v, %v (NUL scrubbed)", gotCls, err)
	}
	gotPrs, err := s.GetPlayerRounds(id, "")
	if err != nil || len(gotPrs) != 1 || !gotPrs[0].KAST || gotPrs[0].DMG != 130 {
		t.Errorf("GetPlayerRounds = %+v, %v", gotPrs, err)
	}
	if gotPrs, err := s.GetPlayerRounds(id, "100"); err != nil || len(gotPrs) != 1 {
		t.Errorf("GetPlayerRounds(100) = %+v, %v", gotPrs, err)
	}
	if gotPrs, err := s.GetPlayerRounds(id, "999"); err != nil || len(gotPrs) != 0 {
		t.Errorf("GetPlayerRounds(999) = %+v, %v", gotPrs, err)
	}
	gotClutches, err := s.GetClutches(id)
	if err != nil || len(gotClutches) != 1 || !gotClutches[0].Won || gotClutches[0].KillTicks != "[200,250]" {
		t.Errorf("GetClutches = %+v, %v", gotClutches, err)
	}
	gotEngs, err := s.GetEngagements(id, "")
	if err != nil || len(gotEngs) != 1 || gotEngs[0].Kind != "opening" || gotEngs[0].Distance != 12.5 {
		t.Errorf("GetEngagements = %+v, %v", gotEngs, err)
	}
	if gotEngs, err := s.GetEngagements(id, "trade"); err != nil || len(gotEngs) != 0 {
		t.Errorf("GetEngagements(trade) = %+v, %v", gotEngs, err)
	}
	gotUtil, err := s.GetUtility(id)
	if err != nil || len(gotUtil) != 1 || gotUtil[0].Damage != 45 || gotUtil[0].DetX == nil || *gotUtil[0].DetX != 1.5 {
		t.Errorf("GetUtility = %+v, %v", gotUtil, err)
	}

	// Replace semantics: a second call swaps the rows.
	if err := s.ReplaceClutches(id, nil); err != nil {
		t.Fatalf("ReplaceClutches(nil): %v", err)
	}
	if got, err := s.GetClutches(id); err != nil || len(got) != 0 {
		t.Errorf("GetClutches after empty replace = %+v, %v", got, err)
	}
}

func TestGetEconomyLossBonusFollowsTeams(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/teams.dem", "sha-teams", time.Now())
	em := testExtracted("sha-teams", time.Now())
	em.Match.RealRounds = 4
	em.Match.SideSwitches = 1
	// Two halves: player 100's team (A) opens CT and wins round 1, player
	// 200's team (B) answers round 2; the sides swap before round 3 where A
	// now plays T and wins again, B (now CT) takes round 4.
	em.Rounds = []models.Round{
		{Number: 1, Winner: "ct", EquipCT: 20000, EquipT: 20000, StartTick: 100, EndTick: 2000},
		{Number: 2, Winner: "t", EquipCT: 15000, EquipT: 25000, StartTick: 2001, EndTick: 4000},
		{Number: 3, Winner: "t", EquipCT: 25000, EquipT: 15000, StartTick: 4001, EndTick: 6000},
		{Number: 4, Winner: "ct", EquipCT: 25000, EquipT: 15000, StartTick: 6001, EndTick: 8000},
	}
	em.RoundEconomy = nil
	em.RoundSides = []models.RoundPlayerSide{
		{Round: 1, SteamID: "100", Side: "ct"}, {Round: 1, SteamID: "200", Side: "t"},
		{Round: 2, SteamID: "100", Side: "ct"}, {Round: 2, SteamID: "200", Side: "t"},
		{Round: 3, SteamID: "100", Side: "t"}, {Round: 3, SteamID: "200", Side: "ct"},
		{Round: 4, SteamID: "100", Side: "t"}, {Round: 4, SteamID: "200", Side: "ct"},
	}
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	rows, err := s.GetEconomy(id)
	if err != nil {
		t.Fatalf("GetEconomy: %v", err)
	}
	if len(rows) != 4 {
		t.Fatalf("rows = %d, want 4", len(rows))
	}
	// Loss counts follow the TEAM across the side switch and restart at 1
	// for each half (a pistol loss pays $1900); a win steps the count down
	// by one, a loss up one (cap 4 = $3400).
	want := []struct{ ct, t int }{
		{1900, 1900}, // half 1 starts at loss count 1 for both teams
		{1400, 2400}, // A won r1 (step down), B lost twice (count 2)
		{1900, 1900}, // half 2 restarts both counts at 1 — B is now CT
		{2400, 1400}, // A (T) won r3 → count 0; B (CT) lost it → count 2
	}
	for i, w := range want {
		if rows[i].LossBonusCT != w.ct || rows[i].LossBonusT != w.t {
			t.Errorf("round %d bonuses = CT %d / T %d, want %d/%d (team-tracked ladder)",
				rows[i].Round, rows[i].LossBonusCT, rows[i].LossBonusT, w.ct, w.t)
		}
	}
}

func TestGetEconomyLossBonus(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/econ.dem", "sha-econ", time.Now())
	// saveTestMatch wrote 1 non-warmup round (winner ct); add two more via
	// a fresh extract with 3 real rounds, all CT wins.
	em := testExtracted("sha-econ", time.Now())
	em.Match.RealRounds = 3
	em.Rounds = []models.Round{
		{Number: 0, Warmup: true},
		{Number: 1, Winner: "ct", EquipCT: 4500, EquipT: 4200, StartTick: 100, EndTick: 2000},
		{Number: 2, Winner: "ct", EquipCT: 5000, EquipT: 1500, StartTick: 2001, EndTick: 4000},
		{Number: 3, Winner: "ct", EquipCT: 5000, EquipT: 1500, StartTick: 4001, EndTick: 6000},
	}
	em.RoundEconomy = []models.RoundEconomy{
		{Round: 1, Side: "ct", EquipValue: 4500, MoneySampledSum: 20000, MoneySamples: 4},
		{Round: 1, Side: "t", EquipValue: 4200, MoneySampledSum: 18000, MoneySamples: 4},
		{Round: 2, Side: "ct", EquipValue: 5000, MoneySampledSum: 15000, MoneySamples: 4},
		{Round: 2, Side: "t", EquipValue: 1500, MoneySampledSum: 9000, MoneySamples: 4},
		{Round: 3, Side: "ct", EquipValue: 5000, MoneySampledSum: 16000, MoneySamples: 4},
		{Round: 3, Side: "t", EquipValue: 1500, MoneySampledSum: 3000, MoneySamples: 4},
	}
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	if err := s.ReplaceRoundClassifications(id, []models.RoundClassification{
		{Round: 1, Label: "pistol", Confidence: 1, RuleVersion: 1, Explanation: "half start"},
	}); err != nil {
		t.Fatalf("ReplaceRoundClassifications: %v", err)
	}
	rows, err := s.GetEconomy(id)
	if err != nil {
		t.Fatalf("GetEconomy: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("rows = %d, want 3 (warmup excluded)", len(rows))
	}
	// CS2 loss-count rules: every half starts at loss count 1, a loss
	// steps the count up (+$500 each, cap $3400) and a win steps it DOWN
	// by one (it does not reset). CT wins all three rounds here —
	// no side switch in this fixture.
	//   r1: both teams enter at count 1 → 1900/1900 (pistol rule);
	//   r2: CT won → count 0 → 1400; T lost twice → count 2 → 2400;
	//   r3: CT still 0 → 1400; T count 3 → 2900.
	if rows[0].LossBonusCT != 1900 || rows[0].LossBonusT != 1900 {
		t.Errorf("round 1 bonuses = %d/%d, want 1900/1900 (half starts at loss count 1)",
			rows[0].LossBonusCT, rows[0].LossBonusT)
	}
	if rows[1].LossBonusCT != 1400 || rows[1].LossBonusT != 2400 {
		t.Errorf("round 2 bonuses = %d/%d, want 1400/2400 (win steps down, 2-loss T)",
			rows[1].LossBonusCT, rows[1].LossBonusT)
	}
	if rows[2].LossBonusCT != 1400 || rows[2].LossBonusT != 2900 {
		t.Errorf("round 3 bonuses = %d/%d, want 1400/2900 (3-loss T)",
			rows[2].LossBonusCT, rows[2].LossBonusT)
	}
	for _, r := range rows {
		if !r.InferredCT || !r.InferredT {
			t.Errorf("round %d inferred flags = %v/%v, want true/true", r.Round, r.InferredCT, r.InferredT)
		}
		if !r.WonCT || r.WonT {
			t.Errorf("round %d won = %v/%v", r.Round, r.WonCT, r.WonT)
		}
	}
	if rows[0].Label != "pistol" || !strings.Contains(rows[0].Explanation, "half start") {
		t.Errorf("round 1 classification join = %q / %q", rows[0].Label, rows[0].Explanation)
	}
	if rows[1].MoneyCT != 15000 || rows[1].MoneyT != 9000 {
		t.Errorf("round 2 money = %d/%d, want 15000/9000", rows[1].MoneyCT, rows[1].MoneyT)
	}
}

// TestGetEconomySpent pins the round-trip of round_economy.spent into
// EconomyRow.SpentCT/SpentT — the per-round side spend the Compare
// rounds table plots (the Economy tab's own surfaces read equipment value
// and net worth instead) — including the COALESCE to 0 for a round with
// no economy row.
func TestGetEconomySpent(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/spent.dem", "sha-spent", time.Now())
	em := testExtracted("sha-spent", time.Now())
	em.Match.RealRounds = 2
	em.Rounds = []models.Round{
		{Number: 1, Winner: "ct", EquipCT: 4500, EquipT: 4200, StartTick: 100, EndTick: 2000},
		{Number: 2, Winner: "t", EquipCT: 5000, EquipT: 1500, StartTick: 2001, EndTick: 4000},
	}
	// Round 2 has no round_economy rows on purpose (COALESCE path).
	em.RoundEconomy = []models.RoundEconomy{
		{Round: 1, Side: "ct", EquipValue: 4500, MoneySampledSum: 20000, MoneySamples: 5, Spent: 4000},
		{Round: 1, Side: "t", EquipValue: 4200, MoneySampledSum: 18000, MoneySamples: 5, Spent: 3400},
	}
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	rows, err := s.GetEconomy(id)
	if err != nil {
		t.Fatalf("GetEconomy: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2", len(rows))
	}
	if rows[0].SpentCT != 4000 || rows[0].SpentT != 3400 {
		t.Errorf("round 1 spent = CT %d / T %d, want 4000/3400 (stored round_economy.spent)",
			rows[0].SpentCT, rows[0].SpentT)
	}
	if rows[1].SpentCT != 0 || rows[1].SpentT != 0 {
		t.Errorf("round 2 spent = CT %d / T %d, want 0/0 (no economy row)",
			rows[1].SpentCT, rows[1].SpentT)
	}
	// The round-detail read carries the same column.
	det, err := s.GetRoundDetail(id, 1)
	if err != nil {
		t.Fatalf("GetRoundDetail: %v", err)
	}
	if len(det.Economy) != 2 || det.Economy[0].Spent != 4000 || det.Economy[1].Spent != 3400 {
		t.Errorf("round detail economy = %+v, want spent 4000/3400", det.Economy)
	}
}

// TestGetEconomyFreePistol pins the round-trip of
// round_economy.free_pistol_value (the side's held free spawn-issued
// default-pistol value at freeze end) into
// EconomyRow.FreePistolCT/FreePistolT and the round-detail read,
// including the COALESCE-to-0 path for a round with no economy row.
func TestGetEconomyFreePistol(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/freep.dem", "sha-freep", time.Now())
	em := testExtracted("sha-freep", time.Now())
	em.Match.RealRounds = 2
	em.Rounds = []models.Round{
		{Number: 1, Winner: "ct", EquipCT: 4000, EquipT: 3600, StartTick: 100, EndTick: 2000},
		{Number: 2, Winner: "t", EquipCT: 5000, EquipT: 1500, StartTick: 2001, EndTick: 4000},
	}
	// Round 2 has no round_economy rows on purpose (COALESCE path).
	em.RoundEconomy = []models.RoundEconomy{
		{Round: 1, Side: "ct", EquipValue: 4000, MoneySampledSum: 600, MoneySamples: 5, Spent: 3400, FreePistolValue: 600},
		{Round: 1, Side: "t", EquipValue: 3600, MoneySampledSum: 1400, MoneySamples: 5, Spent: 2600, FreePistolValue: 1000},
	}
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	rows, err := s.GetEconomy(id)
	if err != nil {
		t.Fatalf("GetEconomy: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2", len(rows))
	}
	if rows[0].FreePistolCT != 600 || rows[0].FreePistolT != 1000 {
		t.Errorf("round 1 free pistols = CT %d / T %d, want 600/1000 (stored round_economy.free_pistol_value)",
			rows[0].FreePistolCT, rows[0].FreePistolT)
	}
	// Net worth the chart plots (frontend lib/econ.js): equip + cash,
	// NEVER the free pistols — subtracting them dropped net worth below
	// equipment value on any side holding less cash than the granted
	// pistols it still had. Both sides here still read their $4000 of
	// cash-flow (equip + cash − free pistols), the column's own round-trip.
	if got := rows[0].EquipCT + rows[0].MoneyCT; got != 4600 {
		t.Errorf("round 1 CT net worth = %d, want 4600 (equip 4000 + cash 600)", got)
	}
	if got := rows[0].EquipT + rows[0].MoneyT; got != 5000 {
		t.Errorf("round 1 T net worth = %d, want 5000 (equip 3600 + cash 1400)", got)
	}
	if got := rows[0].EquipCT + rows[0].MoneyCT - rows[0].FreePistolCT; got != 4000 {
		t.Errorf("round 1 CT equip+cash−free pistols = %d, want 4000 (free_pistol_value round-trip)", got)
	}
	if got := rows[0].EquipT + rows[0].MoneyT - rows[0].FreePistolT; got != 4000 {
		t.Errorf("round 1 T equip+cash−free pistols = %d, want 4000 (free_pistol_value round-trip)", got)
	}
	if rows[1].FreePistolCT != 0 || rows[1].FreePistolT != 0 {
		t.Errorf("round 2 free pistols = CT %d / T %d, want 0/0 (no economy row)",
			rows[1].FreePistolCT, rows[1].FreePistolT)
	}
	det, err := s.GetRoundDetail(id, 1)
	if err != nil {
		t.Fatalf("GetRoundDetail: %v", err)
	}
	if len(det.Economy) != 2 || det.Economy[0].FreePistolValue != 600 || det.Economy[1].FreePistolValue != 1000 {
		t.Errorf("round detail economy = %+v, want free pistol 600/1000", det.Economy)
	}
}

// TestGetEconomyNetWorthInvariant pins the store-side contract the
// chart's net worth rests on (frontend lib/econ.js: net worth =
// Equip* + Money*): Money* is the freeze-end cash sample and is never
// negative, so net worth can never fall below equipment value — even on
// the golden-demo-shaped rows where a side holds far more free
// spawn-issued default pistols than cash (round 13 CT: $600 of cash
// against $1000 of USP-S). The last assertion documents WHY
// free_pistol_value must not be subtracted: on those rows
// equip + cash − free pistols lands BELOW the equipment value.
func TestGetEconomyNetWorthInvariant(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/netinv.dem", "sha-netinv", time.Now())
	em := testExtracted("sha-netinv", time.Now())
	em.Match.RealRounds = 2
	em.Rounds = []models.Round{
		{Number: 1, Winner: "ct", EquipCT: 4400, EquipT: 20300, StartTick: 100, EndTick: 2000},
		{Number: 2, Winner: "t", EquipCT: 12000, EquipT: 1500, StartTick: 2001, EndTick: 4000},
	}
	// Round 2 has no round_economy rows on purpose (COALESCE path).
	em.RoundEconomy = []models.RoundEconomy{
		{Round: 1, Side: "ct", EquipValue: 4400, MoneySampledSum: 600, MoneySamples: 5, Spent: 3400, FreePistolValue: 1000},
		{Round: 1, Side: "t", EquipValue: 20300, MoneySampledSum: 100, MoneySamples: 5, Spent: 5000, FreePistolValue: 1000},
		{Round: 2, Side: "ct", EquipValue: 12000, MoneySampledSum: 0, MoneySamples: 5, FreePistolValue: 600},
	}
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	rows, err := s.GetEconomy(id)
	if err != nil {
		t.Fatalf("GetEconomy: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2", len(rows))
	}
	for _, r := range rows {
		for _, side := range []struct {
			name        string
			equip, cash int
		}{
			{"CT", r.EquipCT, r.MoneyCT},
			{"T", r.EquipT, r.MoneyT},
		} {
			if side.cash < 0 {
				t.Errorf("round %d %s cash = %d, want >= 0 (negative cash would break the net-worth invariant)",
					r.Round, side.name, side.cash)
			}
			if net := side.equip + side.cash; net < side.equip {
				t.Errorf("round %d %s net worth %d < equipment value %d", r.Round, side.name, net, side.equip)
			}
		}
	}
	// Characterization of the inversion this guards: round 1 CT holds
	// $1000 of free spawn pistols against $600 of cash, so subtracting
	// them reads $4000 — below its $4400 of equipment value.
	r := rows[0]
	if r.MoneyCT >= r.FreePistolCT {
		t.Fatalf("fixture: round 1 CT cash %d must be below free pistols %d", r.MoneyCT, r.FreePistolCT)
	}
	if withSub := r.EquipCT + r.MoneyCT - r.FreePistolCT; withSub >= r.EquipCT {
		t.Errorf("fixture: equip+cash−free pistols = %d, want < equip %d", withSub, r.EquipCT)
	}
}

func TestCareerRebuildMath(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/career.dem", "sha-career", time.Now())
	// KAST rows: alice kast in her only recorded round; bob never.
	if err := s.ReplacePlayerRounds(id, []models.PlayerRoundStat{
		{Round: 1, SteamID: "100", KAST: true},
		{Round: 1, SteamID: "200", KAST: false},
	}); err != nil {
		t.Fatalf("ReplacePlayerRounds: %v", err)
	}
	if err := s.ReplaceClutches(id, []models.Clutch{
		{Round: 1, Size: 1, SteamID: "100", StartTick: 100, Won: true},
		{Round: 1, Size: 2, SteamID: "100", StartTick: 200, Won: false},
	}); err != nil {
		t.Fatalf("ReplaceClutches: %v", err)
	}
	if err := s.RebuildCareer(); err != nil {
		t.Fatalf("RebuildCareer: %v", err)
	}

	alice, err := s.GetCareer("100")
	if err != nil {
		t.Fatalf("GetCareer(alice): %v", err)
	}
	// From testExtracted: alice kills 10, deaths 0, hs 4, adr 60, side ct,
	// score CT 1–0 → 1 win; bob: 5/2, adr 30, side t → 0 wins.
	if alice.Matches != 1 || alice.Wins != 1 {
		t.Errorf("alice matches/wins = %d/%d, want 1/1", alice.Matches, alice.Wins)
	}
	if alice.ADRAvg != 60 || alice.ADRStd != 0 {
		t.Errorf("alice adr = %v ± %v, want 60 ± 0", alice.ADRAvg, alice.ADRStd)
	}
	if alice.KD != 10 {
		t.Errorf("alice kd = %v, want 10", alice.KD)
	}
	if alice.HSPct != 40 {
		t.Errorf("alice hs = %v, want 40", alice.HSPct)
	}
	if alice.KASTPct != 100 {
		t.Errorf("alice kast = %v, want 100", alice.KASTPct)
	}
	if alice.Openings != 1 || alice.OpenerWins != 1 {
		t.Errorf("alice openings = %d/%d, want 1/1", alice.Openings, alice.OpenerWins)
	}
	if alice.Trades != 2 {
		t.Errorf("alice trades = %d, want 2", alice.Trades)
	}
	if alice.Clutches != 2 {
		t.Errorf("alice clutches = %d, want 2", alice.Clutches)
	}
	if alice.Name != "alice" {
		t.Errorf("alice name = %q, want latest (NUL-scrubbed) name", alice.Name)
	}

	bob, err := s.GetCareer("200")
	if err != nil {
		t.Fatalf("GetCareer(bob): %v", err)
	}
	if bob.Wins != 0 || bob.KASTPct != 0 || bob.Openings != 1 || bob.OpenerWins != 0 {
		t.Errorf("bob = %+v", bob)
	}

	// ADRStd across two matches: 30 and 90 → population stddev 30.
	id2, err := s.CreateMatchRow("/d/career2.dem", "sha-career2", 5)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	em2 := testExtracted("sha-career2", time.Now().Add(time.Hour))
	em2.PlayerStats = []models.PlayerStats{{SteamID: "100", Side: "t", Name: "alice2", Kills: 9, Deaths: 9, ADR: 90, RoundsPlayed: 12}}
	em2.Players = []models.Player{{SteamID: "100", Name: "alice2", Side: "t"}}
	em2.Rounds = nil
	em2.RoundEconomy = nil
	em2.Events = nil
	if err := s.SaveExtracted(id2, em2); err != nil {
		t.Fatalf("SaveExtracted 2: %v", err)
	}
	if err := s.RebuildCareer(); err != nil {
		t.Fatalf("RebuildCareer 2: %v", err)
	}
	alice, err = s.GetCareer("100")
	if err != nil {
		t.Fatalf("GetCareer(alice) 2: %v", err)
	}
	// Population stddev of {60, 90} is 15.
	if alice.Matches != 2 || alice.ADRAvg != 75 || alice.ADRStd != 15 {
		t.Errorf("alice after 2nd match = matches %d, adr %v ± %v, want 2 / 75 ± 15",
			alice.Matches, alice.ADRAvg, alice.ADRStd)
	}
	if alice.Name != "alice2" {
		t.Errorf("alice name = %q, want alice2 (latest match)", alice.Name)
	}

	// ListPlayers + trend.
	list, err := s.ListPlayers("")
	if err != nil || len(list) != 2 {
		t.Fatalf("ListPlayers = %+v, %v", list, err)
	}
	if list[0].SteamID != "100" {
		t.Errorf("list[0] = %+v, want alice first (most recent match)", list[0])
	}
	if got, err := s.ListPlayers("bob"); err != nil || len(got) != 1 || got[0].SteamID != "200" {
		t.Errorf("ListPlayers(bob) = %+v, %v", got, err)
	}
	trend, err := s.GetTrend("100", "adr")
	if err != nil || len(trend) != 2 {
		t.Fatalf("GetTrend = %+v, %v", trend, err)
	}
	if trend[0].Value != 60 || trend[1].Value != 90 || trend[1].Seq != 1 {
		t.Errorf("trend = %+v, want [60 90] oldest first", trend)
	}
	if _, err := s.GetTrend("100", "nope"); err == nil {
		t.Error("GetTrend(nope) err = nil, want unknown-metric error")
	}
}

// TestGetPlayerWeaponJSONsHeadshots pins the headshots-by-weapon
// derivation in GetPlayerWeaponJSONs: it counts exactly the headshot
// kills extract would credit to player_stats.headshots/kills_by_weapon
// (enemy kills in counted rounds) and folds them into the same JSON shape
// mergeWeapons consumes.
func TestGetPlayerWeaponJSONsHeadshots(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/weap.dem", "sha-weap", time.Now())
	em := testExtracted("sha-weap", time.Now())
	em.Players = []models.Player{
		{SteamID: "100", Name: "alice", Side: "ct"},
		{SteamID: "200", Name: "bob", Side: "t"},
		{SteamID: "300", Name: "carl", Side: "ct"},
	}
	em.PlayerStats = []models.PlayerStats{
		{SteamID: "100", Side: "ct", Name: "alice", KillsByWeapon: `{"ak47":10}`, DamageByWeapon: `{"ak47":900}`},
	}
	em.RoundSides = []models.RoundPlayerSide{
		{Round: 1, SteamID: "100", Side: "ct"},
		{Round: 1, SteamID: "200", Side: "t"},
		{Round: 1, SteamID: "300", Side: "ct"},
	}
	// Rounds come from testExtracted: number 0 = warmup, 1 = real,
	// number 2 = pregame (knife) — only the real round counts.
	em.Events = []models.Event{
		// Credited: enemy headshot in the counted round.
		{Tick: 10, Round: 1, Kind: models.EventKill, Attacker: "100", Victim: "200", Weapon: "ak47", Headshot: true},
		// Enemy body kill — not a headshot.
		{Tick: 11, Round: 1, Kind: models.EventKill, Attacker: "100", Victim: "200", Weapon: "ak47"},
		// Teamkill headshot (both ct) — extract credits no kill at all.
		{Tick: 12, Round: 1, Kind: models.EventKill, Attacker: "100", Victim: "300", Weapon: "ak47", Headshot: true},
		// Suicide headshot — no credit.
		{Tick: 13, Round: 1, Kind: models.EventKill, Attacker: "100", Victim: "100", Weapon: "ak47", Headshot: true},
		// Warmup round headshot — outside realPeriod.
		{Tick: 14, Round: 0, Kind: models.EventKill, Attacker: "100", Victim: "200", Weapon: "awp", Headshot: true},
		// Pregame (knife) round headshot — outside realPeriod.
		{Tick: 15, Round: 2, Kind: models.EventKill, Attacker: "100", Victim: "200", Weapon: "awp", Headshot: true},
		// Another player's headshot — not alice's.
		{Tick: 16, Round: 1, Kind: models.EventKill, Attacker: "200", Victim: "100", Weapon: "awp", Headshot: true},
	}
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	rows, err := s.GetPlayerWeaponJSONs("100")
	if err != nil {
		t.Fatalf("GetPlayerWeaponJSONs: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(rows))
	}
	if rows[0].KillsByWeapon != `{"ak47":10}` || rows[0].DamageByWeapon != `{"ak47":900}` {
		t.Errorf("kills/damage JSON = %q/%q, want the stored player_stats pair",
			rows[0].KillsByWeapon, rows[0].DamageByWeapon)
	}
	if rows[0].HeadshotsByWeapon != `{"ak47":1}` {
		t.Errorf("headshots JSON = %q, want {\"ak47\":1} (only the credited enemy headshot)", rows[0].HeadshotsByWeapon)
	}
}

func TestSavedFiltersCRUD(t *testing.T) {
	s := openMem(t)
	r1, err := s.CreateSavedFilter("opening deaths", "library", `{"kind":"kill"}`)
	if err != nil {
		t.Fatalf("CreateSavedFilter: %v", err)
	}
	if r1.ID == 0 || r1.Name != "opening deaths" || r1.CreatedAt.IsZero() {
		t.Errorf("row = %+v", r1)
	}
	if _, err := s.CreateSavedFilter("opening deaths", "library", "{}"); err == nil {
		t.Error("duplicate name in same scope: err = nil")
	} else if !strings.Contains(err.Error(), "already exists") {
		t.Errorf("duplicate error = %v, want friendly already-exists message", err)
	}
	// Same name, different scope is allowed.
	if _, err := s.CreateSavedFilter("opening deaths", "match", "{}"); err != nil {
		t.Fatalf("same name other scope: %v", err)
	}
	all, err := s.ListSavedFilters()
	if err != nil || len(all) != 2 {
		t.Fatalf("ListSavedFilters = %+v, %v", all, err)
	}
	if err := s.DeleteSavedFilter(r1.ID); err != nil {
		t.Fatalf("DeleteSavedFilter: %v", err)
	}
	if err := s.DeleteSavedFilter(r1.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("second delete err = %v, want ErrNotFound", err)
	}
}

func TestGetEventsAdvancedFilters(t *testing.T) {
	s := openMem(t)
	id, err := s.CreateMatchRow("/d/f.dem", "sha-adv", 1)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	em := testExtracted("sha-adv", time.Now())
	em.Match.SHA256 = "sha-adv"
	em.Events = []models.Event{
		{Tick: 100, Round: 1, Kind: models.EventKill, Attacker: "100", Victim: "200",
			Weapon: "AK-47", Headshot: true, Distance: 10, Dmg: 100, PosX: pf(5), PosY: pf(-5), PosZ: pf(1)},
		{Tick: 200, Round: 1, Kind: models.EventDamage, Attacker: "200", Victim: "100",
			Weapon: "AWP", Headshot: false, Distance: 50, Dmg: 30, PosX: pf(100), PosY: pf(100)},
		{Tick: 300, Round: 1, Kind: models.EventDamage, Attacker: "100", Victim: "200",
			Weapon: "HE Grenade", Headshot: false, Distance: 5, Dmg: 15, PosX: pf(-100), PosY: pf(-100)},
	}
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	get := func(f models.EventFilter) []models.EventRow {
		t.Helper()
		f.MatchID = id
		rows, err := s.GetEvents(f)
		if err != nil {
			t.Fatalf("GetEvents(%+v): %v", f, err)
		}
		return rows
	}
	if got := get(models.EventFilter{Weapon: "AWP"}); len(got) != 1 || got[0].Tick != 200 {
		t.Errorf("weapon=AWP → %+v", got)
	}
	// Distance is a PARTIAL range over the event's own distance column
	// (units of the hit): either side may be open, 0 = open, and the two
	// bounds AND together. Distances in the fixture: 10, 50, 5.
	if got := get(models.EventFilter{DistanceMax: 12}); len(got) != 2 {
		t.Errorf("distance<=12 → %+v", got)
	}
	if got := get(models.EventFilter{DistanceMin: 10}); len(got) != 2 {
		t.Errorf("distance>=10 (open max) → %+v", got)
	}
	if got := get(models.EventFilter{DistanceMin: 6, DistanceMax: 40}); len(got) != 1 || got[0].Tick != 100 {
		t.Errorf("distance 6..40 → %+v", got)
	}
	if got := get(models.EventFilter{DistanceMin: 60}); len(got) != 0 {
		t.Errorf("distance>=60 (open max) → %+v", got)
	}
	if got := get(models.EventFilter{DistanceMin: 0, DistanceMax: 0}); len(got) != 3 {
		t.Errorf("distance 0/0 = both sides open → %+v", got)
	}
	if got := get(models.EventFilter{HeadshotOnly: true}); len(got) != 1 || !got[0].Headshot {
		t.Errorf("headshot only → %+v", got)
	}
	// BBox: pos_x AND pos_y inside [-10, 10] → only seq 0.
	if got := get(models.EventFilter{BBox: &models.BBox{MinX: -10, MaxX: 10, MinY: -10, MaxY: 10}}); len(got) != 1 || got[0].Tick != 100 {
		t.Errorf("bbox ±10 → %+v", got)
	}
	// Combined: kind=kill + bbox far away → empty.
	if got := get(models.EventFilter{Kind: models.EventKill, BBox: &models.BBox{MinX: 90, MaxX: 110, MinY: 90, MaxY: 110}}); len(got) != 0 {
		t.Errorf("kill+bbox far → %+v", got)
	}
	// Positions still scan out of the extended SELECT.
	if got := get(models.EventFilter{Weapon: "AK-47"}); len(got) != 1 || got[0].PosX == nil || *got[0].PosX != 5 {
		t.Errorf("positions not scanned: %+v", got[0])
	}
}

func TestGetCombatStatsFromStoredRows(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/combat.dem", "sha-combat", time.Now())
	// Events: alice kills bob with 60 on-kill dmg + 40 without; alice FF 10
	// on herself? No — FF needs same-final-side victim: use a third player.
	em := testExtracted("sha-combat", time.Now())
	em.Players = []models.Player{
		{SteamID: "100", Name: "alice", Side: "ct"},
		{SteamID: "200", Name: "bob", Side: "t"},
		{SteamID: "300", Name: "carl", Side: "ct"},
	}
	em.PlayerStats = []models.PlayerStats{
		{SteamID: "100", Name: "alice", Side: "ct", EntryKills: 1, TradeKills: 2, Deaths: 1, RoundsPlayed: 2},
		{SteamID: "200", Name: "bob", Side: "t", Deaths: 1, RoundsPlayed: 2},
	}
	em.Events = []models.Event{
		{Tick: 10, Round: 1, Kind: models.EventKill, Attacker: "100", Victim: "200"},
		{Tick: 10, Round: 1, Kind: models.EventDamage, Attacker: "100", Victim: "200", Dmg: 60},
		{Tick: 20, Round: 1, Kind: models.EventDamage, Attacker: "100", Victim: "200", Dmg: 40},
		{Tick: 30, Round: 1, Kind: models.EventDamage, Attacker: "100", Victim: "300", Dmg: 10}, // FF (both ct)
		// Kill events backing the two untraded engagements below: alice's
		// teammate was 150u from bob's killer on tick 50 (within the 200u
		// distance this test configures → counted) but 500u away on tick 60
		// (beyond → not counted). Decision 4: TradeOppMissed is the
		// proximity-gated subset, UntradedDeaths stays the raw count.
		{Tick: 50, Round: 1, Kind: models.EventKill, Attacker: "100", Victim: "200",
			DetailJSON: `{"killer":"alice","victim":"bob","nearDist":150}`},
		{Tick: 60, Round: 1, Kind: models.EventKill, Attacker: "100", Victim: "200",
			DetailJSON: `{"killer":"alice","victim":"bob","nearDist":500}`},
	}
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	// Pin the proximity gate explicitly: the fixtures below are calibrated
	// to a 200u radius, not to whatever DefaultConfig seeds.
	if _, err := s.SetConfig(models.AnalysisConfig{
		TradeWindowS: 5, EcoFullBuy: 20000, EcoForce: 10000, TradeOppDistance: 200, RuleVersion: 1,
	}); err != nil {
		t.Fatalf("SetConfig (distance 200): %v", err)
	}
	if err := s.ReplacePlayerRounds(id, []models.PlayerRoundStat{
		{Round: 1, SteamID: "100", KAST: true},
	}); err != nil {
		t.Fatalf("ReplacePlayerRounds: %v", err)
	}
	if err := s.ReplaceEngagements(id, []models.Engagement{
		{Tick: 50, Round: 1, Kind: "untraded", ASteam: "100", BSteam: "200"},
		{Tick: 60, Round: 1, Kind: "untraded", ASteam: "100", BSteam: "200"},
		{Tick: 70, Round: 1, Kind: "opening", ASteam: "100", BSteam: "200"},
	}); err != nil {
		t.Fatalf("ReplaceEngagements: %v", err)
	}
	rows, err := s.GetCombatStats(id)
	if err != nil {
		t.Fatalf("GetCombatStats: %v", err)
	}
	var alice *models.CombatStat
	for i := range rows {
		if rows[i].SteamID == "100" {
			alice = &rows[i]
		}
	}
	if alice == nil {
		t.Fatalf("no alice row in %+v", rows)
	}
	if alice.DMGNoKill != 50 {
		t.Errorf("dmgNoKill = %d, want 50 (110 total − 60 on-kill)", alice.DMGNoKill)
	}
	if alice.DMGConvPct < 54.5 || alice.DMGConvPct > 54.6 {
		t.Errorf("dmgConvPct = %v, want ~54.55", alice.DMGConvPct)
	}
	if alice.FFDamage != 10 {
		t.Errorf("ffDamage = %d, want 10", alice.FFDamage)
	}
	// Percent scale decision: every percent field of a CombatStat row is
	// 0..100 (DMGConvPct ~54.55 above, KASTPct 100 below), so EntryRate =
	// 100 × 1 entry kill / 2 rounds = 50 and TradeRate = 100 × 2 trades /
	// 1 death = 200 (a ratio over own deaths — allowed above 100). These
	// were 0..1 fractions before (0.5/2.0), which the Combat tab's
	// fmtPercent rendered as "0.5%"/"2%" instead of "50%"/"200%".
	if alice.EntryRate != 50 || alice.TradeRate != 200 {
		t.Errorf("entry/trade rate = %v/%v, want 50/200 (0..100 percent scale, like dmgConvPct/kastPct)",
			alice.EntryRate, alice.TradeRate)
	}
	if alice.KASTPct != 100 {
		t.Errorf("kastPct = %v, want 100", alice.KASTPct)
	}
	// Untraded rows attribute to victim 200 (bob), not alice. Decision 4:
	// UntradedDeaths is the raw timing count (2), TradeOppMissed only the
	// proximity-gated subset (1 — the 150u death; the 500u one is beyond
	// the configured 200u radius).
	var bob *models.CombatStat
	for i := range rows {
		if rows[i].SteamID == "200" {
			bob = &rows[i]
		}
	}
	if bob == nil {
		t.Fatalf("no bob row in %+v", rows)
	}
	if bob.UntradedDeaths != 2 {
		t.Errorf("bob untraded = %d, want 2 (raw timing count)", bob.UntradedDeaths)
	}
	if bob.TradeOppMissed != 1 {
		t.Errorf("bob tradeOppMissed = %d, want 1 (only the 150u death is within 200u)", bob.TradeOppMissed)
	}
}

// TestGetCombatStatsSQLDecisions pins the decisions in the
// GetCombatStats doc comment — the single implementation of these rules.
func TestGetCombatStatsSQLDecisions(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/combat2.dem", "sha-combat2", time.Now())
	em := testExtracted("sha-combat2", time.Now())
	// Names deliberately sort differently from SteamIDs (ORDER BY name).
	em.Players = []models.Player{
		{SteamID: "100", Name: "zoe", Side: "ct"},
		{SteamID: "200", Name: "amy", Side: "t"},
		{SteamID: "300", Name: "carl", Side: "ct"},
		{SteamID: "400", Name: "dave", Side: ""}, // unknown side
		{SteamID: "500", Name: "erin", Side: ""}, // unknown side
	}
	em.PlayerStats = []models.PlayerStats{
		{SteamID: "100", Name: "zoe", Side: "ct", RoundsPlayed: 2},
		{SteamID: "200", Name: "amy", Side: "t", RoundsPlayed: 2},
		{SteamID: "300", Name: "carl", Side: "ct", RoundsPlayed: 2},
		{SteamID: "400", Name: "dave", Side: "", RoundsPlayed: 2},
		{SteamID: "500", Name: "erin", Side: "", RoundsPlayed: 2},
	}
	em.Events = []models.Event{
		// (1) Friendly fire with BOTH sides unknown: ap.side = vp.side
		// matches '' = '' → counted.
		{Tick: 100, Round: 1, Kind: models.EventDamage, Attacker: "400", Victim: "500", Dmg: 10},
		// (2) Damage whose victim dies the same tick from a DIFFERENT
		// attacker: the kill must match attacker+victim+tick, so this stays
		// damage-without-kill.
		{Tick: 200, Round: 1, Kind: models.EventDamage, Attacker: "100", Victim: "200", Dmg: 50},
		{Tick: 200, Round: 1, Kind: models.EventKill, Attacker: "300", Victim: "200"},
		// (3) Same attacker+victim+tick → on-kill damage.
		{Tick: 300, Round: 1, Kind: models.EventDamage, Attacker: "100", Victim: "200", Dmg: 40},
		{Tick: 300, Round: 1, Kind: models.EventKill, Attacker: "100", Victim: "200"},
	}
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	rows, err := s.GetCombatStats(id)
	if err != nil {
		t.Fatalf("GetCombatStats: %v", err)
	}
	// (3) Ordering is by NAME, not SteamID.
	if len(rows) != 5 {
		t.Fatalf("rows = %d, want 5", len(rows))
	}
	wantOrder := []string{"200", "300", "400", "500", "100"}
	for i, sid := range wantOrder {
		if rows[i].SteamID != sid {
			t.Fatalf("row %d steam = %q, want %q (ORDER BY p.name)", i, rows[i].SteamID, sid)
		}
	}
	byID := map[string]models.CombatStat{}
	for _, r := range rows {
		byID[r.SteamID] = r
	}
	if zoe := byID["100"]; zoe.DMGNoKill != 50 {
		t.Errorf("zoe dmgNoKill = %d, want 50 (90 total − 40 same-attacker on-kill)", zoe.DMGNoKill)
	}
	if dave := byID["400"]; dave.FFDamage != 10 || dave.DMGNoKill != 10 {
		t.Errorf("dave ff/noKill = %d/%d, want 10/10 ('' == '' counts as FF)", dave.FFDamage, dave.DMGNoKill)
	}

	// (4) TradeOppMissed is proximity-gated by analysis_config.
	//     trade_opp_distance (pinned to 200 here, independent of the
	//     default): the untraded engagement must join to its kill event's
	//     detail_json.nearDist within [0, dist]. -1 (extract's "nobody
	//     measurable" sentinel), a missing kill event, malformed JSON and
	//     an absent nearDist key all fail the gate; UntradedDeaths counts
	//     every untraded row regardless. A wider configured distance pulls
	//     in the beyond-range death.
	em2 := testExtracted("sha-combat2", time.Now())
	em2.Events = []models.Event{
		{Tick: 400, Round: 1, Kind: models.EventKill, Attacker: "100", Victim: "200",
			DetailJSON: `{"nearDist":150}`}, // within 200 → counted
		{Tick: 410, Round: 1, Kind: models.EventKill, Attacker: "100", Victim: "200",
			DetailJSON: `{"nearDist":500}`}, // beyond 200 → not counted
		{Tick: 420, Round: 1, Kind: models.EventKill, Attacker: "100", Victim: "200",
			DetailJSON: `{"nearDist":-1}`}, // sentinel → not counted
		{Tick: 430, Round: 1, Kind: models.EventKill, Attacker: "100", Victim: "200",
			DetailJSON: `{"killer":"x"}`}, // no nearDist key → not counted
		{Tick: 440, Round: 1, Kind: models.EventKill, Attacker: "100", Victim: "200",
			DetailJSON: `{not json`}, // malformed → json_valid guards → not counted
		// tick 450: no kill event at all → not counted
	}
	if err := s.SaveExtracted(id, em2); err != nil {
		t.Fatalf("SaveExtracted (gating): %v", err)
	}
	if err := s.ReplaceEngagements(id, []models.Engagement{
		{Tick: 400, Round: 1, Kind: "untraded", ASteam: "100", BSteam: "200"},
		{Tick: 410, Round: 1, Kind: "untraded", ASteam: "100", BSteam: "200"},
		{Tick: 420, Round: 1, Kind: "untraded", ASteam: "100", BSteam: "200"},
		{Tick: 430, Round: 1, Kind: "untraded", ASteam: "100", BSteam: "200"},
		{Tick: 440, Round: 1, Kind: "untraded", ASteam: "100", BSteam: "200"},
		{Tick: 450, Round: 1, Kind: "untraded", ASteam: "100", BSteam: "200"},
	}); err != nil {
		t.Fatalf("ReplaceEngagements (gating): %v", err)
	}
	// Pin the 200u gate before reading: the fixture's 150u/500u deaths
	// are calibrated to that radius, not to the seeded default.
	if _, err := s.SetConfig(models.AnalysisConfig{
		TradeWindowS: 5, EcoFullBuy: 20000, EcoForce: 10000, TradeOppDistance: 200, RuleVersion: 1,
	}); err != nil {
		t.Fatalf("SetConfig (distance 200): %v", err)
	}
	gated, err := s.GetCombatStats(id)
	if err != nil {
		t.Fatalf("GetCombatStats (gated): %v", err)
	}
	var gatedAmy *models.CombatStat
	for i := range gated {
		if gated[i].SteamID == "200" {
			gatedAmy = &gated[i]
		}
	}
	if gatedAmy == nil {
		t.Fatalf("no amy row in %+v", gated)
	}
	if gatedAmy.UntradedDeaths != 6 {
		t.Errorf("amy untraded = %d, want 6 (raw count is never gated)", gatedAmy.UntradedDeaths)
	}
	if gatedAmy.TradeOppMissed != 1 {
		t.Errorf("amy tradeOppMissed = %d, want 1 (only nearDist=150 passes the 200u gate)", gatedAmy.TradeOppMissed)
	}
	// Widen the configured distance → the 500u death joins the count; the
	// -1/keyless/malformed/no-event rows still never count.
	if _, err := s.SetConfig(models.AnalysisConfig{
		TradeWindowS: 5, EcoFullBuy: 20000, EcoForce: 10000, TradeOppDistance: 600, RuleVersion: 1,
	}); err != nil {
		t.Fatalf("SetConfig (distance 600): %v", err)
	}
	wide, err := s.GetCombatStats(id)
	if err != nil {
		t.Fatalf("GetCombatStats (wide): %v", err)
	}
	for i := range wide {
		if wide[i].SteamID == "200" && wide[i].TradeOppMissed != 2 {
			t.Errorf("amy tradeOppMissed @600u = %d, want 2 (150 and 500 pass; -1/keyless/malformed/no-event never do)",
				wide[i].TradeOppMissed)
		}
	}
	// A zero distance counts only a teammate exactly on the killer.
	if _, err := s.SetConfig(models.AnalysisConfig{
		TradeWindowS: 5, EcoFullBuy: 20000, EcoForce: 10000, TradeOppDistance: 0, RuleVersion: 1,
	}); err != nil {
		t.Fatalf("SetConfig (distance 0): %v", err)
	}
	tight, err := s.GetCombatStats(id)
	if err != nil {
		t.Fatalf("GetCombatStats (tight): %v", err)
	}
	for i := range tight {
		if tight[i].SteamID == "200" && tight[i].TradeOppMissed != 0 {
			t.Errorf("amy tradeOppMissed @0u = %d, want 0 (no death has nearDist in [0,0])", tight[i].TradeOppMissed)
		}
	}
}

func TestDeleteMatchRebuildsCareer(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/del.dem", "sha-del", time.Now())
	if err := s.RebuildCareer(); err != nil {
		t.Fatalf("RebuildCareer: %v", err)
	}
	if _, err := s.GetCareer("100"); err != nil {
		t.Fatalf("GetCareer before delete: %v", err)
	}
	if err := s.DeleteMatchData(id); err != nil {
		t.Fatalf("DeleteMatchData: %v", err)
	}
	if _, err := s.GetCareer("100"); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetCareer after delete err = %v, want ErrNotFound (career rebuilt without the deleted match)", err)
	}
}
