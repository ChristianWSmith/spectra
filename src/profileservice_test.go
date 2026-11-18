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
					KillsByWeapon: byWeapon},
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

// TestGetProfileDesignedHybrid pins the DTO contract dogfooding design
// §3.5 leaves behind — the audit's §5.2.5 prediction made literal: the
// raw/inferred and non-expressible stats (N2–N6) STAY on the Go DTO and
// every converted stat is GONE from it (the dogfood nine plus W3a's
// Clutches count and Opening-duels rate). The profile reads those as
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
	// sides/maps left with the M5/M6 read migration (2026-11-17): the
	// partitioned seeds serve those tables through the frontend's
	// stored-value read, never this DTO. weapons left the same way with
	// the M7 weapon migration (2026-11-18): the Weapons table reads the
	// weapon_* seed rows.
	staying := []string{
		"steamId", "name", "matches", "wins", "winPct",
		"history",
	}
	converted := []string{
		"adrAvg", "adrStd", "kd", "hsPct", "kastPct", "tradeRate",
		"trades", "tradeOpps", "clutchWinPct", "avgEnemiesFlashed",
		"avgUtilDamage",
		// W3a: the last two presentation paths — the Clutches count and
		// the Opening-duels rate — became career_clutches /
		// career_opening_rate metric rows, so their JSON keys die here
		// exactly like the eleven above.
		"clutches", "openingRate",
		// M7 (2026-11-18): the per-weapon triple became the weapon_*
		// partitioned seed rows, so the JSON fold's key dies here too.
		"weapons",
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
	// W3a's history half rides the same key-set pin: the A half of the
	// K/D/A triple is the STORED `assists` metric row now, so the history
	// row keeps its `assists` key but it goes NULLABLE (nil → JSON null
	// → the profile's "—"), never the raw integer the select used to
	// carry. This fixture runs no metric sweep, so every row is null.
	if len(p.History) == 0 {
		t.Fatalf("history = %+v, want the fixture's 2 rows", p.History)
	}
	var histRows []map[string]any
	histJSON, err := json.Marshal(p.History)
	if err != nil {
		t.Fatalf("marshal history: %v", err)
	}
	if err := json.Unmarshal(histJSON, &histRows); err != nil {
		t.Fatalf("unmarshal history: %v", err)
	}
	for i, r := range histRows {
		v, ok := r["assists"]
		if !ok {
			t.Errorf("history[%d] carries no %q key (the metric-backed A half): %s", i, "assists", r)
		}
		if v != nil {
			t.Errorf("history[%d] assists = %v, want null with no stored metric rows (nil → the profile's —)", i, v)
		}
		if _, raw := r["kills"]; !raw {
			t.Errorf("history[%d] lost its raw K/D columns: %s", i, r)
		}
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
	// The Assists/ADR/KAST cells read STORED metric rows (D13 for
	// ADR/KAST, W3a for the triple's A half). This fixture never runs the
	// metric sweep, so all three are absent — the honest nil the profile
	// renders as "—", never a fabricated 0.
	for i, h := range p.History {
		if h.Assists != nil || h.ADR != nil || h.KASTPct != nil {
			t.Errorf("history[%d] assists/adr/kast = %v/%v/%v, want nil/nil/nil with no stored metric rows",
				i, h.Assists, h.ADR, h.KASTPct)
		}
	}
}

// TestGetProfileCarriesNoWeaponFold pins the M7 migration on the DTO
// (2026-11-18): the profile's Weapons table reads the weapon_* stored
// rows in PlayerProfile.svelte, so the Go JSON fold (mergeWeapons over
// GetPlayerWeaponJSONs) must not survive here "not even as a field
// name" (the TestListPlayersCarriesNoADR pattern). The fold's math
// survives only as the equivalence oracles: the characterization test
// (mergeWeapons pre-image) and the M7 gate (fold vs seeds over the
// golden demo).
func TestGetProfileCarriesNoWeaponFold(t *testing.T) {
	svc := newProfileFixture(t)
	p, err := svc.GetProfile("100")
	if err != nil {
		t.Fatalf("GetProfile: %v", err)
	}
	if p.Name == "" || p.Matches == 0 {
		t.Fatalf("fixture profile empty: %+v (the fold-free DTO still carries the career)", p)
	}
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(raw), "weapons") {
		t.Errorf("profile DTO still carries a weapons field (second presentation path): %s", raw)
	}
}

// TestListPlayersCarriesNoADR pins dogfooding W4's removal on the
// service DTO: the picker rows carry identity + recency ONLY. The ADR
// the player suggestions and the report picker render comes from the
// stored `career_adr` metric rows (frontend services.careerAdrRows —
// the canonical career read), so no Go-computed ADR may survive here,
// not even as a field name — player_career carries raw counts only
// (the career dual-write removal) and store.ListPlayers never selects
// a derived column.
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
