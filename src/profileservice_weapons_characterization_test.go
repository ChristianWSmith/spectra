package main

import (
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestMergeWeaponsCharacterization pins the RETIRED profile Weapons
// JSON fold (mergeWeapons) as M7's equivalence pre-image — ORACLE-ONLY
// since the table migrated to the weapon_* seeds (2026-11-18): the fold
// is PURE INTEGER SUMS per weapon — kills/damage/headshots pooled across
// matches, sorted kills desc → damage desc → name asc, capped at
// weaponTopLimit — so any weapon-partitioned ratio metric must be
// compared against the ROW-RATIO over these pooled counts (Σhs ÷ Σk),
// never the mean-of-per-match-ratios. For ak47 below the two spellings
// diverge measurably: pooled 4/14 ≈ 0.2857 where the unweighted mean
// of the per-match HS shares is (3/10 + 1/4)/2 = 0.325.
func TestMergeWeaponsCharacterization(t *testing.T) {
	// Pooling across matches + malformed/empty JSON rows skipped.
	rows := []models.ProfileWeaponJSONs{
		{KillsByWeapon: `{"ak47":10,"awp":2}`, DamageByWeapon: `{"ak47":900,"awp":300}`, HeadshotsByWeapon: `{"ak47":3}`},
		{KillsByWeapon: `{"ak47":4,"awp":1}`, DamageByWeapon: `{"ak47":900,"awp":150}`, HeadshotsByWeapon: `{"ak47":1}`},
		{KillsByWeapon: "", DamageByWeapon: `not json`, HeadshotsByWeapon: `{}`},
	}
	got := mergeWeapons(rows)
	if len(got) != 2 {
		t.Fatalf("rows = %d (%+v), want 2 weapons (empty/malformed JSON skipped)", len(got), got)
	}
	// Sort: ak47 (14 kills) leads awp (3).
	if got[0].Weapon != "ak47" || got[1].Weapon != "awp" {
		t.Errorf("order = %s,%s, want ak47,awp (kills desc)", got[0].Weapon, got[1].Weapon)
	}
	// Exact pooled sums — the row-ratio inputs M7 compares against.
	if ak := got[0]; ak.Kills != 14 || ak.Damage != 1800 || ak.Headshots != 4 {
		t.Errorf("ak47 = %+v, want kills 14 (10+4), damage 1800 (900+900), headshots 4 (3+1) — pooled sums, not per-match means", ak)
	}
	if awp := got[1]; awp.Kills != 3 || awp.Damage != 450 || awp.Headshots != 0 {
		t.Errorf("awp = %+v, want kills 3 (2+1), damage 450 (300+150), headshots 0 (absent → 0)", awp)
	}

	// Tie-breaks: equal kills → damage desc; equal kills+damage → name asc.
	tied := mergeWeapons([]models.ProfileWeaponJSONs{
		{KillsByWeapon: `{"zeta":5,"alpha":5,"bbb":5,"aaa":5}`, DamageByWeapon: `{"zeta":100,"alpha":200,"bbb":100,"aaa":100}`},
	})
	var order []string
	for _, w := range tied {
		order = append(order, w.Weapon)
	}
	wantOrder := []string{"alpha", "aaa", "bbb", "zeta"}
	if len(order) != len(wantOrder) {
		t.Fatalf("tied order = %v, want %v", order, wantOrder)
	}
	for i := range wantOrder {
		if order[i] != wantOrder[i] {
			t.Errorf("tied order = %v, want %v (kills desc → damage desc → name asc)", order, wantOrder)
		}
	}

	// Top-N cap: 11 weapons (kills 11..1) → the 10 highest kept, the
	// kills=1 weapon dropped.
	bulk := `{"w11":1,"w10":2,"w09":3,"w08":4,"w07":5,"w06":6,"w05":7,"w04":8,"w03":9,"w02":10,"w01":11}`
	capped := mergeWeapons([]models.ProfileWeaponJSONs{{KillsByWeapon: bulk}})
	if len(capped) != 10 || weaponTopLimit != 10 {
		t.Fatalf("capped rows = %d (limit %d), want 10", len(capped), weaponTopLimit)
	}
	if capped[0].Weapon != "w01" || capped[9].Weapon != "w10" || capped[9].Kills != 2 {
		t.Errorf("cap head/tail = %+v/%+v, want w01 (11 kills) first and w10 (2 kills) last", capped[0], capped[9])
	}
	for _, w := range capped {
		if w.Weapon == "w11" {
			t.Errorf("w11 (1 kill) survived the %d-weapon cap: %+v", weaponTopLimit, capped)
		}
	}
}
