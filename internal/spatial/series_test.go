package spatial

import (
	"errors"
	"math"
	"path/filepath"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/extract"
	"github.com/ChristianWSmith/spectra/internal/sidecar"
)

// writeSyntheticSidecar writes frames to dir via the real M2 writer. Each
// call of pos(i) returns the four players' (x,y) for frame index i.
func writeSyntheticSidecar(t *testing.T, dir string, frames int, pos func(i int) [4][2]float64) {
	t.Helper()
	w, err := sidecar.NewWriter(dir, 64)
	if err != nil {
		t.Fatalf("NewWriter: %v", err)
	}
	ids := []uint64{1, 2, 3, 4}
	for i := 0; i < frames; i++ {
		xy := pos(i)
		players := make([]extract.PositionPlayer, 0, 4)
		for s := 0; s < 4; s++ {
			players = append(players, extract.PositionPlayer{
				SteamID: ids[s], X: float32(xy[s][0]), Y: float32(xy[s][1]),
			})
		}
		if err := w.AddFrame(int32(i), players); err != nil {
			t.Fatalf("AddFrame %d: %v", i, err)
		}
	}
	if _, err := w.Close(64); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

// TestComputeKnownGeometry: 2 CT at (0,0)/(10,0), 2 T at (0,100)/(0,110)
// for every frame. Hand-computed expectations:
//
//	spacing = mean(ct pair=10, t pair=10) = 10
//	spread  = mean of 6 pairs:
//	          10 + 10 + 100 + 110 + hypot(10,100) + hypot(10,110)
func TestComputeKnownGeometry(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "1")
	writeSyntheticSidecar(t, dir, 100, func(int) [4][2]float64 {
		return [4][2]float64{{0, 0}, {10, 0}, {0, 100}, {0, 110}}
	})
	sides := map[uint64]string{1: "ct", 2: "ct", 3: "t", 4: "t"}

	sp, err := Compute(dir, KindSpacing, 1, 100, sides)
	if err != nil {
		t.Fatalf("Compute(spacing): %v", err)
	}
	if sp.Buckets != 1 || sp.FromTick != 0 || sp.ToTick != 100 {
		t.Fatalf("spacing header mismatch: %+v", sp)
	}
	if sp.Values[0] != 10 {
		t.Fatalf("spacing = %v, want 10", sp.Values[0])
	}

	wantSpread := (10 + 10 + 100 + 110 + math.Hypot(10, 100) + math.Hypot(10, 110)) / 6
	ss, err := Compute(dir, KindSpread, 1, 100, sides)
	if err != nil {
		t.Fatalf("Compute(spread): %v", err)
	}
	if math.Abs(ss.Values[0]-wantSpread) > 1e-9 {
		t.Fatalf("spread = %v, want %v", ss.Values[0], wantSpread)
	}

	// Two buckets: both halves of the constant geometry are valid samples.
	sp2, err := Compute(dir, KindSpacing, 2, 100, sides)
	if err != nil {
		t.Fatalf("Compute(spacing, 2): %v", err)
	}
	if sp2.Values[0] != 10 || sp2.Values[1] != 10 {
		t.Fatalf("spacing(2) = %v, want [10 10]", sp2.Values)
	}
}

// TestComputeNoSampleBuckets: players absent from the sides map are
// excluded, so a stream with no attributed players yields -1 buckets.
func TestComputeNoSampleBuckets(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "1")
	writeSyntheticSidecar(t, dir, 100, func(int) [4][2]float64 {
		return [4][2]float64{{0, 0}, {10, 0}, {0, 100}, {0, 110}}
	})
	empty, err := Compute(dir, KindSpacing, 2, 100, map[uint64]string{})
	if err != nil {
		t.Fatalf("Compute: %v", err)
	}
	if empty.Values[0] != -1 || empty.Values[1] != -1 {
		t.Fatalf("unattributed spacing = %v, want [-1 -1]", empty.Values)
	}
	// One attributed player in a two-player geometry: player 1 alone is
	// still a valid spread/spacing sample of one team with <2 members →
	// spacing -1; spread counts only attributed players → -1 as well.
	one := map[uint64]string{1: "ct"}
	for _, kind := range []string{KindSpacing, KindSpread} {
		s, err := Compute(dir, kind, 2, 100, one)
		if err != nil {
			t.Fatalf("Compute(%s): %v", kind, err)
		}
		if s.Values[0] != -1 || s.Values[1] != -1 {
			t.Fatalf("%s with one attributed player = %v, want [-1 -1]", kind, s.Values)
		}
	}
}

// TestComputeSingleAlive: with sides for both ct players but only player 1
// ever present (writer needs the frame players — write a 1-player stream
// via a sides map that attributes everyone else away), spacing must be -1.
func TestComputeSingleAlive(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "1")
	w, err := sidecar.NewWriter(dir, 64)
	if err != nil {
		t.Fatalf("NewWriter: %v", err)
	}
	for i := 0; i < 10; i++ {
		if err := w.AddFrame(int32(i), []extract.PositionPlayer{{SteamID: 7, X: 5, Y: 5}}); err != nil {
			t.Fatalf("AddFrame: %v", err)
		}
	}
	if _, err := w.Close(64); err != nil {
		t.Fatalf("Close: %v", err)
	}
	sides := map[uint64]string{7: "ct", 8: "ct"}
	for _, kind := range []string{KindSpacing, KindSpread} {
		s, err := Compute(dir, kind, 1, 10, sides)
		if err != nil {
			t.Fatalf("Compute(%s): %v", kind, err)
		}
		if s.Values[0] != -1 {
			t.Fatalf("%s with one alive = %v, want -1", kind, s.Values[0])
		}
	}
}

func TestComputeErrors(t *testing.T) {
	if _, err := Compute(t.TempDir(), "diagonal", 1, 10, nil); err == nil {
		t.Fatal("unknown kind succeeded")
	}
	_, err := Compute(filepath.Join(t.TempDir(), "missing"), KindSpacing, 1, 10, nil)
	if !errors.Is(err, sidecar.ErrNoSidecar) {
		t.Fatalf("missing sidecar err = %v, want ErrNoSidecar", err)
	}
}
