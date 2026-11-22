package encounter

import "testing"

// TestViewpointsCarryTheEnemyEye checks that every stored viewpoint is the
// enemy's eye (their head) and that viewpoints span the encounter window.
func TestViewpointsCarryTheEnemyEye(t *testing.T) {
	frames := []Frame{
		{Tick: 100, Players: map[uint64]Pos{1: {X: 0, Y: 0, Side: "ct"}, 2: {X: 500, Y: 0, Side: "t"}}},
		{Tick: 101, Players: map[uint64]Pos{1: {X: 0, Y: 0, Side: "ct"}, 2: {X: 500, Y: 0, Side: "t"}}},
		{Tick: 102, Players: map[uint64]Pos{1: {X: 0, Y: 0, Side: "ct"}, 2: {X: 500, Y: 0, Side: "t", Duck: true}}},
	}
	open := func(a, b [3]float64) bool { return false }
	encs, _ := Build(frames, []Shot{{Round: 1, Tick: 101, Shooter: 1}}, map[int]Range{1: {Start: 0, End: 200}}, open, 0)
	if len(encs) != 1 {
		t.Fatalf("encounters = %d, want 1", len(encs))
	}
	e := encs[0]
	if len(e.Viewpoints) != 3 {
		t.Fatalf("viewpoints = %d, want 3", len(e.Viewpoints))
	}
	if got := e.Viewpoints[0].Enemy; got != [3]float64{500, 0, 64} {
		t.Errorf("standing enemy eye = %v, want [500 0 64]", got)
	}
	if got := e.Viewpoints[2].Enemy; got != [3]float64{500, 0, 46} {
		t.Errorf("ducked enemy eye = %v, want [500 0 46]", got)
	}
}
