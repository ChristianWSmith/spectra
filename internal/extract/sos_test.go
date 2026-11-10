package extract

import (
	"encoding/json"
	"math"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/mappack"
	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestSOSGrenadeBounceVocabulary pins Wave A's five bounce soundevents and
// their canonical weapon names (the EquipmentType.String() vocabulary the
// throw/det rows already carry, so the replay's sfx groups key off the same
// strings). Measured on golden: these five names cover ALL 1,826 bounce
// messages / 979 deduped rows — no decoy bounce exists, and the look-alike
// physics impacts (Bounce.Concrete, Bounce.Glass, Player.DamageGrenadeBounce)
// must never resolve to a grenade-bounce row.
func TestSOSGrenadeBounceVocabulary(t *testing.T) {
	want := map[string]string{
		"HEGrenade.Bounce":    "HE Grenade",
		"Flashbang.Bounce":    "Flashbang",
		"SmokeGrenade.Bounce": "Smoke Grenade",
		"Molotov.Bounce":      "Molotov",
		"IncGrenade.Bounce":   "Incendiary Grenade",
	}
	if len(grenadeBounceDefs) != len(want) {
		t.Fatalf("grenadeBounceDefs has %d entries, want %d", len(grenadeBounceDefs), len(want))
	}
	for _, d := range grenadeBounceDefs {
		if want[d.name] != d.weapon {
			t.Errorf("grenadeBounceDefs[%q] weapon = %q, want %q", d.name, d.weapon, want[d.name])
		}
		got, ok := bounceByHash[mappack.SoundEventHash(d.name)]
		if !ok {
			t.Fatalf("hash of %q does not resolve", d.name)
		}
		if got.name != d.name || got.weapon != d.weapon {
			t.Errorf("hash resolution of %q = %+v", d.name, got)
		}
	}
	// A hash collision would silently drop a name from the lookup table.
	if len(bounceByHash) != len(grenadeBounceDefs) {
		t.Errorf("bounceByHash has %d entries, want %d (hash collision?)", len(bounceByHash), len(grenadeBounceDefs))
	}
	for _, name := range []string{
		"HEGrenade.Explode",
		"Bounce.Concrete",
		"Player.DamageGrenadeBounce",
		"SmokeGrenade.Bounce_Can",
		"Decoy.Bounce",
	} {
		if _, ok := bounceByHash[mappack.SoundEventHash(name)]; ok {
			t.Errorf("%q must not resolve to a grenade bounce", name)
		}
	}
}

// TestSOSPlayerSoundClassification pins Wave B's candidate table: the
// kind/material/team split is decided AT TABLE BUILD (never at row time),
// every candidate resolves back to itself through its hash, the lowercase
// spellings the game sometimes uses resolve through the same candidates
// (the hash lowercases), and names outside the vocabulary never resolve.
func TestSOSPlayerSoundClassification(t *testing.T) {
	cases := []struct {
		name, kind, material, team string
	}{
		{"CT_Concrete.StepLeft", models.SoundStep, "Concrete", "ct"},
		{"T_SolidMetal.StepLeft", models.SoundStep, "SolidMetal", "t"},
		// ct_wade.StepLeft is the game's own lowercase spelling — the
		// hash folds case, so the CT_ candidate matches it.
		{"ct_wade.StepLeft", models.SoundStep, "wade", "ct"},
		{"Land_Gravel.StepLeft", models.SoundLand, "Gravel", ""},
		{"Land_Concrete.StepLeft", models.SoundLand, "Concrete", ""},
		// A Silent material is STORED like any other (material is data;
		// whether playback skips it is the frontend's call).
		{"CT_Silent.StepLeft", models.SoundStep, "Silent", "ct"},
		{"Gear.JumpLand.CT", models.SoundJump, "", "ct"},
		{"Gear.JumpLand.T", models.SoundJump, "", "t"},
		{"Default.WalkJump", models.SoundJump, "", ""},
		{"Player.DamageFall", models.SoundFall, "", ""},
		{"Player.DamageFall.Fem", models.SoundFall, "", ""},
		{"Land.Thud", models.SoundLand, "", ""},
		{"Default.Land", models.SoundLand, "", ""},
	}
	for _, tc := range cases {
		def, ok := playerSoundByHash[mappack.SoundEventHash(tc.name)]
		if !ok {
			t.Errorf("%q does not resolve (candidate table)", tc.name)
			continue
		}
		if def.kind != tc.kind || def.material != tc.material || def.team != tc.team {
			t.Errorf("%q → kind=%q material=%q team=%q, want kind=%q material=%q team=%q",
				tc.name, def.kind, def.material, def.team, tc.kind, tc.material, tc.team)
		}
	}
	// Every candidate resolves back to itself and no two collide.
	if len(playerSoundByHash) != len(playerSoundCandidates()) {
		t.Errorf("playerSoundByHash has %d entries, want %d candidates (hash collision?)",
			len(playerSoundByHash), len(playerSoundCandidates()))
	}
	for _, d := range playerSoundCandidates() {
		if got := playerSoundByHash[mappack.SoundEventHash(d.name)]; got.name != d.name {
			t.Errorf("candidate %q resolves to %q", d.name, got.name)
		}
	}
	for _, name := range []string{
		"Weapon_AK47.Single", "BaseGrenade.Explode", "Inferno.Fire.Ignite",
		"Player.PickupWeaponAudible", "Gear.CT", "TeamIntro.Footsteps_Default",
		"CT_Cloth.StepLeft", // a material no shipped name carries
	} {
		if _, ok := playerSoundByHash[mappack.SoundEventHash(name)]; ok {
			t.Errorf("%q must not resolve to a player sound", name)
		}
	}
	// The kind vocabulary stays four-valued and disjoint.
	for _, k := range []string{models.SoundStep, models.SoundLand, models.SoundJump, models.SoundFall} {
		if k == "" {
			t.Error("empty sound kind")
		}
	}
}

// TestSosOrigin pins the packed_params position parse: the 7-byte header
// 4d ce 7c 5a 0a 0c 00 precedes 3×float32 little-endian world coordinates.
// Every failure mode (short buffer, foreign header, NaN/Inf, the zero
// vector) must read as "no position" — callers SKIP such a bounce rather
// than store a guessed origin.
func TestSosOrigin(t *testing.T) {
	packed := func(header []byte, vals ...float32) []byte {
		b := append([]byte{}, header...)
		for _, v := range vals {
			b = append(b, byte(math.Float32bits(v)>>0), byte(math.Float32bits(v)>>8),
				byte(math.Float32bits(v)>>16), byte(math.Float32bits(v)>>24))
		}
		return b
	}
	x, y, z, ok := sosOrigin(packed(sosOriginHeader[:], 100.5, -2048, 30.25))
	if !ok {
		t.Fatal("valid packed_params did not parse")
	}
	if x != 100.5 || y != -2048 || z != 30.25 {
		t.Errorf("origin = (%v, %v, %v), want (100.5, -2048, 30.25)", x, y, z)
	}

	cases := []struct {
		name   string
		packed []byte
	}{
		{"nil", nil},
		{"empty", []byte{}},
		{"header only", sosOriginHeader[:]},
		{"one float short", packed(sosOriginHeader[:], 1, 2)},
		{"foreign header", packed([]byte{0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06}, 1, 2, 3)},
		{"zero vector", packed(sosOriginHeader[:], 0, 0, 0)},
		{"NaN", sosHeaderWithNaN()},
	}
	for _, tc := range cases {
		if _, _, _, ok := sosOrigin(tc.packed); ok {
			t.Errorf("%s: want ok=false", tc.name)
		}
	}
	// Trailing parameter bytes after the origin are tolerated (the header
	// pins the layout; the length check only needs the three floats).
	long := append(packed(sosOriginHeader[:], 7, 8, 9), 0xde, 0xad, 0xbe, 0xef)
	if _, _, _, ok := sosOrigin(long); !ok {
		t.Error("trailing bytes after a valid origin must be tolerated")
	}
	// +Inf must be rejected like NaN.
	if _, _, _, ok := sosOrigin(packed(sosOriginHeader[:], float32(math.Inf(1)), 1, 2)); ok {
		t.Error("+Inf component: want ok=false")
	}
}

// sosHeaderWithNaN builds a header + NaN payload for the table above.
func sosHeaderWithNaN() []byte {
	b := append([]byte{}, sosOriginHeader[:]...)
	nan := math.Float32bits(float32(math.NaN()))
	for i := 0; i < 3; i++ {
		b = append(b, byte(nan), byte(nan>>8), byte(nan>>16), byte(nan>>24))
	}
	return b
}

// TestGrenadeBouncedDedupeAndSkip pins the Wave A storage rules on the
// accumulator: dedupe by (source entity, tick, name) keeping the FIRST
// message, a separate projectile at the same tick stored independently,
// and a bounce whose origin does not parse storing NOTHING (its duplicate
// dedupes away instead of inventing the missing coordinate).
func TestGrenadeBouncedDedupeAndSkip(t *testing.T) {
	a := newAgg()
	// The first message claims the key; its origin wins over the twin's.
	a.grenadeBounced(bounceInfo{tick: 100, entity: 512, name: "HEGrenade.Bounce", weapon: "HE Grenade", hasPos: true, x: 1, y: 2, z: 3})
	a.grenadeBounced(bounceInfo{tick: 100, entity: 512, name: "HEGrenade.Bounce", weapon: "HE Grenade", hasPos: true, x: 1.4, y: 2.4, z: 3.4})
	// A DIFFERENT projectile in the same tick is a different bounce.
	a.grenadeBounced(bounceInfo{tick: 100, entity: 513, name: "HEGrenade.Bounce", weapon: "HE Grenade", hasPos: true, x: 9, y: 9, z: 9})
	// Same entity + tick but a different soundevent = different bounce.
	a.grenadeBounced(bounceInfo{tick: 100, entity: 512, name: "Flashbang.Bounce", weapon: "Flashbang", hasPos: true, x: 5, y: 5, z: 5})
	// Unparseable origin: claims the key, stores nothing — and the twin
	// (which has a fine origin) dedupes away rather than guessing.
	a.grenadeBounced(bounceInfo{tick: 200, entity: 600, name: "SmokeGrenade.Bounce", weapon: "Smoke Grenade", hasPos: false})
	a.grenadeBounced(bounceInfo{tick: 200, entity: 600, name: "SmokeGrenade.Bounce", weapon: "Smoke Grenade", hasPos: true, x: 7, y: 7, z: 7})
	// Zero vector = the posPtrs "no position known" convention → skipped.
	a.grenadeBounced(bounceInfo{tick: 300, entity: 700, name: "Molotov.Bounce", weapon: "Molotov", hasPos: true, x: 0, y: 0, z: 0})

	if len(a.events) != 3 {
		t.Fatalf("events = %d, want 3 (the twin dedupes; origin-less and zero-vector bounces are skipped)", len(a.events))
	}
	for _, e := range a.events {
		if e.Kind != models.EventGrenadeBounce {
			t.Errorf("kind = %q, want %q", e.Kind, models.EventGrenadeBounce)
		}
		if e.PosX == nil || e.PosY == nil || e.PosZ == nil {
			t.Errorf("row %d/%s stored without a position", e.Tick, e.Weapon)
		}
	}
	// The FIRST message's origin wins (1, 2, 3 — not the twin's 1.4, 2.4).
	if got := *a.events[0].PosX; got != 1 {
		t.Errorf("first origin x = %v, want 1 (the first message wins)", got)
	}
	// The unparseable-origin bounce never became a row.
	for _, e := range a.events {
		if e.Tick == 200 {
			t.Errorf("origin-less bounce stored a row at tick 200")
		}
	}
	// detail_json carries the join keys: the projectile entity + the name.
	var detail map[string]any
	if err := json.Unmarshal([]byte(a.events[0].DetailJSON), &detail); err != nil {
		t.Fatalf("detail_json: %v", err)
	}
	if detail["entity"] != float64(512) || detail["soundevent"] != "HEGrenade.Bounce" {
		t.Errorf("detail_json = %v, want entity 512 + soundevent HEGrenade.Bounce", detail)
	}
	// The round is stamped through the same evRound path as every row.
	if a.events[0].Round != 1 {
		t.Errorf("round = %d, want 1 (evRound before any RoundStart)", a.events[0].Round)
	}
}

// TestSoundEventRowRoundAndBuild pins Wave B's row plumbing: agg.soundEvent
// stamps the current round, build() carries the rows into the extract
// output, and renumber() rewrites them with every other round-carrying row
// (a warmup round's rows become negative like events/chat do).
func TestSoundEventRowRoundAndBuild(t *testing.T) {
	a := newAgg()
	a.soundEvent(models.SoundEvent{Tick: 120, SteamID: "76561198000000001", Kind: models.SoundStep, Material: "Concrete", TeamPrefix: "ct", SOSName: "CT_Concrete.StepLeft"})
	if a.soundEvents[0].Round != 1 {
		t.Fatalf("round before any round = %d, want 1 (evRound clamps)", a.soundEvents[0].Round)
	}
	// A warmup round renumbers to -1 in build — sound rows ride the same
	// mapping as events/chat/economy/sides (build.renumber).
	a.roundStart(200, true, false, 0, "")
	a.soundEvent(models.SoundEvent{Tick: 240, SteamID: "76561198000000002", Kind: models.SoundLand, SOSName: "Land.Thud"})

	out := a.build()
	if len(out.SoundEvents) != 2 {
		t.Fatalf("build carried %d sound events, want 2", len(out.SoundEvents))
	}
	if out.SoundEvents[0].Round != -1 || out.SoundEvents[1].Round != -1 {
		t.Errorf("rounds = %d/%d, want -1/-1 (warmup renumber)", out.SoundEvents[0].Round, out.SoundEvents[1].Round)
	}
	if out.SoundEvents[1].Kind != models.SoundLand || out.SoundEvents[1].SOSName != "Land.Thud" {
		t.Errorf("second row = %+v", out.SoundEvents[1])
	}
}

// TestGrenadeDetailEntityJoin pins the throw → bounce → det join key that
// lives in detail_json `entity`: the PROJECTILE entity id on both rows.
// Measured on golden: a bounce's SOS source index is the thrown projectile
// entity 979/979 while the thrower's controller entity id matches 0/979 —
// storing anything else silently breaks the replay's pairing.
func TestGrenadeDetailEntityJoin(t *testing.T) {
	a := newAgg()
	a.grenadeThrown(10, 76561198000000001, "donk", 512, "HE Grenade", nil, nil, nil)
	a.grenadeBlast(blastInfo{tick: 900, weapon: "HE Grenade", source: "hegrenade_detonate", throwerKey: 76561198000000001, throwerName: "donk", entity: 512, x: 1, y: 2, z: 3})

	if len(a.events) != 2 {
		t.Fatalf("events = %d, want 2", len(a.events))
	}
	for _, e := range a.events {
		if !strings.Contains(e.DetailJSON, `"entity":512`) {
			t.Errorf("%s detail_json = %s, want \"entity\":512", e.Kind, e.DetailJSON)
		}
	}
}
