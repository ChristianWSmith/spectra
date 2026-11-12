package store

import (
	"fmt"
	"reflect"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// bulkDetailFixture saves ONE match with grenade rows carrying detail +
// raw payloads (and a kill row for the typed-columns comparison), a
// player roster so the playersJoin name joins have something to resolve,
// and returns the store + match id.
func bulkDetailFixture(t *testing.T) (*Store, int64) {
	t.Helper()
	s := openMem(t)
	id, err := s.CreateMatchRow("/d/bulk.dem", "sha-event-details", 9)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	em := &models.ExtractedMatch{
		Players: []models.Player{
			{SteamID: "100", Name: "alice", Side: "ct"},
			{SteamID: "200", Name: "bob", Side: "t"},
		},
		Events: []models.Event{
			{Tick: 100, Round: 1, Kind: models.EventGrenadeThrow, Attacker: "100",
				Weapon: "smokegrenade", PosX: pf(1.5), PosY: pf(-2.5), PosZ: pf(3.0),
				DetailJSON: `{"entity":4242}`, RawJSON: `{"raw":1}`},
			{Tick: 110, Round: 1, Kind: models.EventGrenadeBounce, Attacker: "100",
				Weapon: "smokegrenade", DetailJSON: `{"entity":4242}`, RawJSON: `{"raw":2}`},
			{Tick: 120, Round: 1, Kind: models.EventKill, Attacker: "100", Victim: "200",
				Weapon: "ak47", DetailJSON: `{"entity":0}`, RawJSON: `{"raw":3}`},
		},
	}
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	return s, id
}

// TestGetEventDetailsBulkEqualsSingle pins the bulk read against the
// single read it replaces: for every requested id the bulk row deep-
// equals GetEvent(id) (typed columns, payloads, player-name joins), the
// bulk row's typed half equals the LIST read's row, INPUT ORDER survives
// a shuffled request, unknown ids are skipped (never fabricated), and
// empty input yields an empty result.
func TestGetEventDetailsBulkEqualsSingle(t *testing.T) {
	s, id := bulkDetailFixture(t)

	all, err := s.GetEvents(models.EventFilter{MatchID: id})
	if err != nil {
		t.Fatalf("GetEvents: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("GetEvents len = %d, want 3", len(all))
	}

	// A SHUFFLED request with an unknown id wedged in the middle.
	ids := []int64{all[2].ID, 999999, all[0].ID, all[1].ID}
	got, err := s.GetEventDetails(ids)
	if err != nil {
		t.Fatalf("GetEventDetails: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("GetEventDetails len = %d, want 3 (the unknown id skipped)", len(got))
	}
	wantOrder := []int64{all[2].ID, all[0].ID, all[1].ID}
	for i, wantID := range wantOrder {
		if got[i].ID != wantID {
			t.Errorf("GetEventDetails[%d].ID = %d, want %d (input order preserved)", i, got[i].ID, wantID)
		}
		single, err := s.GetEvent(wantID)
		if err != nil {
			t.Fatalf("GetEvent(%d): %v", wantID, err)
		}
		if !reflect.DeepEqual(got[i], *single) {
			t.Errorf("GetEventDetails row != GetEvent(%d):\n bulk   = %+v\n single = %+v",
				wantID, got[i], *single)
		}
		for _, lr := range all {
			if lr.ID == wantID && !reflect.DeepEqual(got[i].EventRow, lr) {
				t.Errorf("GetEventDetails(%d).EventRow != list row:\n bulk = %+v\n list = %+v",
					wantID, got[i].EventRow, lr)
			}
		}
	}

	// The payload the replay's grenade hydration reads, plus the joined
	// player name — the fields a caller actually looks at.
	throwRow, err := s.GetEventDetails([]int64{all[0].ID})
	if err != nil || len(throwRow) != 1 {
		t.Fatalf("GetEventDetails(throw) = %+v, %v", throwRow, err)
	}
	if throwRow[0].DetailJSON != `{"entity":4242}` || throwRow[0].RawJSON != `{"raw":1}` {
		t.Errorf("throw payloads = %q/%q, want {\"entity\":4242}/{\"raw\":1}",
			throwRow[0].DetailJSON, throwRow[0].RawJSON)
	}
	if throwRow[0].AttackerName != "alice" {
		t.Errorf("throw AttackerName = %q, want alice (playersJoin in the bulk read)", throwRow[0].AttackerName)
	}

	// Empty input → empty result (the frontend's zero-work path).
	for _, empty := range [][]int64{nil, {}} {
		got, err := s.GetEventDetails(empty)
		if err != nil || len(got) != 0 {
			t.Errorf("GetEventDetails(%v) = %+v, %v; want empty slice, nil", empty, got, err)
		}
	}
}

// TestGetEventDetailsChunksLargeInputs: an id list longer than the
// IN-list chunk (inListChunk) still returns EVERY id, in input order —
// no truncation at a chunk boundary, no reordering across chunks.
func TestGetEventDetailsChunksLargeInputs(t *testing.T) {
	s := openMem(t)
	id, err := s.CreateMatchRow("/d/chunk.dem", "sha-event-details-chunk", 9)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	n := inListChunk + 10 // one full chunk plus a spill
	em := &models.ExtractedMatch{Events: make([]models.Event, n)}
	for i := range em.Events {
		em.Events[i] = models.Event{
			Tick: 100 + i, Round: 1, Kind: models.EventGrenade,
			DetailJSON: fmt.Sprintf(`{"entity":%d}`, i),
		}
	}
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}

	all, err := s.GetEvents(models.EventFilter{MatchID: id})
	if err != nil {
		t.Fatalf("GetEvents: %v", err)
	}
	if len(all) != n {
		t.Fatalf("GetEvents len = %d, want %d", len(all), n)
	}
	// DESCENDING ids: order must survive the chunked read even when the
	// request runs counter to the table's natural order.
	ids := make([]int64, n)
	for i := range ids {
		ids[i] = all[n-1-i].ID
	}
	got, err := s.GetEventDetails(ids)
	if err != nil {
		t.Fatalf("GetEventDetails: %v", err)
	}
	if len(got) != n {
		t.Fatalf("GetEventDetails len = %d, want %d (chunk boundary truncation?)", len(got), n)
	}
	for i, d := range got {
		if d.ID != ids[i] {
			t.Fatalf("GetEventDetails[%d].ID = %d, want %d (input order across chunks)", i, d.ID, ids[i])
		}
		if want := fmt.Sprintf(`{"entity":%d}`, n-1-i); d.DetailJSON != want {
			t.Errorf("GetEventDetails[%d].DetailJSON = %q, want %q", i, d.DetailJSON, want)
		}
	}
}
