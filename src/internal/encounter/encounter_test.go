package encounter

import "testing"

func TestWindowSamplesCarryBothEyes(t *testing.T) {
	frames := []Frame{
		{Tick: 100, Players: map[uint64]Pos{1: {X: 0, Y: 0, Side: "ct"}, 2: {X: 500, Y: 0, Side: "t"}}},
		{Tick: 101, Players: map[uint64]Pos{1: {X: 0, Y: 0, Side: "ct"}, 2: {X: 500, Y: 0, Side: "t"}}},
		{Tick: 102, Players: map[uint64]Pos{1: {X: 0, Y: 0, Side: "ct"}, 2: {X: 500, Y: 0, Side: "t", Duck: true}}},
	}
	open := func(a, b [3]float64) bool { return false }
	encs, _ := Build(frames, []Shot{{Round: 1, Tick: 101, Shooter: 1}}, map[int]Range{1: {Start: 0, End: 200}}, open, 0)
	wins, out := BuildWindows(frames, encs)
	if len(wins) != 1 || len(out) != 1 || out[0].Window != 0 {
		t.Fatalf("windows = %d, encounter window = %d", len(wins), out[0].Window)
	}
	w := wins[0]
	if len(w.Samples) != 3 {
		t.Fatalf("samples = %d, want 3", len(w.Samples))
	}
	if got := w.Samples[0].P2Eye; got != [3]float64{500, 0, 64} {
		t.Errorf("standing enemy eye = %v, want [500 0 64]", got)
	}
	if got := w.Samples[2].P2Eye; got != [3]float64{500, 0, 46} {
		t.Errorf("ducked enemy eye = %v, want [500 0 46]", got)
	}
	if got := w.Samples[0].P2World; got != [3]float64{500, 0, 0} {
		t.Errorf("enemy world = %v, want [500 0 0]", got)
	}
}

// TestWindowsMergeMutualEncounters: A sees B and B sees A over overlapping spans is
// one window with two encounters; a later separate fight is its own window.
func TestWindowsMergeMutualEncounters(t *testing.T) {
	var frames []Frame
	for tk := 0; tk <= 400; tk++ {
		frames = append(frames, Frame{Tick: tk, Players: map[uint64]Pos{1: {Side: "ct"}, 2: {X: 300, Side: "t"}}})
	}
	encs := []Encounter{
		{Round: 1, Shooter: 1, Enemy: 2, Start: 100, End: 200},
		{Round: 1, Shooter: 2, Enemy: 1, Start: 150, End: 300},
		{Round: 1, Shooter: 1, Enemy: 2, Start: 350, End: 380},
	}
	wins, out := BuildWindows(frames, encs)
	if len(wins) != 2 {
		t.Fatalf("windows = %d, want 2 (merged mutual pair, then the later fight)", len(wins))
	}
	if out[0].Window != 0 || out[1].Window != 0 || out[2].Window != 1 {
		t.Errorf("encounter windows = %d %d %d, want 0 0 1", out[0].Window, out[1].Window, out[2].Window)
	}
	if wins[0].Start != 100 || wins[0].End != 300 {
		t.Errorf("merged window = [%d, %d], want [100, 300]", wins[0].Start, wins[0].End)
	}
	if out[0].Start != 100 || out[0].End != 200 || out[1].Start != 150 || out[1].End != 300 {
		t.Errorf("encounters keep their own spans: %+v %+v", out[0], out[1])
	}
}

// TestWindowSamplesOnePerTick: a repeated tick in the sidecar gives one sample.
func TestWindowSamplesOnePerTick(t *testing.T) {
	frames := []Frame{
		{Tick: 100, Players: map[uint64]Pos{1: {Side: "ct"}, 2: {X: 500, Side: "t"}}},
		{Tick: 101, Players: map[uint64]Pos{1: {Side: "ct"}, 2: {X: 500, Side: "t"}}},
		{Tick: 101, Players: map[uint64]Pos{1: {Side: "ct"}, 2: {X: 500, Side: "t"}}},
		{Tick: 102, Players: map[uint64]Pos{1: {Side: "ct"}, 2: {X: 500, Side: "t"}}},
	}
	open := func(a, b [3]float64) bool { return false }
	encs, _ := Build(frames, []Shot{{Round: 1, Tick: 101, Shooter: 1}}, map[int]Range{1: {Start: 0, End: 200}}, open, 0)
	wins, _ := BuildWindows(frames, encs)
	if len(wins) != 1 || len(wins[0].Samples) != 3 {
		t.Fatalf("samples = %d, want 3 (one per tick 100, 101, 102)", len(wins[0].Samples))
	}
}
