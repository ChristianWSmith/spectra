package main

import (
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// oppositeSide is the fixture's other side ("ct" ⇄ "t").
func oppositeSide(side string) string {
	if side == "ct" {
		return "t"
	}
	return "ct"
}

// newProfileFixture opens an in-memory store with TWO extracted matches
// for the same player (alice: ct in match 1 with 10k/5d, t in match 2
// with 4k/0d) plus the credited/teamkill/round-less kill events behind the
// weapon breakdowns, three tradeable teammate deaths per match behind the
// trade-opportunity denominator, and one player_round_stats row per match
// behind the Sides card, then returns a ProfileService over it.
func newProfileFixture(t *testing.T) *ProfileService {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	save := func(n int, side string, kills, deaths, creditedHS int, byWeapon string) {
		t.Helper()
		sha := "sha-profile"
		path := "/d/profile.dem"
		if n == 2 {
			sha, path = "sha-profile2", "/d/profile2.dem"
		}
		id, err := st.CreateMatchRow(path, sha, 42)
		if err != nil {
			t.Fatalf("CreateMatchRow: %v", err)
		}
		// Credited kills: alice (100) headshots bob (200, enemy) N times
		// with the ak47 in the counted round, plus one teamkill headshot
		// on carl (300, same side) that extract never credits.
		events := make([]models.Event, 0, creditedHS+2)
		for i := 0; i < creditedHS; i++ {
			events = append(events, models.Event{
				Tick: 100 + i, Round: 1, Kind: models.EventKill,
				Attacker: "100", Victim: "200", Weapon: "ak47", Headshot: true,
			})
		}
		// Trade opportunities: bob kills alice's teammates carl/dave/eve
		// in the counted round with a measurable nearDist inside the
		// default 1000u trade-opportunity distance — three opportunities
		// for alice per match (she is alive and on the victim's side in
		// round 1). The kill events are what analytics.Compute gates on
		// when it WRITES match_trade_opps; this fixture seeds the row
		// that pass produces (the store test pins the SUM read, the
		// analytics equivalence test pins the gating) — see
		// TestGetProfileTradeRatePercent for the total.
		for i, victim := range []string{"300", "400", "500"} {
			events = append(events, models.Event{
				Tick: 150 + 10*i, Round: 1, Kind: models.EventKill,
				Attacker: "200", Victim: victim,
				DetailJSON: `{"killer":"bob","victim":"victim","nearDist":500}`,
			})
		}
		events = append(events,
			models.Event{ // teamkill headshot — no credit anywhere
				Tick: 200, Round: 1, Kind: models.EventKill,
				Attacker: "100", Victim: "300", Weapon: "ak47", Headshot: true,
			},
			models.Event{ // headshot stamped to a round with no round row
				// (a discarded round — the extractor never stores one): the
				// rounds JOIN in GetPlayerWeaponJSONs drops it, exactly the
				// exclusion the old warmup flag used to provide.
				Tick: 50, Round: 0, Kind: models.EventKill,
				Attacker: "100", Victim: "200", Weapon: "awp", Headshot: true,
			},
		)
		em := &models.ExtractedMatch{
			Match: models.Match{
				Path: path, SHA256: sha, Size: 42,
				Map: "de_dust2", TickRate: 64, RealRounds: 24,
				ScoreCT: 13, ScoreT: 10,
				ExtractedAt: time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC).Add(time.Duration(n) * time.Hour),
			},
			Players: []models.Player{
				{SteamID: "100", Name: "alice", Side: side},
				{SteamID: "200", Name: "bob", Side: oppositeSide(side)},
				{SteamID: "300", Name: "carl", Side: side},
				{SteamID: "400", Name: "dave", Side: side},
				{SteamID: "500", Name: "eve", Side: side},
			},
			PlayerStats: []models.PlayerStats{
				{SteamID: "100", Side: side, Name: "alice",
					Kills: kills, Deaths: deaths, Headshots: creditedHS,
					ADR: 80, HSPct: 60, RoundsPlayed: 24,
					// Trade kills feed career.Trades → the profile's Trade
					// rate card (TestGetProfileTradeRatePercent pins the
					// percent scale of that card).
					TradeKills: 2,
					// The two per-match averages (TestGetProfileAverages):
					// match 1 reads 8 flashed / 120 util, match 2 4 / 60.
					EnemiesFlashed: 8 - 4*(n-1),
					UtilityDamage:  120 - 60*(n-1),
					KillsByWeapon:  byWeapon, DamageByWeapon: `{"ak47":900}`},
			},
			Rounds: []models.Round{
				{Number: 1, Winner: "ct", StartTick: 100, EndTick: 5000},
			},
			RoundSides: []models.RoundPlayerSide{
				{Round: 1, SteamID: "100", Side: side},
				{Round: 1, SteamID: "200", Side: oppositeSide(side)},
				{Round: 1, SteamID: "300", Side: side},
				{Round: 1, SteamID: "400", Side: side},
				{Round: 1, SteamID: "500", Side: side},
			},
			Events: events,
		}
		if err := st.SaveExtracted(id, em); err != nil {
			t.Fatalf("SaveExtracted: %v", err)
		}
		// The stored trade-opportunity rows analytics.Compute writes for
		// alice here: three tradeable teammate deaths per match under the
		// default distance (nearDist 500 ≤ 1000) — the profile reads them
		// through store.CountPlayerTradeOpportunities (SUM over
		// match_trade_opps).
		if err := st.ReplaceTradeOpps(id, map[string]int{"100": 3}, nil); err != nil {
			t.Fatalf("ReplaceTradeOpps: %v", err)
		}
		// One counted round of per-round stats — the Sides card's rows
		// (store.GetPlayerSideSplits). Alice plays it on `side`: match 1
		// is the CT round (won — round 1's winner = "ct"), match 2 the T
		// round (lost).
		roundStats := models.PlayerRoundStat{
			Round: 1, SteamID: "100", Name: "alice", KAST: n == 1, RuleVersion: 1,
		}
		if n == 1 {
			roundStats.Kills, roundStats.Deaths, roundStats.DMG = 5, 2, 600
		} else {
			roundStats.Kills, roundStats.Deaths, roundStats.DMG = 4, 0, 300
		}
		if err := st.ReplacePlayerRounds(id, []models.PlayerRoundStat{roundStats}); err != nil {
			t.Fatalf("ReplacePlayerRounds: %v", err)
		}
	}
	save(1, "ct", 10, 5, 3, `{"ak47":10}`)
	save(2, "t", 4, 0, 1, `{"ak47":4}`)
	if err := st.RebuildCareer(); err != nil {
		t.Fatalf("RebuildCareer: %v", err)
	}
	return &ProfileService{st: st}
}

// TestGetProfileSidesKD: the Sides table is a PER-ROUND split (players
// switch sides at halftime, so one row per match side would mix both
// halves): alice plays counted round 1 on ct in match 1 (won, 5k/2d)
// and on t in match 2 (lost, 4k/0d) — one round per side. K/D comes from
// the same player_round_stats rows as Rounds/ADR/KAST with the career
// rollup's floor (kdCareerSQL: SUM(kills) / MAX(SUM(deaths), 1)), never
// a division-by-zero/empty-side 0.
func TestGetProfileSidesKD(t *testing.T) {
	svc := newProfileFixture(t)
	p, err := svc.GetProfile("100")
	if err != nil {
		t.Fatalf("GetProfile: %v", err)
	}
	if len(p.Sides) != 2 {
		t.Fatalf("sides = %+v, want ct and t rows", p.Sides)
	}
	bySide := map[string]ProfileSide{}
	for _, s := range p.Sides {
		bySide[s.Side] = s
	}
	ct, tside := bySide["ct"], bySide["t"]
	if ct.Rounds != 1 || tside.Rounds != 1 {
		t.Errorf("rounds = %d/%d, want 1/1 (one counted round per side)", ct.Rounds, tside.Rounds)
	}
	// Round wins: round 1's winner is "ct", so the CT row won its round
	// and the T row did not — per-round, not per match.
	if ct.RoundWinPct < 99.9 || ct.RoundWinPct > 100.1 || tside.RoundWinPct != 0 {
		t.Errorf("roundWinPct ct/t = %v/%v, want 100/0", ct.RoundWinPct, tside.RoundWinPct)
	}
	if kd := ct.KD; kd < 2.49 || kd > 2.51 {
		t.Errorf("ct KD = %v, want 2.5 (5 kills / 2 deaths)", kd)
	}
	// Zero-death side: the denominator floors at 1 (kdCareerSQL's shape).
	if kd := tside.KD; kd < 3.99 || kd > 4.01 {
		t.Errorf("t KD = %v, want 4.0 (4 kills / max(0 deaths, 1))", kd)
	}
	if ct.ADR < 599.9 || ct.ADR > 600.1 || tside.ADR < 299.9 || tside.ADR > 300.1 {
		t.Errorf("ADR ct/t = %v/%v, want 600/300 (player_round_stats.dmg ÷ rounds)", ct.ADR, tside.ADR)
	}
	if ct.KASTPct < 99.9 || ct.KASTPct > 100.1 || tside.KASTPct != 0 {
		t.Errorf("kastPct ct/t = %v/%v, want 100/0 (kast 0/1 → ×100)", ct.KASTPct, tside.KASTPct)
	}
}

// TestGetProfileTradeRatePercent pins the SCALE and the FORMULA of the
// profile's Trade rate card: 100 × successful trades ÷ trade
// opportunities (0..100 percent, like every other *Pct/*Rate field on
// the Profile DTO — the value fmtPercent renders directly). The fixture's
// alice has 2 career trades per match (4 total) over 3 tradeable
// teammate deaths per match (6 opportunities), so the card must show
// 66.7%, NOT the old 4 trades ÷ 5 own deaths (80%).
func TestGetProfileTradeRatePercent(t *testing.T) {
	svc := newProfileFixture(t)
	p, err := svc.GetProfile("100")
	if err != nil {
		t.Fatalf("GetProfile: %v", err)
	}
	if p.Trades != 4 || p.TradeOpps != 6 {
		t.Errorf("trades/opportunities = %d/%d, want 4/6 (2 trades × 2 matches, 3 teammate deaths × 2 matches)",
			p.Trades, p.TradeOpps)
	}
	if p.TradeRate < 66.6 || p.TradeRate > 66.7 {
		t.Errorf("tradeRate = %v, want ~66.67 (4 ÷ 6 ×100)", p.TradeRate)
	}
}

// TestGetProfileAverages: the two per-match average cards read
// player_stats.enemies_flashed / utility_damage averaged over the
// player's matches — match 1 stores 8/120, match 2 stores 4/60, so the
// cards must show 6 and 90 (per match, not career sums).
func TestGetProfileAverages(t *testing.T) {
	svc := newProfileFixture(t)
	p, err := svc.GetProfile("100")
	if err != nil {
		t.Fatalf("GetProfile: %v", err)
	}
	if p.AvgEnemiesFlashed < 5.99 || p.AvgEnemiesFlashed > 6.01 {
		t.Errorf("avgEnemiesFlashed = %v, want 6 ((8+4)/2)", p.AvgEnemiesFlashed)
	}
	if p.AvgUtilDamage < 89.9 || p.AvgUtilDamage > 90.1 {
		t.Errorf("avgUtilDamage = %v, want 90 ((120+60)/2)", p.AvgUtilDamage)
	}
}

// TestGetProfileHistoryStartingSide: the match history's side cell is the
// side the player STARTED the match on (the first counted round's
// freeze-end sample), while Win still derives from the final side
// (models.WinFor over player_stats.side) — different facts after
// halftime: alice opens match 1 on ct (win) and match 2 on t (loss), and
// the most recent match comes first.
func TestGetProfileHistoryStartingSide(t *testing.T) {
	svc := newProfileFixture(t)
	p, err := svc.GetProfile("100")
	if err != nil {
		t.Fatalf("GetProfile: %v", err)
	}
	if len(p.History) != 2 {
		t.Fatalf("history = %+v, want 2 rows", p.History)
	}
	if p.History[0].StartSide != "t" || p.History[1].StartSide != "ct" {
		t.Errorf("startSide = %q/%q, want t (match 2) then ct (match 1)",
			p.History[0].StartSide, p.History[1].StartSide)
	}
	if p.History[0].Win || !p.History[1].Win {
		t.Errorf("win = %v/%v, want false/true (final side vs 13–10)", p.History[0].Win, p.History[1].Win)
	}
}

// TestGetProfileWeaponsAndCareer: the Weapons table folds per-weapon
// headshots from the stored kill events alongside kills/damage, and the
// career K/D + HS% StatCards read the non-zero player_career rollup.
func TestGetProfileWeaponsAndCareer(t *testing.T) {
	svc := newProfileFixture(t)
	p, err := svc.GetProfile("100")
	if err != nil {
		t.Fatalf("GetProfile: %v", err)
	}
	if p.KD <= 0 || p.HSPct <= 0 {
		t.Errorf("career kd/hsPct = %v/%v, want both > 0", p.KD, p.HSPct)
	}
	if len(p.Weapons) == 0 {
		t.Fatal("no weapon rows")
	}
	var ak *ProfileWeapon
	for i := range p.Weapons {
		if p.Weapons[i].Weapon == "ak47" {
			ak = &p.Weapons[i]
		}
	}
	if ak == nil {
		t.Fatalf("no ak47 row in %+v", p.Weapons)
	}
	if ak.Kills != 14 {
		t.Errorf("ak47 kills = %d, want 14 (10 + 4 across the two matches)", ak.Kills)
	}
	if ak.Headshots != 4 {
		t.Errorf("ak47 headshots = %d, want 4 (3 + 1 credited enemy headshots; teamkill/round-less excluded)", ak.Headshots)
	}
	if ak.Headshots > ak.Kills {
		t.Errorf("ak47 headshots %d > kills %d", ak.Headshots, ak.Kills)
	}
}
