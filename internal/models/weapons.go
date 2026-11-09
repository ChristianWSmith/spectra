package models

// utilityWeaponKinds maps the canonical utility weapon names — exactly the
// strings demoinfocs' common.EquipmentType.String() emits for EqHE, EqFlash,
// EqSmoke, EqMolotov, EqIncendiary and EqDecoy, which is what extract's
// wepName/blastFor write into events.weapon — to the stored utility kind
// (utility_events.kind). Molotov ≡ Incendiary: the detonation event records
// "Incendiary Grenade" for both teams' flames, so they pair as one kind.
//
// This map is the ONE definition of the utility set, read by:
//
//	analytics.rounds  DMG/UtilDmg aggregation → models.IsUtilityWeapon
//	analytics.utility utilKind                → models.UtilityWeaponKind
//	extract.handlers  common.Eq* enum gate    (the parser cannot see
//	                                           names before demoinfocs
//	                                           resolves them; pinned to
//	                                           this map by
//	                                           extract.TestUtilityWeaponSetsIdentical)
//
// Every producer of events.weapon emits EquipmentType.String(), so the
// exact-match lookup sees the same inputs in every layer.
var utilityWeaponKinds = map[string]string{
	"HE Grenade":         "he",
	"Flashbang":          "flash",
	"Smoke Grenade":      "smoke",
	"Molotov":            "molotov",
	"Incendiary Grenade": "molotov",
	"Decoy Grenade":      "decoy",
}

// utilityPrices is THE canonical buy-price table for the six utility
// grenades ($, the game's buy-menu cost; CS2 prices — the Incendiary was
// cut from CS:GO's $600 to $500 in the 2024-05-23 update, see CS2.md
// "Death drops (mp_death_drop_gun / mp_death_drop_grenade)"). It exists
// for ONE consumer today: extract.inferDeathDrops' most-expensive
// tiebreak when the victim last held no util this round. No other layer
// may re-derive grenade prices (econ.js prices no gear; there is no
// second table) — pinned by models.TestUtilityPricesPinned.
//
// Molotov (T, $400) vs Incendiary (CT, $500): both spellings map to the
// stored "molotov" kind elsewhere, but the PRICES differ, so both stay
// here — a side can only carry its own, so the difference only matters
// if this table is ever read cross-side.
var utilityPrices = map[string]int{
	"HE Grenade":         300,
	"Flashbang":          200,
	"Smoke Grenade":      300,
	"Molotov":            400,
	"Incendiary Grenade": 500,
	"Decoy Grenade":      50,
}

// UtilityPrice returns the canonical buy price ($) of a canonical
// utility weapon name (0 when the name is not utility — the zero value
// means "not priced here", never "$0 grenade").
func UtilityPrice(weapon string) int {
	return utilityPrices[weapon]
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

// primaryWeapons/secondaryWeapons are the Go TWIN of the frontend's
// PRIMARY_WEAPONS/SECONDARY_WEAPONS sets in frontend/src/lib/replay/loadout.js
// — quoted verbatim from there (canonical EquipmentType.String() spellings,
// the same names the state stream's weapon/inventory fields carry). The two
// sides must classify identically: extract computes the state stream's
// stowed main-weapon ammo with these (internal/extract's scanWeapons), the
// card resolves the displayed main weapon with loadout.js's mainWeaponOf —
// cf. the sideparity Go/JS twins (internal/rules + lib/sideparity.js) in
// ref/CONSOLIDATION.md. Loadout.js's header cross-references THIS file.
var primaryWeapons = map[string]struct{}{
	"Galil AR": {}, "FAMAS": {}, "AK-47": {}, "M4A4": {}, "M4A1": {}, "SG 553": {},
	"AUG": {}, "SSG 08": {}, "AWP": {}, "SCAR-20": {}, "G3SG1": {},
	"MP7": {}, "MP9": {}, "PP-Bizon": {}, "MAC-10": {}, "UMP-45": {},
	"P90": {}, "MP5-SD": {},
	"Sawed-Off": {}, "Nova": {}, "MAG-7": {}, "XM1014": {}, "M249": {}, "Negev": {},
}

// secondaryWeapons — sidearms (the Zeus rides with the pistols), quoted
// from loadout.js's SECONDARY_WEAPONS (see primaryWeapons).
var secondaryWeapons = map[string]struct{}{
	"P2000": {}, "Glock-18": {}, "P250": {}, "Desert Eagle": {}, "Five-SeveN": {},
	"Dual Berettas": {}, "Tec-9": {}, "CZ75 Auto": {}, "USP-S": {}, "R8 Revolver": {},
	"Zeus x27": {},
}

// IsPrimaryWeapon reports whether weapon is a CS2 long gun (rifle, SMG,
// shotgun, LMG, sniper) — the FIRST choice for a player's main weapon.
// Exact-match on the canonical name (twin: loadout.js isPrimaryWeapon).
func IsPrimaryWeapon(weapon string) bool {
	_, ok := primaryWeapons[weapon]
	return ok
}

// IsSecondaryWeapon reports whether weapon is a sidearm — the fallback
// main weapon when no primary is carried (twin: loadout.js
// isSecondaryWeapon). NO starter-pistol fallback lives here: a caller that
// needs one opts in explicitly (loadout.js mainWeaponOf's `starter`).
func IsSecondaryWeapon(weapon string) bool {
	_, ok := secondaryWeapons[weapon]
	return ok
}
