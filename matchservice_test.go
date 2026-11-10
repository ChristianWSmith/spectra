package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/library"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// newMatchServiceFixture opens an in-memory store with ONE extracted
// match (teams "alpha"/"beta") and returns the service + match id.
func newMatchServiceFixture(t *testing.T) (*MatchService, int64) {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	id, err := st.CreateMatchRow("/d/svc.dem", "sha-matchservice", 42)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	em := &models.ExtractedMatch{
		Match: models.Match{
			Path: "/d/svc.dem", SHA256: "sha-matchservice", Size: 42,
			Map: "de_dust2", TickRate: 64, RealRounds: 3,
			ScoreCT: 2, ScoreT: 1, ExtractedAt: time.Now(),
		},
		Teams: []models.Team{
			{Side: "ct", Name: "alpha", Score: 2},
			{Side: "t", Name: "beta", Score: 1},
		},
	}
	if err := st.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	return &MatchService{st: st}, id
}

// TestGetMatchStampsCopyState pins the service-owned annotation:
// MatchService.GetMatch derives CopyState from the filesystem
// (library.Importer.CopyState) — a bare MatchService (no importer wired)
// and the store itself leave it "", which is the "store never fills it"
// rule made observable.
func TestGetMatchStampsCopyState(t *testing.T) {
	svc, id := newMatchServiceFixture(t)

	// No importer wired: the field stays the store's empty default.
	bare, err := svc.GetMatch(id)
	if err != nil {
		t.Fatalf("GetMatch: %v", err)
	}
	if bare.CopyState != "" {
		t.Errorf("CopyState without an importer = %q, want \"\" (the store never fills it)", bare.CopyState)
	}

	// With an importer: no copy on disk and the fixture's stored path
	// (/d/svc.dem) not being a real file → "missing".
	copyDir := t.TempDir()
	imp := library.New(library.Options{
		Store:         svc.st,
		Parse:         stubParse,
		ParserVersion: "test",
		SidecarDir:    t.TempDir(),
		CopyDir:       copyDir,
	})
	t.Cleanup(imp.Shutdown)
	svc.imp = imp

	m, err := svc.GetMatch(id)
	if err != nil {
		t.Fatalf("GetMatch: %v", err)
	}
	if m.CopyState != "missing" {
		t.Errorf("CopyState (no copy, dead source) = %q, want missing", m.CopyState)
	}

	// The copy lands → "copied", derived fresh on the next read (nothing
	// cached, nothing stored).
	if err := os.WriteFile(filepath.Join(copyDir, m.SHA256+".dem"), []byte("x"), 0o644); err != nil {
		t.Fatalf("write copy: %v", err)
	}
	m, err = svc.GetMatch(id)
	if err != nil {
		t.Fatalf("GetMatch: %v", err)
	}
	if m.CopyState != "copied" {
		t.Errorf("CopyState (copy on disk) = %q, want copied", m.CopyState)
	}
}

// TestGetMatchSummary: unknown id → store.ErrNotFound; known id → exactly
// the ListMatches row for that id (the single-match read contract).
func TestGetMatchSummary(t *testing.T) {
	svc, id := newMatchServiceFixture(t)

	if _, err := svc.GetMatchSummary(999999); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("GetMatchSummary(999999) err = %v, want store.ErrNotFound", err)
	}

	list, err := svc.st.ListMatches("", "", false)
	if err != nil {
		t.Fatalf("ListMatches: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("ListMatches len = %d, want 1", len(list))
	}
	want := list[0]
	got, err := svc.GetMatchSummary(id)
	if err != nil {
		t.Fatalf("GetMatchSummary: %v", err)
	}
	if got.ID != want.ID || got.Path != want.Path || got.Map != want.Map || got.Size != want.Size ||
		got.ScoreCT != want.ScoreCT || got.ScoreT != want.ScoreT || got.CTName != want.CTName ||
		got.TName != want.TName || got.RealRounds != want.RealRounds || got.Status != want.Status ||
		got.SHA256 != want.SHA256 {
		t.Errorf("GetMatchSummary = %+v\n       ListMatches row = %+v", got, want)
	}
	if got.ID != id {
		t.Errorf("GetMatchSummary id = %d, want %d", got.ID, id)
	}
}

// TestGetTeamNames: unknown id → store.ErrNotFound; known id → the two
// team display names, equal to the ListMatches row's name columns.
func TestGetTeamNames(t *testing.T) {
	svc, id := newMatchServiceFixture(t)

	if _, err := svc.GetTeamNames(999999); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("GetTeamNames(999999) err = %v, want store.ErrNotFound", err)
	}

	names, err := svc.GetTeamNames(id)
	if err != nil {
		t.Fatalf("GetTeamNames: %v", err)
	}
	if names.CT != "alpha" || names.T != "beta" {
		t.Errorf("GetTeamNames = %+v, want {CT:alpha T:beta}", names)
	}

	list, err := svc.st.ListMatches("", "", false)
	if err != nil {
		t.Fatalf("ListMatches: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("ListMatches len = %d, want 1", len(list))
	}
	if names.CT != list[0].CTName || names.T != list[0].TName {
		t.Errorf("GetTeamNames = %q/%q, ListMatches row = %q/%q",
			names.CT, names.T, list[0].CTName, list[0].TName)
	}
}

// TestGetBlindDurations: the replay flash-white overlay's narrow read —
// blind rows only (a kill carrying the same payload field stays out),
// events.seq order, a missing duration maps to 0 (the frontend drops
// those), and a match with no blinds yields an empty slice, never an
// error.
func TestGetBlindDurations(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	id, err := st.CreateMatchRow("/d/blind.dem", "sha-blind-durations", 7)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	if err := st.SaveExtracted(id, &models.ExtractedMatch{Events: []models.Event{
		{Tick: 10, Round: 1, Kind: models.EventBlind, Victim: "1",
			DetailJSON: `{"flashDurationMs":1200}`},
		{Tick: 20, Round: 1, Kind: models.EventBlind, Victim: "2"}, // no duration → 0
		{Tick: 30, Round: 1, Kind: models.EventKill, Victim: "1",
			DetailJSON: `{"flashDurationMs":999}`}, // not a blind row
	}}); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	svc := &MatchService{st: st}
	got, err := svc.GetBlindDurations(id)
	if err != nil {
		t.Fatalf("GetBlindDurations: %v", err)
	}
	want := []BlindDuration{{Seq: 0, Ms: 1200}, {Seq: 1, Ms: 0}}
	if len(got) != len(want) {
		t.Fatalf("GetBlindDurations = %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("GetBlindDurations[%d] = %+v, want %+v", i, got[i], want[i])
		}
	}
	// A match with no blinds: empty slice, nil error (fail-soft input).
	other, err := st.CreateMatchRow("/d/none.dem", "sha-no-blinds", 0)
	if err != nil {
		t.Fatalf("CreateMatchRow(other): %v", err)
	}
	if got, err := svc.GetBlindDurations(other); err != nil || len(got) != 0 {
		t.Errorf("no-blind match = %+v, %v; want empty slice, nil", got, err)
	}
}

// TestGetDropDetails: the replay drop layer's narrow read — weapon_drop
// rows only in events.seq order (a kill carrying the same payload fields
// stays out), cat/mag/reserve roundtrip, and a match with no drops
// yields an empty slice, never an error.
func TestGetDropDetails(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	id, err := st.CreateMatchRow("/d/drops.dem", "sha-drop-details", 7)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	if err := st.SaveExtracted(id, &models.ExtractedMatch{Events: []models.Event{
		{Tick: 10, Round: 1, Kind: models.EventWeaponDrop, Attacker: "1", Weapon: "AK-47",
			DetailJSON: `{"cat":"gun","mag":17,"reserve":90}`},
		{Tick: 20, Round: 1, Kind: models.EventWeaponDrop, Attacker: "2", Weapon: "Flashbang",
			DetailJSON: `{"cat":"util"}`},
		{Tick: 30, Round: 1, Kind: models.EventKill, Victim: "1",
			DetailJSON: `{"cat":"gun","mag":5}`}, // not a weapon_drop row
	}}); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	svc := &MatchService{st: st}
	got, err := svc.GetDropDetails(id)
	if err != nil {
		t.Fatalf("GetDropDetails: %v", err)
	}
	want := []models.DropDetail{
		{Seq: 0, Cat: "gun", Mag: 17, Reserve: 90},
		{Seq: 1, Cat: "util", Mag: 0, Reserve: 0},
	}
	if len(got) != len(want) {
		t.Fatalf("GetDropDetails = %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("GetDropDetails[%d] = %+v, want %+v", i, got[i], want[i])
		}
	}
	// A match with no drops: empty slice, nil error (fail-soft input).
	other, err := st.CreateMatchRow("/d/none.dem", "sha-no-drops", 0)
	if err != nil {
		t.Fatalf("CreateMatchRow(other): %v", err)
	}
	if got, err := svc.GetDropDetails(other); err != nil || len(got) != 0 {
		t.Errorf("no-drop match = %+v, %v; want empty slice, nil", got, err)
	}
}
