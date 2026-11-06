package sidecar

import (
	"encoding/json"
	"testing"
)

// TestPlayerColorsRideTheSlotTable pins extract.RosterSink's delivery
// through to meta.json: colors land BY SLOT INDEX next to the SteamIDs
// (the same order ReplayService.GetReplayMeta walks), a roster entry
// outside the slot table never invents a row, and a slot the roster never
// reported a color for records -1 ("none") rather than a guess.
func TestPlayerColorsRideTheSlotTable(t *testing.T) {
	dir := t.TempDir()
	w, err := NewWriter(dir, 0)
	if err != nil {
		t.Fatalf("NewWriter: %v", err)
	}
	// The first frame carries A then B → the slot table locks on [A, B].
	tick, players := syntheticState(0)
	if err := w.AddFrame(tick, players); err != nil {
		t.Fatalf("AddFrame: %v", err)
	}
	// Delivered after the slot table locked, exactly as Parse does at the
	// end of a parse; 999 is a SteamID that is NOT in the table.
	w.SetPlayerColors(map[uint64]int{slotA: 3, slotB: 0, 999: 4})

	meta, err := w.Close(64)
	if err != nil {
		t.Fatalf("Close: %v", err)
	}
	if len(meta.Players) != 2 || len(meta.PlayerColors) != 2 {
		t.Fatalf("slots = %v, colors = %v, want 2/2", meta.Players, meta.PlayerColors)
	}
	want := map[uint64]int{slotA: 3, slotB: 0}
	for i, id := range meta.Players {
		if meta.PlayerColors[i] != want[id] {
			t.Errorf("slot %d (steamId %d) color = %d, want %d", i, id, meta.PlayerColors[i], want[id])
		}
	}
	if c, ok := meta.ColorAt(0); !ok || c != 3 {
		t.Errorf("ColorAt(0) = (%d, %v), want (3, true)", c, ok)
	}
	// Re-opened from disk (meta.json round trip).
	r, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if c, ok := r.Meta().ColorAt(1); !ok || c != 0 {
		t.Errorf("reopened ColorAt(1) = (%d, %v), want (0, true)", c, ok)
	}
}

// TestPlayerColorsFailSoft covers the two "no color" cases callers must
// distinguish from blue (0): a parse that delivered no roster colors
// (meta carries no playerColors key at all) and a roster entry missing
// for one slot (-1).
func TestPlayerColorsFailSoft(t *testing.T) {
	dir := t.TempDir()
	w, err := NewWriter(dir, 0)
	if err != nil {
		t.Fatalf("NewWriter: %v", err)
	}
	tick, players := syntheticState(0)
	if err := w.AddFrame(tick, players); err != nil {
		t.Fatalf("AddFrame: %v", err)
	}
	w.SetPlayerColors(nil) // a parse with no RosterSink delivery
	meta, err := w.Close(64)
	if err != nil {
		t.Fatalf("Close: %v", err)
	}
	if meta.PlayerColors != nil {
		t.Errorf("PlayerColors = %v, want nil (no key in meta.json)", meta.PlayerColors)
	}
	if c, ok := meta.ColorAt(0); ok {
		t.Errorf("ColorAt(0) = (%d, true), want ok=false for a sidecar without the field", c)
	}

	// Roster that never reported B: B's slot records -1, not 0/blue.
	dir2 := t.TempDir()
	w2, err := NewWriter(dir2, 0)
	if err != nil {
		t.Fatalf("NewWriter: %v", err)
	}
	if err := w2.AddFrame(tick, players); err != nil {
		t.Fatalf("AddFrame: %v", err)
	}
	w2.SetPlayerColors(map[uint64]int{slotA: 1})
	meta2, err := w2.Close(64)
	if err != nil {
		t.Fatalf("Close: %v", err)
	}
	if len(meta2.PlayerColors) != 2 || meta2.PlayerColors[0] != 1 || meta2.PlayerColors[1] != -1 {
		t.Errorf("PlayerColors = %v, want [1 -1]", meta2.PlayerColors)
	}
}

// TestPlayerColorsAbsentFromOldMetaJSON is the pre-field sidecar: meta.json
// written before playerColors existed must still parse and report "no
// color" (graceful degradation — no schema, no migration).
func TestPlayerColorsAbsentFromOldMetaJSON(t *testing.T) {
	const raw = `{
  "formatVersion": 2,
  "tickRate": 64,
  "sampleRate": 64,
  "frames": 3,
  "encoding": "q16-v2",
  "players": [76561198000000001, 76561198000000002]
}`
	var m Meta
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatalf("parse pre-field meta.json: %v", err)
	}
	if m.PlayerColors != nil {
		t.Errorf("PlayerColors = %v, want nil", m.PlayerColors)
	}
	if _, ok := m.ColorAt(0); ok {
		t.Error("ColorAt(0) must report ok=false for a sidecar without the field")
	}
	if _, ok := m.ColorAt(-1); ok {
		t.Error("ColorAt(-1) must report ok=false")
	}
}
