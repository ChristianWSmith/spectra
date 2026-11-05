package extract

import "testing"

// TestRoundSeeds pins the state-stream seed trigger: the very first frame
// seeds (round 0 before any RoundStart), every later frame in the same
// round does not, and each round change seeds exactly once.
func TestRoundSeeds(t *testing.T) {
	rs := roundSeeds{}
	if !rs.take(0) {
		t.Error("first frame: seed = false, want true")
	}
	if rs.take(0) {
		t.Error("same round: seed = true, want false")
	}
	if !rs.take(1) {
		t.Error("round 1: seed = false, want true")
	}
	if rs.take(1) {
		t.Error("round 1 repeated: seed = true, want false")
	}
	if rs.take(1) {
		t.Error("round 1 repeated again: seed = true, want false")
	}
	if !rs.take(2) {
		t.Error("round 2: seed = false, want true")
	}
	// Rounds may repeat numbers only via change detection — a revisit of
	// a previous counter value still seeds (counter change is the signal).
	if !rs.take(1) {
		t.Error("counter changed back to 1: seed = false, want true")
	}
}

// TestBuildStateSampleDeath: death is a sample — HP forced to 0 and no
// weapon/inventory/ammo carried — while armor/attack stay as read.
func TestBuildStateSampleDeath(t *testing.T) {
	dead := buildStateSample(42, false, 0, 100, "AK-47", []string{"AK-47"}, 30, 90, true)
	if dead.HP != 0 {
		t.Errorf("dead HP = %d, want 0 (sampled, not inferred)", dead.HP)
	}
	if dead.Armor != 100 {
		t.Errorf("dead Armor = %d, want the as-read 100", dead.Armor)
	}
	if !dead.Attack {
		t.Error("dead Attack = false, want as-read true")
	}
	if dead.Weapon != "" || dead.Inventory != nil || dead.MagAmmo != 0 || dead.ReserveAmmo != 0 {
		t.Errorf("dead weapon fields = %q %v %d %d, want empty (entity props gone)",
			dead.Weapon, dead.Inventory, dead.MagAmmo, dead.ReserveAmmo)
	}
	if dead.Alive {
		t.Error("dead sample must carry Alive=false")
	}

	inv := []string{"AK-47", "USP-S"}
	alive := buildStateSample(42, true, 87, 100, "AK-47", inv, 30, 90, false)
	if alive.HP != 87 || alive.Weapon != "AK-47" || alive.MagAmmo != 30 || alive.ReserveAmmo != 90 {
		t.Errorf("alive sample = %+v", alive)
	}
	if len(alive.Inventory) != 2 {
		t.Fatalf("alive inventory = %v", alive.Inventory)
	}
	// The stored inventory must not alias the caller's slice (the sink
	// keeps it across frames while extract reuses its buffers).
	inv[0] = "M4A4"
	if alive.Inventory[0] != "AK-47" {
		t.Error("stored inventory aliases the caller's slice")
	}
}

// TestBuildStateSampleClamps: raw reads land on the wire widths — the
// negative sentinel (AmmoInMagazine -1) and over-range values never reach
// the writer unclamped.
func TestBuildStateSampleClamps(t *testing.T) {
	s := buildStateSample(1, true, 300, -5, "Negev", nil, -1, 70000, false)
	if s.HP != 255 {
		t.Errorf("HP = %d, want 255", s.HP)
	}
	if s.Armor != 0 {
		t.Errorf("Armor = %d, want 0", s.Armor)
	}
	if s.MagAmmo != 0 {
		t.Errorf("MagAmmo = %d, want 0 (-1 sentinel)", s.MagAmmo)
	}
	if s.ReserveAmmo != 65535 {
		t.Errorf("ReserveAmmo = %d, want 65535", s.ReserveAmmo)
	}
}
