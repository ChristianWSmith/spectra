package integration_test

import (
	"context"
	"math"
	"strconv"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/encounter"
	"github.com/ChristianWSmith/spectra/internal/extract"
)

// posRecord is one player's position at one delivered frame, straight from the
// parser's position stream (no tick samples, no window collector).
type posRecord struct {
	tick int
	x, y float64
}

// TestGoldenWindowSpeedMatchesPositionStream is an independent check on the
// dense speed the encounter windows carry. The reference is computed here from
// the raw position stream: for each player, the speed at a frame is the
// horizontal distance from the previous delivered frame's position over the
// tick step, nil when that previous frame lacks the player, lies in another
// counted round, or the step is not positive. Every window sample's stored
// speed must equal it.
func TestGoldenWindowSpeedMatchesPositionStream(t *testing.T) {
	var frames []posFrame
	sink := positionCollector{frames: &frames}

	noGeometry := func(string) (encounter.Occluder, error) {
		return func(a, b [3]float64) bool { return false }, nil
	}
	m, err := extract.Parse(context.Background(), openGoldenDemo(t), extract.ParseOptions{
		Positions:      sink,
		WindowOccluder: noGeometry,
	})
	if err != nil {
		t.Fatalf("extract.Parse: %v", err)
	}
	if len(m.Windows) == 0 {
		t.Fatal("no encounter windows on the golden demo — nothing to check")
	}

	// A frame belongs to the last counted round that has started, as the
	// parser's round counter assigns it: post-round frames (after the round's
	// end tick, before the next start) stay in that round.
	roundOf := func(tick int) int {
		best := 0
		for _, r := range m.Rounds {
			if r.StartTick <= tick && r.Number > best {
				best = r.Number
			}
		}
		return best
	}

	// Reference speed per (player, tick), from the position stream alone.
	type key struct {
		id   uint64
		tick int
	}
	ref := make(map[key]float64, 1<<20)
	nilRef := make(map[key]bool)
	var prev *posFrame
	for i := range frames {
		f := &frames[i]
		for id, p := range f.pos {
			k := key{id, f.tick}
			if prev == nil {
				nilRef[k] = true
				continue
			}
			q, ok := prev.pos[id]
			dt := f.tick - prev.tick
			rnd := roundOf(f.tick)
			if !ok || rnd == 0 || roundOf(prev.tick) != rnd || dt <= 0 {
				nilRef[k] = true
				continue
			}
			ref[k] = math.Hypot(p.x-q.x, p.y-q.y) * m.Match.TickRate / float64(dt)
		}
		prev = f
	}

	checked, mismatched, nilOK := 0, 0, 0
	for _, w := range m.Windows {
		p1, _ := strconv.ParseUint(w.P1, 10, 64)
		p2, _ := strconv.ParseUint(w.P2, 10, 64)
		for _, sm := range w.Samples {
			for _, side := range []struct {
				id    uint64
				speed *float64
			}{{p1, sm.P1Speed}, {p2, sm.P2Speed}} {
				k := key{side.id, sm.Tick}
				want, have := ref[k]
				if !have {
					if !nilRef[k] {
						continue // the player was not in the position stream at this tick
					}
					checked++
					if side.speed == nil {
						nilOK++
					} else {
						mismatched++
						if mismatched <= 5 {
							t.Errorf("player %d tick %d: stored speed %v, reference nil", side.id, sm.Tick, *side.speed)
						}
					}
					continue
				}
				checked++
				if side.speed == nil {
					mismatched++
					if mismatched <= 5 {
						t.Errorf("player %d tick %d: stored speed nil, reference %v", side.id, sm.Tick, want)
					}
					continue
				}
				if math.Abs(*side.speed-want) > 1e-9 {
					mismatched++
					if mismatched <= 5 {
						t.Errorf("player %d tick %d: stored speed %v, reference %v", side.id, sm.Tick, *side.speed, want)
					}
				}
			}
		}
	}
	t.Logf("window speed check: %d samples checked, %d nil-agreements, %d mismatches", checked, nilOK, mismatched)
	if checked == 0 {
		t.Fatal("no window samples had a reference — the check is vacuous")
	}
	if mismatched > 0 {
		t.Errorf("%d of %d window speed values disagree with the position stream", mismatched, checked)
	}
}

// positionCollector records every delivered position frame, with the parser's
// own tick and each alive player's position. Repeated ticks are kept once, as
// the stream delivers them (first observation wins).
type posFrame struct {
	tick int
	pos  map[uint64]posRecord
}

type positionCollector struct {
	frames *[]posFrame
}

func (c positionCollector) AddFrame(tick int32, players []extract.PositionPlayer) error {
	fs := c.frames
	if n := len(*fs); n > 0 && (*fs)[n-1].tick == int(tick) {
		return nil
	}
	rec := posFrame{tick: int(tick), pos: make(map[uint64]posRecord, len(players))}
	for _, p := range players {
		rec.pos[p.SteamID] = posRecord{tick: int(tick), x: float64(p.X), y: float64(p.Y)}
	}
	*fs = append(*fs, rec)
	return nil
}
