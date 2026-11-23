package extract

import (
	"math"
	"strconv"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// feedWindowFrame delivers one counted frame to the collector the way the
// parse does: the position frame first, then the tick samples.
func feedWindowFrame(c *windowCollector, tick int32, round int, rate float64, players ...models.TickSample) {
	var pos []PositionPlayer
	for _, p := range players {
		if !p.HasPosition {
			continue
		}
		key, _ := strconv.ParseUint(p.SteamID, 10, 64)
		pos = append(pos, PositionPlayer{SteamID: key, X: float32(p.X), Y: float32(p.Y), Z: float32(p.Z), Air: p.InAir, Side: p.Side})
	}
	c.add(tick, pos)
	c.addTicks(tick, round, rate, players)
}

func windowAlive(id string, x, y float64, air bool) models.TickSample {
	return models.TickSample{SteamID: id, Side: "ct", Alive: true, HP: 100, Weapon: "ak47",
		HasPosition: true, X: x, Y: y, Z: 7, InAir: air}
}

// TestWindowCollectorSpeedRule pins the dense speed the windows carry: the
// horizontal distance between consecutive positioned samples of the same
// player over Δtick/tickRate, nil on the first sample of a stretch, after a
// gap, across a round change and with an unknown tick rate. The same rule the
// player_ticks writer used before the move.
func TestWindowCollectorSpeedRule(t *testing.T) {
	const rate = 64.0
	var c windowCollector
	feedWindowFrame(&c, 100, 1, rate, windowAlive("1", 0, 0, false))
	feedWindowFrame(&c, 101, 1, rate, windowAlive("1", 3, 4, true))  // 5 u in 1 tick: 320 u/s
	feedWindowFrame(&c, 103, 1, rate, windowAlive("1", 3, 4, false)) // still: 0
	feedWindowFrame(&c, 104, 1, rate)                                // absent
	feedWindowFrame(&c, 105, 1, rate, windowAlive("1", 9, 4, false)) // gap: nil
	feedWindowFrame(&c, 106, 2, rate, windowAlive("1", 9, 5, false)) // round change: nil
	feedWindowFrame(&c, 107, 2, 0, windowAlive("1", 9, 6, false))    // unknown rate: nil
	feedWindowFrame(&c, 108, 2, rate, windowAlive("1", 9, 7, false)) // 1 u in 1 tick: 64 u/s

	want := []struct {
		tick  int
		speed float64 // NaN = nil
		air   bool
	}{
		{100, math.NaN(), false}, {101, 320, true}, {103, 0, false},
		{105, math.NaN(), false}, {106, math.NaN(), false}, {107, math.NaN(), false},
		{108, 64, false},
	}
	byTick := map[int]encounterPos{}
	for _, f := range c.frames {
		if p, ok := f.Players[1]; ok {
			byTick[f.Tick] = encounterPos{speed: p.Speed, air: p.Air, weapon: p.Weapon}
		}
	}
	for _, w := range want {
		got, ok := byTick[w.tick]
		if !ok {
			t.Fatalf("tick %d: no sample for player 1", w.tick)
		}
		if math.IsNaN(w.speed) {
			if got.speed != nil {
				t.Errorf("tick %d: speed = %v, want nil", w.tick, *got.speed)
			}
		} else if got.speed == nil || math.Abs(*got.speed-w.speed) > 1e-9 {
			t.Errorf("tick %d: speed = %v, want %v", w.tick, got.speed, w.speed)
		}
		if got.air != w.air {
			t.Errorf("tick %d: in-air = %v, want %v", w.tick, got.air, w.air)
		}
		if got.weapon != "ak47" {
			t.Errorf("tick %d: weapon = %q, want ak47", w.tick, got.weapon)
		}
	}
}

type encounterPos struct {
	speed  *float64
	air    bool
	weapon string
}

// TestWindowCollectorDeadSampleIsAbsent pins the NULL-not-0 rule for the
// windows: a dead player has no position sample, so no frame entry and no
// speed; the first positioned sample after the death has no previous sample
// (nil speed), so a respawn never produces a speed.
func TestWindowCollectorDeadSampleIsAbsent(t *testing.T) {
	var c windowCollector
	dead := models.TickSample{SteamID: "2", Side: "t", Alive: false, HP: 0, Weapon: "ignored"}
	feedWindowFrame(&c, 10, 1, 64, windowAlive("2", 0, 0, false))
	feedWindowFrame(&c, 11, 1, 64, dead)
	feedWindowFrame(&c, 12, 1, 64, windowAlive("2", 500, 500, false))

	if _, ok := c.frames[1].Players[2]; ok {
		t.Errorf("dead frame carries a position entry for player 2")
	}
	last := c.frames[2].Players[2]
	if last.Speed != nil {
		t.Errorf("first positioned sample after death: speed = %v, want nil", *last.Speed)
	}
}

// TestTickSpeedRule pins the pure speed rule the collector and any future
// reader share.
func TestTickSpeedRule(t *testing.T) {
	if v, ok := models.TickSpeed(100, 1, 0, 0, 101, 1, 3, 4, 64); !ok || math.Abs(v-320) > 1e-9 {
		t.Errorf("5 u in one tick at 64 Hz = %v, %v; want 320, true", v, ok)
	}
	if _, ok := models.TickSpeed(100, 1, 0, 0, 101, 2, 3, 4, 64); ok {
		t.Errorf("round change: ok = true, want false")
	}
	if _, ok := models.TickSpeed(100, 1, 0, 0, 100, 1, 3, 4, 64); ok {
		t.Errorf("non-positive step: ok = true, want false")
	}
	if _, ok := models.TickSpeed(100, 1, 0, 0, 101, 1, 3, 4, 0); ok {
		t.Errorf("unknown tick rate: ok = true, want false")
	}
}
