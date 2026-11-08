package extract

import (
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestDecoyLifecycleKinds pins the two-row decoy lifecycle this feature
// split apart (spec 2026-11-07): the ACTIVATION (decoy_started ≈ the
// projectile coming to rest) is its own kind so no detonation rule —
// analytics, heatmaps, the scrubber — counts it as an explosion, while
// the EXPIRY (decoy_detonate → BaseGrenade.Explode) stays an ordinary
// EventGrenade detonation row. Both rows carry the payload coordinates
// blastFor extracted from the game event (verified on
// golden/de_dust2.dem.zst: decoy_detonate ships x/y/z — the rest
// position, identical to the activation's — plus the thrower).
func TestDecoyLifecycleKinds(t *testing.T) {
	a := newAgg()

	// Activation — the decoy at rest (payload read by blastFor).
	a.decoyLanded(blastInfo{
		tick:        6618,
		weapon:      "Decoy Grenade",
		source:      "decoy_started",
		throwerKey:  76561198012345678,
		throwerName: "donk",
		x:           1918.71,
		y:           1121.50,
		z:           195.03,
	})
	// Explosion — the SAME builder every other detonation uses.
	a.grenadeBlast(blastInfo{
		tick:        7536,
		weapon:      "Decoy Grenade",
		source:      "decoy_detonate",
		throwerKey:  76561198012345678,
		throwerName: "donk",
		x:           1918.71,
		y:           1121.50,
		z:           195.03,
	})

	if len(a.events) != 2 {
		t.Fatalf("events = %d, want 2 (activation + explosion)", len(a.events))
	}
	land, det := a.events[0], a.events[1]

	// The kind split is the contract: activation ≠ detonation.
	if land.Kind != models.EventGrenadeLand {
		t.Errorf("activation kind = %q, want %q", land.Kind, models.EventGrenadeLand)
	}
	if det.Kind != models.EventGrenade {
		t.Errorf("explosion kind = %q, want %q (the game plays BaseGrenade.Explode)", det.Kind, models.EventGrenade)
	}
	// The two kinds must never collapse into each other (every consumer
	// matches the kind exactly — a shared string would leak activations
	// into stats).
	if models.EventGrenadeLand == models.EventGrenade {
		t.Fatal("EventGrenadeLand must differ from EventGrenade")
	}

	// Ticks: activation at rest, explosion ~8.7 s later (the 15–18 s
	// noise window starts at activation; here the window is bounded by
	// the detonation row the replay pairs with it).
	if land.Tick != 6618 || det.Tick != 7536 {
		t.Errorf("ticks = %d/%d, want 6618/7536", land.Tick, det.Tick)
	}

	// Payload position survives on BOTH rows — the coordinates are read
	// from the game event, never guessed or paired.
	for i, e := range []models.Event{land, det} {
		if e.PosX == nil || e.PosY == nil || e.PosZ == nil {
			t.Fatalf("row %d position = %v/%v/%v, want the payload x/y/z", i, e.PosX, e.PosY, e.PosZ)
		}
		if *e.PosX != 1918.71 || *e.PosY != 1121.50 || *e.PosZ != 195.03 {
			t.Errorf("row %d position = %v/%v/%v, want 1918.71/1121.50/195.03", i, *e.PosX, *e.PosY, *e.PosZ)
		}
	}

	// Same weapon and thrower on both rows (the replay's plan pairs them).
	for i, e := range []models.Event{land, det} {
		if e.Weapon != "Decoy Grenade" {
			t.Errorf("row %d weapon = %q, want Decoy Grenade", i, e.Weapon)
		}
		if e.Attacker != keyStr(76561198012345678) {
			t.Errorf("row %d attacker = %q, want the thrower key", i, e.Attacker)
		}
	}
}

// TestDecoyLandedIsNotCountedAsGrenade guards the leak explicitly: the
// activation row must NOT satisfy an EventGrenade match (analytics
// utility pairing, the grenade heatmaps and every other consumer switch
// on the exact kind — see models.EventGrenadeLand's comment).
func TestDecoyLandedIsNotCountedAsGrenade(t *testing.T) {
	if models.EventGrenadeLand == "grenade" || models.EventGrenadeLand != "grenade_land" {
		t.Fatalf("EventGrenadeLand = %q, want the distinct \"grenade_land\" string", models.EventGrenadeLand)
	}
}
