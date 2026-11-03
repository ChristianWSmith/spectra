package models

// utilityWeaponKinds maps the canonical utility weapon names — exactly the
// strings demoinfocs' common.EquipmentType.String() emits for EqHE, EqFlash,
// EqSmoke, EqMolotov, EqIncendiary and EqDecoy, which is what extract's
// wepName/blastFor write into events.weapon — to the stored utility kind
// (utility_events.kind). Molotov ≡ Incendiary: the detonation event records
// "Incendiary Grenade" for both teams' flames, so they pair as one kind.
//
// This map is the ONE definition of the utility set. The three copies that
// used to exist were:
//
//	analytics.rounds  utilWeapons map        → now models.IsUtilityWeapon
//	analytics.utility utilKind switch        → now models.UtilityWeaponKind
//	extract.handlers  common.Eq* enum gate   → kept (the parser cannot see
//	                                           names before demoinfocs
//	                                           resolves them) but pinned to
//	                                           this map by
//	                                           extract.TestUtilityWeaponSetsIdentical
//
// Behavior-neutral consolidation: every producer of events.weapon emits
// EquipmentType.String(), so the exact-match lookup sees the same inputs the
// three copies did.
var utilityWeaponKinds = map[string]string{
	"HE Grenade":         "he",
	"Flashbang":          "flash",
	"Smoke Grenade":      "smoke",
	"Molotov":            "molotov",
	"Incendiary Grenade": "molotov",
	"Decoy Grenade":      "decoy",
}

// IsUtilityWeapon reports whether weapon is one of CS2's six utility
// grenades. Matching is exact on the canonical names (every writer of
// events.weapon emits EquipmentType.String(); case variants never occur).
func IsUtilityWeapon(weapon string) bool {
	_, ok := utilityWeaponKinds[weapon]
	return ok
}

// UtilityWeaponKind returns the stored utility kind for a canonical utility
// weapon name ("" when the weapon is not utility). It is the set membership
// test of IsUtilityWeapon plus the name→kind projection the grenade pairing
// and utility_events rows store.
func UtilityWeaponKind(weapon string) string {
	return utilityWeaponKinds[weapon]
}
