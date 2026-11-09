package extract

import (
	"reflect"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestDropCat pins the drop-row classification (detail_json cat): the
// canonical util set decides "util", the firearm sets decide "gun", and
// everything else (knife, C4, kit, armour, unknown) is NOT drop evidence
// and never stores a weapon_pickup row.
func TestDropCat(t *testing.T) {
	for _, n := range []string{"HE Grenade", "Flashbang", "Smoke Grenade", "Molotov", "Incendiary Grenade", "Decoy Grenade"} {
		if got := dropCat(n); got != "util" {
			t.Errorf("dropCat(%q) = %q, want util", n, got)
		}
	}
	for _, n := range []string{"AK-47", "AWP", "M4A1", "Glock-18", "Desert Eagle", "Zeus x27", "R8 Revolver"} {
		if got := dropCat(n); got != "gun" {
			t.Errorf("dropCat(%q) = %q, want gun", n, got)
		}
	}
	for _, n := range []string{"Knife", "C4", "Defuse Kit", "Kevlar Vest", "Kevlar + Helmet", "Unknown", ""} {
		if got := dropCat(n); got != "" {
			t.Errorf("dropCat(%q) = %q, want \"\" (not drop evidence)", n, got)
		}
	}
}

// TestInferDeathDrops pins the death-drop rule (the user's stated rules):
// first primary → first secondary → no gun, and ONE util: last-held-this-
// round (when still carried) → most expensive → none. Pure table test —
// the golden diag (TestDiagDropInventoryAtKill) exercises the same code
// against real inventories.
func TestInferDeathDrops(t *testing.T) {
	gun := func(name string, mag, res int) inventoryItem {
		return inventoryItem{name: name, mag: mag, reserve: res}
	}
	nade := func(name string) inventoryItem { return inventoryItem{name: name} }

	cases := []struct {
		name     string
		inv      []inventoryItem
		lastHeld string
		want     []dropDecision
	}{
		{
			name: "primary wins over secondary",
			inv:  []inventoryItem{gun("Glock-18", 20, 120), gun("AK-47", 30, 90), nade("Smoke Grenade")},
			want: []dropDecision{
				{name: "AK-47", cat: "gun", mag: 30, reserve: 90},
				{name: "Smoke Grenade", cat: "util"},
			},
		},
		{
			name: "first primary in inventory order wins",
			inv:  []inventoryItem{gun("AWP", 5, 30), gun("AK-47", 17, 90)},
			want: []dropDecision{{name: "AWP", cat: "gun", mag: 5, reserve: 30}},
		},
		{
			name: "secondary only when no primary",
			inv:  []inventoryItem{gun("Desert Eagle", 7, 35), gun("USP-S", 12, 24)},
			want: []dropDecision{{name: "Desert Eagle", cat: "gun", mag: 7, reserve: 35}},
		},
		{
			name: "knife-only death drops no gun",
			inv:  []inventoryItem{{name: "Knife"}},
		},
		{
			name: "no util in inventory → no util drop",
			inv:  []inventoryItem{gun("AK-47", 30, 90)},
			want: []dropDecision{{name: "AK-47", cat: "gun", mag: 30, reserve: 90}},
		},
		{
			name: "last-held util beats price",
			inv:  []inventoryItem{nade("HE Grenade"), nade("Flashbang"), nade("Incendiary Grenade")},
			// Flashbang ($200) is the cheapest — held-last still wins.
			lastHeld: "Flashbang",
			want:     []dropDecision{{name: "Flashbang", cat: "util"}},
		},
		{
			name:     "last-held util no longer carried → most expensive",
			inv:      []inventoryItem{nade("Flashbang"), nade("Smoke Grenade")},
			lastHeld: "HE Grenade", // thrown earlier this round
			want:     []dropDecision{{name: "Smoke Grenade", cat: "util"}},
		},
		{
			name: "never held a util → most expensive",
			inv:  []inventoryItem{nade("Flashbang"), nade("Molotov"), nade("HE Grenade")},
			want: []dropDecision{{name: "Molotov", cat: "util"}},
		},
		{
			name: "price tie keeps the first inventory entry",
			inv:  []inventoryItem{nade("HE Grenade"), nade("Smoke Grenade")},
			want: []dropDecision{{name: "HE Grenade", cat: "util"}},
		},
		{
			name: "gun + util together",
			inv:  []inventoryItem{gun("M4A4", 30, 90), gun("Five-SeveN", 20, 100), nade("Decoy Grenade")},
			want: []dropDecision{
				{name: "M4A4", cat: "gun", mag: 30, reserve: 90},
				{name: "Decoy Grenade", cat: "util"},
			},
		},
		{
			name: "empty inventory → nothing",
			inv:  nil,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := inferDeathDrops(c.inv, c.lastHeld)
			if !reflect.DeepEqual(got, c.want) {
				t.Errorf("inferDeathDrops(%v, %q) = %+v, want %+v", c.inv, c.lastHeld, got, c.want)
			}
		})
	}
}

// TestInferDeathDropsNeverClassifiesNonItems pins that the util rule can
// never fire on a non-grenade name even if a caller passes one (the cat
// split is models.IsUtilityWeapon's — a "util" decision is always a
// canonical grenade).
func TestInferDeathDropsNeverClassifiesNonItems(t *testing.T) {
	for _, d := range inferDeathDrops([]inventoryItem{{name: "C4"}, {name: "Knife"}}, "") {
		if d.cat != "gun" && d.cat != "util" {
			t.Fatalf("unexpected cat %q", d.cat)
		}
		if d.cat == "util" && !models.IsUtilityWeapon(d.name) {
			t.Errorf("util decision %q is not a canonical utility weapon", d.name)
		}
	}
}
