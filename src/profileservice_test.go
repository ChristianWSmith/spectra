package main

import (
	"encoding/json"
	"strings"
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
// with 4k/0d) plus the credited/teamkill/round-less kill events behind
// the weapon breakdowns and one player_round_stats row per match behind
// the Sides card, then returns a ProfileService over it.
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
		// Trade-opportunity kills (bob takes out alice's teammates
		// carl/dave/eve) are deliberately ABSENT: the profile's Trade
		// rate card converted to the career_trade_rate metric in
		// dogfooding W3, the DTO no longer carries trade rate counts,
		// and nothing in this fixture reads match_trade_opps any more —
		// internal/analytics' trade-opps tests pin that stored write.
		// carl/dave/eve stay in the roster so the side-split fixture
		// keeps a full team.
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
					KillsByWeapon: byWeapon, DamageByWeapon: `{"ak47":900}`},
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

// TestGetProfileDesignedHybrid pins the DTO contract dogfooding design
// §3.5 leaves behind — the audit's §5.2.5 prediction made literal: the
// raw/inferred and non-expressible stats (N2–N6) STAY on the Go DTO and
// the nine converted stats are GONE from it. The profile reads those as
// stored metric rows through the canonical career read (the "Career
// metrics" panel), so a reintroduced field here would be exactly the
// second presentation path the conversion removes — the JSON key SET is
// the contract, checked both ways.
func TestGetProfileDesignedHybrid(t *testing.T) {
	svc := newProfileFixture(t)
	p, err := svc.GetProfile("100")
	if err != nil {
		t.Fatalf("GetProfile: %v", err)
	}
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatalf("marshal profile: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal profile: %v", err)
	}
	staying := []string{
		"steamId", "name", "matches", "wins", "winPct", "openingRate",
		"clutches", "sides", "maps", "weapons", "history",
	}
	converted := []string{
		"adrAvg", "adrStd", "kd", "hsPct", "kastPct", "tradeRate",
		"trades", "tradeOpps", "clutchWinPct", "avgEnemiesFlashed",
		"avgUtilDamage",
	}
	for _, k := range staying {
		if _, ok := got[k]; !ok {
			t.Errorf("staying field %q missing from the Profile DTO: %s", k, raw)
		}
	}
	for _, k := range converted {
		if _, ok := got[k]; ok {
			t.Errorf("converted field %q is back on the Profile DTO (second presentation path): %s", k, raw)
		}
	}
	if len(got) != len(staying) {
		t.Errorf("Profile DTO carries %d fields, want exactly the %d staying ones: %s",
			len(got), len(staying), raw)
	}
	// The staying Go stats are still REAL values, not zeros: two
	// matches, one win (alice's ct match), 50%.
	if p.Matches != 2 || p.Wins != 1 || p.WinPct < 49.9 || p.WinPct > 50.1 {
		t.Errorf("matches/wins/winPct = %d/%d/%v, want 2/1/50", p.Matches, p.Wins, p.WinPct)
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
	// The ADR/KAST cells read STORED metric rows (D13). This fixture
	// never runs the metric sweep, so both are absent — the honest nil
	// the profile renders as "—", never a fabricated 0.
	for i, h := range p.History {
		if h.ADR != nil || h.KASTPct != nil {
			t.Errorf("history[%d] adr/kast = %v/%v, want nil with no stored metric rows",
				i, h.ADR, h.KASTPct)
		}
	}
}

// TestGetProfileWeapons: the Weapons table folds per-weapon headshots
// from the stored kill events alongside kills/damage. (The career K/D +
// HS% StatCards this test used to check left with those fields — the
// profile reads them as metric rows now; the rollup itself is pinned by
// the store's TestCareerRebuildMath.)
func TestGetProfileWeapons(t *testing.T) {
	svc := newProfileFixture(t)
	p, err := svc.GetProfile("100")
	if err != nil {
		t.Fatalf("GetProfile: %v", err)
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

// TestListPlayersCarriesNoADR pins dogfooding W4's removal on the
// service DTO: the picker rows carry identity + recency ONLY. The ADR
// the player suggestions and the report picker render comes from the
// stored `career_adr` metric rows (frontend services.careerAdrRows —
// the canonical career read), so no Go-computed ADR may survive here,
// not even as a field name — while RebuildCareer keeps WRITING
// player_career.adr_avg (Q4's dual-write) and store.ListPlayers stops
// selecting it.
func TestListPlayersCarriesNoADR(t *testing.T) {
	svc := newProfileFixture(t)
	rows, err := svc.ListPlayers("")
	if err != nil {
		t.Fatalf("ListPlayers: %v", err)
	}
	if len(rows) == 0 {
		t.Fatal("ListPlayers returned no rows (fixture ran RebuildCareer)")
	}
	raw, err := json.Marshal(rows)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(raw), "adrAvg") {
		t.Errorf("picker rows still carry an ADR field (second presentation path): %s", raw)
	}
	found := false
	for _, r := range rows {
		if r.Name == "alice" {
			found = true
			if r.Matches != 2 {
				t.Errorf("alice matches = %d, want 2", r.Matches)
			}
		}
	}
	if !found {
		t.Errorf("alice missing from %s", raw)
	}
}
