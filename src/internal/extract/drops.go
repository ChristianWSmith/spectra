package extract

import (
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/common"
)

// Death-drop inference (models.EventWeaponDrop / EventWeaponPickup) —
// THE one rule that turns a victim's inventory at death into the drop
// rows the replay map draws.
//
// Characterization (drops_diag_test.go TestDiagDropInventoryAtKill, all
// seven golden demos, SPECTRA_DIAG_ALL=1): events.Kill dispatches with
// the victim's inventory INTACT and unmutated — 1174/1174 kills carried
// a non-empty e.Victim.Weapons(), and every one of them was IDENTICAL to
// the victim's last per-frame sample before the death. So the kill-time
// inventory read IS authoritative and there is deliberately NO
// last-known-inventory fallback map here (a second path nothing can
// exercise is dead code, not evidence — cf. the no-legacy-fallback rule
// in AGENTS.md; the diag re-run is how a future parser bump re-verifies
// the seam).
//
// The rules are the user's stated drop rules (implemented regardless of
// the game's own defaults — see CS2.md "Death drops" for where CS2's
// mp_death_drop_* cvars differ):
//
//   - GUN: the FIRST primary in inventory order (the same scanWeapons
//     order semantics — extract.go), else the FIRST secondary, else NO
//     gun (a knife-only death drops nothing).
//   - UTIL: at most ONE grenade: the last util the victim EQUIPPED this
//     round (agg.lastHeldUtil — the per-frame active-weapon sample) if it
//     is still in the inventory, else the MOST EXPENSIVE util in the
//     inventory (models.UtilityPrice — the canonical price table), else
//     no util drop.
//
// Classification (`cat` "gun"|"util" on the stored detail_json) is
// stamped HERE from the canonical sets models.IsPrimaryWeapon /
// IsSecondaryWeapon / IsUtilityWeapon — the frontend never re-derives
// the util rule.

// inventoryItem is one entry of the victim's inventory as the drop rule
// reads it: canonical name (EquipmentType.String() — the same spelling
// events.weapon carries) plus the gun's magazine/reserve ammo AT DEATH
// ("dropped weapons track their ammo/mag state" — authoritative on the
// weapon_drop row; util carries no ammo, so its fields stay 0).
type inventoryItem struct {
	name    string
	mag     int
	reserve int
}

// dropDecision is one inferred drop: the canonical weapon name, its
// detail_json cat ("gun"|"util"), and the gun's ammo (0/0 for util).
type dropDecision struct {
	name    string
	cat     string
	mag     int
	reserve int
}

// dropCat classifies a canonical weapon name for the drop rows: "util"
// for the canonical grenades, "gun" for firearms, "" for anything else
// (knife, C4, kit, armour, unknown — never dropped by this rule and
// never STORED as a weapon_pickup row: the kind's contract is the drop
// evidence pair).
func dropCat(name string) string {
	switch {
	case models.IsUtilityWeapon(name):
		return "util"
	case models.IsPrimaryWeapon(name) || models.IsSecondaryWeapon(name):
		return "gun"
	default:
		return ""
	}
}

// dropInventory converts the victim's demoinfocs weapon list into the
// plain inventory the pure rule reads (handler-side conversion — the
// only demoinfocs touch in this file). Ammo is read AT this instant
// (AmmoInMagazine / AmmoReserve; the -1 sentinel clamps to 0 via
// clampState16, the same wire clamp the state stream uses).
func dropInventory(weapons []*common.Equipment) []inventoryItem {
	var out []inventoryItem
	for _, w := range weapons {
		if w == nil {
			continue
		}
		out = append(out, inventoryItem{
			name:    wepName(w),
			mag:     clampState16(w.AmmoInMagazine()),
			reserve: clampState16(w.AmmoReserve()),
		})
	}
	return out
}

// inferDeathDrops applies the drop rules above to the victim's
// inventory (inventory order = pl.Weapons() order) and this round's
// last-held util ("" = never equipped one this round). Returns 0–2
// decisions: a gun (first primary → first secondary → none) and at most
// one util. Pure — unit-tested by drops_test.go.
func inferDeathDrops(inv []inventoryItem, lastHeldUtil string) []dropDecision {
	var out []dropDecision

	// Gun: same first-primary / first-secondary scan semantics as
	// extract.scanWeapons (first primary wins wherever it sits; the
	// sidearm only qualifies when no primary exists).
	gun := ""
	for _, it := range inv {
		if models.IsPrimaryWeapon(it.name) {
			gun = it.name
			break
		}
	}
	if gun == "" {
		for _, it := range inv {
			if models.IsSecondaryWeapon(it.name) {
				gun = it.name
				break
			}
		}
	}
	if gun != "" {
		// Ammo at death: the matching inventory entry's mag/reserve
		// (missing entry — impossible for `gun` unless the name came
		// from nowhere — reads 0, never guessed).
		var mag, reserve int
		for _, it := range inv {
			if it.name == gun {
				mag, reserve = it.mag, it.reserve
				break
			}
		}
		out = append(out, dropDecision{name: gun, cat: "gun", mag: mag, reserve: reserve})
	}

	// Util: candidates = the util items actually in the inventory.
	// Last-held wins if it is among them; else the most expensive
	// (inventory order breaks price ties); else nothing — a victim with
	// no util drops none.
	var utils []inventoryItem
	for _, it := range inv {
		if models.IsUtilityWeapon(it.name) {
			utils = append(utils, it)
		}
	}
	if len(utils) > 0 {
		best := utils[0]
		for _, it := range utils {
			if it.name == lastHeldUtil {
				best = it
				break // last-held util beats price, first same-name entry wins
			}
		}
		if best.name != lastHeldUtil {
			for _, it := range utils[1:] {
				if models.UtilityPrice(it.name) > models.UtilityPrice(best.name) {
					best = it
				}
			}
		}
		out = append(out, dropDecision{name: best.name, cat: "util"})
	}
	return out
}
