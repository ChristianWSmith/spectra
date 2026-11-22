package store

import (
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestEncounterRoundTrip writes encounters with samples, reads them back, and
// checks that a second save replaces (not appends) the match's encounters.
func TestEncounterRoundTrip(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/enc.dem", "sha-enc", time.Now())
	rows := []models.EncounterRow{{
		Round: 2, Shooter: "100", Enemy: "200", StartTick: 500, EndTick: 502, SeedTick: 501,
		Samples: []models.EncounterSample{
			{Tick: 500, ShooterEye: [3]float64{1, 2, 64}, EnemyEye: [3]float64{300, 4, 64}, EnemyWorld: [3]float64{300, 4, 0}},
			{Tick: 501, ShooterEye: [3]float64{1, 2, 64}, EnemyEye: [3]float64{301, 4, 46}, EnemyWorld: [3]float64{301, 4, 0}},
		},
	}}
	if err := s.SaveEncounters(id, rows); err != nil {
		t.Fatalf("SaveEncounters: %v", err)
	}
	if err := s.SaveEncounters(id, rows); err != nil {
		t.Fatalf("SaveEncounters again: %v", err)
	}
	got, err := s.GetEncounters(id)
	if err != nil {
		t.Fatalf("GetEncounters: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("encounters = %d, want 1 (a re-save replaces)", len(got))
	}
	e := got[0]
	if e.Shooter != "100" || e.Enemy != "200" || e.SeedTick != 501 || e.Round != 2 {
		t.Errorf("encounter header = %+v", e)
	}
	if len(e.Samples) != 2 || e.Samples[1].EnemyEye != [3]float64{301, 4, 46} || e.Samples[0].EnemyWorld != [3]float64{300, 4, 0} {
		t.Errorf("samples = %+v", e.Samples)
	}
}
