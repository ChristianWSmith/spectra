package extract

import (
	"context"
	"encoding/json"
	"math"
	"os"
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
// Expected values are the golden baseline from ref/PLAN_MILESTONE_1.md §6.
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
	if m.Match.RealRounds != 24 || m.Match.WarmupRounds != 1 {
		t.Errorf("rounds = %d real + %d warmup, want 24 + 1", m.Match.RealRounds, m.Match.WarmupRounds)
	}
	if m.Match.SideSwitches != 1 {
		t.Errorf("sideSwitches = %d, want 1", m.Match.SideSwitches)
	}
	if m.Match.HalfCT != 7 || m.Match.HalfT != 4 {
		t.Errorf("half score = %d/%d, want 7/4", m.Match.HalfCT, m.Match.HalfT)
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
	if len(m.Rounds) != 25 {
		t.Fatalf("rounds = %d, want 25", len(m.Rounds))
	}
	warmupRounds := 0
	for i, r := range m.Rounds {
		if r.Number != i+1 {
			t.Errorf("round[%d].Number = %d, want %d (chronological)", i, r.Number, i+1)
		}
		if r.Warmup {
			warmupRounds++
			if r.Number != 2 {
				t.Errorf("warmup round is #%d, want #2", r.Number)
			}
		}
	}
	if warmupRounds != 1 {
		t.Errorf("warmup rounds = %d, want exactly 1", warmupRounds)
	}
	if m.Rounds[1].Winner != "" || m.Rounds[1].DurationS != 0 {
		t.Errorf("warmup round end state = %q/%v, want empty/0", m.Rounds[1].Winner, m.Rounds[1].DurationS)
	}

	// Freeze-end economy port check: round 1 equip values from the baseline.
	econ := map[string]models.RoundEconomy{}
	for _, e := range m.RoundEconomy {
		if e.Round == 1 {
			econ[e.Side] = e
		}
	}
	if econ["ct"].EquipValue != 3250 || econ["t"].EquipValue != 3250 {
		t.Errorf("round 1 equip = ct %d / t %d, want 3250/3250", econ["ct"].EquipValue, econ["t"].EquipValue)
	}

	// ---- typed events ----
	counts := map[string]int{}
	for _, e := range m.Events {
		counts[e.Kind]++
		if e.Round < 1 || e.Round > 25 {
			t.Errorf("event kind=%s tick=%d round=%d outside 1..25", e.Kind, e.Tick, e.Round)
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
		if g.Round < 1 || g.Round > 25 {
			t.Errorf("generic %s tick=%d round=%d outside 1..25", g.Name, g.Tick, g.Round)
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
		if c.Round < 1 || c.Round > 25 {
			t.Errorf("chat round=%d outside 1..25", c.Round)
		}
	}

	// ---- players ----
	if len(m.Players) != 10 || len(m.PlayerStats) != 10 {
		t.Fatalf("players = %d, stats = %d, want 10/10", len(m.Players), len(m.PlayerStats))
	}
	present := 0
	for _, p := range m.Players {
		if p.FinalStatePresent {
			present++
		}
	}
	if present != 3 {
		t.Errorf("FinalStatePresent = %d of 10, want exactly 3", present)
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
	if math.Abs(forever.ADR-142.9) > 0.05 {
		t.Errorf("forever2kELO ADR = %.4f, want ≈142.9", forever.ADR)
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
