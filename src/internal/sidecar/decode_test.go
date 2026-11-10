package sidecar

import (
	"bytes"
	"math"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/extract"
)

// TestDecodeFramesRoundTrip writes a small sidecar through the Writer,
// reads the raw stream back and decodes it.
func TestDecodeFramesRoundTrip(t *testing.T) {
	dir := t.TempDir()
	w, err := NewWriter(dir, 64)
	if err != nil {
		t.Fatalf("NewWriter: %v", err)
	}
	type frame struct {
		tick    int32
		players []extract.PositionPlayer
	}
	frames := []frame{
		{0, []extract.PositionPlayer{
			{SteamID: 111, X: -123.4, Y: 567.8, Z: 12.9, Yaw: 45, Air: true},
			{SteamID: 222, X: 1000, Y: -2000, Z: 0, Yaw: 179.3},
		}},
		{16, []extract.PositionPlayer{
			{SteamID: 111, X: -120, Y: 560, Z: 12, Yaw: -90, Duck: true},
			{SteamID: 222, X: 1000, Y: -2000, Z: 0, Yaw: 179.3},
		}},
		{32, nil}, // empty frame
	}
	for _, f := range frames {
		if err := w.AddFrame(f.tick, f.players); err != nil {
			t.Fatalf("AddFrame(%d): %v", f.tick, err)
		}
	}
	meta, err := w.Close(64)
	if err != nil {
		t.Fatalf("Close: %v", err)
	}
	if meta.Frames != 3 || len(meta.Players) != 2 {
		t.Fatalf("meta = %+v, want 3 frames / 2 slots", meta)
	}

	r, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	raw, err := r.ReadRange(0, 0)
	if err != nil {
		t.Fatalf("ReadRange: %v", err)
	}
	got, err := DecodeFrames(raw, r.Meta().Players)
	if err != nil {
		t.Fatalf("DecodeFrames: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("frames = %d, want 3", len(got))
	}
	if got[0].Tick != 0 || len(got[0].Players) != 2 {
		t.Errorf("frame 0 = %+v", got[0])
	}
	p := got[0].Players[0]
	if p.SteamID != 111 || !p.Air || p.Duck {
		t.Errorf("frame 0 player = %+v, want steam 111 airborne", p)
	}
	if math.Abs(p.X-(-123.4)) > 1.01 || math.Abs(p.Y-567.8) > 1.01 || math.Abs(p.Z-12.9) > 1.01 {
		t.Errorf("frame 0 pos = %v/%v/%v, want quantized -123.4/567.8/12.9", p.X, p.Y, p.Z)
	}
	if math.Abs(p.Yaw-45) > 1.5 {
		t.Errorf("frame 0 yaw = %v, want ~45", p.Yaw)
	}
	if got[1].Tick != 16 || len(got[1].Players) != 2 {
		t.Errorf("frame 1 = %+v", got[1])
	}
	if got[1].Players[1].SteamID != 222 || !got[1].Players[1].Duck {
		// player 1 is the 111 sample (duck); player 2 is 222.
		if got[1].Players[0].SteamID == 222 {
			t.Errorf("slot order wrong: %+v", got[1].Players)
		}
	}
	if !got[1].Players[0].Duck {
		t.Errorf("frame 1 player 111 duck flag = false, want true")
	}
	if len(got[2].Players) != 0 {
		t.Errorf("frame 2 = %+v, want empty", got[2])
	}
}

func TestDecodeFramesErrors(t *testing.T) {
	if _, err := DecodeFrames([]byte{1, 2, 3}, nil); err == nil {
		t.Error("truncated header: err = nil")
	}
	// Valid header (mask=1 → 8 payload bytes) but no payload.
	if _, err := DecodeFrames([]byte{0, 0, 0, 0, 1, 0}, nil); err == nil {
		t.Error("truncated payload: err = nil")
	}
	// Empty input is a valid empty stream.
	got, err := DecodeFrames(nil, nil)
	if err != nil || len(got) != 0 {
		t.Errorf("empty stream = %+v, %v", got, err)
	}
}

func TestDecodeFramesSkipsUnknownSlots(t *testing.T) {
	// One frame, mask bit 3 set, but the slot table only has 1 entry: the
	// payload must still walk correctly and the player be skipped.
	var b bytes.Buffer
	b.Write([]byte{1, 0, 0, 0})                        // tick 1
	b.Write([]byte{8, 0})                              // mask: slot 3
	b.Write(make([]byte, 8))                           // one player payload
	got, err := DecodeFrames(b.Bytes(), []uint64{999}) // table too short for slot 3
	if err != nil {
		t.Fatalf("DecodeFrames: %v", err)
	}
	if len(got) != 1 || len(got[0].Players) != 0 {
		t.Errorf("got = %+v, want one empty frame (unknown slot skipped)", got)
	}
}
