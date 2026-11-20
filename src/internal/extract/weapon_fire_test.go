package extract

import (
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestShotWritesTypedWeaponFire pins the weapon_fire promotion: one typed
// row per counted shot (attacker + weapon, no payload pairing), gated
// exactly like the shots counter — a discarded round and an unknown
// shooter add neither a count nor a row, so count(weapon_fire) per
// attacker equals player_stats.shots.
func TestShotWritesTypedWeaponFire(t *testing.T) {
	a := newAgg()
	const key uint64 = 76561198000000042
	a.shot(1200, key, "Shooter", "AK-47")
	a.shot(1230, key, "Shooter", "Glock-18")
	a.shot(1260, 0, "Nobody", "AK-47") // unknown shooter: no count, no row
	a.discarding = true
	a.shot(1290, key, "Shooter", "AK-47") // discarded round: no count, no row
	a.discarding = false

	if got := a.ensure(key, "Shooter").shots; got != 2 {
		t.Fatalf("shots = %d, want 2", got)
	}
	var fires []models.Event
	for _, ev := range a.events {
		if ev.Kind == models.EventWeaponFire {
			fires = append(fires, ev)
		}
	}
	if len(fires) != 2 {
		t.Fatalf("weapon_fire rows = %d, want 2 (one per counted shot)", len(fires))
	}
	if fires[0].Tick != 1200 || fires[0].Attacker != "76561198000000042" || fires[0].Weapon != "AK-47" {
		t.Errorf("first row = %+v, want tick 1200, attacker 76561198000000042, weapon AK-47", fires[0])
	}
	if fires[1].Weapon != "Glock-18" {
		t.Errorf("second row weapon = %q, want Glock-18", fires[1].Weapon)
	}
	if fires[0].DetailJSON != "" || fires[0].RawJSON != "" {
		t.Errorf("weapon_fire row carries a payload (detail %q, raw %q); generic_events must stay the only copy",
			fires[0].DetailJSON, fires[0].RawJSON)
	}
}
