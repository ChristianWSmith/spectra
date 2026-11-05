package extract

import (
	"encoding/json"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestBombDropEvidence pins the bomb_drop evidence contract (the
// dropped-C4 position thread): the event's pos_* columns carry the
// CARRIER's position at the drop tick, DetailJSON tags source
// "carrier" and carries the bomb entity's position when one was
// known. The row keeps its original kind/source, so event counts are
// unaffected (the golden fixture pins those).
func TestBombDropEvidence(t *testing.T) {
	a := newAgg()
	px, py, pz := 10.0, 20.0, 3.0
	bx, by, bz := 11.0, 21.0, 4.0
	a.bombDropped(500, 76561198000000001, "carrier", &px, &py, &pz, &bx, &by, &bz)

	if len(a.events) != 1 {
		t.Fatalf("events = %d, want 1", len(a.events))
	}
	ev := a.events[0]
	if ev.Kind != models.EventBombDrop {
		t.Fatalf("kind = %s, want bomb_drop", ev.Kind)
	}
	if ev.PosX == nil || *ev.PosX != 10 || ev.PosY == nil || *ev.PosY != 20 || ev.PosZ == nil || *ev.PosZ != 3 {
		t.Fatalf("pos = %v/%v/%v, want the carrier drop position 10/20/3", ev.PosX, ev.PosY, ev.PosZ)
	}
	if ev.Attacker != "76561198000000001" {
		t.Errorf("attacker = %q, want the dropper's key", ev.Attacker)
	}
	var detail map[string]any
	if err := json.Unmarshal([]byte(ev.DetailJSON), &detail); err != nil {
		t.Fatalf("DetailJSON: %v", err)
	}
	if detail["source"] != "carrier" {
		t.Errorf("source = %v, want carrier", detail["source"])
	}
	if detail["player"] != "carrier" {
		t.Errorf("player = %v, want the dropper's name", detail["player"])
	}
	bp, ok := detail["bombPos"].([]any)
	if !ok || len(bp) != 3 || bp[0] != 11.0 || bp[1] != 21.0 || bp[2] != 4.0 {
		t.Errorf("bombPos = %v, want [11 21 4]", detail["bombPos"])
	}
}

// An unknown bomb-entity position (zero-vector → nils) must not stamp
// a bogus bombPos into the evidence — absence is the honest value.
func TestBombDropEvidenceOmitsUnknownBombPos(t *testing.T) {
	a := newAgg()
	px, py, pz := 1.0, 2.0, 3.0
	a.bombDropped(600, 0, "", &px, &py, &pz, nil, nil, nil)
	if len(a.events) != 1 {
		t.Fatalf("events = %d, want 1", len(a.events))
	}
	if a.events[0].PosX == nil || *a.events[0].PosX != 1 {
		t.Fatal("carrier position missing from the columns")
	}
	var detail map[string]any
	if err := json.Unmarshal([]byte(a.events[0].DetailJSON), &detail); err != nil {
		t.Fatalf("DetailJSON: %v", err)
	}
	if _, present := detail["bombPos"]; present {
		t.Errorf("bombPos present for an unknown position: %v", detail["bombPos"])
	}
}

// TestBombPickupEvidence pins the pickup contract: the position columns
// carry where the pickup happened, and DetailJSON's source flag records
// WHICH position was used (bomb entity, falling back to the player).
func TestBombPickupEvidence(t *testing.T) {
	a := newAgg()
	px, py, pz := 5.0, 6.0, 7.0
	a.bombPickedUp(700, 76561198000000002, "picker", &px, &py, &pz, "bomb")
	if len(a.events) != 1 {
		t.Fatalf("events = %d, want 1", len(a.events))
	}
	ev := a.events[0]
	if ev.Kind != models.EventBombPickup {
		t.Fatalf("kind = %s, want bomb_pickup", ev.Kind)
	}
	if ev.PosX == nil || *ev.PosX != 5 || ev.PosY == nil || *ev.PosY != 6 || ev.PosZ == nil || *ev.PosZ != 7 {
		t.Fatalf("pos = %v/%v/%v, want 5/6/7", ev.PosX, ev.PosY, ev.PosZ)
	}
	if ev.Attacker != "76561198000000002" {
		t.Errorf("attacker = %q, want the picker's key", ev.Attacker)
	}
	var detail map[string]any
	if err := json.Unmarshal([]byte(ev.DetailJSON), &detail); err != nil {
		t.Fatalf("DetailJSON: %v", err)
	}
	if detail["source"] != "bomb" || detail["player"] != "picker" {
		t.Errorf("detail = %v, want source=bomb player=picker", detail)
	}
}
