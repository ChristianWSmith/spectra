package models

import "testing"

// TestWeaponSplitsPinned pins the primary/secondary membership sets —
// quoted from frontend/src/lib/replay/loadout.js's PRIMARY_WEAPONS /
// SECONDARY_WEAPONS (the Go/JS twins). A rename or a new weapon must be
// added to BOTH sides: extract's stowed main-weapon ammo (scanWeapons) and
// the card's mainWeaponOf must classify the same inventory identically.
func TestWeaponSplitsPinned(t *testing.T) {
	primary := []string{
		"Galil AR", "FAMAS", "AK-47", "M4A4", "M4A1", "SG 553",
		"AUG", "SSG 08", "AWP", "SCAR-20", "G3SG1",
		"MP7", "MP9", "PP-Bizon", "MAC-10", "UMP-45", "P90", "MP5-SD",
		"Sawed-Off", "Nova", "MAG-7", "XM1014", "M249", "Negev",
	}
	secondary := []string{
		"P2000", "Glock-18", "P250", "Desert Eagle", "Five-SeveN",
		"Dual Berettas", "Tec-9", "CZ75 Auto", "USP-S", "R8 Revolver",
		"Zeus x27",
	}
	for _, name := range primary {
		if !IsPrimaryWeapon(name) {
			t.Errorf("IsPrimaryWeapon(%q) = false, want true", name)
		}
		if IsSecondaryWeapon(name) {
			t.Errorf("IsSecondaryWeapon(%q) = true, want false (splits are disjoint)", name)
		}
	}
	for _, name := range secondary {
		if !IsSecondaryWeapon(name) {
			t.Errorf("IsSecondaryWeapon(%q) = false, want true", name)
		}
		if IsPrimaryWeapon(name) {
			t.Errorf("IsPrimaryWeapon(%q) = true, want false (splits are disjoint)", name)
		}
	}
	// Held items and non-guns are neither: the main weapon is NEVER a
	// knife, a grenade, the bomb, or the unnamed sentinel.
	neither := []string{
		"Knife", "C4", "HE Grenade", "Flashbang", "Smoke Grenade",
		"Molotov", "Incendiary Grenade", "Decoy Grenade", "Defuse Kit",
		"Kevlar Vest", "Kevlar + Helmet", "Unknown", "",
	}
	for _, name := range neither {
		if IsPrimaryWeapon(name) || IsSecondaryWeapon(name) {
			t.Errorf("%q classified as a firearm, want neither", name)
		}
	}
	// Set sizes: 24 long guns, 11 sidearms — a silent set edit must not
	// slip in (the explicit members above are the real guard).
	if len(primaryWeapons) != len(primary) || len(secondaryWeapons) != len(secondary) {
		t.Errorf("set sizes = %d primary / %d secondary, want %d / %d",
			len(primaryWeapons), len(secondaryWeapons), len(primary), len(secondary))
	}
}
