package extract

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestDropCat pins the drop-row classification (detail_json cat): the
// canonical util set decides "util", the firearm sets decide "gun", the
// defuse kit decides "kit" (models.IsKit), and everything else (knife,
// C4, armour, unknown) is NOT drop evidence and never stores a
// weapon_pickup row.
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
	// The kit is drop evidence — the one name that MOVED out of the
	// excluded set when kit possession became inferable (models.IsKit).
	if got := dropCat("Defuse Kit"); got != "kit" {
		t.Errorf(`dropCat("Defuse Kit") = %q, want kit`, got)
	}
	// A near-miss spelling is not the kit (exact canonical match).
	if got := dropCat("defuser"); got != "" {
		t.Errorf(`dropCat("defuser") = %q, want "" (canonical spelling only)`, got)
	}
	for _, n := range []string{"Knife", "C4", "Kevlar Vest", "Kevlar + Helmet", "Unknown", ""} {
		if got := dropCat(n); got != "" {
			t.Errorf("dropCat(%q) = %q, want \"\" (not drop evidence)", n, got)
		}
	}
}

// TestInferDeathDrops pins the death-drop rule (the user's stated rules):
// first primary → first secondary → no gun, ONE util: last-held-this-
// round (when still carried) → most expensive → none, and a kit when the
// victim had one (hasKit). Pure table test — the golden diag
// (TestDiagDropInventoryAtKill) exercises the same code against real
// inventories.
func TestInferDeathDrops(t *testing.T) {
	gun := func(name string, mag, res int) inventoryItem {
		return inventoryItem{name: name, mag: mag, reserve: res}
	}
	nade := func(name string) inventoryItem { return inventoryItem{name: name} }

	cases := []struct {
		name     string
		inv      []inventoryItem
		lastHeld string
		hasKit   bool
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
		{
			// The kit is the ONE decision that ignores the inventory:
			// hasKit alone produces it, appended after gun/util.
			name:   "kit only — no inventory needed",
			inv:    nil,
			hasKit: true,
			want:   []dropDecision{{name: "Defuse Kit", cat: "kit"}},
		},
		{
			name:   "kit rides after gun + util",
			inv:    []inventoryItem{gun("M4A4", 30, 90), nade("Smoke Grenade")},
			hasKit: true,
			want: []dropDecision{
				{name: "M4A4", cat: "gun", mag: 30, reserve: 90},
				{name: "Smoke Grenade", cat: "util"},
				{name: "Defuse Kit", cat: "kit"},
			},
		},
		{
			// hasKit false (T, or a CT who never bought one) → no kit
			// row, whatever the inventory says.
			name: "kit false → no kit decision",
			inv:  []inventoryItem{gun("AK-47", 30, 90)},
			want: []dropDecision{{name: "AK-47", cat: "gun", mag: 30, reserve: 90}},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := inferDeathDrops(c.inv, c.lastHeld, c.hasKit)
			if !reflect.DeepEqual(got, c.want) {
				t.Errorf("inferDeathDrops(%v, %q, %v) = %+v, want %+v", c.inv, c.lastHeld, c.hasKit, got, c.want)
			}
		})
	}
}

// TestInferDeathDropsNeverClassifiesNonItems pins that the util rule can
// never fire on a non-grenade name even if a caller passes one (the cat
// split is models.IsUtilityWeapon's — a "util" decision is always a
// canonical grenade), and that hasKit can only ever yield the kit row.
func TestInferDeathDropsNeverClassifiesNonItems(t *testing.T) {
	decisions := inferDeathDrops([]inventoryItem{{name: "C4"}, {name: "Knife"}}, "", true)
	for _, d := range decisions {
		if d.cat != "gun" && d.cat != "util" && d.cat != "kit" {
			t.Fatalf("unexpected cat %q", d.cat)
		}
		if d.cat == "util" && !models.IsUtilityWeapon(d.name) {
			t.Errorf("util decision %q is not a canonical utility weapon", d.name)
		}
		if d.cat == "kit" {
			if !models.IsKit(d.name) {
				t.Errorf("kit decision %q is not the canonical kit name", d.name)
			}
			// A kit carries no ammo — 0/0 on the decision, and the row's
			// detail_json must stay player/cat/source only (agg.kill
			// stamps mag/reserve for cat "gun" only).
			if d.mag != 0 || d.reserve != 0 {
				t.Errorf("kit decision carries ammo %d/%d, want 0/0", d.mag, d.reserve)
			}
		}
	}
}

// TestKillEmitsKitDrop pins the kit half of the death-drop contract end
// to end through agg.kill: hasKit=true yields ONE extra weapon_drop row
// named "Defuse Kit" with cat "kit", the VICTIM's key and the VICTIM's
// position at the kill (the same evidence every other death drop uses),
// and a detail_json of exactly player/cat/source — never mag/reserve (a
// kit carries no ammo). hasKit=false yields no kit row at all, and the
// gun/util decisions are byte-identical either way (the kit decision is
// appended last — drops.go inferDeathDrops).
func TestKillEmitsKitDrop(t *testing.T) {
	px, py, pz := 120.0, -340.0, 5.0
	kill := func(hasKit bool) []models.Event {
		a := newAgg()
		a.kill(killInfo{
			tick:       4200,
			real:       true,
			tickRate:   64,
			victimKey:  76561198000000001,
			victimName: "KitHolder",
			victimSide: "ct",
			posX:       &px,
			posY:       &py,
			posZ:       &pz,
			inv:        []inventoryItem{{name: "M4A4", mag: 30, reserve: 90}},
			hasKit:     hasKit,
		})
		var drops []models.Event
		for _, ev := range a.events {
			if ev.Kind == models.EventWeaponDrop {
				drops = append(drops, ev)
			}
		}
		return drops
	}

	without := kill(false)
	if len(without) != 1 {
		t.Fatalf("hasKit=false drops = %d, want 1 (gun only)", len(without))
	}
	if without[0].Weapon == "Defuse Kit" {
		t.Error("hasKit=false produced a kit drop row")
	}

	with := kill(true)
	if len(with) != 2 {
		t.Fatalf("hasKit=true drops = %d, want 2 (gun + kit)", len(with))
	}
	kit := with[1]
	if kit.Weapon != "Defuse Kit" {
		t.Errorf("kit row weapon = %q, want %q", kit.Weapon, "Defuse Kit")
	}
	if kit.Attacker != "76561198000000001" {
		t.Errorf("kit row attacker = %q, want the victim's key", kit.Attacker)
	}
	if kit.PosX == nil || *kit.PosX != 120 || kit.PosY == nil || *kit.PosY != -340 || kit.PosZ == nil || *kit.PosZ != 5 {
		t.Errorf("kit row pos = %v/%v/%v, want the victim position 120/-340/5", kit.PosX, kit.PosY, kit.PosZ)
	}
	var detail map[string]any
	if err := json.Unmarshal([]byte(kit.DetailJSON), &detail); err != nil {
		t.Fatalf("kit DetailJSON: %v", err)
	}
	if detail["cat"] != "kit" || detail["player"] != "KitHolder" || detail["source"] != "victim" {
		t.Errorf("kit detail = %v, want player/cat:\"kit\"/source:\"victim\"", detail)
	}
	if _, ok := detail["mag"]; ok {
		t.Errorf("kit detail carries mag: %v (a kit has no ammo)", detail["mag"])
	}
	if _, ok := detail["reserve"]; ok {
		t.Errorf("kit detail carries reserve: %v", detail["reserve"])
	}
	// The gun row is untouched by the kit decision (same name, ammo).
	var gun *models.Event
	for i := range with {
		if with[i].Weapon == "M4A4" {
			gun = &with[i]
		}
	}
	if gun == nil {
		t.Fatal("gun drop row missing")
	}
	var gdetail map[string]any
	if err := json.Unmarshal([]byte(gun.DetailJSON), &gdetail); err != nil {
		t.Fatalf("gun DetailJSON: %v", err)
	}
	if gdetail["cat"] != "gun" || gdetail["mag"] != float64(30) || gdetail["reserve"] != float64(90) {
		t.Errorf("gun detail = %v, want cat gun + mag/reserve 30/90", gdetail)
	}
}

// TestItemPickupKitGate pins the item_pickup handler's classification
// gate for kits (handlers.go — the gate itself is dropCat): a kit row is
// STORED (cat "kit"), knife/C4/armour stay filtered, and the stored row
// carries the picker's key, name and position exactly like a gun/util
// pickup. The buy-vs-ground distinction is deliberately NOT made here
// (nothing at extract time can tell them apart) — that is the frontend's
// buytime rule (lib/replay/kits.js).
func TestItemPickupKitGate(t *testing.T) {
	// What the handler lets through: dropCat == "" returns early.
	for _, filtered := range []string{"Knife", "C4", "Kevlar Vest", "Kevlar + Helmet"} {
		if dropCat(filtered) != "" {
			t.Errorf("dropCat(%q) = %q, want \"\" (gate must filter it)", filtered, dropCat(filtered))
		}
	}
	if dropCat("Defuse Kit") == "" {
		t.Fatal(`dropCat("Defuse Kit") = "" — the kit gate must let kit rows through`)
	}

	// The stored row shape the gate produces for a kit acquisition.
	a := newAgg()
	px, py, pz := 44.0, -80.0, 1.0
	a.weaponPickedUp(9000, 76561198000000002, "KitPicker", "Defuse Kit", "kit", &px, &py, &pz)
	if len(a.events) != 1 {
		t.Fatalf("events = %d, want 1", len(a.events))
	}
	ev := a.events[0]
	if ev.Kind != models.EventWeaponPickup {
		t.Fatalf("kind = %s, want weapon_pickup", ev.Kind)
	}
	if ev.Weapon != "Defuse Kit" {
		t.Errorf("weapon = %q, want %q", ev.Weapon, "Defuse Kit")
	}
	if ev.Attacker != "76561198000000002" {
		t.Errorf("attacker = %q, want the picker's key", ev.Attacker)
	}
	if ev.PosX == nil || *ev.PosX != 44 {
		t.Errorf("pos = %v, want the picker's position", ev.PosX)
	}
	var detail map[string]any
	if err := json.Unmarshal([]byte(ev.DetailJSON), &detail); err != nil {
		t.Fatalf("DetailJSON: %v", err)
	}
	if detail["cat"] != "kit" || detail["player"] != "KitPicker" {
		t.Errorf("detail = %v, want player/\"KitPicker\" + cat \"kit\"", detail)
	}
}
