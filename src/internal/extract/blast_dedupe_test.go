package extract

import (
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// blastRows returns the EventGrenade rows the accumulator stored, in order.
func blastRows(a *agg) []models.Event {
	var out []models.Event
	for _, e := range a.events {
		if e.Kind == models.EventGrenade {
			out = append(out, e)
		}
	}
	return out
}

// TestGrenadeBlastDedupe pins the write-side detonation dedupe
// (agg.blastSeen, consulted by agg.grenadeBlast): ONE stored detonation
// row per (tick, thrower, weapon), FIRST dispatch wins.
//
// Why the dedupe exists: demoinfocs-golang v6 (v6.0.0-rc.1) dispatches
// events.FlashExplode TWICE per flashbang — once from the
// flashbang_detonate game event (pkg/demoinfocs/game_events.go,
// flashBangDetonate) and once from the flash projectile's entity
// on-destroy handler (pkg/demoinfocs/datatables.go, stOnDestroy, gated
// wep == common.EqFlash). HE/smoke/fire/decoy detonations dispatch once,
// which is why the duplication showed on flashes only. Cached in CS2.md
// ("A flashbang detonation fires TWICE in demoinfocs-golang v6").
//
// The key carries the weapon so a flash and an HE from the same thrower
// in one tick never merge; two DISTINCT same-kind nades from one thrower
// in the identical tick would merge — impossible in practice (0 such
// groups library-wide, and 0 occurrences in the golden parse).
func TestGrenadeBlastDedupe(t *testing.T) {
	const (
		tick  = 900
		donk  = uint64(76561198000000001)
		flash = "Flashbang"
		he    = "HE Grenade"
	)

	// The duplicated dispatch: same tick/thrower/weapon, the two sources'
	// positions differ by ~0.01 u (entity position vs game-event
	// position) — the second call must store NOTHING.
	t.Run("same tick+thrower+weapon stores one row, first position wins", func(t *testing.T) {
		a := newAgg()
		a.grenadeBlast(blastInfo{tick: tick, weapon: flash, source: "flashbang_detonate",
			throwerKey: donk, throwerName: "donk", entity: 512, x: 100, y: 200, z: 3})
		a.grenadeBlast(blastInfo{tick: tick, weapon: flash, source: "flashbang_detonate",
			throwerKey: donk, throwerName: "donk", entity: 512, x: 100.01, y: 200, z: 3})

		rows := blastRows(a)
		if len(rows) != 1 {
			t.Fatalf("EventGrenade rows = %d, want 1 (one row per detonation)", len(rows))
		}
		if rows[0].PosX == nil || *rows[0].PosX != 100 {
			t.Errorf("row posX = %v, want the FIRST dispatch's 100", rows[0].PosX)
		}
	})

	// Controls: the key's components each separate distinct detonations.
	t.Run("same tick, different thrower stores two", func(t *testing.T) {
		a := newAgg()
		a.grenadeBlast(blastInfo{tick: tick, weapon: flash, source: "flashbang_detonate",
			throwerKey: donk, throwerName: "donk", entity: 512, x: 100, y: 200, z: 3})
		a.grenadeBlast(blastInfo{tick: tick, weapon: flash, source: "flashbang_detonate",
			throwerKey: donk + 1, throwerName: "someone", entity: 513, x: 110, y: 210, z: 3})
		if got := len(blastRows(a)); got != 2 {
			t.Errorf("EventGrenade rows = %d, want 2 (different throwers are different detonations)", got)
		}
	})

	t.Run("same tick+thrower, different weapon stores two", func(t *testing.T) {
		a := newAgg()
		a.grenadeBlast(blastInfo{tick: tick, weapon: flash, source: "flashbang_detonate",
			throwerKey: donk, throwerName: "donk", entity: 512, x: 100, y: 200, z: 3})
		a.grenadeBlast(blastInfo{tick: tick, weapon: he, source: "hegrenade_detonate",
			throwerKey: donk, throwerName: "donk", entity: 514, x: 105, y: 205, z: 3})
		if got := len(blastRows(a)); got != 2 {
			t.Errorf("EventGrenade rows = %d, want 2 (a flash and an HE in one tick never merge)", got)
		}
	})

	t.Run("same thrower+weapon, different tick stores two", func(t *testing.T) {
		a := newAgg()
		a.grenadeBlast(blastInfo{tick: tick, weapon: flash, source: "flashbang_detonate",
			throwerKey: donk, throwerName: "donk", entity: 512, x: 100, y: 200, z: 3})
		a.grenadeBlast(blastInfo{tick: tick + 64, weapon: flash, source: "flashbang_detonate",
			throwerKey: donk, throwerName: "donk", entity: 520, x: 120, y: 220, z: 3})
		if got := len(blastRows(a)); got != 2 {
			t.Errorf("EventGrenade rows = %d, want 2 (different ticks are different detonations)", got)
		}
	})

	// The dedupe is uniform over kinds (the general criterion is "the
	// parser dispatches some detonations twice", today exactly the flash
	// twin) — a no-op for the once-dispatched kinds at distinct ticks.
	t.Run("non-flash kind at two distinct ticks stores two", func(t *testing.T) {
		a := newAgg()
		a.grenadeBlast(blastInfo{tick: tick, weapon: he, source: "hegrenade_detonate",
			throwerKey: donk, throwerName: "donk", entity: 512, x: 100, y: 200, z: 3})
		a.grenadeBlast(blastInfo{tick: tick + 64, weapon: he, source: "hegrenade_detonate",
			throwerKey: donk, throwerName: "donk", entity: 514, x: 120, y: 220, z: 3})
		if got := len(blastRows(a)); got != 2 {
			t.Errorf("EventGrenade rows = %d, want 2", got)
		}
	})
}
