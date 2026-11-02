package main

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

func pf(v float64) *float64 { return &v }

// TestHeatmapKindsUseAttackerPosition guards the kills-vs-deaths split: the
// kills raster plots where the KILLER was (events.apos_*), deaths where the
// victim fell (events.pos_*). Both kinds used to rasterize the same victim
// positions, so the two heatmaps came out identical.
func TestHeatmapKindsUseAttackerPosition(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "heatmap.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer func() { _ = st.Close() }()

	id, err := st.CreateMatchRow("/d.dem", "sha-heatmap", 1)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	em := &models.ExtractedMatch{
		Match: models.Match{
			Map: "de_test", TickRate: 64, DurationTicks: 1000, Frames: 100,
			PlaybackTimeS: 15.625, RealRounds: 1, ExtractedAt: time.Now(), ParseMS: 1,
		},
		Players: []models.Player{
			{SteamID: "100", Name: "a", Side: "ct", FinalStatePresent: true},
			{SteamID: "200", Name: "b", Side: "t", FinalStatePresent: true},
		},
		Rounds: []models.Round{
			{Number: 1, Winner: "ct", StartTick: 0, EndTick: 1000},
		},
		RoundSides: []models.RoundPlayerSide{
			{Round: 1, SteamID: "100", Side: "ct"},
			{Round: 1, SteamID: "200", Side: "t"},
		},
		// Kill A: victim at the origin, killer at (100,100).
		// Kill B: victim at (50,50), killer at (200,200).
		Events: []models.Event{
			{Tick: 10, Round: 1, Kind: models.EventKill, Attacker: "100", Victim: "200",
				PosX: pf(0), PosY: pf(0), AttackerPosX: pf(100), AttackerPosY: pf(100)},
			{Tick: 20, Round: 1, Kind: models.EventKill, Attacker: "200", Victim: "100",
				PosX: pf(50), PosY: pf(50), AttackerPosX: pf(200), AttackerPosY: pf(200)},
		},
	}
	if err := st.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}

	as := &AnalyticsService{st: st}
	none := HeatmapFilter{RoundFrom: -1, RoundTo: -1}
	kills, err := as.GetHeatmap(id, "kills", none)
	if err != nil {
		t.Fatalf("GetHeatmap(kills): %v", err)
	}
	deaths, err := as.GetHeatmap(id, "deaths", none)
	if err != nil {
		t.Fatalf("GetHeatmap(deaths): %v", err)
	}
	if kills.Samples != 2 || deaths.Samples != 2 {
		t.Fatalf("samples kills=%d deaths=%d, want 2/2", kills.Samples, deaths.Samples)
	}
	// Bounds are the sampled extents ± heatmapPad (2): the kills raster must
	// span the ATTACKER positions, the deaths raster the VICTIM positions.
	if kills.MinX < 90 || kills.MaxX > 210 {
		t.Errorf("kills bounds x=[%.1f,%.1f], want the attacker span ~[98,202]", kills.MinX, kills.MaxX)
	}
	if deaths.MinX > 0 || deaths.MaxX > 60 {
		t.Errorf("deaths bounds x=[%.1f,%.1f], want the victim span ~[-2,52]", deaths.MinX, deaths.MaxX)
	}
	identical := len(kills.Cells) == len(deaths.Cells)
	if identical {
		for i := range kills.Cells {
			if kills.Cells[i] != deaths.Cells[i] {
				identical = false
				break
			}
		}
	}
	if identical {
		t.Error("kills and deaths heatmaps are identical")
	}
}
