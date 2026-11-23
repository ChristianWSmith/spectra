package encounter

import "sort"

// BuildWindows groups encounters into windows and fills their samples. Encounters
// between the same two players in the same round are merged when their spans
// overlap (A sees B and B sees A over the same stretch becomes one window with two
// encounters). Each encounter's Window is set to its window's index. Samples are
// taken from frames, one per tick, where both players are present. Frames must be
// sorted by tick. Encounters keep their own spans.
func BuildWindows(frames []Frame, encs []Encounter) ([]Window, []Encounter) {
	type key struct {
		round int
		a, b  uint64
	}
	order := make([]int, len(encs))
	for i := range order {
		order[i] = i
	}
	pairOf := func(e Encounter) key {
		a, b := e.Shooter, e.Enemy
		if a > b {
			a, b = b, a
		}
		return key{e.Round, a, b}
	}
	sort.Slice(order, func(i, j int) bool {
		ki, kj := pairOf(encs[order[i]]), pairOf(encs[order[j]])
		if ki != kj {
			if ki.round != kj.round {
				return ki.round < kj.round
			}
			if ki.a != kj.a {
				return ki.a < kj.a
			}
			return ki.b < kj.b
		}
		return encs[order[i]].Start < encs[order[j]].Start
	})

	var windows []Window
	out := make([]Encounter, len(encs))
	copy(out, encs)
	for i := 0; i < len(order); {
		k := pairOf(encs[order[i]])
		w := Window{Round: k.round, P1: k.a, P2: k.b, Start: encs[order[i]].Start, End: encs[order[i]].End}
		members := []int{order[i]}
		j := i + 1
		for ; j < len(order) && pairOf(encs[order[j]]) == k; j++ {
			e := encs[order[j]]
			if e.Start <= w.End { // overlaps or touches the current window
				if e.End > w.End {
					w.End = e.End
				}
				members = append(members, order[j])
				continue
			}
			// A gap: close this window and start the next one for the same pair.
			windows, out = closeWindow(windows, out, frames, w, members)
			w = Window{Round: k.round, P1: k.a, P2: k.b, Start: e.Start, End: e.End}
			members = []int{order[j]}
		}
		windows, out = closeWindow(windows, out, frames, w, members)
		i = j
	}
	return windows, out
}

// closeWindow appends w (with its samples) and points its member encounters at it.
func closeWindow(windows []Window, out []Encounter, frames []Frame, w Window, members []int) ([]Window, []Encounter) {
	idx := len(windows)
	w.Samples = samplesFor(frames, w.P1, w.P2, w.Start, w.End)
	windows = append(windows, w)
	for _, m := range members {
		out[m].Window = idx
	}
	return windows, out
}

// samplesFor returns one sample per tick in [start, end] where both players are
// present, in tick order, with repeated ticks kept once.
func samplesFor(frames []Frame, p1, p2 uint64, start, end int) []WindowSample {
	lo := sort.Search(len(frames), func(k int) bool { return frames[k].Tick >= start })
	var out []WindowSample
	for k := lo; k < len(frames) && frames[k].Tick <= end; k++ {
		if n := len(out); n > 0 && out[n-1].Tick == frames[k].Tick {
			continue
		}
		a, ok1 := frames[k].Players[p1]
		b, ok2 := frames[k].Players[p2]
		if !ok1 || !ok2 {
			continue
		}
		out = append(out, WindowSample{
			Tick:  frames[k].Tick,
			P1Eye: eye(a), P1World: [3]float64{a.X, a.Y, a.Z},
			P2Eye: eye(b), P2World: [3]float64{b.X, b.Y, b.Z},
			P1Air: a.Air, P2Air: b.Air,
			P1Speed: a.Speed, P2Speed: b.Speed,
			P1Weapon: a.Weapon, P2Weapon: b.Weapon,
		})
	}
	return out
}
