package extract

import (
	"strings"
	"testing"

	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/common"
)

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
// weapon/inventory/ammo (active OR main) carried — while armor/attack stay
// as read, and money/helmet stay as read too (deliberate: both persist
// through death — money lives on the player controller, round-end cash
// lands while dead). Reloading joins HP's rule, not the weapon rule: even
// a caller that passes reloading=true gets false on a dead sample (a dead
// player reloads nothing — the sidecar emits that fresh false, so a death
// mid-reload ends the reload instead of pinning last-known).
func TestBuildStateSampleDeath(t *testing.T) {
	dead := buildStateSample(42, false, 0, 100, 3700, true, "AK-47", []string{"AK-47"}, 30, 90, 30, 90, true, true)
	if dead.HP != 0 {
		t.Errorf("dead HP = %d, want 0 (sampled, not inferred)", dead.HP)
	}
	if dead.Armor != 100 {
		t.Errorf("dead Armor = %d, want the as-read 100", dead.Armor)
	}
	if dead.Money != 3700 {
		t.Errorf("dead Money = %d, want the as-read 3700 (account persists through death)", dead.Money)
	}
	if !dead.Helmet {
		t.Error("dead Helmet = false, want the as-read true")
	}
	if !dead.Attack {
		t.Error("dead Attack = false, want as-read true")
	}
	if dead.Weapon != "" || dead.Inventory != nil || dead.MagAmmo != 0 || dead.ReserveAmmo != 0 ||
		dead.MainMag != 0 || dead.MainReserve != 0 {
		t.Errorf("dead weapon fields = %q %v %d %d %d %d, want empty (entity props gone)",
			dead.Weapon, dead.Inventory, dead.MagAmmo, dead.ReserveAmmo, dead.MainMag, dead.MainReserve)
	}
	if dead.Reloading {
		t.Error("dead Reloading = true, want false (a dead player reloads nothing)")
	}
	if dead.Alive {
		t.Error("dead sample must carry Alive=false")
	}

	inv := []string{"AK-47", "USP-S"}
	alive := buildStateSample(42, true, 87, 100, 4300, false, "AK-47", inv, 30, 90, 30, 90, false, true)
	if alive.HP != 87 || alive.Weapon != "AK-47" || alive.MagAmmo != 30 || alive.ReserveAmmo != 90 {
		t.Errorf("alive sample = %+v", alive)
	}
	if !alive.Reloading {
		t.Error("alive Reloading = false, want the as-read true")
	}
	if alive.MainMag != 30 || alive.MainReserve != 90 {
		t.Errorf("alive main ammo = %d/%d, want 30/90", alive.MainMag, alive.MainReserve)
	}
	if alive.Money != 4300 || alive.Helmet {
		t.Errorf("alive money/helmet = %d/%v, want 4300/false", alive.Money, alive.Helmet)
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
// the writer unclamped (the MAIN weapon's reads clamp the same way).
func TestBuildStateSampleClamps(t *testing.T) {
	s := buildStateSample(1, true, 300, -5, 70000, false, "Negev", nil, -1, 70000, -3, 70001, false, false)
	if s.HP != 255 {
		t.Errorf("HP = %d, want 255", s.HP)
	}
	if s.Armor != 0 {
		t.Errorf("Armor = %d, want 0", s.Armor)
	}
	if s.Money != 65535 {
		t.Errorf("Money = %d, want 65535 (u16 wire clamp)", s.Money)
	}
	if s.MagAmmo != 0 {
		t.Errorf("MagAmmo = %d, want 0 (-1 sentinel)", s.MagAmmo)
	}
	if s.ReserveAmmo != 65535 {
		t.Errorf("ReserveAmmo = %d, want 65535", s.ReserveAmmo)
	}
	if s.MainMag != 0 {
		t.Errorf("MainMag = %d, want 0 (negative read clamps to 0)", s.MainMag)
	}
	if s.MainReserve != 65535 {
		t.Errorf("MainReserve = %d, want 65535 (u16 wire clamp)", s.MainReserve)
	}
}

// TestScanWeaponsMainWeapon pins the MAIN-weapon resolution the stowed
// ammo rides on: FIRST primary wins wherever it sits in the order, a
// secondary is the fallback, and an inventory with no firearm (knife
// round / dropped sidearm) resolves to NO main — never a starter guess
// (frontend twin: loadout.js mainWeaponOf with starter:false). The
// inventory itself keeps pl.Weapons() order, names verbatim.
func TestScanWeaponsMainWeapon(t *testing.T) {
	eq := func(ty common.EquipmentType) *common.Equipment { return &common.Equipment{Type: ty} }
	knife := func() *common.Equipment { return eq(common.EqKnife) }

	// Primary wins over an earlier secondary (order in the list decides
	// nothing but which FIRST primary/secondary each pass picks).
	inv, main := scanWeapons([]*common.Equipment{knife(), eq(common.EqUSP), eq(common.EqAK47), eq(common.EqGlock)})
	if got := namesOf(inv); got != "Knife,USP-S,AK-47,Glock-18" {
		t.Errorf("inventory = %q, want pl.Weapons() order preserved", got)
	}
	if main == nil || main.Type != common.EqAK47 {
		t.Errorf("main = %v, want the first primary (AK-47)", main)
	}

	// No primary → first secondary.
	inv, main = scanWeapons([]*common.Equipment{knife(), eq(common.EqDeagle), eq(common.EqUSP)})
	if got := namesOf(inv); got != "Knife,Desert Eagle,USP-S" {
		t.Errorf("inventory = %q", got)
	}
	if main == nil || main.Type != common.EqDeagle {
		t.Errorf("main = %v, want the first secondary (Desert Eagle)", main)
	}

	// Knife round (or a dropped sidearm): no firearm → no main at all,
	// so the sample carries 0/0 — only consumed when a main exists.
	inv, main = scanWeapons([]*common.Equipment{knife()})
	if got := namesOf(inv); got != "Knife" {
		t.Errorf("inventory = %q, want [Knife]", got)
	}
	if main != nil {
		t.Errorf("main = %v, want nil (knife-only inventory carries no main)", main)
	}
	inv, main = scanWeapons(nil)
	if len(inv) != 0 || main != nil {
		t.Errorf("empty weapon list → inventory %v, main %v; want both empty", inv, main)
	}

	// The resolution feeds buildStateSample: no main → 0/0 on the wire.
	s := buildStateSample(7, true, 100, 0, 800, false, "Knife", inv, 1, 0, 0, 0, false, false)
	if s.MainMag != 0 || s.MainReserve != 0 {
		t.Errorf("knife-round main ammo = %d/%d, want 0/0", s.MainMag, s.MainReserve)
	}
}

// namesOf joins a canonical inventory for compact assertions.
func namesOf(inv []string) string { return strings.Join(inv, ",") }
