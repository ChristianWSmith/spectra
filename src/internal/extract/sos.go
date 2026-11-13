package extract

import (
	"bytes"
	"encoding/binary"
	"math"

	demoinfocs "github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/common"

	"github.com/ChristianWSmith/spectra/internal/mappack"
	"github.com/ChristianWSmith/spectra/internal/models"
)

// CMsgSosStartSoundEvent is the demo's sound-event channel: a fixed32
// soundevent_hash (resolved to a name with mappack.SoundEventHash — the ONE
// hash rule, no second copy), an optional source entity index, and
// packed_params carrying per-event parameters. Three consumers read it here:
//
//   - Wave A: the five grenade BOUNCE soundevents → typed
//     models.EventGrenadeBounce rows (deduped, origin-required);
//   - Wave B: the player-sound vocabulary (footsteps/lands/jumps/fall
//     damage) → sound_events rows attributed to a participant;
//   - Wave C: the fire-cue vocabulary (extinguish / air-burst failure /
//     detonation body-break / fire fade-out) → typed cue rows
//     (models.EventExtinguish … EventFadeOut — deduped, origin-required,
//     audio-only: no landmark category claims them, sfx.js fireCues plays
//     them).
//
// Everything is name-driven: no VPK or surfaceproperties file is touched at
// import time (imports must work without CS2 installed), so the candidate
// vocabulary below is static and hashed ONCE at package init.

// bounceDef is one grenade-bounce soundevent: the exact event name and the
// canonical equipment name the row stores as Event.Weapon — the same
// EquipmentType.String() vocabulary grenade_throw/grenade rows carry, so the
// replay's sfx groups key off it unchanged.
type bounceDef struct {
	name   string
	weapon string
}

// grenadeBounceDefs is Wave A's vocabulary: the ONLY five grenade bounce
// soundevents (verified against the local install's soundevents table —
// `cs2find events bounce`; there is no decoy bounce, and the look-alikes
// Bounce.Concrete/Bounce.Glass/… are generic physics impacts, not
// grenade flights).
var grenadeBounceDefs = []bounceDef{
	{name: "HEGrenade.Bounce", weapon: "HE Grenade"},
	{name: "Flashbang.Bounce", weapon: "Flashbang"},
	{name: "SmokeGrenade.Bounce", weapon: "Smoke Grenade"},
	{name: "Molotov.Bounce", weapon: "Molotov"},
	{name: "IncGrenade.Bounce", weapon: "Incendiary Grenade"},
}

// bounceByHash resolves a demo SOS hash to its bounce definition (built
// once; a hash that is not a bounce never reaches grenadeBounced).
var bounceByHash = func() map[uint32]bounceDef {
	m := make(map[uint32]bounceDef, len(grenadeBounceDefs))
	for _, d := range grenadeBounceDefs {
		m[mappack.SoundEventHash(d.name)] = d
	}
	return m
}()

// playerSoundDef is one candidate player-sound name with its classification
// decided AT TABLE BUILD (never at row time): kind, the material token the
// name spells, and the team prefix ("" when the name carries none).
type playerSoundDef struct {
	name     string
	kind     string
	material string
	team     string
}

// playerSoundMaterials is the surface vocabulary of the `<CT|T>_<Material>/
// Land_<Material>.StepLeft` family — the union of the walkleft/walkright
// names the shipped soundevents tables carry (cs2find events stepleft, all
// three prefixes), so one material list serves every prefix. Stored exactly
// as the game spells it (material is data — a `Silent` material is stored
// like any other; whether playback skips it is the frontend's call).
var playerSoundMaterials = []string{
	"Cardboard", "Carpet", "Ceiling_Tile", "ChainLink", "Concrete", "Default",
	"Dirt", "Drywall", "Flesh", "Foliage", "Glass", "GlassBottle", "Grass",
	"Gravel", "Grenade", "Ladder", "MetalBarrel", "MetalGrate",
	"MetalRailing", "MetalVehicle", "MetalVent", "Mud", "Plastic_Barrel",
	"Plastic_Box", "Plastic_autoCover", "Plastic_milkCrate", "PlayerFlesh",
	"Rubber", "Sand", "Silent", "Slime", "SlipperySlime", "Snow",
	"SolidMetal", "Tile", "Water", "WaterVol", "Weapon", "WetConcrete",
	"WetMud", "WetTile", "Wet_Sand", "Wood", "WoodBox", "Wood_Basket",
	"Wood_Crate", "Wood_Ladder", "Wood_Panel", "Wood_Solid", "wade",
}

// playerSoundCandidates is the static candidate table: every material × the
// three prefixes (CT_/T_ → step, Land_ → land), plus the fixed names whose
// kind is not a material step. Hashing lowercases (mappack.SoundEventHash),
// so the game's occasional lowercase spelling (ct_wade.StepLeft) resolves
// through the CT_ candidate too.
func playerSoundCandidates() []playerSoundDef {
	out := make([]playerSoundDef, 0, len(playerSoundMaterials)*3+7)
	for _, m := range playerSoundMaterials {
		out = append(out,
			playerSoundDef{name: "CT_" + m + ".StepLeft", kind: models.SoundStep, material: m, team: "ct"},
			playerSoundDef{name: "T_" + m + ".StepLeft", kind: models.SoundStep, material: m, team: "t"},
			playerSoundDef{name: "Land_" + m + ".StepLeft", kind: models.SoundLand, material: m},
		)
	}
	return append(out,
		// Jumps: the gear landing set (team-specific) and the generic
		// launch cue — neither name carries a surface.
		playerSoundDef{name: "Gear.JumpLand.CT", kind: models.SoundJump, team: "ct"},
		playerSoundDef{name: "Gear.JumpLand.T", kind: models.SoundJump, team: "t"},
		playerSoundDef{name: "Default.WalkJump", kind: models.SoundJump},
		// Fall damage (the * wildcard from the research: both shipped
		// spellings — the generic and the female-agent set).
		playerSoundDef{name: "Player.DamageFall", kind: models.SoundFall},
		playerSoundDef{name: "Player.DamageFall.Fem", kind: models.SoundFall},
		// Material-less landings.
		playerSoundDef{name: "Land.Thud", kind: models.SoundLand},
		playerSoundDef{name: "Default.Land", kind: models.SoundLand},
	)
}

// playerSoundByHash resolves a demo SOS hash to its player-sound
// classification (built once at package init — the ~156-name table is
// hashed a single time per process, never per message).
var playerSoundByHash = func() map[uint32]playerSoundDef {
	candidates := playerSoundCandidates()
	m := make(map[uint32]playerSoundDef, len(candidates))
	for _, d := range candidates {
		m[mappack.SoundEventHash(d.name)] = d
	}
	return m
}()

// sosOriginHeader is the 7-byte prefix packed_params carries before a
// grenade bounce's world position (research-validated layout:
// 4d ce 7c 5a 0a 0c 00, then 3×float32 little-endian). The header check is
// the defensive half — a message whose packed_params does not start with it
// may be laid out differently, and a layout we do not understand must never
// be read as coordinates.
var sosOriginHeader = [7]byte{0x4d, 0xce, 0x7c, 0x5a, 0x0a, 0x0c, 0x00}

// sosOrigin reads a grenade bounce's origin out of packed_params: the
// 7-byte header, then x/y/z as float32 little-endian. ok is false on ANY
// failure — short buffer, unexpected header, a non-finite component, or the
// zero vector (posPtrs' "no position known" convention). Callers treat !ok
// as a missing required input: the bounce row is SKIPPED, never stored with
// a guessed position.
func sosOrigin(packed []byte) (x, y, z float64, ok bool) {
	const header = len(sosOriginHeader)
	if len(packed) < header+3*4 || !bytes.Equal(packed[:header], sosOriginHeader[:]) {
		return 0, 0, 0, false
	}
	f := func(off int) float64 {
		return float64(math.Float32frombits(binary.LittleEndian.Uint32(packed[off : off+4])))
	}
	x, y, z = f(header), f(header+4), f(header+8)
	if math.IsNaN(x) || math.IsNaN(y) || math.IsNaN(z) ||
		math.IsInf(x, 0) || math.IsInf(y, 0) || math.IsInf(z, 0) {
		return 0, 0, 0, false
	}
	if x == 0 && y == 0 && z == 0 {
		return 0, 0, 0, false
	}
	return x, y, z, true
}

// playerByEntity resolves a SOS source entity index to its participant. CS2
// emits a player's sound from his PAWN entity, while demoinfocs keys its
// participant table by the player CONTROLLER entity, so neither index can be
// used directly (measured on golden: 0 of 16,252 player-sound messages carry
// a controller index). Two walks, both demoinfocs-public:
//
//  1. the pawn's own m_hController handle → Participants().FindByHandle64 —
//     O(1), resolves 5,164/16,252 golden messages;
//  2. the REVERSE link: any participant whose controller's m_hPawn points at
//     this entity (Player.PlayerPawnEntity) — resolves the remaining 11,088,
//     whose pawn reads m_hController = 0xFFFFFF (invalid handle) at message
//     time, so walk 1 can never see them.
//
// Together: 16,252/16,252 (100%) on golden. Returns nil when the source is
// absent (-1) or neither walk finds a participant — callers SKIP such a
// message; identity is never guessed.
func playerByEntity(gs *demoinfocs.GameState, entityID int) *common.Player {
	if gs == nil || entityID < 0 {
		return nil
	}
	if pawn := gs.Entities()[entityID]; pawn != nil {
		if ctlVal, ok := pawn.PropertyValue("m_hController"); ok {
			if pl := gs.Participants().FindByHandle64(ctlVal.Handle()); pl != nil {
				return pl
			}
		}
	}
	for _, pl := range gs.Participants().All() {
		if pl == nil {
			continue
		}
		if p := pl.PlayerPawnEntity(); p != nil && p.ID() == entityID {
			return pl
		}
	}
	return nil
}

// --- Wave C: the fire-cue vocabulary (smoke ⇄ fire interactions) -------------
//
// The owner's spec: when a smoke puts out a fire — or a firebomb lands in
// an active smoke and never ignites — the demo's SOS stream carries
// Molotov.Extinguish, and the replay must play it (there is NO game event
// for it: inferno_extinguish fires 0× ever — CS2.md). A fire grenade that
// blooms mid-air carries Molotov.StartFailed / IncGrenade.StartFailed —
// its OWN air-burst failure cue (owner ruling, 2026-11-12), a firebomb
// DETONATING (landing and breaking) carries Molotov.Smash / IncGrenade.Pop
// (owner ruling, 2026-11-12), and Inferno.FadeOut co-fires from the same
// source as the extinguish cue at suppressed landings (the probe's
// decision-rule capture). Captured unconditionally — play what the demo
// recorded, no smoke/fire-state gating — and drawn NOWHERE: the owner's
// indicator ruling stands, and scenario (ii) is correct by construction (a
// suppressed fire never emits inferno_startburn, so no fire row exists to
// draw).

// fireCueDef is one fire-cue soundevent: the exact name, the events.kind
// the row stores, and the canonical equipment name Event.Weapon carries —
// "" when the soundevent itself does not identify the nade. The air-burst
// and container-break names SPELL the nade (Molotov.* / IncGrenade.*), so
// the row picks its asset file exactly like wave A's weapon column; the
// extinguish and fade cues fire for BOTH nades' fires (one sound each —
// no Incendiary variant exists), so a weapon there would be a guess and
// stays empty (missing input ⇒ no value, never a fabricated one).
type fireCueDef struct {
	name   string
	kind   string
	weapon string
}

// fireCueDefs is Wave C's vocabulary — the six fire-family soundevents
// the replay plays as audio-only cues, verified against the local
// install's soundevents table (`cs2find events`, 2026-11-12):
//
//   - Molotov.Extinguish → sounds/weapons/molotov/molotov_extinguish.vsnd_c
//     — the ONLY extinguish soundevent in the install (no Incendiary
//     variant; Incendiary landings play the same cue — the owner's hunch
//     confirmed). 66× across the 7-demo golden pool: 58 where the firebomb
//     ignited and smoke killed its own fire, 8 where no fire ever started
//     (lands-in-active-smoke — both of the owner's scenarios).
//   - Molotov.StartFailed → …/molotov_detonate_air_01.vsnd_c and
//     IncGrenade.StartFailed → …/inc_grenade_detonate_air_01.vsnd_c — the
//     AIR-BURST failure cue (owner ruling, 2026-11-12: its own kind of
//     sound; a fire grenade that blooms in the air emits no fire). 9× in
//     the pool (5 mol / 4 inc).
//   - Molotov.Smash → …/molotov_smash_01..04.vsnd_c and IncGrenade.Pop →
//     …/inc_grenade_pop_03.vsnd_c — the firebomb DETONATING (landing and
//     breaking; the owner's term). No IncGrenade.Smash exists (grep over
//     all 21,220 install soundevent names: Molotov.Smash is the only
//     "smash"), so Pop — the only container-break sound in the IncGrenade
//     family — is the incendiary twin by elimination (flagged for the
//     owner's by-ear verification). Both fire 0× across the current pool;
//     captured anyway (owner decision: wire the dead capture, verify
//     manually).
//   - Inferno.FadeOut → …/fire_loop_fadeout_01.vsnd_c — the fire fading
//     out: co-fires at +0 from the SAME source entity as Extinguish at
//     suppressed landings (59/66 pool extinguish cues, 5/5 of the
//     no-own-fire landings — the probe's carve-out: the inventory DOES
//     show it there), and at every fire's death — so, captured
//     unconditionally, the replay plays it wherever the demo recorded it.
//
// No round-count gating on any of these (knife/warmup discard is queued
// separately — stamp rounds normally through addEvent → evRound).
var fireCueDefs = []fireCueDef{
	{name: "Molotov.Extinguish", kind: models.EventExtinguish, weapon: ""},
	{name: "Molotov.StartFailed", kind: models.EventStartFailed, weapon: "Molotov"},
	{name: "IncGrenade.StartFailed", kind: models.EventStartFailed, weapon: "Incendiary Grenade"},
	{name: "Molotov.Smash", kind: models.EventSmash, weapon: "Molotov"},
	{name: "IncGrenade.Pop", kind: models.EventSmash, weapon: "Incendiary Grenade"},
	{name: "Inferno.FadeOut", kind: models.EventFadeOut, weapon: ""},
}

// fireCueByHash resolves a demo SOS hash to its fire-cue definition (built
// once at package init through mappack.SoundEventHash — the ONE hash rule,
// no second copy; the three waves' name vocabularies are disjoint, so one
// message resolves to at most one wave — pinned by
// TestSOSFireCueVocabulary).
var fireCueByHash = func() map[uint32]fireCueDef {
	m := make(map[uint32]fireCueDef, len(fireCueDefs))
	for _, d := range fireCueDefs {
		m[mappack.SoundEventHash(d.name)] = d
	}
	return m
}()

// fireCueKey is Wave C's dedupe key: (source entity, tick, soundevent
// name) — the SAME shape as wave A's bounceKey (agg.go), kept as its own
// type so the two waves' seen-sets read honestly. The state is
// Parse-local: extract.parse owns the map beside the handler that feeds
// it (per-parse state lives with its only writer, exactly like every
// other SOS-wave state); the name vocabularies are disjoint, so the maps
// could not cross-collide even if shared (pinned by test).
type fireCueKey struct {
	entity int
	tick   int
	name   string
}

// fireCueInfo is one fire-cue SOS message (see models.EventExtinguish —
// packed_params carries the cue's world position through the same 7-byte
// header as wave A).
type fireCueInfo struct {
	tick    int
	entity  int
	name    string
	kind    string
	weapon  string
	hasPos  bool
	x, y, z float64
}

// fireCue stores ONE cue row per (source entity, tick, name) — Wave A's
// rule byte-for-byte (TestGrenadeBouncedDedupeAndSkip's semantics):
//
//   - the FIRST message claims the key; a duplicate dedupes away;
//   - a first message whose origin does not parse claims the key and
//     stores NOTHING — its twin then dedupes rather than a guessed
//     position (missing required input ⇒ no row);
//   - a zero vector is the posPtrs "no position known" convention ⇒ skip.
//
// The origin comes from packed_params through the same 7-byte header as
// wave A (pool observation: hasOrigin=true on EVERY cue — 66/66
// extinguish + 9/9 StartFailed messages carry one). Round rides the same
// addEvent → evRound path as every events row and is renumbered with them
// in build.renumber — no round-count gating here (knife/warmup discard is
// queued separately). detail_json carries the source entity + the exact
// soundevent name — wave A's provenance keys, so the row always says
// which cue it was.
func (a *agg) fireCue(c fireCueInfo, seen map[fireCueKey]bool) {
	key := fireCueKey{entity: c.entity, tick: c.tick, name: c.name}
	if seen[key] {
		return
	}
	seen[key] = true
	if !c.hasPos {
		return
	}
	px, py, pz := pos3(c.x, c.y, c.z)
	if px == nil {
		return
	}
	a.addEvent(models.Event{
		Tick:   c.tick,
		Kind:   c.kind,
		Weapon: c.weapon,
		PosX:   px,
		PosY:   py,
		PosZ:   pz,
		DetailJSON: detailJSON(map[string]any{
			"entity":     c.entity,
			"soundevent": c.name,
		}),
	}, "")
}
