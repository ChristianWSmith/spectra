package sidecar

import (
	"testing"

	"github.com/ChristianWSmith/spectra/internal/extract"
)

// TestLateJoiningKeyGetsAppendedSlot pins the slot table's growth rule
// (owner report 2026-11-17 — a covering bot's marker popped into
// existence at the takeover because its pre-takeover samples died at the
// first-frame slot table): a key first seen AFTER the initial frame
// APPENDS its own slot — handed-out slot numbers are never renumbered —
// its position AND state samples are stored under it, meta.json carries
// it for the roster join, and only a key arriving after maxSlots still
// fails soft to a skip.
func TestLateJoiningKeyGetsAppendedSlot(t *testing.T) {
	dir := t.TempDir()
	w, err := NewWriter(dir, 0)
	if err != nil {
		t.Fatalf("NewWriter: %v", err)
	}
	// The synthetic bot key's shape (extract.playerKey: 0xFF prefix |
	// entity id) — the same key the roster's players.steam_id carries.
	const botKey = uint64(0xFF00000000000000 | 0x0B07)
	humanA := extract.PositionPlayer{SteamID: slotA, X: 10, Y: 20, Z: 0, Side: "ct"}
	humanB := extract.PositionPlayer{SteamID: slotB, X: 30, Y: 40, Z: 0, Side: "t"}
	bot := extract.PositionPlayer{SteamID: botKey, X: 50, Y: 60, Z: 0, Side: "ct"}

	// Frame 1: the human roster claims the initial slots (first-seen order).
	if err := w.AddFrame(1000, []extract.PositionPlayer{humanA, humanB}); err != nil {
		t.Fatalf("AddFrame 1: %v", err)
	}
	// Frame 2: the covering bot joins mid-match — its key APPENDS slot 2.
	if err := w.AddFrame(1002, []extract.PositionPlayer{humanA, humanB, bot}); err != nil {
		t.Fatalf("AddFrame 2: %v", err)
	}
	// The state stream runs after the position sink per frame, so the
	// bot's state sample resolves through the slot the frame above just
	// handed out.
	if err := w.AddState(true, []extract.StatePlayer{
		{SteamID: slotA, HP: 100, Alive: true},
		{SteamID: botKey, HP: 77, Alive: true},
	}); err != nil {
		t.Fatalf("AddState: %v", err)
	}
	meta, err := w.Close(64)
	if err != nil {
		t.Fatalf("Close: %v", err)
	}
	want := []uint64{slotA, slotB, botKey}
	if len(meta.Players) != len(want) {
		t.Fatalf("slots = %v, want %v", meta.Players, want)
	}
	for i, id := range want {
		if meta.Players[i] != id {
			t.Errorf("slot %d = %d, want %d (append-only — handed-out numbers never renumber)", i, meta.Players[i], id)
		}
	}

	// Round trip: the closed stream decodes the bot's payload under its
	// own slot, and the state stream carries its record there too.
	// (ReadRange(0, 0) = through the end — the half-open range contract.)
	r, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	raw, err := r.ReadRange(0, 0)
	if err != nil {
		t.Fatalf("ReadRange: %v", err)
	}
	frames, err := DecodeFrames(raw, r.Meta().Players)
	if err != nil {
		t.Fatalf("DecodeFrames: %v", err)
	}
	if len(frames) != 2 {
		t.Fatalf("frames = %d, want 2", len(frames))
	}
	gotKeys := map[uint64]bool{}
	for _, p := range frames[1].Players {
		gotKeys[p.SteamID] = true
	}
	if !gotKeys[botKey] || !gotKeys[slotA] || !gotKeys[slotB] {
		t.Errorf("frame 2 players = %v, want A + B + the late bot", gotKeys)
	}

	stRaw, err := r.ReadStateRange(0, 0)
	if err != nil {
		t.Fatalf("ReadStateRange: %v", err)
	}
	records, err := DecodeStateRecords(stRaw)
	if err != nil {
		t.Fatalf("DecodeStateRecords: %v", err)
	}
	botSlot := 2 // appended after the two humans
	found := false
	for _, rec := range records {
		if rec.Slot == botSlot && rec.Has(StateHP) && rec.HP == 77 {
			found = true
		}
	}
	if !found {
		t.Errorf("no HP=77 state record on the late bot's slot %d (%+v)", botSlot, records)
	}
}

// TestSlotTableFullStillFailsSoft: growth is capped — a key arriving
// after maxSlots keeps the old contract (skip + log, never a parse
// failure).
func TestSlotTableFullStillFailsSoft(t *testing.T) {
	dir := t.TempDir()
	w, err := NewWriter(dir, 0)
	if err != nil {
		t.Fatalf("NewWriter: %v", err)
	}
	first := make([]extract.PositionPlayer, 0, maxSlots)
	for i := 0; i < maxSlots; i++ {
		first = append(first, extract.PositionPlayer{SteamID: uint64(76561198000000000 + i), X: float32(i)})
	}
	if err := w.AddFrame(1000, first); err != nil {
		t.Fatalf("AddFrame: %v", err)
	}
	overflow := extract.PositionPlayer{SteamID: 0xFF00000000000000 | 0x99, X: 1}
	if err := w.AddFrame(1002, append(first, overflow)); err != nil {
		t.Fatalf("AddFrame overflow: %v (the skip must not fail the parse)", err)
	}
	meta, err := w.Close(64)
	if err != nil {
		t.Fatalf("Close: %v", err)
	}
	if len(meta.Players) != maxSlots {
		t.Fatalf("slots = %d, want the %d cap", len(meta.Players), maxSlots)
	}
	for _, id := range meta.Players {
		if id == overflow.SteamID {
			t.Fatal("the overflow key claimed a slot past maxSlots")
		}
	}
}
