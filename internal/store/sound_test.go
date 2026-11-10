package store

import (
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestSoundEventsSaveAndRead pins the sound_events persistence contract
// (extract.sos.go writes, this reads): SaveExtracted's batch insert
// roundtrips every column, GetSoundEvents serves an INCLUSIVE tick window
// (0 = open bound on that side) in tick order, the presence count splits by
// kind, and a reprocess (second SaveExtracted) replaces the rows instead of
// appending — the childTables lifecycle every other child table follows.
func TestSoundEventsSaveAndRead(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/sound.dem", "sha-sound-read", time.Now())

	em := testExtracted("sha-sound-read", time.Now())
	em.SoundEvents = []models.SoundEvent{
		{Tick: 300, Round: 2, SteamID: "100", Kind: models.SoundStep, Material: "Gravel", TeamPrefix: "ct", SOSName: "CT_Gravel.StepLeft"},
		{Tick: 100, Round: 1, SteamID: "200", Kind: models.SoundLand, Material: "Concrete", TeamPrefix: "", SOSName: "Land_Concrete.StepLeft"},
		{Tick: 200, Round: 1, SteamID: "100", Kind: models.SoundJump, TeamPrefix: "ct", SOSName: "Gear.JumpLand.CT"},
	}
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}

	// Whole match (both bounds open), ordered by tick.
	all, err := s.GetSoundEvents(id, 0, 0)
	if err != nil {
		t.Fatalf("GetSoundEvents(all): %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("rows = %d, want 3", len(all))
	}
	wantTicks := []int{100, 200, 300}
	for i, se := range all {
		if se.Tick != wantTicks[i] {
			t.Errorf("row %d tick = %d, want %d (tick order)", i, se.Tick, wantTicks[i])
		}
		if se.MatchID != id {
			t.Errorf("row %d matchId = %d, want %d", i, se.MatchID, id)
		}
	}
	// Full-column roundtrip on the first row.
	if all[0].SteamID != "200" || all[0].Kind != models.SoundLand ||
		all[0].Material != "Concrete" || all[0].SOSName != "Land_Concrete.StepLeft" || all[0].Round != 1 {
		t.Errorf("row 0 = %+v", all[0])
	}
	// A jump carries no material (the name spells none) — "" is stored, not
	// a fabricated token.
	if all[1].Material != "" || all[1].TeamPrefix != "ct" {
		t.Errorf("jump row material/team = %q/%q, want empty material", all[1].Material, all[1].TeamPrefix)
	}

	// Inclusive window: both bounds are kept.
	win, err := s.GetSoundEvents(id, 200, 300)
	if err != nil {
		t.Fatalf("GetSoundEvents(200,300): %v", err)
	}
	if len(win) != 2 || win[0].Tick != 200 || win[1].Tick != 300 {
		t.Errorf("window = %+v, want the two rows at 200 and 300", win)
	}
	// Open lower bound (0) with a closed upper: everything <= 200.
	lo, err := s.GetSoundEvents(id, 0, 200)
	if err != nil {
		t.Fatalf("GetSoundEvents(0,200): %v", err)
	}
	if len(lo) != 2 || lo[0].Tick != 100 {
		t.Errorf("lower-open window = %+v, want rows at 100 and 200", lo)
	}
	// A window with no rows is empty, not an error.
	none, err := s.GetSoundEvents(id, 5000, 6000)
	if err != nil {
		t.Fatalf("GetSoundEvents(empty): %v", err)
	}
	if len(none) != 0 {
		t.Errorf("empty window returned %d rows", len(none))
	}

	// Presence: total + per-kind split, kinds with rows only.
	pres, err := s.GetSoundEventPresence(id)
	if err != nil {
		t.Fatalf("GetSoundEventPresence: %v", err)
	}
	if pres.MatchID != id || pres.Total != 3 {
		t.Fatalf("presence = %+v, want matchId %d / total 3", pres, id)
	}
	if pres.ByKind[models.SoundStep] != 1 || pres.ByKind[models.SoundLand] != 1 || pres.ByKind[models.SoundJump] != 1 {
		t.Errorf("byKind = %v, want one of each", pres.ByKind)
	}
	if _, ok := pres.ByKind[models.SoundFall]; ok {
		t.Errorf("byKind carries a fabricated fall entry: %v", pres.ByKind)
	}

	// A second SaveExtracted REPLACES the rows (childTables delete-first).
	em.SoundEvents = em.SoundEvents[:1]
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted (2nd): %v", err)
	}
	after, err := s.GetSoundEvents(id, 0, 0)
	if err != nil {
		t.Fatalf("GetSoundEvents (after reprocess): %v", err)
	}
	if len(after) != 1 || after[0].Tick != 300 {
		t.Errorf("after reprocess = %+v, want only the kept row", after)
	}
	pres, err = s.GetSoundEventPresence(id)
	if err != nil || pres.Total != 1 {
		t.Errorf("presence after reprocess = %+v, err %v, want total 1", pres, err)
	}

	// DeleteMatchData clears the rows with the rest of the children.
	if err := s.DeleteMatchData(id); err != nil {
		t.Fatalf("DeleteMatchData: %v", err)
	}
	if rows, err := s.GetSoundEvents(id, 0, 0); err != nil || len(rows) != 0 {
		t.Errorf("after delete = %d rows, err %v; want 0", len(rows), err)
	}
}

// TestSoundEventsPresenceOptional pins the optional-read contract: a match
// with no sound rows — or an unknown match id — yields a ZERO presence with
// no error (the UI's "no footstep data" answer), like the blind/drop
// payload reads. NUL bytes in a name are scrubbed like every other bound
// string (demo-sourced text can carry them).
func TestSoundEventsPresenceOptional(t *testing.T) {
	s := openMem(t)

	pres, err := s.GetSoundEventPresence(4242)
	if err != nil {
		t.Fatalf("presence for unknown match: %v", err)
	}
	if pres.Total != 0 || len(pres.ByKind) != 0 {
		t.Errorf("unknown match presence = %+v, want zero", pres)
	}
	rows, err := s.GetSoundEvents(4242, 0, 0)
	if err != nil || len(rows) != 0 {
		t.Errorf("unknown match rows = %d, err %v; want empty", len(rows), err)
	}

	id := saveTestMatch(t, s, "/d/sound2.dem", "sha-sound-presence", time.Now())
	em := testExtracted("sha-sound-presence", time.Now())
	em.SoundEvents = []models.SoundEvent{
		{Tick: 10, Round: 1, SteamID: "100", Kind: models.SoundStep, Material: "Gravel\x00dust", TeamPrefix: "ct", SOSName: "CT_Gravel\x00. StepLeft"},
	}
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	got, err := s.GetSoundEvents(id, 0, 0)
	if err != nil || len(got) != 1 {
		t.Fatalf("rows = %d, err %v", len(got), err)
	}
	if got[0].Material != "Graveldust" || got[0].SOSName != "CT_Gravel. StepLeft" {
		t.Errorf("NUL scrub failed: material=%q sos=%q", got[0].Material, got[0].SOSName)
	}
}
