package store

import (
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestEncounterWindowRoundTrip writes a mutual window (two encounters) with its
// samples, reads it back, and checks that a second save replaces the match's rows.
func TestEncounterWindowRoundTrip(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/enc.dem", "sha-enc", time.Now())
	wins := []models.EncounterWindow{{
		Round: 2, P1: "100", P2: "200", StartTick: 500, EndTick: 502,
		Samples: []models.WindowSample{
			{Tick: 500, P1Eye: [3]float64{1, 2, 64}, P1World: [3]float64{1, 2, 0}, P2Eye: [3]float64{300, 4, 64}, P2World: [3]float64{300, 4, 0}},
			{Tick: 501, P1Eye: [3]float64{1, 2, 64}, P1World: [3]float64{1, 2, 0}, P2Eye: [3]float64{301, 4, 46}, P2World: [3]float64{301, 4, 0}},
		},
		Encounters: []models.Encounter{
			{Shooter: "100", Enemy: "200", StartTick: 500, EndTick: 501, SeedTick: 501},
			{Shooter: "200", Enemy: "100", StartTick: 501, EndTick: 502, SeedTick: 501},
		},
	}}
	if err := s.SaveEncounterWindows(id, wins); err != nil {
		t.Fatalf("SaveEncounterWindows: %v", err)
	}
	if err := s.SaveEncounterWindows(id, wins); err != nil {
		t.Fatalf("SaveEncounterWindows again: %v", err)
	}
	got, err := s.GetEncounterWindows(id)
	if err != nil {
		t.Fatalf("GetEncounterWindows: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("windows = %d, want 1 (a re-save replaces)", len(got))
	}
	w := got[0]
	if w.P1 != "100" || w.P2 != "200" || w.Round != 2 || w.StartTick != 500 || w.EndTick != 502 {
		t.Errorf("window header = %+v", w)
	}
	if len(w.Samples) != 2 || w.Samples[1].P2Eye != [3]float64{301, 4, 46} || w.Samples[0].P1World != [3]float64{1, 2, 0} {
		t.Errorf("samples = %+v", w.Samples)
	}
	if len(w.Encounters) != 2 || w.Encounters[0].Shooter != "100" || w.Encounters[1].Shooter != "200" {
		t.Errorf("encounters = %+v (both sides of the mutual fight)", w.Encounters)
	}
}
