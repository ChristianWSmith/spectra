package extract

import "testing"

// TestTickSampleMerge pins the tick sink's merge rule: the state sample is
// the spine (identity, side, alive, hp, money carry over as sampled), the
// weapon only exists while alive, and the position fields are set ONLY
// when a position was sampled — a dead frame can never hand the store a
// position, in-air flag or (downstream) speed.
func TestTickSampleMerge(t *testing.T) {
	alive := buildStateSample(76561198000000001, true, 87, 100, 2350, true, "ak47", []string{"ak47"}, 30, 90, 30, 90, false, false)
	alive.Side = "t"
	pos := PositionPlayer{SteamID: 76561198000000001, X: 1.5, Y: -2.25, Z: 64, Air: true, Side: "t"}

	got := tickSample(alive, pos, true)
	if got.SteamID != "76561198000000001" || got.Side != "t" || !got.Alive || got.HP != 87 || got.Money != 2350 || got.Weapon != "ak47" {
		t.Errorf("alive sample = %+v", got)
	}
	if !got.HasPosition || got.X != 1.5 || got.Y != -2.25 || got.Z != 64 || !got.InAir {
		t.Errorf("alive position = %+v", got)
	}

	dead := buildStateSample(0xFF00000000000007, false, 40, 50, 1200, false, "deagle", nil, 0, 0, 0, 0, false, false)
	dead.Side = "ct"
	got = tickSample(dead, PositionPlayer{}, false)
	if got.Alive || got.HP != 0 || got.Money != 1200 || got.Side != "ct" {
		t.Errorf("dead sample = %+v, want alive=false hp=0 money=1200 side=ct", got)
	}
	if got.Weapon != "" || got.HasPosition || got.InAir || got.X != 0 {
		t.Errorf("dead sample carries weapon/position: %+v", got)
	}
	if got.SteamID != keyStr(0xFF00000000000007) {
		t.Errorf("bot key = %q, want the synthetic accumulator key", got.SteamID)
	}
}
