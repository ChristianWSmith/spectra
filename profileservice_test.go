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
// with 4k/0d) plus the credited/teamkill/warmup kill events behind the
// weapon breakdowns, and returns a ProfileService over it.
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
		events = append(events,
			models.Event{ // teamkill headshot — no credit anywhere
				Tick: 200, Round: 1, Kind: models.EventKill,
				Attacker: "100", Victim: "300", Weapon: "ak47", Headshot: true,
			},
			models.Event{ // warmup headshot — outside realPeriod
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
			},
			PlayerStats: []models.PlayerStats{
				{SteamID: "100", Side: side, Name: "alice",
					Kills: kills, Deaths: deaths, Headshots: creditedHS,
					ADR: 80, HSPct: 60, RoundsPlayed: 24,
					// Trade kills feed career.Trades → the profile's Trade
					// rate card (TestGetProfileTradeRatePercent pins the
					// percent scale of that card).
					TradeKills:    2,
					KillsByWeapon: byWeapon, DamageByWeapon: `{"ak47":900}`},
			},
			Rounds: []models.Round{
				{Number: 0, Warmup: true},
				{Number: 1, Winner: "ct", StartTick: 100, EndTick: 5000},
			},
			RoundSides: []models.RoundPlayerSide{
				{Round: 1, SteamID: "100", Side: side},
				{Round: 1, SteamID: "200", Side: oppositeSide(side)},
				{Round: 1, SteamID: "300", Side: side},
			},
			Events: events,
		}
		if err := st.SaveExtracted(id, em); err != nil {
			t.Fatalf("SaveExtracted: %v", err)
		}
	}
	save(1, "ct", 10, 5, 3, `{"ak47":10}`)
	save(2, "t", 4, 0, 1, `{"ak47":4}`)
	if err := st.RebuildCareer(); err != nil {
		t.Fatalf("RebuildCareer: %v", err)
	}
	return &ProfileService{st: st}
}

// TestGetProfileSidesKD: the Sides table's K/D column comes from the same
// history rows as its Matches/Wins/ADR — pooled kills / deaths per side
// with the career rollup's floor (kdCareerSQL: SUM(kills) /
// MAX(SUM(deaths), 1)), never a division-by-zero/empty-side 0.
func TestGetProfileSidesKD(t *testing.T) {
	svc := newProfileFixture(t)
	p, err := svc.GetProfile("100")
	if err != nil {
		t.Fatalf("GetProfile: %v", err)
	}
	if len(p.Sides) != 2 {
		t.Fatalf("sides = %+v, want ct and t rows", p.Sides)
	}
	bySide := map[string]float64{}
	for _, s := range p.Sides {
		bySide[s.Side] = s.KD
	}
	if kd := bySide["ct"]; kd < 1.99 || kd > 2.01 {
		t.Errorf("ct KD = %v, want 2.0 (10 kills / 5 deaths)", kd)
	}
	// Zero-death side: the denominator floors at 1 (kdCareerSQL's shape).
	if kd := bySide["t"]; kd < 3.99 || kd > 4.01 {
		t.Errorf("t KD = %v, want 4.0 (4 kills / max(0 deaths, 1))", kd)
	}
}

// TestGetProfileTradeRatePercent pins the SCALE of the profile's career
// Trade rate card: 0..100 percent, like every other *Pct/*Rate field on
// the Profile DTO (WinPct, KASTPct, OpeningRate, ClutchWinPct are all
// ×100 right beside it) — the scale fmtPercent renders directly. The
// fixture's alice has 2 career trades per match (4 total) over 5 career
// deaths, so the card must show 80%, not a 0..1 fraction rendered as
// "0.8%" (the pre-fix value).
func TestGetProfileTradeRatePercent(t *testing.T) {
	svc := newProfileFixture(t)
	p, err := svc.GetProfile("100")
	if err != nil {
		t.Fatalf("GetProfile: %v", err)
	}
	if p.TradeRate < 79.9 || p.TradeRate > 80.1 {
		t.Errorf("tradeRate = %v, want 80 (4 career trades / 5 deaths ×100)", p.TradeRate)
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
		t.Errorf("ak47 headshots = %d, want 4 (3 + 1 credited enemy headshots; teamkill/warmup excluded)", ak.Headshots)
	}
	if ak.Headshots > ak.Kills {
		t.Errorf("ak47 headshots %d > kills %d", ak.Headshots, ak.Kills)
	}
}
