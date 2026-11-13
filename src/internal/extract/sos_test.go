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

// TestSOSFireCueVocabulary pins Wave C's six fire-cue soundevents: their
// events.kind and the canonical weapon (or the deliberate "" when the
// soundevent names no nade), resolution through fireCueByHash, and — the
// strongest form — each name's LITERAL murmur2 value (the hash rule's
// published output for these exact strings, captured through
// mappack.SoundEventHash / `cs2find hash`, 2026-11-12): a rename of any
// def, or a drift in the hash rule itself, fails here instead of silently
// dropping the cue at import. Also pins the three waves' name
// vocabularies as pairwise disjoint (one message → at most one wave) and
// the ignition-family look-alikes as never-resolving.
func TestSOSFireCueVocabulary(t *testing.T) {
	want := []struct {
		name   string
		kind   string
		weapon string
		hash   uint32
	}{
		{"Molotov.Extinguish", models.EventExtinguish, "", 0x76B5D77D},
		{"Molotov.StartFailed", models.EventStartFailed, "Molotov", 0x7827DA8A},
		{"IncGrenade.StartFailed", models.EventStartFailed, "Incendiary Grenade", 0xB456C38F},
		{"Molotov.Smash", models.EventSmash, "Molotov", 0x0310DB06},
		{"IncGrenade.Pop", models.EventSmash, "Incendiary Grenade", 0x4137A918},
		{"Inferno.FadeOut", models.EventFadeOut, "", 0x1B045DA6},
	}
	if len(fireCueDefs) != len(want) {
		t.Fatalf("fireCueDefs has %d entries, want %d", len(fireCueDefs), len(want))
	}
	for _, w := range want {
		if got := mappack.SoundEventHash(w.name); got != w.hash {
			t.Errorf("SoundEventHash(%q) = 0x%08X, want 0x%08X (hash rule or name drifted)", w.name, got, w.hash)
		}
		d, ok := fireCueByHash[w.hash]
		if !ok {
			t.Fatalf("hash of %q does not resolve", w.name)
		}
		if d.name != w.name || d.kind != w.kind || d.weapon != w.weapon {
			t.Errorf("hash resolution of %q = %+v, want {name:%q kind:%q weapon:%q}", w.name, d, w.name, w.kind, w.weapon)
		}
	}
	// A hash collision would silently drop a name from the lookup table.
	if len(fireCueByHash) != len(fireCueDefs) {
		t.Errorf("fireCueByHash has %d entries, want %d (hash collision?)", len(fireCueByHash), len(fireCueDefs))
	}
	// Kind vocabulary: StartFailed and Extinguish/Smash/FadeOut stay
	// distinct cues (audibly different sounds — the owner's spec), the
	// nade-specific names share their moment's kind through the weapon
	// column, and the extinguish/fade cues carry NO weapon (one sound for
	// both nades — never guessed).
	kinds := map[string]bool{}
	for _, d := range fireCueDefs {
		kinds[d.kind] = true
	}
	for k := range kinds {
		if k == "" {
			t.Error("empty fire-cue kind")
		}
	}
	if !kinds[models.EventExtinguish] || !kinds[models.EventStartFailed] ||
		!kinds[models.EventSmash] || !kinds[models.EventFadeOut] {
		t.Errorf("fire-cue kinds = %v, want all four of extinguish/start_failed/smash/fade_out", kinds)
	}
	if len(kinds) != 4 {
		t.Errorf("fire-cue kinds distinct = %d, want 4 (StartFailed must stay its own kind)", len(kinds))
	}
	// Pairwise disjointness across the three waves: one SOS hash resolves
	// to at most one wave's table, so no message is ever stored twice or
	// misrouted (the extract handler runs the branches independently).
	for _, d := range fireCueDefs {
		h := mappack.SoundEventHash(d.name)
		if _, ok := bounceByHash[h]; ok {
			t.Errorf("%q also resolves in bounceByHash (waves overlap)", d.name)
		}
		if _, ok := playerSoundByHash[h]; ok {
			t.Errorf("%q also resolves in playerSoundByHash (waves overlap)", d.name)
		}
	}
	for _, d := range grenadeBounceDefs {
		if _, ok := fireCueByHash[mappack.SoundEventHash(d.name)]; ok {
			t.Errorf("bounce %q also resolves in fireCueByHash", d.name)
		}
	}
	// The ignition family and other look-alikes must never become cues:
	// the replay already plays the normal-bloom files through the
	// "Molotov"/"Incendiary Grenade" detonation groups, and the loop/ignite
	// sounds fire only where a fire actually starts (0× at suppressed
	// landings — the probe's carve-out stays closed for them).
	for _, name := range []string{
		"Molotov.Start", "Molotov.StartDistant", "IncGrenade.Start",
		"Molotov.Bounce", "IncGrenade.Bounce", "IncGrenade.Bounce_M",
		"Inferno.Loop", "Inferno.Fire.Ignite", "Molotov.Loop",
		"Molotov.Throw", "SmokeGrenade.Extinguish",
	} {
		if _, ok := fireCueByHash[mappack.SoundEventHash(name)]; ok {
			t.Errorf("%q must not resolve to a fire cue", name)
		}
	}
}

// TestFireCueDedupeAndSkip pins Wave C's storage rules on the accumulator:
// dedupe by (source entity, tick, name) keeping the FIRST message (the
// same semantics TestGrenadeBouncedDedupeAndSkip pins for Wave A), the
// origin-required rule through the packed_params header, round stamping
// through the one evRound path, and the provenance keys in detail_json.
// The same-tick different-name case is REAL: the extinguish and fade cues
// co-fire at +0 from the same source entity (59/66 pool extinguish cues)
// and BOTH must become rows — the replay plays both sounds.
func TestFireCueDedupeAndSkip(t *testing.T) {
	a := newAgg()
	seen := map[fireCueKey]bool{}

	// The first message claims the key; its twin dedupes away (the origin
	// of the FIRST message wins — same as Wave A).
	a.fireCue(fireCueInfo{tick: 100, entity: 512, name: "Molotov.Extinguish",
		kind: models.EventExtinguish, hasPos: true, x: 1, y: 2, z: 3}, seen)
	a.fireCue(fireCueInfo{tick: 100, entity: 512, name: "Molotov.Extinguish",
		kind: models.EventExtinguish, hasPos: true, x: 1.4, y: 2.4, z: 3.4}, seen)
	// A DIFFERENT source entity at the same tick is a different cue …
	a.fireCue(fireCueInfo{tick: 100, entity: 513, name: "Molotov.StartFailed",
		kind: models.EventStartFailed, weapon: "Molotov", hasPos: true, x: 9, y: 9, z: 9}, seen)
	// … and the SAME entity + tick with a different soundevent is a
	// different cue — the real extinguish + fade pair: both stored.
	a.fireCue(fireCueInfo{tick: 100, entity: 512, name: "Inferno.FadeOut",
		kind: models.EventFadeOut, hasPos: true, x: 5, y: 5, z: 5}, seen)
	// Unparseable origin: claims the key, stores nothing — and the twin
	// (which HAS a fine origin) dedupes away rather than a guessed position.
	a.fireCue(fireCueInfo{tick: 200, entity: 600, name: "Molotov.Smash",
		kind: models.EventSmash, weapon: "Molotov", hasPos: false}, seen)
	a.fireCue(fireCueInfo{tick: 200, entity: 600, name: "Molotov.Smash",
		kind: models.EventSmash, weapon: "Molotov", hasPos: true, x: 7, y: 7, z: 7}, seen)
	// Zero vector = the posPtrs "no position known" convention → skipped.
	a.fireCue(fireCueInfo{tick: 300, entity: 700, name: "Inferno.FadeOut",
		kind: models.EventFadeOut, hasPos: true, x: 0, y: 0, z: 0}, seen)

	if len(a.events) != 3 {
		t.Fatalf("events = %d, want 3 (the first's twin deduped; origin-less Smash claims-but-skips; the same-entity fade cue stored beside its extinguish sibling)", len(a.events))
	}
	// Rows carry the def's kind + weapon (nade from the soundevent name;
	// "" for the nade-agnostic extinguish/fade cues) and a position —
	// never a guess.
	wantRows := []struct {
		kind   string
		weapon string
		x      float64
	}{
		{models.EventExtinguish, "", 1},
		{models.EventStartFailed, "Molotov", 9},
		{models.EventFadeOut, "", 5},
	}
	for i := range wantRows {
		if a.events[i].Kind != wantRows[i].kind || a.events[i].Weapon != wantRows[i].weapon {
			t.Errorf("events[%d] kind/weapon = %q/%q, want %q/%q", i,
				a.events[i].Kind, a.events[i].Weapon, wantRows[i].kind, wantRows[i].weapon)
		}
		if a.events[i].PosX == nil || *a.events[i].PosX != wantRows[i].x {
			t.Errorf("events[%d].PosX = %v, want %v (the first message's origin wins)", i, a.events[i].PosX, wantRows[i].x)
		}
	}
	// The deduped twin's origin (1.4) must NOT win — the first message's (1).
	if got := *a.events[0].PosX; got != 1 {
		t.Errorf("first origin x = %v, want 1 (the first message wins)", got)
	}
	// The origin-less Smash and the zero-vector fade never became rows —
	// and NO Smash row exists at all (both of its messages were claims).
	for _, e := range a.events {
		if e.Kind == models.EventSmash {
			t.Errorf("skipped cue stored a row: kind=%s tick=%d", e.Kind, e.Tick)
		}
		if e.Tick == 300 {
			t.Errorf("zero-vector cue stored a row at tick 300")
		}
	}
	// detail_json carries the provenance keys: source entity + the exact
	// soundevent name (which cue it was).
	var detail map[string]any
	if err := json.Unmarshal([]byte(a.events[0].DetailJSON), &detail); err != nil {
		t.Fatalf("detail_json: %v", err)
	}
	if detail["entity"] != float64(512) || detail["soundevent"] != "Molotov.Extinguish" {
		t.Errorf("detail_json = %v, want entity 512 + soundevent Molotov.Extinguish", detail)
	}
	// Round rides the same evRound path as every events row: round 1
	// before any RoundStart (evRound clamps).
	if a.events[0].Round != 1 {
		t.Errorf("round = %d, want 1 (evRound before any RoundStart)", a.events[0].Round)
	}
	// The FIRST round is COUNTED, so the pre-round cue prefix survives it.
	a.roundStart(100, false, false, 0, "")
	// A DISCARDED (warmup) round stores NO cue rows — the cues ride the
	// same ingest discard as every other row (agg.addEvent drops them;
	// a round that does not exist gets no round_start row either).
	a.roundStart(200, true, false, 0, "")
	a.fireCue(fireCueInfo{tick: 240, entity: 801, name: "Molotov.Extinguish",
		kind: models.EventExtinguish, hasPos: true, x: 8, y: 8, z: 8}, seen)
	// …while the next COUNTED round's cue is stored — renumber rewrites it
	// chrono → dense (3 → 2) with every other round-carrying row.
	a.roundStart(300, false, false, 0, "")
	a.fireCue(fireCueInfo{tick: 320, entity: 800, name: "Inferno.FadeOut",
		kind: models.EventFadeOut, hasPos: true, x: 3, y: 4, z: 5}, seen)

	out := a.build()
	// roundStart stores its own round_start rows, so build carries those
	// plus the cue rows — count the cue kinds only.
	cueRows := 0
	roundsByTick := map[int]int{}
	for _, e := range out.Events {
		switch e.Kind {
		case models.EventExtinguish, models.EventStartFailed, models.EventSmash, models.EventFadeOut:
			cueRows++
			roundsByTick[e.Tick] = e.Round
		}
	}
	// The discarded round's cue (tick 240) is absent — its round has no
	// rows at all; the 3 prefix cues (chrono round 1 → dense 1) and the
	// counted-round cue (chrono 3 → dense 2) survive.
	if cueRows != 4 {
		t.Fatalf("build carried %d cue rows, want 4 (3 prefix + 1 counted-round; the discarded round's cue dropped)", cueRows)
	}
	if _, ok := roundsByTick[240]; ok {
		t.Errorf("discarded round stored a cue row at tick 240")
	}
	// All three prefix cues share tick 100 → one map entry, round 1.
	if r := roundsByTick[100]; r != 1 {
		t.Errorf("prefix cue round = %d, want 1 (dense renumber)", r)
	}
	if r := roundsByTick[320]; r != 2 {
		t.Errorf("counted-round cue round = %d, want 2 (chrono 3 → dense 2)", r)
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
// output, renumber() rewrites them with every other round-carrying row
// (chrono → dense), and a DISCARDED round's sounds are never stored.
func TestSoundEventRowRoundAndBuild(t *testing.T) {
	a := newAgg()
	a.soundEvent(models.SoundEvent{Tick: 120, SteamID: "76561198000000001", Kind: models.SoundStep, Material: "Concrete", TeamPrefix: "ct", SOSName: "CT_Concrete.StepLeft"})
	if a.soundEvents[0].Round != 1 {
		t.Fatalf("round before any round = %d, want 1 (evRound clamps)", a.soundEvents[0].Round)
	}
	// The first round is COUNTED, so the pre-round prefix survives with it.
	a.roundStart(100, false, false, 0, "")
	// A discarded (warmup) round stores no sound rows…
	a.roundStart(200, true, false, 0, "")
	a.soundEvent(models.SoundEvent{Tick: 240, SteamID: "76561198000000009", Kind: models.SoundStep, SOSName: "CT_Concrete.StepLeft"})
	if len(a.soundEvents) != 1 {
		t.Fatalf("discarded round kept sound rows: %d, want 1", len(a.soundEvents))
	}
	// …while the next counted round's row rides the renumber mapping
	// (chronological 3 → dense 2).
	a.roundStart(300, false, false, 0, "")
	a.soundEvent(models.SoundEvent{Tick: 320, SteamID: "76561198000000002", Kind: models.SoundLand, SOSName: "Land.Thud"})

	out := a.build()
	if len(out.SoundEvents) != 2 {
		t.Fatalf("build carried %d sound events, want 2", len(out.SoundEvents))
	}
	if out.SoundEvents[0].Round != 1 || out.SoundEvents[1].Round != 2 {
		t.Errorf("rounds = %d/%d, want 1/2 (dense renumber)", out.SoundEvents[0].Round, out.SoundEvents[1].Round)
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
