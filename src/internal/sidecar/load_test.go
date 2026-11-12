package sidecar

import (
	"errors"
	"reflect"
	"slices"
	"testing"
)

// TestLoadProgressMatchesLoad pins the progress loader against the
// canonical Load: the decoded frames are identical (progress decodes per
// block inside the same shared walk), and the callback's numbers are the
// honest denominator the loading ladder asks for — first call (0, total)
// with total = the clamped range size known before any read, then a
// strictly increasing count of COMPLETE frames read AND decoded, landing
// exactly on total. done never counts bytes, estimates, or a fabricated
// fraction.
func TestLoadProgressMatchesLoad(t *testing.T) {
	dir := t.TempDir()
	writeSynthetic(t, dir, 1000) // 1000 frames = 4 zstd blocks (BlockFrames = 256)

	want, err := Load(dir, 0, 0)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	var seen [][2]int
	got, err := LoadProgress(dir, 0, 0, func(done, total int) {
		seen = append(seen, [2]int{done, total})
	})
	if err != nil {
		t.Fatalf("LoadProgress: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("LoadProgress != Load: %d vs %d frames", len(got.Frames), len(want.Frames))
	}

	if len(seen) < 3 {
		t.Fatalf("progress calls = %d, want one open call plus a call per block (≥3)", len(seen))
	}
	if seen[0] != [2]int{0, 1000} {
		t.Errorf("first call = %v, want {0 1000} (whole match's frame count up front)", seen[0])
	}
	for i, c := range seen {
		if c[1] != 1000 {
			t.Errorf("call %d total = %d, want 1000 (fixed denominator)", i, c[1])
		}
		if i > 0 && c[0] <= seen[i-1][0] {
			t.Errorf("call %d done = %d, want strictly more than %d", i, c[0], seen[i-1][0])
		}
	}
	if last := seen[len(seen)-1]; last[0] != 1000 {
		t.Errorf("last call = %v, want {1000 1000} (the closing call lands on the end)", last)
	}

	// A partial range counts only the frames it will return (250..262),
	// and progress stays inside that denominator.
	seen = nil
	sub, err := LoadProgress(dir, 250, 262, func(done, total int) {
		seen = append(seen, [2]int{done, total})
	})
	if err != nil {
		t.Fatalf("LoadProgress(250,262): %v", err)
	}
	if len(sub.Frames) != 12 {
		t.Errorf("frames = %d, want 12", len(sub.Frames))
	}
	if len(seen) == 0 || seen[0] != [2]int{0, 12} {
		t.Errorf("first call = %v, want {0 12}", seen)
	}
	if last := seen[len(seen)-1]; last != [2]int{12, 12} {
		t.Errorf("last call = %v, want {12 12}", last)
	}
	for i, c := range seen {
		if c[1] != 12 {
			t.Errorf("call %d total = %d, want 12", i, c[1])
		}
	}

	// An exhausted range (from at/after the end) has nothing to read:
	// one (0, 0) call, no frames, no error. total 0 is the payload's
	// documented indeterminate shape, not a percentage.
	seen = nil
	empty, err := LoadProgress(dir, 1000, 0, func(done, total int) {
		seen = append(seen, [2]int{done, total})
	})
	if err != nil {
		t.Fatalf("LoadProgress(exhausted): %v", err)
	}
	if len(empty.Frames) != 0 || !slices.Equal(seen, [][2]int{{0, 0}}) {
		t.Errorf("exhausted range: %d frames, calls %v — want 0 frames and exactly {0 0}", len(empty.Frames), seen)
	}
}

// TestLoadProgressErrorStage keeps Load's stage-naming wraps through the
// progress path: a missing sidecar fails at "open:" before any progress
// call (there is no meta to take a denominator from), and ErrNoSidecar
// still matches through the wrap.
func TestLoadProgressErrorStage(t *testing.T) {
	seen := 0
	_, err := LoadProgress(t.TempDir(), 0, 0, func(done, total int) { seen++ })
	if !errors.Is(err, ErrNoSidecar) {
		t.Fatalf("err = %v, want ErrNoSidecar through the wrap", err)
	}
	if seen != 0 {
		t.Errorf("progress called %d times before a meta existed, want 0", seen)
	}
	if _, err := Load(t.TempDir(), 0, 0); !errors.Is(err, ErrNoSidecar) {
		t.Errorf("Load err = %v, want ErrNoSidecar (Load is LoadProgress(nil))", err)
	}
}
