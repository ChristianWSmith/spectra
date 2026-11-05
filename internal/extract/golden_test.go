package extract

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"slices"
	"sort"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestParseGolden is the dev-only acceptance check against the golden demo
// (donk.dem). It points at a RAW, already-decompressed .dem stream — extract
// itself stays demoinfocs-only (no zstd). Skipped unless SPECTRA_TEST_DEMO is
// set, so `make test` never depends on local files:
//
//	SPECTRA_TEST_DEMO=/path/to/donk.dem go test ./internal/extract -run TestParseGolden -v
//
// Expected values are the golden baseline captured 2026-10-30.
func TestParseGolden(t *testing.T) {
	path := os.Getenv("SPECTRA_TEST_DEMO")
	if path == "" {
		t.Skip("set SPECTRA_TEST_DEMO")
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open golden demo: %v", err)
	}
	defer func() { _ = f.Close() }()

	type prog struct{ done, total int }
	var progress []prog
	m, err := Parse(context.Background(), f, ParseOptions{
		Progress: func(done, total int) {
			progress = append(progress, prog{done, total})
		},
	})
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if m == nil {
		t.Fatal("Parse returned nil ExtractedMatch")
	}

	// ---- header / match ----
	if m.Match.Map != "de_cache" {
		t.Errorf("map = %q, want de_cache", m.Match.Map)
	}
	if m.Match.TickRate != 64 {
		t.Errorf("tickRate = %v, want 64", m.Match.TickRate)
	}
	if m.Match.Frames != 136948 {
		t.Errorf("frames = %d, want 136948", m.Match.Frames)
	}
	if m.Match.DurationTicks != 136896 {
		t.Errorf("durationTicks = %d, want 136896", m.Match.DurationTicks)
	}
	if m.Match.PlaybackTimeS != 2139 {
		t.Errorf("playbackTimeS = %v, want 2139 (35m39s)", m.Match.PlaybackTimeS)
	}
	if m.Match.ScoreCT != 10 || m.Match.ScoreT != 13 {
		t.Errorf("score = CT %d – %d T, want 10–13", m.Match.ScoreCT, m.Match.ScoreT)
	}
	if m.Match.RealRounds != 23 || m.Match.WarmupRounds != 1 {
		t.Errorf("rounds = %d real + %d warmup, want 23 + 1 (knife + warmup precede the first-half pistol)",
			m.Match.RealRounds, m.Match.WarmupRounds)
	}
	if m.Match.SideSwitches != 1 {
		t.Errorf("sideSwitches = %d, want 1", m.Match.SideSwitches)
	}
	if m.Match.HalfCT != 8 || m.Match.HalfT != 4 {
		t.Errorf("half score = %d/%d, want 8/4 (settled, swapped back)", m.Match.HalfCT, m.Match.HalfT)
	}
	if m.Match.IsPOV {
		t.Error("isPOV = true, want false")
	}
	if m.Match.ParserVersion != ParserVersion {
		t.Errorf("parserVersion = %q, want %q", m.Match.ParserVersion, ParserVersion)
	}
	if m.Match.ExtractedAt.IsZero() || m.Match.ParseMS <= 0 {
		t.Errorf("extractedAt/parseMS not set: %v / %d", m.Match.ExtractedAt, m.Match.ParseMS)
	}
	if m.Match.WarningsCount != 0 || len(m.Warnings) != 0 {
		t.Errorf("warnings = %d (%v), want 0", m.Match.WarningsCount, m.Warnings)
	}
	if m.Match.Status != "" || m.Match.Error != "" || m.Match.ID != 0 || m.Match.Path != "" ||
		m.Match.SHA256 != "" || m.Match.Size != 0 {
		t.Errorf("store-owned match fields must stay zero: %+v", m.Match)
	}

	// ---- rounds ----
	// Ingest numbering: real rounds are 1..23 (first-half pistol = 1),
	// knife/pregame and warmup rounds take negative indices counting back
	// from round 1 (-2 knife, -1 warmup) so number order stays chrono.
	if len(m.Rounds) != 25 {
		t.Fatalf("rounds = %d, want 25", len(m.Rounds))
	}
	warmupRounds := 0
	for i, r := range m.Rounds {
		var want int
		switch i {
		case 0: // pregame knife round
			want = -2
		case 1: // warmup
			want = -1
		default: // real rounds count 1..23
			want = i - 1
		}
		if r.Number != want {
			t.Errorf("round[%d].Number = %d, want %d (ingest numbering: pistol=1, pre-match negatives)",
				i, r.Number, want)
		}
		if r.Warmup {
			warmupRounds++
			if r.Number != -1 {
				t.Errorf("warmup round is #%d, want #-1", r.Number)
			}
		}
	}
	if warmupRounds != 1 {
		t.Errorf("warmup rounds = %d, want exactly 1", warmupRounds)
	}
	if m.Rounds[1].Winner != "" || m.Rounds[1].DurationS != 0 {
		t.Errorf("warmup round end state = %q/%v, want empty/0", m.Rounds[1].Winner, m.Rounds[1].DurationS)
	}
	if m.Rounds[2].Number != 1 || m.Rounds[2].Warmup || m.Rounds[2].Pregame {
		t.Errorf("round[2] = #%d warmup=%v pregame=%v, want the first-half pistol as round 1",
			m.Rounds[2].Number, m.Rounds[2].Warmup, m.Rounds[2].Pregame)
	}

	// Freeze-end economy port check: the knife round (#-2) starts both
	// sides at 3250; the first real round (#1, pistol) at 4000/3600.
	econ := map[string]models.RoundEconomy{}
	for _, e := range m.RoundEconomy {
		switch e.Round {
		case -2:
			econ["knife-"+e.Side] = e
		case 1:
			econ[e.Side] = e
		}
	}
	if econ["knife-ct"].EquipValue != 3250 || econ["knife-t"].EquipValue != 3250 {
		t.Errorf("knife round equip = ct %d / t %d, want 3250/3250",
			econ["knife-ct"].EquipValue, econ["knife-t"].EquipValue)
	}
	if econ["ct"].EquipValue != 4000 || econ["t"].EquipValue != 3600 {
		t.Errorf("round 1 (pistol) equip = ct %d / t %d, want 4000/3600",
			econ["ct"].EquipValue, econ["t"].EquipValue)
	}

	// Equipment value is INVENTORY value at freeze time end — the gear a
	// side actually holds — never this round's spend: round 3's CT side
	// spent 4200 yet holds 8350 of gear (rifles carried over from earlier
	// rounds), and its T opponent spent 5000 for 23800. round_economy.spent
	// keeps the spend in its own column (CS2.md
	// "m_unFreezetimeEndEquipmentValue").
	for _, want := range []struct {
		round int
		side  string
		equip int
		spent int
	}{
		{3, "ct", 8350, 4200},
		{3, "t", 23800, 5000},
	} {
		var got models.RoundEconomy
		found := false
		for _, e := range m.RoundEconomy {
			if e.Round == want.round && e.Side == want.side {
				got, found = e, true
				break
			}
		}
		if !found {
			t.Fatalf("round %d %s economy row missing", want.round, want.side)
		}
		if got.EquipValue != want.equip || got.Spent != want.spent {
			t.Errorf("round %d %s equip/spent = %d/%d, want %d/%d",
				want.round, want.side, got.EquipValue, got.Spent, want.equip, want.spent)
		}
		if got.EquipValue <= got.Spent {
			t.Errorf("round %d %s equip %d must exceed the round's spend %d — equipment value counts gear carried into the round",
				want.round, want.side, got.EquipValue, got.Spent)
		}
	}

	// ---- typed events ----
	// Round stamps follow the ingest numbering: -2/-1 for pre-match rows,
	// 1..23 for real rounds.
	minRound, maxRound := -2, 23
	counts := map[string]int{}
	for _, e := range m.Events {
		counts[e.Kind]++
		if e.Round < minRound || e.Round > maxRound {
			t.Errorf("event kind=%s tick=%d round=%d outside %d..%d", e.Kind, e.Tick, e.Round, minRound, maxRound)
		}
	}
	if counts[models.EventKill] != 170 {
		t.Errorf("kill events = %d, want 170", counts[models.EventKill])
	}
	if counts[models.EventDamage] != 662 {
		t.Errorf("damage events = %d, want 662", counts[models.EventDamage])
	}

	// ---- generic events (histogram source) ----
	distinct := map[string]bool{}
	for _, g := range m.GenericEvents {
		distinct[g.Name] = true
		if g.Round < minRound || g.Round > maxRound {
			t.Errorf("generic %s tick=%d round=%d outside %d..%d", g.Name, g.Tick, g.Round, minRound, maxRound)
		}
	}
	if len(distinct) != 46 {
		t.Errorf("distinct generic event names = %d, want 46", len(distinct))
	}
	if len(m.GenericEvents) < 20900 || len(m.GenericEvents) > 21200 {
		t.Errorf("generic event rows = %d, want ~21032", len(m.GenericEvents))
	}

	// ---- chat ----
	if len(m.Chat) != 34 {
		t.Errorf("chat rows = %d, want 34", len(m.Chat))
	}
	for _, c := range m.Chat {
		if c.Round < minRound || c.Round > maxRound {
			t.Errorf("chat round=%d outside %d..%d", c.Round, minRound, maxRound)
		}
	}

	// ---- players ----
	if len(m.Players) != 10 || len(m.PlayerStats) != 10 {
		t.Fatalf("players = %d, stats = %d, want 10/10", len(m.Players), len(m.PlayerStats))
	}
	// ---- final-state snapshot (end-of-demo roster) ----
	// The snapshot is finalRoster (every CT/T participant, including the
	// seven players who disconnect inside the GOTV tail after match point —
	// their controller entity state survives to the demo's last tick), so
	// all ten players carry FinalStatePresent and their snapshot-only Score.
	// (It used to be Participants().Playing(), which drops IsConnected=false
	// players: 3/10 present and Score 0 for the seven leavers.)
	wantSnapshot := []string{
		"-meg2k", "FREELOOK", "Magnojezzz", "Zuedsta", "adamS",
		"donk666", "forever2kELO", "hades--", "kRaSnaL", "llorente",
	}
	present := make([]string, 0, 10)
	for _, p := range m.Players {
		if p.FinalStatePresent {
			present = append(present, p.Name)
		}
	}
	sort.Strings(present)
	if !slices.Equal(present, wantSnapshot) {
		t.Errorf("final snapshot covers %v, want all %v", present, wantSnapshot)
	}
	zeroScore := []string{}
	for _, ps := range m.PlayerStats {
		if ps.Score == 0 {
			zeroScore = append(zeroScore, ps.Name)
		}
	}
	if len(zeroScore) != 0 {
		t.Errorf("players with snapshot-only Score 0 = %v, want none", zeroScore)
	}

	var forever *models.PlayerStats
	for i := range m.PlayerStats {
		if m.PlayerStats[i].SteamID == "76561198296382419" {
			forever = &m.PlayerStats[i]
		}
	}
	if forever == nil {
		t.Fatal("forever2kELO (76561198296382419) missing from player stats")
	}
	if forever.Kills != 25 {
		t.Errorf("forever2kELO kills = %d, want 25", forever.Kills)
	}
	// ADR = enemy damage capped per hit at the victim's remaining HP
	// (overkill is not damage dealt), divided by the player's counted
	// rounds (knife/warmup excluded). 116.9 is the external scoreboard's
	// official value for this demo (donk.png) — the extractor now matches
	// it for all ten players.
	if math.Abs(forever.ADR-116.9) > 0.05 {
		t.Errorf("forever2kELO ADR = %.4f, want ≈116.9", forever.ADR)
	}

	// Weapon maps must be valid JSON objects.
	for _, s := range m.PlayerStats {
		var kb map[string]int
		if err := json.Unmarshal([]byte(s.KillsByWeapon), &kb); err != nil {
			t.Errorf("%s KillsByWeapon invalid JSON %q: %v", s.SteamID, s.KillsByWeapon, err)
		}
		var db map[string]int
		if err := json.Unmarshal([]byte(s.DamageByWeapon), &db); err != nil {
			t.Errorf("%s DamageByWeapon invalid JSON %q: %v", s.SteamID, s.DamageByWeapon, err)
		}
	}

	// ---- progress ----
	if len(progress) == 0 {
		t.Fatal("progress callback never invoked")
	}
	for i, pg := range progress {
		if i > 0 && pg.done <= progress[i-1].done {
			t.Fatalf("progress done not strictly increasing: %v", progress)
		}
	}
	last := progress[len(progress)-1]
	if last.done != 136948 || last.total != 136948 {
		t.Errorf("final progress = (%d, %d), want (136948, 136948)", last.done, last.total)
	}
}
