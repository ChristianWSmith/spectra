package extract

import (
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestUtilityWeaponSetsIdentical pins the utility-weapon set that used to
// exist as three hand-maintained copies:
//
//  1. models.utilityWeaponKinds — canonical NAMES (analytics' util-dmg
//     attribution and grenade pairing both call into it now);
//  2. utilEquipmentTypes (this package) — EQUIPMENT TYPES for the
//     PlayerHurt gate, since the parser sees types before demoinfocs'
//     name resolution is re-derivable;
//  3. the canonical names themselves — demoinfocs' EquipmentType.String(),
//     which is what wepName writes into events.weapon.
//
// All three must agree, or a grenade counts as utility damage in one layer
// and not the other.
func TestUtilityWeaponSetsIdentical(t *testing.T) {
	// The CS2 domain fact: exactly six utility grenades (canonical names
	// as demoinfocs spells them).
	canonical := []string{
		"HE Grenade", "Flashbang", "Smoke Grenade",
		"Molotov", "Incendiary Grenade", "Decoy Grenade",
	}
	want := map[string]bool{}
	for _, name := range canonical {
		want[name] = true
	}

	// (2) extract's enum → names, via the same call wepName makes.
	got := map[string]bool{}
	for _, typ := range utilEquipmentTypes {
		name := typ.String()
		if got[name] {
			t.Errorf("duplicate type %v (%q) in utilEquipmentTypes", typ, name)
		}
		got[name] = true
		if !models.IsUtilityWeapon(name) {
			t.Errorf("extract type %v → %q missing from models.IsUtilityWeapon", typ, name)
		}
	}
	// (1)+(3) both directions: same size, and every canonical name present.
	if len(got) != len(want) {
		t.Errorf("extract set has %d names, models/canonical has %d", len(got), len(want))
	}
	for _, name := range canonical {
		if !got[name] {
			t.Errorf("canonical utility %q missing from extract's enum set", name)
		}
		if !models.IsUtilityWeapon(name) {
			t.Errorf("models.IsUtilityWeapon(%q) = false, want true", name)
		}
		if models.UtilityWeaponKind(name) == "" {
			t.Errorf("models.UtilityWeaponKind(%q) = \"\", want a stored kind", name)
		}
	}

	// Nothing else may slip into the set (raw demo weapon strings, guns,
	// the knife, spacing/case variants).
	for _, notUtility := range []string{
		"", "AK-47", "AWP", "knife", "Zeus x27", "C4",
		"hegrenade", "flashbang", "smokegrenade", "weapon_hegrenade",
		"HE Grenade ", " Molotov",
	} {
		if models.IsUtilityWeapon(notUtility) {
			t.Errorf("IsUtilityWeapon(%q) = true, want false", notUtility)
		}
	}

	// Molotov ≡ Incendiary: both pair and store as the same kind.
	if models.UtilityWeaponKind("Molotov") != models.UtilityWeaponKind("Incendiary Grenade") {
		t.Errorf("molotov kind %q != incendiary kind %q",
			models.UtilityWeaponKind("Molotov"), models.UtilityWeaponKind("Incendiary Grenade"))
	}
}
