package report

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/analytics"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// seedMatch builds a hand-made match fixture: 10 players (5 per side),
// 5 rounds, kills, economy rows and per-round stats — enough surface for
// the report templates without a demo or the M5 seed (G1-owned).
func seedMatch(t *testing.T, st *store.Store) int64 {
	t.Helper()
	id, err := st.CreateMatchRow("/demos/fixture.dem", "sha-fixture-report", 42)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	em := &models.ExtractedMatch{
		Match: models.Match{
			Map: "De_Mirage", PatchVersion: 14000, TickRate: 64,
			DurationTicks: 2000, PlaybackTimeS: 31.25, Frames: 2000,
			ServerName: "fixture-server", ClientName: "GOTV", GameDir: "csgo",
			WarmupRounds: 1, RealRounds: 5, ScoreCT: 3, ScoreT: 2,
			EntityClasses: 220, EndEntityCount: 80, ParserVersion: "vtest-1",
			ExtractedAt: time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC),
			ParseMS:     99, WarningsCount: 1,
		},
		Teams: []models.Team{
			{Side: "ct", Name: "Alpha", Score: 3},
			{Side: "t", Name: "Bravo", Score: 2},
		},
	}
	for i := 0; i < 10; i++ {
		side := "ct"
		if i >= 5 {
			side = "t"
		}
		em.Players = append(em.Players, models.Player{
			SteamID: string(rune('A'+i)) + "00", Name: "player" + string(rune('0'+i)),
			Side: side, FinalStatePresent: true,
		})
		em.PlayerStats = append(em.PlayerStats, models.PlayerStats{
			SteamID: string(rune('A'+i)) + "00", Side: side, Name: "player" + string(rune('0'+i)),
			Kills: 10 - i, Deaths: i, Assists: 1, Headshots: 2, MVPs: 1, Score: 20,
			TotalDamage: 1000, DamageTaken: 800, ADR: 50, HSPct: 20,
			RoundsPlayed: 5, OpeningKills: 1, TradeKills: 2, UtilityDamage: 30,
			MoneySpentTotal: 12000, KillsByWeapon: `{"ak47":3}`, DamageByWeapon: `{"ak47":400}`,
		})
	}
	for r := 1; r <= 5; r++ {
		winner := "ct"
		if r%2 == 0 {
			winner = "t"
		}
		em.Rounds = append(em.Rounds, models.Round{
			Number: r, Winner: winner, Reason: winner + "Win", DurationS: 115.5,
			StartTick: (r - 1) * 400, EndTick: r*400 - 1, FreezeEndTick: (r-1)*400 + 30,
			MVP: "A00", MVPReason: "kill", EquipCT: 24000, EquipT: 21000,
			FirstKillSteam: "A00", FirstDeathSteam: "A05",
		})
		em.RoundEconomy = append(em.RoundEconomy,
			models.RoundEconomy{Round: r, Side: "ct", EquipValue: 24000, MoneySampledSum: 19500, MoneySamples: 5},
			models.RoundEconomy{Round: r, Side: "t", EquipValue: 21000, MoneySampledSum: 17500, MoneySamples: 5},
		)
	}
	em.Events = []models.Event{
		{Tick: 100, Round: 1, Kind: "kill", Attacker: "A00", Victim: "A05", Weapon: "ak47", Headshot: true, Dmg: 100},
		{Tick: 120, Round: 1, Kind: "damage", Attacker: "A05", Victim: "A00", Weapon: "glock", Dmg: 30},
	}
	em.Warnings = []string{"fixture warning"}
	if err := st.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	// Per-round stats are an analytics writer, not SaveExtracted.
	var prs []models.PlayerRoundStat
	for r := 1; r <= 5; r++ {
		prs = append(prs, models.PlayerRoundStat{
			MatchID: id, Round: r, SteamID: "A00", Name: "player0",
			Kills: 2, Assists: 1, Deaths: 0, Traded: r%2 == 0, Survived: true,
			KAST: true, DMG: 180, UtilDmg: 10, MoneyStart: 800, Equip: 4500, Spent: 4500,
		})
	}
	if err := st.ReplacePlayerRounds(id, prs); err != nil {
		t.Fatalf("ReplacePlayerRounds: %v", err)
	}
	return id
}

func TestBuiltinsAndFind(t *testing.T) {
	b := Builtins()
	if len(b) != 4 {
		t.Fatalf("Builtins() = %d templates, want 4", len(b))
	}
	want := map[string]bool{"match.md": true, "match.html": true, "player.md": true, "round.md": true}
	for _, tpl := range b {
		if !want[tpl.ID] {
			t.Fatalf("unexpected builtin %q", tpl.ID)
		}
		if tpl.Origin != "builtin" || tpl.Body == "" {
			t.Fatalf("builtin %q incomplete: %+v", tpl.ID, tpl)
		}
		want[tpl.ID] = false
	}
	if _, err := Find(b, "nope.md"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Find(missing) err = %v, want ErrNotFound", err)
	}
	if tpl, err := Find(b, "round.md"); err != nil || tpl.Scope != "round" {
		t.Fatalf("Find(round.md) = %+v, %v", tpl, err)
	}
}

func TestSynthTeamNames(t *testing.T) {
	sb := []models.PlayerStatsRow{
		{SteamID: "B00", Name: "zed", Side: "t"},
		{SteamID: "A00", Name: "kRaSnaL", Side: "ct"},
		{SteamID: "A01", Name: "lowix", Side: "ct"},
		{SteamID: "C00", Name: "sideless", Side: ""},
	}
	ct, tn := synthTeamNames(sb)
	if ct != "team_kRaSnaL" || tn != "team_zed" {
		t.Fatalf("synthTeamNames = %q / %q, want team_kRaSnaL / team_zed", ct, tn)
	}
	// Input order must not matter (callers pass store-sorted scoreboards).
	ct2, tn2 := synthTeamNames([]models.PlayerStatsRow{sb[3], sb[2], sb[1], sb[0]})
	if ct2 != ct || tn2 != tn {
		t.Errorf("synthTeamNames reordered = %q / %q, want %q / %q", ct2, tn2, ct, tn)
	}
	// No recorded sides → empty pair (teamNames falls back to CT/T).
	if ct3, tn3 := synthTeamNames(nil); ct3 != "" || tn3 != "" {
		t.Errorf("synthTeamNames(nil) = %q / %q, want empty", ct3, tn3)
	}
}

func TestRenderMatchSnapshot(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	defer func() { _ = st.Close() }()
	id := seedMatch(t, st)

	data, err := BuildMatchData(st, id)
	if err != nil {
		t.Fatalf("BuildMatchData: %v", err)
	}
	tpl, err := Find(Builtins(), "match.md")
	if err != nil {
		t.Fatalf("Find: %v", err)
	}
	out, err := Render(tpl.ID, tpl.Body, data)
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	for _, want := range []string{
		"# Match report — De_Mirage",
		"Alpha 3 – 2 Bravo", // team names, never the sides (sides switch)
		"player0", "player9",
		"## Scoreboard", "## Rounds", "## Economy", "## Clutches", "## Utility",
		"| 1 | ct | ctWin |", // rounds table row
		// Enriched buy classes render next to the stored round class
		// (Class column stays the round_classifications label).
		"| Class | CT buy | T buy |", "|  | full | full |",
		"vtest-1",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("match.md missing %q\n---\n%s", want, out)
		}
	}
	// Stability: re-rendering the same data is byte-identical.
	again, err := Render(tpl.ID, tpl.Body, data)
	if err != nil {
		t.Fatalf("re-Render: %v", err)
	}
	if again != out {
		t.Error("match.md re-render differs from first render")
	}

	// HTML sibling renders too.
	html, err := Find(Builtins(), "match.html")
	if err != nil {
		t.Fatalf("Find html: %v", err)
	}
	hout, err := Render(html.ID, html.Body, data)
	if err != nil {
		t.Fatalf("Render html: %v", err)
	}
	if !strings.Contains(hout, "<!DOCTYPE html>") || !strings.Contains(hout, "De_Mirage") {
		t.Errorf("match.html incomplete:\n%s", hout)
	}
}

func TestRenderPlayerAndRound(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	defer func() { _ = st.Close() }()
	id := seedMatch(t, st)

	pdata, err := BuildPlayerData(st, id, "A00")
	if err != nil {
		t.Fatalf("BuildPlayerData: %v", err)
	}
	ptpl, _ := Find(Builtins(), "player.md")
	pout, err := Render(ptpl.ID, ptpl.Body, pdata)
	if err != nil {
		t.Fatalf("Render player: %v", err)
	}
	for _, want := range []string{"# Player report — player0", "A00", "## Per-round", "K/D/A"} {
		if !strings.Contains(pout, want) {
			t.Errorf("player.md missing %q", want)
		}
	}
	if _, err := BuildPlayerData(st, id, "missing"); err == nil {
		t.Error("BuildPlayerData(missing player) succeeded")
	}

	rdata, err := BuildRoundData(st, id, 2)
	if err != nil {
		t.Fatalf("BuildRoundData: %v", err)
	}
	rtpl, _ := Find(Builtins(), "round.md")
	rout, err := Render(rtpl.ID, rtpl.Body, rdata)
	if err != nil {
		t.Fatalf("Render round: %v", err)
	}
	for _, want := range []string{"# Round 2", "## Economy", "## Events", "## Chat"} {
		if !strings.Contains(rout, want) {
			t.Errorf("round.md missing %q", want)
		}
	}
}

func TestRenderPluginTemplate(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	defer func() { _ = st.Close() }()
	id := seedMatch(t, st)
	data, err := BuildMatchData(st, id)
	if err != nil {
		t.Fatalf("BuildMatchData: %v", err)
	}
	pluginTpl := Template{
		ID: "plug-match", Title: "Plug", Scope: "match", Format: "md",
		Origin: "plugin", Body: "plug report: {{.Match.Map}} {{.Match.ScoreCT}}-{{.Match.ScoreT}} ({{len .Scoreboard}} players)",
	}
	out, err := Render(pluginTpl.ID, pluginTpl.Body, data)
	if err != nil {
		t.Fatalf("Render plugin template: %v", err)
	}
	if out != "plug report: De_Mirage 3-2 (10 players)" {
		t.Fatalf("plugin render = %q", out)
	}
}

// TestMatchReportEconomyBuyClasses pins the approved surface-alignment
// change: BuildMatchData runs the read-time enrichment (analytics.
// EconomyRows under the stored analysis_config) exactly like
// AnalyticsService.GetEconomy, so the report's economy rows carry the
// per-side buy classes instead of empty ClassCT/ClassT.
func TestMatchReportEconomyBuyClasses(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	defer func() { _ = st.Close() }()
	id := seedMatch(t, st)

	data, err := BuildMatchData(st, id)
	if err != nil {
		t.Fatalf("BuildMatchData: %v", err)
	}
	if len(data.Economy) != 5 {
		t.Fatalf("economy rows = %d, want 5", len(data.Economy))
	}
	// Fixture buys: CT 24000 / T 21000, thresholds 20000 (full) / 10000
	// (force) — both sides are full buys, with the why string populated.
	for _, r := range data.Economy {
		if r.ClassCT != "full" || r.ClassT != "full" {
			t.Errorf("round %d classes = %q/%q, want full/full", r.Round, r.ClassCT, r.ClassT)
		}
		if r.ClassWhyCT == "" || r.ClassWhyT == "" {
			t.Errorf("round %d why strings empty: %q/%q", r.Round, r.ClassWhyCT, r.ClassWhyT)
		}
	}
	if data.Economy[0].ClassWhyCT != "equip 24000 ≥ full-buy threshold 20000 → full buy" {
		t.Errorf("ClassWhyCT = %q", data.Economy[0].ClassWhyCT)
	}
	// The same rows the Economy tab serves (one canonical enrichment).
	raw, err := st.GetEconomy(id)
	if err != nil {
		t.Fatalf("GetEconomy: %v", err)
	}
	cfg, err := st.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	want := analytics.EconomyRows(raw, analytics.ConfigFrom(cfg, 0))
	if len(want) != len(data.Economy) {
		t.Fatalf("Economy tab rows = %d, report rows = %d", len(want), len(data.Economy))
	}
	for i := range want {
		if want[i].ClassCT != data.Economy[i].ClassCT || want[i].ClassT != data.Economy[i].ClassT {
			t.Errorf("round %d report classes %q/%q != Economy tab %q/%q",
				want[i].Round, data.Economy[i].ClassCT, data.Economy[i].ClassT,
				want[i].ClassCT, want[i].ClassT)
		}
	}
}
