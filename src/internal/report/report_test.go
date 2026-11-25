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
			RealRounds: 5, ScoreCT: 3, ScoreT: 2,
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
			MVPs: 1, Score: 20,

			TradeKills: 2,
		})
	}
	for r := 1; r <= 5; r++ {
		winner := "ct"
		if r%2 == 0 {
			winner = "t"
		}
		em.Rounds = append(em.Rounds, models.Round{
			Number: r, Winner: winner, Reason: winner + "Win",
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
	// The K/D/A counts come from these event rows (the fold seeds read events):
	// A00 ends with 10 kills (the event above + 9), 1 assist, 0 deaths; B00 with
	// 9 kills (8 + the assist kill), 1 assist (F00's kill of G00), 1 death.
	enemies := []string{"F00", "G00", "H00", "I00", "J00"}
	for i := 0; i < 9; i++ {
		em.Events = append(em.Events, models.Event{Tick: 600 + i, Round: 2, Kind: models.EventKill,
			Attacker: "A00", Victim: enemies[i%5], Weapon: "ak47"})
	}
	for i := 0; i < 8; i++ {
		em.Events = append(em.Events, models.Event{Tick: 700 + i, Round: 2, Kind: models.EventKill,
			Attacker: "B00", Victim: enemies[i%5], Weapon: "ak47"})
	}
	em.Events = append(em.Events,
		models.Event{Tick: 720, Round: 2, Kind: models.EventKill, Attacker: "B00", Victim: "G00", Assister: "A00", Weapon: "ak47"},
		models.Event{Tick: 730, Round: 2, Kind: models.EventKill, Attacker: "F00", Victim: "B00", Weapon: "ak47"},
		models.Event{Tick: 740, Round: 2, Kind: models.EventKill, Attacker: "F00", Victim: "G00", Assister: "B00", Weapon: "ak47"},
	)
	// Chat in round 2 (the round the report test renders): one all-chat,
	// one team-chat and one system row — pins the Channel column spellings
	// ([ALL] / TEAM / empty) end to end through SaveExtracted → GetRoundDetail.
	em.Chat = []models.Chat{
		{Tick: 810, Round: 2, SteamID: "A00", Name: "player0", Text: "gl hf", Kind: "chat", Channel: "all"},
		{Tick: 820, Round: 2, SteamID: "A05", Name: "player5", Text: "b long", Kind: "chat", Channel: "team"},
		{Tick: 830, Round: 2, Text: "Match is live", Kind: "system"},
	}
	em.Warnings = []string{"fixture warning"}
	if err := st.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	// The import pipeline marks a match ready after its analyze stage; the sweep counts only ready matches.
	if err := st.SetMatchStatus(id, models.StatusReady, ""); err != nil {
		t.Fatalf("SetMatchStatus: %v", err)
	}
	// Per-round stats are an analytics writer, not SaveExtracted.
	var prs []models.PlayerRoundStat
	for r := 1; r <= 5; r++ {
		prs = append(prs, models.PlayerRoundStat{
			MatchID: id, Round: r, SteamID: "A00", Name: "player0",
			Traded: r%2 == 0,
			KAST:   true, MoneyStart: 800, Equip: 4500, Spent: 4500,
		})
	}
	if err := st.ReplacePlayerRounds(id, prs); err != nil {
		t.Fatalf("ReplacePlayerRounds: %v", err)
	}
	return id
}

func TestBuiltinsAndFind(t *testing.T) {
	b := Builtins()
	if len(b) != 5 {
		t.Fatalf("Builtins() = %d templates, want 5", len(b))
	}
	want := map[string]bool{"match.md": true, "match.html": true, "player.md": true, "round.md": true, "profile.md": true}
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
		"| Class | CT buy | T buy |",
		// Unanalyzed fixture = the pre-change-DB statement: no stored
		// round label and no stored side classes render EMPTY — the
		// retired read-time fill would have shown "full/full" here
		// (behavior change, 2026-11-12: report rows are stored reads).
		"|  |  |  |",
		"vtest-1",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("match.md missing %q\n---\n%s", want, out)
		}
	}
	// After the analyze pass (what the import pipeline runs) the SAME
	// report carries the stored label next to the stored side classes:
	// round 1 is the index-0 pistol round, rounds 2-5 are full buys on
	// both sides (CT 24000 / T 21000 vs 20000/10000).
	cfg, err := st.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	if err := analytics.Compute(st, id, analytics.ConfigFrom(cfg, 0)); err != nil {
		t.Fatalf("Compute: %v", err)
	}
	analyzedData, err := BuildMatchData(st, id)
	if err != nil {
		t.Fatalf("BuildMatchData (post-analyze): %v", err)
	}
	analyzed, err := Render(tpl.ID, tpl.Body, analyzedData)
	if err != nil {
		t.Fatalf("Render (post-analyze): %v", err)
	}
	for _, want := range []string{
		"| pistol | pistol | pistol |", // round 1: stored label + stored side classes
		"| full | full | full |",       // rounds 2-5
	} {
		if !strings.Contains(analyzed, want) {
			t.Errorf("analyzed match.md missing %q\n---\n%s", want, analyzed)
		}
	}
	if strings.Contains(analyzed, "|  |  |  |") {
		t.Error("analyzed match.md still renders empty buy-class cells (stored rows not read)")
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

// TestUtilityTickColumnIsEffective pins the match template's Utility
// table: its Tick column renders models.UtilityEvent.EffectiveTick — the
// paired throw's own tick, the detonation tick when unpaired — so the
// report's tick column is throw-based like the utility log itself. Every
// other report fixture carries NO utility rows (the range body never
// executes there), so this is the one place the template's method call
// runs: without it a rename would only fail at render time, in front of
// a user.
func TestUtilityTickColumnIsEffective(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	defer func() { _ = st.Close() }()
	id := seedMatch(t, st)
	if err := st.ReplaceUtility(id, []models.UtilityEvent{
		{Seq: 0, Tick: 150, ThrowTick: 100, Round: 1, Thrower: "A00", ThrowerName: "player0", Kind: "he"},
		{Seq: 1, Tick: 250, Round: 1, Thrower: "A00", ThrowerName: "player0", Kind: "smoke"},
	}); err != nil {
		t.Fatalf("ReplaceUtility: %v", err)
	}
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
	// Paired row → the throw's tick (100, not its detonation's 150);
	// unpaired row → the detonation tick it honestly knows (250).
	for _, want := range []string{
		"| 0 | 100 | player0 | he |",
		"| 1 | 250 | player0 | smoke |",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("match.md utility table missing %q\n---\n%s", want, out)
		}
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
	// The chat table carries the Channel column with its exact spellings:
	// [ALL] for all chat, TEAM for team chat (the round report renders no
	// side tag — it has no side inputs, so it never guesses one), and an
	// empty cell for system rows.
	for _, want := range []string{
		"| Tick | Name | Channel | Text |",
		"| 810 | player0 | [ALL] | gl hf |",
		"| 820 | player5 | TEAM | b long |",
		"| 830 |  |  | Match is live |",
	} {
		if !strings.Contains(rout, want) {
			t.Errorf("round.md chat table missing %q", want)
		}
	}
}

// TestReportMetricReadBack pins the design §3.6 Go read-back end to end:
// the builtin match/player templates render ADR / HS% / KD / KDA from the
// STORED fresh metric rows (one canonical read — never a recomputation),
// formatted through the format convention the trend/history series read
// established (percent stores a 0..1 fraction and renders ×100 — the
// same numbers today's printf "%.0f"/"%.1f"/"%.2f" spelled over
// GetScoreboard's Go columns), and an ABSENT or BEHIND row renders the
// honest dash — never a recomputed number, never a fabricated 0 (Q8).
func TestReportMetricReadBack(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	defer func() { _ = st.Close() }()
	id := seedMatch(t, st)
	cfg, err := st.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	def := func(name string) models.MetricRow {
		t.Helper()
		d, err := st.GetMetricByName(name)
		if err != nil {
			t.Fatalf("GetMetricByName(%s): %v", name, err)
		}
		return d
	}
	adrDef, hsDef, kdDef, kdaDef := def("adr"), def("hs_pct"), def("kd"), def("kda")

	render := func(t *testing.T) string {
		t.Helper()
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
		return out
	}
	insert := func(d models.MetricRow, version int, steamID string, v float64) {
		t.Helper()
		if err := st.InsertMetricValues(d.ID, version, cfg.RuleVersion, []store.MetricValueRow{
			{MatchID: id, SubjectKey: steamID, Value: v},
		}); err != nil {
			t.Fatalf("InsertMetricValues(%s): %v", d.Name, err)
		}
	}

	// 1) No stored rows at all → every metric cell is the honest dash
	// (the unanalyzed fixture — nothing has been swept yet).
	if out := render(t); !strings.Contains(out, "| — | — | — |") {
		t.Errorf("match.md without metric rows lost the dash cells:\n%s", out)
	}

	// 2) Fresh rows → the formatted numbers: adr float1 (42.5), hs_pct
	// percent (0.2 ×100 → 20), kd float2 (2.5 → 2.50), kda float2
	// (1.5 → 1.50 — w13d's conversion: player.md reads the stored
	// `kda` row where it used to printf Go's computed ratio). A
	// subject with no row keeps the dash beside them.
	insert(adrDef, adrDef.Version, "A00", 42.5)
	insert(hsDef, hsDef.Version, "A00", 0.2)
	insert(kdDef, kdDef.Version, "A00", 2.5)
	insert(kdaDef, kdaDef.Version, "A00", 1.5)
	out := render(t)
	if !strings.Contains(out, "| 42.5 | 20% | 2.50 |") {
		t.Errorf("match.md fresh metric cells missing \"| 42.5 | 20%% | 2.50 |\":\n%s", out)
	}
	if !strings.Contains(out, "| — | — | — |") {
		t.Errorf("match.md subject without rows must keep the dash cells:\n%s", out)
	}

	// The player scope reads the SAME cells (one read, both documents).
	pdata, err := BuildPlayerData(st, id, "A00")
	if err != nil {
		t.Fatalf("BuildPlayerData: %v", err)
	}
	ptpl, err := Find(Builtins(), "player.md")
	if err != nil {
		t.Fatalf("Find player.md: %v", err)
	}
	pout, err := Render(ptpl.ID, ptpl.Body, pdata)
	if err != nil {
		t.Fatalf("Render player.md: %v", err)
	}
	for _, want := range []string{"KD 2.50, KDA 1.50", "ADR 42.5 · HS% 20"} {
		if !strings.Contains(pout, want) {
			t.Errorf("player.md missing %q\n---\n%s", want, pout)
		}
	}
	if strings.Contains(pout, "KD —, KDA") {
		t.Errorf("player.md rendered the dash despite fresh rows:\n%s", pout)
	}

	// 3) A BEHIND row (stale metric_version — the read serves fresh rows
	// only) drops back to the dash: never the old number (§3.7.4).
	if err := st.ClearMetricValues(kdDef.ID); err != nil {
		t.Fatalf("ClearMetricValues: %v", err)
	}
	insert(kdDef, kdDef.Version-1, "A00", 99)
	out = render(t)
	if !strings.Contains(out, "| 42.5 | 20% | — |") {
		t.Errorf("match.md behind kd did not render the dash:\n%s", out)
	}
	if strings.Contains(out, "99.00") {
		t.Errorf("match.md leaked a behind value:\n%s", out)
	}
}

// TestReportCompoundCellsComposePerHalf pins the inferred-conversion
// W3b read-back (design §3.1 / Q2, invariant 9) as the owner ruling of
// 2026-11-17 left it: every report cell composes from ITS OWN stored
// seed row. The metric halves — the match tables' A / Openings /
// Trades, the player report's K/D/A A-half, both opening pairs,
// Trades, Best streak and Enemies flashed — read the STORED fresh rows
// through the SAME canonical read as ADR/HS%/KD/KDA
// (store.GetMetricValuesForMatch); the count cells (K, D, Rounds,
// MVPs, Utility damage) read THEIR seeds the same way now — the raw
// scoreboard passthrough they used to print is gone from the templates;
// and a cell with no fresh row — absent OR behind — renders the honest
// dash: never the stored column, never a fabricated 0, never a chip
// inside the cell.
func TestReportCompoundCellsComposePerHalf(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	defer func() { _ = st.Close() }()
	id := seedMatch(t, st)
	cfg, err := st.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	def := func(name string) models.MetricRow {
		t.Helper()
		d, err := st.GetMetricByName(name)
		if err != nil {
			t.Fatalf("GetMetricByName(%s): %v", name, err)
		}
		return d
	}
	assistsDef := def("assists")
	ekDef, edDef := def("entry_kills"), def("entry_deaths")
	tradeDef := def("trade_kills")
	streakDef, flashDef := def("best_streak"), def("enemies_flashed")
	adrDef, hsDef, kdDef := def("adr"), def("hs_pct"), def("kd")
	killsDef, deathsDef := def("kills"), def("deaths")
	roundsDef, mvpsDef, utilDef := def("rounds_played"), def("mvps"), def("utility_damage")

	insert := func(d models.MetricRow, version int, steamID string, v float64) {
		t.Helper()
		if err := st.InsertMetricValues(d.ID, version, cfg.RuleVersion, []store.MetricValueRow{
			{MatchID: id, SubjectKey: steamID, Value: v},
		}); err != nil {
			t.Fatalf("InsertMetricValues(%s): %v", d.Name, err)
		}
	}
	matchDoc := func(t *testing.T) string {
		t.Helper()
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
			t.Fatalf("Render match.md: %v", err)
		}
		return out
	}
	htmlDoc := func(t *testing.T) string {
		t.Helper()
		data, err := BuildMatchData(st, id)
		if err != nil {
			t.Fatalf("BuildMatchData: %v", err)
		}
		tpl, err := Find(Builtins(), "match.html")
		if err != nil {
			t.Fatalf("Find: %v", err)
		}
		out, err := Render(tpl.ID, tpl.Body, data)
		if err != nil {
			t.Fatalf("Render match.html: %v", err)
		}
		return out
	}
	playerDoc := func(t *testing.T) string {
		t.Helper()
		data, err := BuildPlayerData(st, id, "A00")
		if err != nil {
			t.Fatalf("BuildPlayerData: %v", err)
		}
		tpl, err := Find(Builtins(), "player.md")
		if err != nil {
			t.Fatalf("Find player.md: %v", err)
		}
		out, err := Render(tpl.ID, tpl.Body, data)
		if err != nil {
			t.Fatalf("Render player.md: %v", err)
		}
		return out
	}

	// 1) No stored rows at all (the unanalyzed fixture): EVERY cell is
	// the honest dash — the count cells included (owner ruling
	// 2026-11-17): player0's stored K 10 / D 0 / 5 rounds / 1 MVP no
	// longer reach the document without their seed rows (the no-raw-
	// fallback pin: the stored field is right there and never prints).
	const noRows = "| player0 | ct | — | — | — | — | — | — | — | —/— | — | — |"
	if out := matchDoc(t); !strings.Contains(out, noRows) {
		t.Errorf("match.md without rows lost the per-half dashes:\n%s", out)
	}
	pout := playerDoc(t)
	for _, want := range []string{
		"K/D/A: **—/—/—**",
		// w13d: the KDA half reads the stored `kda` row too — with no
		// rows it is the honest dash beside KD's.
		"(KD —, KDA —)",
		"Openings —/— · Open K/D —/— · Trades — · Best streak —",
		"Enemies flashed —",
		"Rounds played: —",
		"Utility damage —",
	} {
		if !strings.Contains(pout, want) {
			t.Errorf("player.md without rows missing %q\n---\n%s", want, pout)
		}
	}

	// 2) Fresh rows → every cell renders its formatted number (the int
	// seeds render the plain count) from the STORED rows — the count
	// cells included: player0 is K 10 / D 0 / 5 rounds / 1 MVP / 30
	// utility damage exactly as the seeds store them. A second subject
	// with no rows keeps every dash beside theirs (its raw fields —
	// K 9 / D 1 / 5 rounds / 1 MVP — never print).
	for _, in := range []struct {
		d models.MetricRow
		v float64
	}{
		{assistsDef, 7}, {ekDef, 3}, {edDef, 4}, {tradeDef, 9},
		{streakDef, 6}, {flashDef, 8}, {adrDef, 42.5}, {hsDef, 0.2}, {kdDef, 2.5},
		{killsDef, 10}, {deathsDef, 0}, {roundsDef, 5}, {mvpsDef, 1}, {utilDef, 30},
	} {
		insert(in.d, in.d.Version, "A00", in.v)
	}
	out := matchDoc(t)
	const freshRow = "| player0 | ct | 10 | 0 | 7 | 42.5 | 20% | 2.50 | 5 | 3/4 | 9 | 1 |"
	if !strings.Contains(out, freshRow) {
		t.Errorf("match.md fresh converting cells missing %q:\n%s", freshRow, out)
	}
	const otherRow = "| player1 | ct | — | — | — | — | — | — | — | —/— | — | — |"
	if !strings.Contains(out, otherRow) {
		t.Errorf("match.md subject without rows lost its dashes:\n%s", out)
	}
	pout = playerDoc(t)
	for _, want := range []string{
		"K/D/A: **10/0/7**",
		"Openings 3/4 · Open K/D 3/4 · Trades 9 · Best streak 6",
		"Enemies flashed 8",
		// The count line members are seeded cells now (owner ruling
		// 2026-11-17) — same numbers, one canonical read.
		"Utility damage 30",
		"Rounds played: 5",
	} {
		if !strings.Contains(pout, want) {
			t.Errorf("player.md missing %q\n---\n%s", want, pout)
		}
	}
	// The HTML export renders the SAME cells (design §3.2: the md/html
	// exports follow the template dispositions — one presentation path
	// per value).
	hout := htmlDoc(t)
	for _, want := range []string{
		"<td>player0</td><td>ct</td><td>10</td><td>0</td><td>7</td><td>42.5</td><td>20%</td><td>2.50</td>",
		"<td>3/4</td>",
	} {
		if !strings.Contains(hout, want) {
			t.Errorf("match.html missing %q:\n%s", want, hout)
		}
	}

	// 3) Per-half independence inside the PAIR: entry_kills stays fresh
	// while entry_deaths goes behind → each half renders from ITS OWN
	// source (3/—), never the stored column, never a fabricated 0.
	if err := st.ClearMetricValues(edDef.ID); err != nil {
		t.Fatalf("ClearMetricValues: %v", err)
	}
	insert(edDef, edDef.Version-1, "A00", 888)
	out = matchDoc(t)
	const pairBehind = "| player0 | ct | 10 | 0 | 7 | 42.5 | 20% | 2.50 | 5 | 3/— | 9 | 1 |"
	if !strings.Contains(out, pairBehind) {
		t.Errorf("match.md behind entry_deaths did not dash ONLY its half:\n%s", out)
	}
	if strings.Contains(bodyOf(out), "888") {
		t.Errorf("match.md leaked the behind entry_deaths value:\n%s", out)
	}
	pout = playerDoc(t)
	if !strings.Contains(pout, "Openings 3/— · Open K/D 3/— · Trades 9 · Best streak 6") {
		t.Errorf("player.md pairs not composed per half:\n%s", pout)
	}
	if strings.Contains(bodyOf(pout), "888") {
		t.Errorf("player.md leaked the behind entry_deaths value:\n%s", pout)
	}

	// 4) The triple's A half behind → 10/0/— : the seeded K/D halves
	// keep their stored rows, the metric half dashes, and the behind
	// number never reaches either document (Q8's 20/5/— semantics).
	if err := st.ClearMetricValues(assistsDef.ID); err != nil {
		t.Fatalf("ClearMetricValues: %v", err)
	}
	insert(assistsDef, assistsDef.Version-1, "A00", 999)
	out = matchDoc(t)
	if !strings.Contains(out, "| player0 | ct | 10 | 0 | — | 42.5 | 20% | 2.50 | 5 | 3/— | 9 | 1 |") {
		t.Errorf("match.md behind assists did not dash ONLY the A half:\n%s", out)
	}
	if strings.Contains(bodyOf(out), "999") {
		t.Errorf("match.md leaked the behind assists value:\n%s", out)
	}
	pout = playerDoc(t)
	if !strings.Contains(pout, "K/D/A: **10/0/—**") {
		t.Errorf("player.md behind assists did not dash the A half:\n%s", pout)
	}
	if strings.Contains(bodyOf(pout), "**10/0/999**") {
		t.Errorf("player.md leaked the behind assists value:\n%s", pout)
	}
}

// bodyOf drops the Generated footer from a rendered document before a
// leak scan: the footer's nanosecond timestamp (text/template prints
// time.Time with Go's full layout, fraction digits included) is the
// only volatile text in a rendered doc, so a leak substring like "888"
// must never false-positive against the clock (observed 2026-11-17:
// intermittent full-suite failures whose fraction happened to contain
// the leak digits, e.g. "...37.017846888 +0000 UTC" — the behind state
// itself rendered correctly). Covers both footer markers: the markdown
// templates' "Generated …" line and the HTML template's meta paragraph.
func bodyOf(doc string) string {
	if i := strings.Index(doc, "\nGenerated "); i >= 0 {
		return doc[:i]
	}
	if i := strings.Index(doc, `<p class="meta">Generated `); i >= 0 {
		return doc[:i]
	}
	return doc
}

// TestReportLeakCheckIgnoresGeneratedFooter pins the footer strip: a
// clock whose fraction contains the leak digits must not trip the scan,
// while a REAL body leak must still trip it (both directions,
// constructed — no clock, deterministic).
func TestReportLeakCheckIgnoresGeneratedFooter(t *testing.T) {
	const footer = "\n\nGenerated 2026-11-18 03:36:34.367193888 +0000 UTC by Spectra\n"
	if strings.Contains(bodyOf("| player0 | ct |"+footer), "888") {
		t.Errorf("bodyOf kept the footer clock digits:\n%q", bodyOf("| player0 | ct |"+footer))
	}
	if !strings.Contains(bodyOf("| player0 | 888 |"+footer), "888") {
		t.Errorf("bodyOf dropped a REAL body leak:\n%q", bodyOf("| player0 | 888 |"+footer))
	}
	const htmlFooter = `<p class="meta">Generated 2026-11-18 03:36:34.367193888 +0000 UTC</p>`
	if strings.Contains(bodyOf("<td>42</td>"+htmlFooter), "888") {
		t.Errorf("bodyOf kept the html footer clock digits")
	}
	if !strings.Contains(bodyOf("<td>888</td>"+htmlFooter), "888") {
		t.Errorf("bodyOf dropped a REAL html body leak")
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

// TestMatchReportEconomyBuyClasses pins the stored-read contract of the
// match report's economy rows (behavior change, 2026-11-12 — all-stored
// eco): BuildMatchData does NO read-time enrichment anymore, it reads the
// STORED per-side classes (round_side_classes, written by the analyze
// pass) exactly like AnalyticsService.GetEconomy, so report and Economy
// tab agree by construction. The fixture therefore runs the analyze pass
// itself (it used to stay unanalyzed and leaned on the retired read-time
// fill, which is what made round 1 read "full" — under the stored rules a
// counted round at index 0 is a PISTOL round, the same label the round
// chips render).
func TestMatchReportEconomyBuyClasses(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	defer func() { _ = st.Close() }()
	id := seedMatch(t, st)

	// Analyze the fixture under the seeded rules (what the import
	// pipeline's analyze stage does) so the side classes are stored.
	cfg, err := st.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	if err := analytics.Compute(st, id, analytics.ConfigFrom(cfg, 0)); err != nil {
		t.Fatalf("Compute: %v", err)
	}

	data, err := BuildMatchData(st, id)
	if err != nil {
		t.Fatalf("BuildMatchData: %v", err)
	}
	if len(data.Economy) != 5 {
		t.Fatalf("economy rows = %d, want 5", len(data.Economy))
	}
	// Fixture buys: CT 24000 / T 21000, thresholds 20000 (full) / 10000
	// (force) — round 1 is the index-0 PISTOL round, rounds 2-5 are full
	// buys on both sides, with the why string populated.
	if r := data.Economy[0]; !r.PistolRound || r.ClassCT != "pistol" || r.ClassT != "pistol" {
		t.Errorf("round 1 = pistol=%v %q/%q, want pistol/pistol (stored round label + side rows)",
			r.PistolRound, r.ClassCT, r.ClassT)
	}
	for _, r := range data.Economy[1:] {
		if r.ClassCT != "full" || r.ClassT != "full" {
			t.Errorf("round %d classes = %q/%q, want full/full", r.Round, r.ClassCT, r.ClassT)
		}
		if r.ClassWhyCT == "" || r.ClassWhyT == "" {
			t.Errorf("round %d why strings empty: %q/%q", r.Round, r.ClassWhyCT, r.ClassWhyT)
		}
	}
	if data.Economy[1].ClassWhyCT != "equip 24000 ≥ full-buy threshold 20000 → full buy" {
		t.Errorf("ClassWhyCT = %q", data.Economy[1].ClassWhyCT)
	}
	// The same rows the Economy tab serves — both are stored reads now, so
	// the comparison is direct (no enrichment step on either side).
	raw, err := st.GetEconomy(id)
	if err != nil {
		t.Fatalf("GetEconomy: %v", err)
	}
	if len(raw) != len(data.Economy) {
		t.Fatalf("Economy tab rows = %d, report rows = %d", len(raw), len(data.Economy))
	}
	for i := range raw {
		if raw[i] != data.Economy[i] {
			t.Errorf("round %d report row %+v != Economy tab row %+v (one stored read)",
				raw[i].Round, data.Economy[i], raw[i])
		}
	}
}
