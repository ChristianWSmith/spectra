// Package integration_test is the M1 acceptance harness: it parses the
// golden demo (donk.dem.zst at the repo root) through internal/extract and
// asserts a committed fixture of golden numbers (ref/PLAN_MILESTONE_1.md §6,
// "Baseline captured 2026-10-30"). The directory holds only test files and
// testdata/, so it never joins production builds.
//
// Regenerate the fixture deliberately (PRD §9.2 — treat the fixture diff as
// the review artifact):
//
//	go test ./internal/integration -run TestGolden -update
package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/klauspost/compress/zstd"

	"github.com/ChristianWSmith/spectra/internal/extract"
	"github.com/ChristianWSmith/spectra/internal/models"
)

const (
	// demoPath is relative to this package dir (go test sets the cwd to the
	// package directory); ../../ is the repo root.
	demoPath = "../../donk.dem.zst"
	// fixturePath is the committed golden numbers this test enforces.
	fixturePath = "testdata/donk.golden.json"

	// parseSecondsMax is a generous upper bound on the parse wall-time, not
	// an exact expectation: CI runners vary (plan §6 — wall-time tolerance,
	// all other numbers are deterministic). The fixture stores this ceiling,
	// never a measured value.
	parseSecondsMax = 90

	// lfsPointerPrefix / lfsPointerMaxSize detect a Git LFS pointer file
	// (what a checkout yields without `git lfs pull`): < 4 KB ASCII starting
	// with the spec URL. A pointer passes the "exists" check but is not a
	// demo (plan §6).
	lfsPointerPrefix  = "version https://git-lfs.github.com/spec"
	lfsPointerMaxSize = 4096

	// adrTolerance covers float rounding: fixture ADR/HS% values are stored
	// rounded to 1 decimal; everything else compares exact.
	adrTolerance = 0.05
)

// zstdMagic is the 4-byte frame magic 28 b5 2f fd; anything else is a raw .dem.
var zstdMagic = [4]byte{0x28, 0xb5, 0x2f, 0xfd}

// modelEventKinds is the full typed-event vocabulary (models.EventKind
// constants). The fixture records a count for every kind, even 0.
var modelEventKinds = []string{
	models.EventKill,
	models.EventDamage,
	models.EventBlind,
	models.EventBombPlant,
	models.EventBombDefuse,
	models.EventBombExplode,
	models.EventBombDrop,
	models.EventBombPickup,
	models.EventGrenadeThrow,
	models.EventGrenade,
	models.EventRoundStart,
	models.EventRoundEnd,
	models.EventConnect,
	models.EventDisconnect,
}

// update regenerates the fixture when passed on the command line
// (`go test ./internal/integration -run TestGolden -update`).
var update = flag.Bool("update", false, "regenerate testdata/donk.golden.json")

// goldenFixture is the committed fixture shape — numbers and small strings
// only, no payloads. Field names are a contract with testdata/donk.golden.json.
type goldenFixture struct {
	ParserVersion      string         `json:"parserVersion"`
	Map                string         `json:"map"`
	TickRate           float64        `json:"tickRate"`
	Frames             int            `json:"frames"`
	DurationTicks      int            `json:"durationTicks"`
	PlaybackTimeS      float64        `json:"playbackTimeS"`
	ScoreCT            int            `json:"scoreCT"`
	ScoreT             int            `json:"scoreT"`
	HalfCT             int            `json:"halfCT"`
	HalfT              int            `json:"halfT"`
	SideSwitches       int            `json:"sideSwitches"`
	RealRounds         int            `json:"realRounds"`
	WarmupRounds       int            `json:"warmupRounds"`
	RoundsTotal        int            `json:"roundsTotal"`
	WarmupRoundNumbers []int          `json:"warmupRoundNumbers"`
	Events             map[string]int `json:"events"`
	EventTotal         int            `json:"eventTotal"`
	EventKindsDistinct int            `json:"eventKindsDistinct"`
	GenericDistinct    int            `json:"genericDistinct"`
	GenericTotal       int            `json:"genericTotal"`
	Chat               int            `json:"chat"`
	Warnings           int            `json:"warnings"`
	Players            int            `json:"players"`
	FinalStatePlayers  int            `json:"finalStatePlayers"`
	// VoiceChunks stays 0 in M1: internal/extract does not capture voice
	// (deferred to M4 per plan §6). The field is kept so the fixture shape is
	// stable when M4 starts recording real chunk counts — do not parse voice
	// here.
	VoiceChunks     int              `json:"voiceChunks"`
	PlayersHeadline []headlinePlayer `json:"playersHeadline"`
	TopPlayer       topPlayer        `json:"topPlayer"`
	ParseSecondsMax int              `json:"parseSecondsMax"`
}

// headlinePlayer is one scoreboard row's headline stats, sorted by kills
// descending; ADR/HS% are rounded to 1 decimal.
type headlinePlayer struct {
	SteamID string  `json:"steamId"`
	Name    string  `json:"name"`
	Side    string  `json:"side"`
	Kills   int     `json:"kills"`
	Deaths  int     `json:"deaths"`
	Assists int     `json:"assists"`
	ADR     float64 `json:"adr"`
	HSPct   float64 `json:"hsPct"`
}

// topPlayer is the top fragger's headline line.
type topPlayer struct {
	SteamID string  `json:"steamId"`
	Kills   int     `json:"kills"`
	Deaths  int     `json:"deaths"`
	Assists int     `json:"assists"`
	ADR     float64 `json:"adr"`
}

// shouldSkip reports whether the golden demo at path is unusable (absent or
// an un-smudged Git LFS pointer), with a human-readable reason.
func shouldSkip(path string) (bool, string) {
	fi, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return true, "golden demo missing (shallow clone or LFS not pulled)"
		}
		return true, fmt.Sprintf("stat golden demo: %v", err)
	}
	if fi.Size() < lfsPointerMaxSize {
		// Safe to slurp: only tiny files reach here.
		data, err := os.ReadFile(path) //nolint:gosec // path is the fixed demo location or a unit-test temp file
		if err != nil {
			return true, fmt.Sprintf("read golden demo: %v", err)
		}
		first, _, _ := strings.Cut(string(data), "\n")
		if strings.HasPrefix(strings.TrimRight(first, "\r"), lfsPointerPrefix) {
			return true, "golden demo is a Git LFS pointer (run git lfs pull)"
		}
	}
	return false, ""
}

// TestGoldenSkipBehavior unit-tests the pointer/absent detection without a
// demo file (no LFS requirement, runs under -short).
func TestGoldenSkipBehavior(t *testing.T) {
	t.Run("missing", func(t *testing.T) {
		skip, reason := shouldSkip(filepath.Join(t.TempDir(), "nope.dem.zst"))
		if !skip {
			t.Error("missing file: skip = false, want true")
		}
		if reason == "" {
			t.Error("missing file: empty skip reason")
		}
	})

	t.Run("lfs pointer", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "pointer.dem.zst")
		pointer := lfsPointerPrefix + "/v1\noid sha256:0123456789abcdef\nsize 189897437\n"
		if err := os.WriteFile(path, []byte(pointer), 0o600); err != nil {
			t.Fatalf("write pointer file: %v", err)
		}
		skip, reason := shouldSkip(path)
		if !skip {
			t.Error("LFS pointer: skip = false, want true")
		}
		if !strings.Contains(reason, "LFS pointer") {
			t.Errorf("LFS pointer: reason = %q, want mention of LFS pointer", reason)
		}
	})

	t.Run("large fake file is not skipped", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "fake.dem.zst")
		if err := os.WriteFile(path, bytes.Repeat([]byte{0x42}, lfsPointerMaxSize+1), 0o600); err != nil {
			t.Fatalf("write fake file: %v", err)
		}
		if skip, reason := shouldSkip(path); skip {
			t.Errorf("file >4KB: skip = true (reason %q), want false", reason)
		}
	})

	t.Run("small non-pointer file is not skipped", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "tiny.dem")
		if err := os.WriteFile(path, []byte("PBDEMS2 not an lfs pointer\n"), 0o600); err != nil {
			t.Fatalf("write tiny file: %v", err)
		}
		if skip, reason := shouldSkip(path); skip {
			t.Errorf("small non-pointer: skip = true (reason %q), want false", reason)
		}
	})
}

// TestGolden is the Tier-1 acceptance check against the committed fixture.
// Skipped under -short and when the demo is absent or an LFS pointer so
// `make test` never hard-fails on missing LFS content.
func TestGolden(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping golden-demo parse in -short mode")
	}
	if skip, reason := shouldSkip(demoPath); skip {
		t.Skip(reason)
	}

	f, err := os.Open(demoPath) //nolint:gosec // path is the fixed repo-root golden demo
	if err != nil {
		t.Fatalf("open golden demo: %v", err)
	}
	defer func() { _ = f.Close() }()

	// Magic sniff: zstd frame magic → decompress with klauspost; else raw .dem.
	head := make([]byte, len(zstdMagic))
	if _, err := io.ReadFull(f, head); err != nil {
		t.Fatalf("sniff demo magic: %v", err)
	}
	// Re-feed the sniffed bytes so the consumer always sees the full stream.
	reader := io.MultiReader(bytes.NewReader(head), f)
	if bytes.Equal(head, zstdMagic[:]) {
		zr, zerr := zstd.NewReader(reader)
		if zerr != nil {
			t.Fatalf("zstd.NewReader: %v", zerr)
		}
		defer zr.Close()
		reader = zr
	}

	start := time.Now()
	m, err := extract.Parse(context.Background(), reader, extract.ParseOptions{})
	parseSeconds := time.Since(start).Seconds()
	if err != nil {
		t.Fatalf("extract.Parse: %v", err)
	}
	if m == nil {
		t.Fatal("extract.Parse returned nil ExtractedMatch")
	}
	t.Logf("parsed donk.dem.zst in %.1fs", parseSeconds)

	got := buildGolden(t, m)
	if parseSeconds > parseSecondsMax {
		t.Errorf("parse wall-time %.1fs exceeds ceiling %ds (fixture records the ceiling, not the measurement)",
			parseSeconds, parseSecondsMax)
	}

	// Hard-coded safety nets: asserted ALWAYS, even with -update, so a bad
	// regeneration cannot silently commit a shifted baseline.
	assertSafetyNets(t, &got)

	if *update {
		if err := os.MkdirAll(filepath.Dir(fixturePath), 0o755); err != nil {
			t.Fatalf("mkdir testdata: %v", err)
		}
		data, err := json.MarshalIndent(got, "", "  ")
		if err != nil {
			t.Fatalf("marshal fixture: %v", err)
		}
		if err := os.WriteFile(fixturePath, append(data, '\n'), 0o644); err != nil {
			t.Fatalf("write fixture: %v", err)
		}
		t.Logf("updated %s", fixturePath)
		return
	}

	data, err := os.ReadFile(fixturePath) //nolint:gosec // fixed package-relative fixture path
	if err != nil {
		t.Fatalf("fixture %s unreadable (%v) — run: go test ./internal/integration -run TestGolden -update", fixturePath, err)
	}
	var want goldenFixture
	if err := json.Unmarshal(data, &want); err != nil {
		t.Fatalf("parse fixture %s: %v", fixturePath, err)
	}
	compareGolden(t, &got, &want)
}

// buildGolden projects the extract output onto the fixture shape.
func buildGolden(t *testing.T, m *models.ExtractedMatch) goldenFixture {
	t.Helper()

	kindCounts := map[string]int{}
	for _, e := range m.Events {
		kindCounts[e.Kind]++
	}
	events := make(map[string]int, len(modelEventKinds))
	for _, k := range modelEventKinds {
		events[k] = kindCounts[k]
	}

	genericDistinct := map[string]bool{}
	for _, g := range m.GenericEvents {
		genericDistinct[g.Name] = true
	}

	var warmupRoundNumbers []int
	finalState := 0
	for _, r := range m.Rounds {
		if r.Warmup {
			warmupRoundNumbers = append(warmupRoundNumbers, r.Number)
		}
	}
	for _, p := range m.Players {
		if p.FinalStatePresent {
			finalState++
		}
	}
	sort.Ints(warmupRoundNumbers)

	headline := make([]headlinePlayer, 0, len(m.PlayerStats))
	for _, ps := range m.PlayerStats {
		headline = append(headline, headlinePlayer{
			SteamID: ps.SteamID,
			Name:    ps.Name,
			Side:    ps.Side,
			Kills:   ps.Kills,
			Deaths:  ps.Deaths,
			Assists: ps.Assists,
			ADR:     round1(ps.ADR),
			HSPct:   round1(ps.HSPct),
		})
	}
	sort.Slice(headline, func(i, j int) bool {
		if headline[i].Kills != headline[j].Kills {
			return headline[i].Kills > headline[j].Kills
		}
		if headline[i].Deaths != headline[j].Deaths {
			return headline[i].Deaths < headline[j].Deaths
		}
		return headline[i].SteamID < headline[j].SteamID
	})

	top := topPlayer{}
	if len(headline) > 0 {
		top = topPlayer{
			SteamID: headline[0].SteamID,
			Kills:   headline[0].Kills,
			Deaths:  headline[0].Deaths,
			Assists: headline[0].Assists,
			ADR:     headline[0].ADR,
		}
	}

	return goldenFixture{
		ParserVersion:      m.Match.ParserVersion,
		Map:                m.Match.Map,
		TickRate:           m.Match.TickRate,
		Frames:             m.Match.Frames,
		DurationTicks:      m.Match.DurationTicks,
		PlaybackTimeS:      m.Match.PlaybackTimeS,
		ScoreCT:            m.Match.ScoreCT,
		ScoreT:             m.Match.ScoreT,
		HalfCT:             m.Match.HalfCT,
		HalfT:              m.Match.HalfT,
		SideSwitches:       m.Match.SideSwitches,
		RealRounds:         m.Match.RealRounds,
		WarmupRounds:       m.Match.WarmupRounds,
		RoundsTotal:        len(m.Rounds),
		WarmupRoundNumbers: warmupRoundNumbers,
		Events:             events,
		EventTotal:         len(m.Events),
		EventKindsDistinct: len(kindCounts),
		GenericDistinct:    len(genericDistinct),
		GenericTotal:       len(m.GenericEvents),
		Chat:               len(m.Chat),
		Warnings:           m.Match.WarningsCount,
		Players:            len(m.Players),
		FinalStatePlayers:  finalState,
		VoiceChunks:        0, // M1: extract captures no voice; M4 extends (see struct comment)
		PlayersHeadline:    headline,
		TopPlayer:          top,
		ParseSecondsMax:    parseSecondsMax,
	}
}

// assertSafetyNets re-checks the plan §6 baseline invariants directly against
// the got-object, independent of the fixture file.
func assertSafetyNets(t *testing.T, got *goldenFixture) {
	t.Helper()
	if got.Map != "de_cache" {
		t.Errorf("safety: map = %q, want de_cache", got.Map)
	}
	if got.TickRate != 64 {
		t.Errorf("safety: tickRate = %v, want 64", got.TickRate)
	}
	if got.Frames != 136948 {
		t.Errorf("safety: frames = %d, want 136948", got.Frames)
	}
	if got.ScoreCT != 10 || got.ScoreT != 13 {
		t.Errorf("safety: score = CT %d – %d T, want 10–13", got.ScoreCT, got.ScoreT)
	}
	if got.RoundsTotal != 25 {
		t.Errorf("safety: roundsTotal = %d, want 25", got.RoundsTotal)
	}
	if got.RealRounds != 24 {
		t.Errorf("safety: realRounds = %d, want 24", got.RealRounds)
	}
	if got.Players != 10 {
		t.Errorf("safety: players = %d, want 10", got.Players)
	}
	if got.Warnings != 0 {
		t.Errorf("safety: warnings = %d, want 0", got.Warnings)
	}
	if got.TopPlayer.Kills != 25 {
		t.Errorf("safety: topPlayer kills = %d, want 25", got.TopPlayer.Kills)
	}
}

// compareGolden diffs got against the committed fixture field by field;
// failure messages name the field with got vs want.
func compareGolden(t *testing.T, got, want *goldenFixture) {
	t.Helper()

	cmpStr(t, "parserVersion", got.ParserVersion, want.ParserVersion)
	cmpStr(t, "map", got.Map, want.Map)
	cmpFloat(t, "tickRate", got.TickRate, want.TickRate, 0)
	cmpInt(t, "frames", got.Frames, want.Frames)
	cmpInt(t, "durationTicks", got.DurationTicks, want.DurationTicks)
	cmpFloat(t, "playbackTimeS", got.PlaybackTimeS, want.PlaybackTimeS, 0)
	cmpInt(t, "scoreCT", got.ScoreCT, want.ScoreCT)
	cmpInt(t, "scoreT", got.ScoreT, want.ScoreT)
	cmpInt(t, "halfCT", got.HalfCT, want.HalfCT)
	cmpInt(t, "halfT", got.HalfT, want.HalfT)
	cmpInt(t, "sideSwitches", got.SideSwitches, want.SideSwitches)
	cmpInt(t, "realRounds", got.RealRounds, want.RealRounds)
	cmpInt(t, "warmupRounds", got.WarmupRounds, want.WarmupRounds)
	cmpInt(t, "roundsTotal", got.RoundsTotal, want.RoundsTotal)
	cmpIntSlice(t, "warmupRoundNumbers", got.WarmupRoundNumbers, want.WarmupRoundNumbers)

	for _, k := range modelEventKinds {
		cmpInt(t, "events."+k, got.Events[k], want.Events[k])
	}
	for k, v := range got.Events {
		if _, known := want.Events[k]; !known {
			t.Errorf("events.%s = %d, want key absent from fixture vocabulary", k, v)
		}
	}
	cmpInt(t, "eventTotal", got.EventTotal, want.EventTotal)
	cmpInt(t, "eventKindsDistinct", got.EventKindsDistinct, want.EventKindsDistinct)
	cmpInt(t, "genericDistinct", got.GenericDistinct, want.GenericDistinct)
	cmpInt(t, "genericTotal", got.GenericTotal, want.GenericTotal)
	cmpInt(t, "chat", got.Chat, want.Chat)
	cmpInt(t, "warnings", got.Warnings, want.Warnings)
	cmpInt(t, "players", got.Players, want.Players)
	cmpInt(t, "finalStatePlayers", got.FinalStatePlayers, want.FinalStatePlayers)
	cmpInt(t, "voiceChunks", got.VoiceChunks, want.VoiceChunks)

	cmpInt(t, "playersHeadline.len", len(got.PlayersHeadline), len(want.PlayersHeadline))
	for i := range got.PlayersHeadline {
		if i >= len(want.PlayersHeadline) {
			break
		}
		g, w := got.PlayersHeadline[i], want.PlayersHeadline[i]
		field := fmt.Sprintf("playersHeadline[%d]", i)
		cmpStr(t, field+".steamId", g.SteamID, w.SteamID)
		cmpStr(t, field+".name", g.Name, w.Name)
		cmpStr(t, field+".side", g.Side, w.Side)
		cmpInt(t, field+".kills", g.Kills, w.Kills)
		cmpInt(t, field+".deaths", g.Deaths, w.Deaths)
		cmpInt(t, field+".assists", g.Assists, w.Assists)
		cmpFloat(t, field+".adr", g.ADR, w.ADR, adrTolerance)
		cmpFloat(t, field+".hsPct", g.HSPct, w.HSPct, adrTolerance)
	}

	cmpStr(t, "topPlayer.steamId", got.TopPlayer.SteamID, want.TopPlayer.SteamID)
	cmpInt(t, "topPlayer.kills", got.TopPlayer.Kills, want.TopPlayer.Kills)
	cmpInt(t, "topPlayer.deaths", got.TopPlayer.Deaths, want.TopPlayer.Deaths)
	cmpInt(t, "topPlayer.assists", got.TopPlayer.Assists, want.TopPlayer.Assists)
	cmpFloat(t, "topPlayer.adr", got.TopPlayer.ADR, want.TopPlayer.ADR, adrTolerance)

	// parseSecondsMax is the committed ceiling (never a measurement).
	cmpInt(t, "parseSecondsMax", got.ParseSecondsMax, want.ParseSecondsMax)
}

func cmpStr(t *testing.T, field, got, want string) {
	t.Helper()
	if got != want {
		t.Errorf("%s = %q, want %q", field, got, want)
	}
}

func cmpInt(t *testing.T, field string, got, want int) {
	t.Helper()
	if got != want {
		t.Errorf("%s = %d, want %d", field, got, want)
	}
}

// cmpFloat compares with absolute tolerance tol; tol 0 means exact bits.
func cmpFloat(t *testing.T, field string, got, want, tol float64) {
	t.Helper()
	if tol <= 0 {
		if got != want {
			t.Errorf("%s = %v, want %v", field, got, want)
		}
		return
	}
	if math.Abs(got-want) > tol {
		t.Errorf("%s = %.4f, want %.4f (±%v)", field, got, want, tol)
	}
}

func cmpIntSlice(t *testing.T, field string, got, want []int) {
	t.Helper()
	if len(got) != len(want) {
		t.Errorf("%s = %v, want %v (length %d vs %d)", field, got, want, len(got), len(want))
		return
	}
	for i := range got {
		if got[i] != want[i] {
			t.Errorf("%s[%d] = %d, want %d", field, i, got[i], want[i])
		}
	}
}

// round1 rounds to 1 decimal for stable fixture storage.
func round1(v float64) float64 {
	return math.Round(v*10) / 10
}
