package mappack

import (
	"encoding/binary"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/pierrec/lz4/v4"
)

// Weapon/utility audio extraction: the firing and detonation sounds in
// pak01_dir.vpk (sounds/weapons/…​.vsnd_c) → playable .wav/.mp3 files in
// the app data dir (data.SoundsDir()). One entry per logical item — the
// canonical demoinfocs equipment names iconTable keys on ("AK-47",
// "HE Grenade", …), plus THROW groups keyed `<name> throw` ("HE Grenade
// throw" — the replay's throw cues, sfx.js throwCues) — and EVERY sound
// variant of that item is extracted: the replay picks one at random per
// play so repeated shots don't loop the exact same sample. Valve IP never
// ships — extraction runs locally on demand (frontend/public/maps/README.md
// acquisition posture).
//
// Format facts: CS2.md "Sound assets (.vsnd_c)" (v4 fixed DATA header,
// v5 CTRL/binary-KV3, PCM → the standard 44-byte RIFF header Valve
// strips, MP3 → raw stream). This file holds the ONE .vsnd_c decoder
// (decodeVSnd) — never write a second one; the sound-event layer
// (CS2.md "Sound-event names ↔ demo soundevent_hash") is deliberately NOT
// consulted: orphan/shared soundevent names make heuristics wrong, so the
// canonical-name → VPK-paths mapping is this static table (pinned by
// TestSoundTableKeysInIconTable, like icons.go's iconTable).

const (
	soundSuffix = ".vsnd_c"
	// Output extensions the /api/sounds route whitelists (see
	// ValidSoundFileBase): PCM becomes a .wav, an MP3 stream is written
	// as-is with a .mp3. ADPCM has no extension — decodeVSnd errors
	// instead of writing it.
	soundExtWAV = ".wav"
	soundExtMP3 = ".mp3"
)

// soundTable is the ONE canonical-name → VPK-path table for audio (keys
// are exact EquipmentType.String() outputs — the same vocabulary as
// iconTable, which is why every key here exists there too — or one of
// those names + " throw" for a utility's throw group; the ONE other key
// class is an internal sound group, listed in internalSoundGroups below;
// values are the .vsnd_c paths relative to the VPK root). Near-layer
// fire/detonation files only (no *_detonation*_distant / *_distant
// variants — the far layer would sound wrong on the close camera), all
// PCM16 44100 unless noted. ak47_03 and glock_01 are deliberately
// skipped: they are orphans (no soundevent references them) and probe
// duplicates of the kept set.
//
// "Decoy Grenade" has NO detonation entry on purpose: the game gives a
// exploding decoy no soundevent of its own — its explosion plays
// BaseGrenade.Explode, i.e. the HE files already in soundTable["HE
// Grenade"] (sfx.js remaps the decoy detonation cue to "HE Grenade"; the
// tick/bounce noise is simulated by the replay's decoy plan, spec
// 2026-11-07). The decoy's THROW group below is a different thing and
// DOES ship (Decoy.Throw → decoy_throw_06).
var soundTable = map[string][]string{
	// Rifles
	"AK-47": {
		"sounds/weapons/ak47/ak47_01.vsnd_c", // v5 (binary KV3) in this build
		"sounds/weapons/ak47/ak47_02.vsnd_c",
		"sounds/weapons/ak47/ak47_04.vsnd_c",
	},
	"M4A4": {
		"sounds/weapons/m4a1/m4a1_01.vsnd_c",
		"sounds/weapons/m4a1/m4a1_02.vsnd_c",
		"sounds/weapons/m4a1/m4a1_03.vsnd_c",
		"sounds/weapons/m4a1/m4a1_04.vsnd_c",
	},
	"M4A1": {"sounds/weapons/m4a1/m4a1_silencer_01.vsnd_c"}, // the M4A1-S, single variant
	"AWP": {
		"sounds/weapons/awp/awp_01.vsnd_c",
		"sounds/weapons/awp/awp_02.vsnd_c",
	},
	"Galil AR": {"sounds/weapons/galilar/galil_01.vsnd_c"},
	"FAMAS": {
		"sounds/weapons/famas/famas_01.vsnd_c",
		"sounds/weapons/famas/famas_02.vsnd_c",
		"sounds/weapons/famas/famas_03.vsnd_c",
	},
	"SG 553": { // demoinfocs spells it "SG 553", the VPK keeps the sg556 dir
		"sounds/weapons/sg556/sg556_01.vsnd_c",
		"sounds/weapons/sg556/sg556_02.vsnd_c",
		"sounds/weapons/sg556/sg556_03.vsnd_c",
		"sounds/weapons/sg556/sg556_04.vsnd_c",
	},
	"AUG": {
		"sounds/weapons/aug/aug_01.vsnd_c",
		"sounds/weapons/aug/aug_02.vsnd_c",
		"sounds/weapons/aug/aug_03.vsnd_c",
		"sounds/weapons/aug/aug_04.vsnd_c",
	},
	"SSG 08": {"sounds/weapons/ssg08/ssg08_01.vsnd_c"},
	"SCAR-20": {
		"sounds/weapons/scar20/scar20_01.vsnd_c",
		"sounds/weapons/scar20/scar20_02.vsnd_c",
		"sounds/weapons/scar20/scar20_03.vsnd_c",
	},
	"G3SG1": {
		"sounds/weapons/g3sg1/g3sg1_01.vsnd_c",
		"sounds/weapons/g3sg1/g3sg1_02.vsnd_c",
		"sounds/weapons/g3sg1/g3sg1_03.vsnd_c",
	},
	// SMGs
	"MAC-10": {
		"sounds/weapons/mac10/mac10_01.vsnd_c",
		"sounds/weapons/mac10/mac10_02.vsnd_c",
	},
	"MP9": {
		"sounds/weapons/mp9/mp9_01.vsnd_c",
		"sounds/weapons/mp9/mp9_02.vsnd_c",
		"sounds/weapons/mp9/mp9_03.vsnd_c",
		"sounds/weapons/mp9/mp9_04.vsnd_c",
	},
	"MP5-SD": {"sounds/weapons/mp5/mp5_01.vsnd_c"},
	"UMP-45": {"sounds/weapons/ump45/ump45_02.vsnd_c"}, // no ump45_01 exists
	"P90": {
		"sounds/weapons/p90/p90_01.vsnd_c",
		"sounds/weapons/p90/p90_02.vsnd_c",
	},
	"PP-Bizon": {
		"sounds/weapons/bizon/bizon_01.vsnd_c",
		"sounds/weapons/bizon/bizon_02.vsnd_c",
	},
	// Heavy
	"Nova":   {"sounds/weapons/nova/nova-1.vsnd_c"},
	"XM1014": {"sounds/weapons/xm1014/xm1014-1.vsnd_c"},
	"MAG-7": {
		"sounds/weapons/mag7/mag7_01.vsnd_c",
		"sounds/weapons/mag7/mag7_02.vsnd_c",
	},
	"Negev": {
		"sounds/weapons/negev/negev_01.vsnd_c",
		"sounds/weapons/negev/negev_02.vsnd_c",
	},
	"M249": {
		"sounds/weapons/m249/m249_01.vsnd_c",
		"sounds/weapons/m249/m249_02.vsnd_c",
		"sounds/weapons/m249/m249_03.vsnd_c",
	},
	// Pistols
	"Glock-18": {"sounds/weapons/glock18/glock_02.vsnd_c"}, // glock_01 is an orphan
	"USP-S": { // the suppressed shot
		"sounds/weapons/usp/usp_01.vsnd_c",
		"sounds/weapons/usp/usp_02.vsnd_c",
		"sounds/weapons/usp/usp_03.vsnd_c",
	},
	"P2000": {
		"sounds/weapons/hkp2000/hkp2000_01.vsnd_c",
		"sounds/weapons/hkp2000/hkp2000_02.vsnd_c",
		"sounds/weapons/hkp2000/hkp2000_03.vsnd_c",
	},
	"P250":       {"sounds/weapons/p250/p250_01.vsnd_c"},
	"Five-SeveN": {"sounds/weapons/fiveseven/fiveseven_01.vsnd_c"},
	"Tec-9":      {"sounds/weapons/tec9/tec9_02.vsnd_c"}, // no tec9_01 exists
	"CZ75 Auto": {
		"sounds/weapons/cz75a/cz75_01.vsnd_c",
		"sounds/weapons/cz75a/cz75_02.vsnd_c",
		"sounds/weapons/cz75a/cz75_03.vsnd_c",
	},
	"Desert Eagle": {
		"sounds/weapons/deagle/deagle_01.vsnd_c",
		"sounds/weapons/deagle/deagle_02.vsnd_c",
	},
	"R8 Revolver": {"sounds/weapons/revolver/revolver-1_01.vsnd_c"},
	"Dual Berettas": {
		"sounds/weapons/elite/elites_01.vsnd_c",
		"sounds/weapons/elite/elites_02.vsnd_c",
		"sounds/weapons/elite/elites_03.vsnd_c",
		"sounds/weapons/elite/elites_04.vsnd_c",
	},
	"Sawed-Off": {"sounds/weapons/sawedoff/sawedoff-1.vsnd_c"},
	// Equipment
	// The knife cue arrives ONLY from DAMAGE rows (sfx.js knifeCues — a
	// swing makes no sound at all), and the demo only ever networks the
	// HIT: these are the game's Weapon_Knife.Hit.*.Flesh soundevents —
	// what every client hears when the blade lands (verified against the
	// local install's event→file map, 2026-11-07; slash/Stab/HitWall are
	// CLIENT-LOCAL foley the demo never carries, so they would play only
	// for the local player and are deliberately absent). All 20 are
	// resource-v5 MP3 44,100 stereo — the manifest's FIRST MP3s: the
	// browser decodes them natively, and preload fails soft per file if
	// a decoder ever rejects one (the group then plays fewer variants).
	"Knife": {
		// Weapon_Knife.Hit.Flesh / .Hit.Light.Flesh (light slash hits —
		// note the game ships no _05)
		"sounds/weapons/knife/knife_hit_light_flesh_01.vsnd_c",
		"sounds/weapons/knife/knife_hit_light_flesh_02.vsnd_c",
		"sounds/weapons/knife/knife_hit_light_flesh_03.vsnd_c",
		"sounds/weapons/knife/knife_hit_light_flesh_04.vsnd_c",
		"sounds/weapons/knife/knife_hit_light_flesh_06.vsnd_c",
		"sounds/weapons/knife/knife_hit_light_flesh_07.vsnd_c",
		"sounds/weapons/knife/knife_hit_light_flesh_08.vsnd_c",
		"sounds/weapons/knife/knife_hit_light_flesh_09.vsnd_c",
		"sounds/weapons/knife/knife_hit_light_flesh_10.vsnd_c",
		// Weapon_Knife.Hit.Heavy.Flesh (heavy slash hits)
		"sounds/weapons/knife/heavy_hit_flesh_01.vsnd_c",
		"sounds/weapons/knife/heavy_hit_flesh_04.vsnd_c",
		"sounds/weapons/knife/heavy_hit_flesh_08.vsnd_c",
		"sounds/weapons/knife/heavy_hit_flesh_09.vsnd_c",
		"sounds/weapons/knife/heavy_hit_flesh_10.vsnd_c",
		// Weapon_Knife.Hit.Light.Backstab.Flesh (backstabs)
		"sounds/weapons/knife/knife_hit_light_backstab_flesh_01.vsnd_c",
		"sounds/weapons/knife/knife_hit_light_backstab_flesh_02.vsnd_c",
		"sounds/weapons/knife/knife_hit_light_backstab_flesh_03.vsnd_c",
		"sounds/weapons/knife/knife_hit_light_backstab_flesh_04.vsnd_c",
		"sounds/weapons/knife/knife_hit_light_backstab_flesh_05.vsnd_c",
		"sounds/weapons/knife/knife_hit_light_backstab_flesh_06.vsnd_c",
	},
	"Zeus x27": {"sounds/weapons/taser/taser_shoot.vsnd_c"},
	"C4":       {"sounds/weapons/c4/c4_explode1.vsnd_c"}, // played on bomb_explode
	// The planted C4's BEEP groups — two SINGLE-file groups keyed by
	// site, deliberately NOT variants of one group: sfx.js's beep
	// scheduler picks the key deterministically (site from the
	// bomb_plant row — c4BeepGroup) and pickVariant would randomly
	// substitute one sample for another if they shared a key (beep ≠
	// explosion, A ≠ B). The pair is the game's own events in this
	// build: C4.PlantSound → c4_beep2 / C4.PlantSoundB → c4_beep3
	// (soundevents/game_sounds_weapons.vsndevts_c — event name
	// immediately followed by its .vsnd path, the adjacency the whole
	// file uses); CS2 gives the B-site plant the lower-pitched, LONGER
	// beep (179 ms vs 151 ms here). The game's distinct samples for the
	// final ten seconds of the fuse (a 2023-10-17 update) are
	// deliberately NOT extracted: Valve pairs them with a different
	// cadence we do not replicate, so for us they are dead assets — the
	// WHOLE fuse beeps at this one pair of tones on the established
	// cadence (sfx.js c4BeepRate / c4BeepTicks).
	"C4 beep A": {"sounds/weapons/c4/c4_beep2.vsnd_c"},
	"C4 beep B": {"sounds/weapons/c4/c4_beep3.vsnd_c"},
	// The plant/defuse CUE groups — ONE file per cue, because these are
	// four DISTINCT moments, not variants of one (the manifest's
	// pickVariant picks randomly WITHIN a group — a shared key would let
	// the arm sound stand in for the completion). Each path is the file
	// its own soundevent names in soundevents/game_sounds_weapons.vsndevts_c
	// (the event-name → .vsnd adjacency the beep groups above were
	// verified with): `c4.initiate` → c4_initiate (arming starts, 1.91 s),
	// `c4.plant` → c4_plant (plant finished, 0.55 s mono),
	// `c4.disarmstart` → c4_disarmstart (1.25 s), `c4.disarmfinish` →
	// c4_disarmfinish (1.50 s). Deliberately NOT extracted:
	// `c4.plantquiet` (a second plant event we cannot place in the
	// lifecycle), `c4.keypressquiet` → key_press1..7 (an unplaceable
	// multi-file event) and c4_click.vsnd_c — referenced by NO soundevent
	// in the install, i.e. an orphan under the ak47_03/glock_01 rule.
	// sfx.js bombActionCues builds exactly these four keys.
	"C4 plant start":     {"sounds/weapons/c4/c4_initiate.vsnd_c"},
	"C4 plant complete":  {"sounds/weapons/c4/c4_plant.vsnd_c"},
	"C4 defuse start":    {"sounds/weapons/c4/c4_disarmstart.vsnd_c"},
	"C4 defuse complete": {"sounds/weapons/c4/c4_disarmfinish.vsnd_c"},
	// The ANNOUNCER lines (owner-provided mapping 2026-11-09, NOT
	// verified against primary sources): one .vsnd_c per line under the
	// game's classic-announcer VO tree, one single-file group each —
	// these are distinct moments, not variants, so they never share a
	// key. sfx.js roundEndCues/bombAnnouncerCues address them by their
	// literal manifest keys: a counted round win → ctwin/terwin
	// (reason-independent), a draw → rounddraw, a bomb plant → bombpl,
	// a defuse → bombdef (played FIRST, then ctwin AFTER the defuse
	// line's own duration + sfx.js ANNOUNCER_SEQUENCE_GAP_S — the
	// owner-observed sequencing; ANNOUNCER_ORDER_DELAY_S is the fallback
	// when the buffer is not decoded). Extracted on demand
	// from the user's own install like every other entry (Valve IP never
	// ships).
	"ctwin":     {"sounds/vo/announcer/cs2_classic/ctwin.vsnd_c"},
	"terwin":    {"sounds/vo/announcer/cs2_classic/terwin.vsnd_c"},
	"rounddraw": {"sounds/vo/announcer/cs2_classic/rounddraw.vsnd_c"},
	"bombpl":    {"sounds/vo/announcer/cs2_classic/bombpl.vsnd_c"},
	"bombdef":   {"sounds/vo/announcer/cs2_classic/bombdef.vsnd_c"},
	// The match-POINT stinger (sfx.js matchPointCues — "matchpoint" at
	// a match-point round's freeze start). cs2find-discovered and
	// existence-verified against the local pak01_dir.vpk (2026-11-09),
	// NOT owner-provided: NO match-point line exists under
	// sounds/vo/announcer/cs2_classic/ (the whole announcer tree carries
	// only the five shipped lines + hostage/rescue, radio-cutoff,
	// legacy-hype and map-veto lines),
	// and the game's own match-point soundevent is
	// Music.Match.MatchPoint → sounds/music/cs_stinger.vsnd (a 4.1 s
	// PCM16 44.1 kHz stereo music stinger — also the file behind
	// Music.Match.FinalRound; the Announcer.* event family has no
	// match-point entry at all). The key stays the cue's literal name;
	// the path is the event's file. One file, so it is single-sample
	// like the other distinct-moment cues.
	"matchpoint": {"sounds/music/cs_stinger.vsnd_c"},
	// Grenades (detonation sounds — the replay's utility cues)
	"HE Grenade": {
		"sounds/weapons/hegrenade/hegrenade_detonate_02.vsnd_c",
		"sounds/weapons/hegrenade/hegrenade_detonate_03.vsnd_c",
	},
	"Flashbang": {
		"sounds/weapons/flashbang/flashbang_explode1.vsnd_c",
		"sounds/weapons/flashbang/flashbang_explode2.vsnd_c",
	},
	// The near smoke bloom IS the game's smoke-detonation sound (14 s).
	"Smoke Grenade": {"sounds/weapons/smokegrenade/smoke_emit.vsnd_c"},
	"Molotov":       {"sounds/weapons/molotov/molotov_detonate_1.vsnd_c"}, // near _2/_3 are event-less
	"Incendiary Grenade": {
		"sounds/weapons/incgrenade/inc_grenade_detonate_1.vsnd_c",
		"sounds/weapons/incgrenade/inc_grenade_detonate_2.vsnd_c",
		"sounds/weapons/incgrenade/inc_grenade_detonate_3.vsnd_c",
	},
	// Utility THROW sounds (Feature A): the replay's throw cues
	// (sfx.js throwCues) key these off the grenade_throw rows as
	// `<weapon> throw`, so the keys are the canonical weapon name + the
	// " throw" suffix — flat entries in this ONE table (one extraction
	// loop, one reverse index, one manifest, unchanged playGroup). The
	// paths are each grenade's throw SOUND EVENT's file (the canonical
	// event→file technique — CS2.md "Sound-event names ↔ demo
	// soundevent_hash"); the per-dir grenade_throw.vsnd_c copies are
	// byte-identical orphans referenced by nothing and are deliberately
	// NOT used. All resource-v5 MP3 44,100 mono (decodeVSnd handles
	// v5 + MP3); lengths: HE 0.268 s, flash 0.459 s, smoke 0.397 s,
	// decoy 0.418 s, molotov/incendiary ~0.4 s each.
	"HE Grenade throw": {
		"sounds/items/weapon_hegrenade_throw.vsnd_c", // the HE throw lives under sounds/items/
	},
	"Flashbang throw":     {"sounds/weapons/flashbang/flashbang_throw_03.vsnd_c"},
	"Smoke Grenade throw": {"sounds/weapons/smokegrenade/smoke_grenade_throw_04.vsnd_c"},
	"Molotov throw": {
		"sounds/weapons/molotov/molotov_throw_01.vsnd_c",
		"sounds/weapons/molotov/molotov_throw_02.vsnd_c",
		"sounds/weapons/molotov/molotov_throw_03.vsnd_c",
		"sounds/weapons/molotov/molotov_throw_04.vsnd_c",
		"sounds/weapons/molotov/molotov_throw_05.vsnd_c",
		"sounds/weapons/molotov/molotov_throw_06.vsnd_c",
	},
	"Incendiary Grenade throw": {
		"sounds/weapons/incgrenade/inc_grenade_throw_fire_01.vsnd_c",
		"sounds/weapons/incgrenade/inc_grenade_throw_fire_02.vsnd_c",
		"sounds/weapons/incgrenade/inc_grenade_throw_fire_03.vsnd_c",
	},
	"Decoy Grenade throw": {"sounds/weapons/decoy/decoy_throw_06.vsnd_c"},
	// "Decoy Grenade" (detonation) omitted: the exploding decoy plays
	// BaseGrenade.Explode — the HE files above — so its cue is remapped
	// to "HE Grenade" at cue build (sfx.js grenadeCues); there is no
	// decoy-specific detonation file to extract (CS2.md "Sound assets").

	// ---- Grenade BOUNCE sounds (the replay's bounce cues) -------------
	// Each group is the bounce SOUND EVENT's own .vsnd set — the canonical
	// event→file technique (cs2find events bounce, verified against the
	// local install 2026-11-09): HEGrenade/Flashbang/SmokeGrenade/
	// Molotov/IncGrenade.Bounce, exactly the five names extract's SOS
	// handler stores as models.EventGrenadeBounce rows (there is no decoy
	// bounce, so no Decoy group). One file per event where the game has
	// one (HE/flash/smoke), variants where it has several (molotov 3,
	// incendiary 4) so repeated bounces do not loop the same sample —
	// the throw-group convention above.
	"HE Grenade bounce":    {"sounds/weapons/hegrenade/he_bounce-1.vsnd_c"},
	"Flashbang bounce":     {"sounds/weapons/flashbang/grenade_hit1.vsnd_c"},
	"Smoke Grenade bounce": {"sounds/weapons/smokegrenade/grenade_hit1.vsnd_c"},
	"Molotov bounce": {
		"sounds/physics/glass/glass_bottle_impact_hard1.vsnd_c",
		"sounds/physics/glass/glass_bottle_impact_hard2.vsnd_c",
		"sounds/physics/glass/glass_bottle_impact_hard3.vsnd_c",
	},
	"Incendiary Grenade bounce": {
		"sounds/physics/weapons/weapon_incendiary_impact_01.vsnd_c",
		"sounds/physics/weapons/weapon_incendiary_impact_02.vsnd_c",
		"sounds/physics/weapons/weapon_incendiary_impact_03.vsnd_c",
		"sounds/physics/weapons/weapon_incendiary_impact_04.vsnd_c",
	},
	// ---- Fire-cue sounds (the replay's smoke⇄fire / air-burst cues) ----
	// The asset side of Wave C (extract/sos.go fireCueDefs — the four
	// fire-family soundevents; name→file from `cs2find events`, existence
	// re-checked against the VPK 2026-11-12). The extinguish and fade
	// groups are NADE-NEUTRAL (one sound for both Molotov and Incendiary
	// fires — the install has no Incendiary extinguish/fade variant), so
	// their keys carry no weapon and sfx.js fireCues addresses them by
	// kind alone; the air-burst group is per-nade — sfx.js addresses it
	// through the row's weapon column, which the soundevent NAME spells
	// (Molotov.* / IncGrenade.* — never guessed). All four keys are
	// internal groups (registered in internalSoundGroups below — the
	// whole widening). DROPPED 2026-11-12 (owner ruling after by-ear
	// verification): the container-break groups "Molotov smash" (4
	// variants) and "Incendiary Grenade pop" — 0× in the pool, never
	// heard in game, and the detonate sounds already carry the character.
	"Fire extinguish":                 {"sounds/weapons/molotov/molotov_extinguish.vsnd_c"},
	"Molotov start failed":            {"sounds/weapons/molotov/molotov_detonate_air_01.vsnd_c"},
	"Incendiary Grenade start failed": {"sounds/weapons/incgrenade/inc_grenade_detonate_air_01.vsnd_c"},
	"Fire fade out":                   {"sounds/weapons/molotov/fire_loop_fadeout_01.vsnd_c"},
	// ---- Player sounds (footsteps / landings / jumps / fall damage) ----
	// The asset side of the sound_events table (extract.sos.go): one
	// `step <material>` group per FILE FAMILY under sounds/player/footsteps
	// (the shipped vsndevts walker resolves 0 files for `*.StepLeft` names,
	// so the per-material file lists below are the static result of a
	// READ-ONLY `cs2find find --prefix sounds/player/footsteps` probe of
	// the local install, 2026-11-09 — 409 files, indices kept exactly as
	// shipped, no contiguous-range assumption). Group keys are the family
	// prefixes verbatim (concrete_ct is the install's only concrete step
	// set). CT_Silent/T_Silent have no group on purpose: the silent
	// materials play nothing (their sound_events rows still store the
	// material as data).
	"step bass": {
		"sounds/player/footsteps/bass_01.vsnd_c",
		"sounds/player/footsteps/bass_02.vsnd_c",
		"sounds/player/footsteps/bass_03.vsnd_c",
		"sounds/player/footsteps/bass_04.vsnd_c",
		"sounds/player/footsteps/bass_05.vsnd_c",
		"sounds/player/footsteps/bass_06.vsnd_c",
		"sounds/player/footsteps/bass_07.vsnd_c",
		"sounds/player/footsteps/bass_08.vsnd_c",
		"sounds/player/footsteps/bass_09.vsnd_c",
		"sounds/player/footsteps/bass_10.vsnd_c",
	},
	"step carpet": {
		"sounds/player/footsteps/carpet_01.vsnd_c",
		"sounds/player/footsteps/carpet_03.vsnd_c",
		"sounds/player/footsteps/carpet_04.vsnd_c",
		"sounds/player/footsteps/carpet_05.vsnd_c",
		"sounds/player/footsteps/carpet_08.vsnd_c",
		"sounds/player/footsteps/carpet_09.vsnd_c",
		"sounds/player/footsteps/carpet_11.vsnd_c",
		"sounds/player/footsteps/carpet_14.vsnd_c",
		"sounds/player/footsteps/carpet_15.vsnd_c",
		"sounds/player/footsteps/carpet_16.vsnd_c",
		"sounds/player/footsteps/carpet_17.vsnd_c",
		"sounds/player/footsteps/carpet_18.vsnd_c",
		"sounds/player/footsteps/carpet_19.vsnd_c",
		"sounds/player/footsteps/carpet_20.vsnd_c",
	},
	"step concrete_ct": {
		"sounds/player/footsteps/concrete_ct_01.vsnd_c",
		"sounds/player/footsteps/concrete_ct_02.vsnd_c",
		"sounds/player/footsteps/concrete_ct_03.vsnd_c",
		"sounds/player/footsteps/concrete_ct_04.vsnd_c",
		"sounds/player/footsteps/concrete_ct_05.vsnd_c",
		"sounds/player/footsteps/concrete_ct_06.vsnd_c",
		"sounds/player/footsteps/concrete_ct_07.vsnd_c",
		"sounds/player/footsteps/concrete_ct_08.vsnd_c",
		"sounds/player/footsteps/concrete_ct_09.vsnd_c",
		"sounds/player/footsteps/concrete_ct_10.vsnd_c",
		"sounds/player/footsteps/concrete_ct_11.vsnd_c",
		"sounds/player/footsteps/concrete_ct_12.vsnd_c",
		"sounds/player/footsteps/concrete_ct_13.vsnd_c",
		"sounds/player/footsteps/concrete_ct_14.vsnd_c",
		"sounds/player/footsteps/concrete_ct_15.vsnd_c",
		"sounds/player/footsteps/concrete_ct_16.vsnd_c",
		"sounds/player/footsteps/concrete_ct_17.vsnd_c",
	},
	"step dirt": {
		"sounds/player/footsteps/dirt_01.vsnd_c",
		"sounds/player/footsteps/dirt_02.vsnd_c",
		"sounds/player/footsteps/dirt_03.vsnd_c",
		"sounds/player/footsteps/dirt_04.vsnd_c",
		"sounds/player/footsteps/dirt_05.vsnd_c",
		"sounds/player/footsteps/dirt_06.vsnd_c",
		"sounds/player/footsteps/dirt_07.vsnd_c",
		"sounds/player/footsteps/dirt_08.vsnd_c",
		"sounds/player/footsteps/dirt_09.vsnd_c",
		"sounds/player/footsteps/dirt_10.vsnd_c",
		"sounds/player/footsteps/dirt_11.vsnd_c",
		"sounds/player/footsteps/dirt_12.vsnd_c",
		"sounds/player/footsteps/dirt_13.vsnd_c",
		"sounds/player/footsteps/dirt_14.vsnd_c",
	},
	"step glass": {
		"sounds/player/footsteps/glass_01.vsnd_c",
		"sounds/player/footsteps/glass_07.vsnd_c",
		"sounds/player/footsteps/glass_08.vsnd_c",
		"sounds/player/footsteps/glass_09.vsnd_c",
		"sounds/player/footsteps/glass_10.vsnd_c",
		"sounds/player/footsteps/glass_11.vsnd_c",
		"sounds/player/footsteps/glass_12.vsnd_c",
		"sounds/player/footsteps/glass_13.vsnd_c",
	},
	"step grass": {
		"sounds/player/footsteps/grass_01.vsnd_c",
		"sounds/player/footsteps/grass_02.vsnd_c",
		"sounds/player/footsteps/grass_03.vsnd_c",
		"sounds/player/footsteps/grass_04.vsnd_c",
		"sounds/player/footsteps/grass_05.vsnd_c",
		"sounds/player/footsteps/grass_06.vsnd_c",
		"sounds/player/footsteps/grass_07.vsnd_c",
		"sounds/player/footsteps/grass_08.vsnd_c",
		"sounds/player/footsteps/grass_09.vsnd_c",
		"sounds/player/footsteps/grass_10.vsnd_c",
		"sounds/player/footsteps/grass_11.vsnd_c",
		"sounds/player/footsteps/grass_12.vsnd_c",
		"sounds/player/footsteps/grass_13.vsnd_c",
	},
	"step gravel": {
		"sounds/player/footsteps/gravel_01.vsnd_c",
		"sounds/player/footsteps/gravel_02.vsnd_c",
		"sounds/player/footsteps/gravel_03.vsnd_c",
		"sounds/player/footsteps/gravel_04.vsnd_c",
		"sounds/player/footsteps/gravel_05.vsnd_c",
		"sounds/player/footsteps/gravel_06.vsnd_c",
		"sounds/player/footsteps/gravel_07.vsnd_c",
		"sounds/player/footsteps/gravel_08.vsnd_c",
		"sounds/player/footsteps/gravel_09.vsnd_c",
		"sounds/player/footsteps/gravel_10.vsnd_c",
	},
	"step ladder": {
		"sounds/player/footsteps/ladder_01.vsnd_c",
		"sounds/player/footsteps/ladder_02.vsnd_c",
		"sounds/player/footsteps/ladder_03.vsnd_c",
		"sounds/player/footsteps/ladder_04.vsnd_c",
		"sounds/player/footsteps/ladder_05.vsnd_c",
		"sounds/player/footsteps/ladder_06.vsnd_c",
		"sounds/player/footsteps/ladder_08.vsnd_c",
		"sounds/player/footsteps/ladder_09.vsnd_c",
		"sounds/player/footsteps/ladder_10.vsnd_c",
		"sounds/player/footsteps/ladder_11.vsnd_c",
		"sounds/player/footsteps/ladder_12.vsnd_c",
	},
	"step ladder_wood": {
		"sounds/player/footsteps/ladder_wood_01.vsnd_c",
		"sounds/player/footsteps/ladder_wood_02.vsnd_c",
		"sounds/player/footsteps/ladder_wood_03.vsnd_c",
		"sounds/player/footsteps/ladder_wood_04.vsnd_c",
		"sounds/player/footsteps/ladder_wood_05.vsnd_c",
		"sounds/player/footsteps/ladder_wood_06.vsnd_c",
		"sounds/player/footsteps/ladder_wood_07.vsnd_c",
		"sounds/player/footsteps/ladder_wood_08.vsnd_c",
		"sounds/player/footsteps/ladder_wood_09.vsnd_c",
		"sounds/player/footsteps/ladder_wood_10.vsnd_c",
		"sounds/player/footsteps/ladder_wood_11.vsnd_c",
		"sounds/player/footsteps/ladder_wood_12.vsnd_c",
		"sounds/player/footsteps/ladder_wood_13.vsnd_c",
		"sounds/player/footsteps/ladder_wood_14.vsnd_c",
	},
	"step metal_auto": {
		"sounds/player/footsteps/metal_auto_01.vsnd_c",
		"sounds/player/footsteps/metal_auto_02.vsnd_c",
		"sounds/player/footsteps/metal_auto_03.vsnd_c",
		"sounds/player/footsteps/metal_auto_04.vsnd_c",
		"sounds/player/footsteps/metal_auto_05.vsnd_c",
		"sounds/player/footsteps/metal_auto_06.vsnd_c",
	},
	"step metal_chainlink": {
		"sounds/player/footsteps/metal_chainlink_01.vsnd_c",
		"sounds/player/footsteps/metal_chainlink_02.vsnd_c",
		"sounds/player/footsteps/metal_chainlink_03.vsnd_c",
		"sounds/player/footsteps/metal_chainlink_04.vsnd_c",
		"sounds/player/footsteps/metal_chainlink_05.vsnd_c",
		"sounds/player/footsteps/metal_chainlink_06.vsnd_c",
		"sounds/player/footsteps/metal_chainlink_07.vsnd_c",
		"sounds/player/footsteps/metal_chainlink_09.vsnd_c",
	},
	"step metal_grate": {
		"sounds/player/footsteps/metal_grate_01.vsnd_c",
		"sounds/player/footsteps/metal_grate_02.vsnd_c",
		"sounds/player/footsteps/metal_grate_03.vsnd_c",
		"sounds/player/footsteps/metal_grate_04.vsnd_c",
		"sounds/player/footsteps/metal_grate_05.vsnd_c",
		"sounds/player/footsteps/metal_grate_06.vsnd_c",
		"sounds/player/footsteps/metal_grate_07.vsnd_c",
		"sounds/player/footsteps/metal_grate_08.vsnd_c",
		"sounds/player/footsteps/metal_grate_09.vsnd_c",
		"sounds/player/footsteps/metal_grate_10.vsnd_c",
		"sounds/player/footsteps/metal_grate_11.vsnd_c",
		"sounds/player/footsteps/metal_grate_12.vsnd_c",
		"sounds/player/footsteps/metal_grate_13.vsnd_c",
		"sounds/player/footsteps/metal_grate_14.vsnd_c",
		"sounds/player/footsteps/metal_grate_15.vsnd_c",
	},
	"step metal_railing_a": {
		"sounds/player/footsteps/metal_railing_a_01.vsnd_c",
		"sounds/player/footsteps/metal_railing_a_02.vsnd_c",
		"sounds/player/footsteps/metal_railing_a_03.vsnd_c",
		"sounds/player/footsteps/metal_railing_a_04.vsnd_c",
		"sounds/player/footsteps/metal_railing_a_05.vsnd_c",
		"sounds/player/footsteps/metal_railing_a_06.vsnd_c",
		"sounds/player/footsteps/metal_railing_a_07.vsnd_c",
		"sounds/player/footsteps/metal_railing_a_08.vsnd_c",
		"sounds/player/footsteps/metal_railing_a_09.vsnd_c",
	},
	"step metal_solid": {
		"sounds/player/footsteps/metal_solid_35.vsnd_c",
		"sounds/player/footsteps/metal_solid_36.vsnd_c",
		"sounds/player/footsteps/metal_solid_37.vsnd_c",
		"sounds/player/footsteps/metal_solid_38.vsnd_c",
		"sounds/player/footsteps/metal_solid_39.vsnd_c",
		"sounds/player/footsteps/metal_solid_40.vsnd_c",
		"sounds/player/footsteps/metal_solid_41.vsnd_c",
		"sounds/player/footsteps/metal_solid_42.vsnd_c",
		"sounds/player/footsteps/metal_solid_43.vsnd_c",
		"sounds/player/footsteps/metal_solid_44.vsnd_c",
		"sounds/player/footsteps/metal_solid_45.vsnd_c",
		"sounds/player/footsteps/metal_solid_46.vsnd_c",
		"sounds/player/footsteps/metal_solid_47.vsnd_c",
		"sounds/player/footsteps/metal_solid_48.vsnd_c",
		"sounds/player/footsteps/metal_solid_49.vsnd_c",
		"sounds/player/footsteps/metal_solid_50.vsnd_c",
	},
	"step metal_vent": {
		"sounds/player/footsteps/metal_vent_01.vsnd_c",
		"sounds/player/footsteps/metal_vent_02.vsnd_c",
		"sounds/player/footsteps/metal_vent_03.vsnd_c",
		"sounds/player/footsteps/metal_vent_04.vsnd_c",
		"sounds/player/footsteps/metal_vent_05.vsnd_c",
		"sounds/player/footsteps/metal_vent_06.vsnd_c",
	},
	"step mud": {
		"sounds/player/footsteps/mud_01.vsnd_c",
		"sounds/player/footsteps/mud_02.vsnd_c",
		"sounds/player/footsteps/mud_03.vsnd_c",
		"sounds/player/footsteps/mud_04.vsnd_c",
		"sounds/player/footsteps/mud_05.vsnd_c",
		"sounds/player/footsteps/mud_06.vsnd_c",
		"sounds/player/footsteps/mud_07.vsnd_c",
		"sounds/player/footsteps/mud_08.vsnd_c",
		"sounds/player/footsteps/mud_09.vsnd_c",
	},
	"step plastic_barrel": {
		"sounds/player/footsteps/plastic_barrel_01.vsnd_c",
		"sounds/player/footsteps/plastic_barrel_02.vsnd_c",
		"sounds/player/footsteps/plastic_barrel_03.vsnd_c",
		"sounds/player/footsteps/plastic_barrel_04.vsnd_c",
		"sounds/player/footsteps/plastic_barrel_05.vsnd_c",
	},
	"step puddle": {
		"sounds/player/footsteps/puddle_01.vsnd_c",
		"sounds/player/footsteps/puddle_02.vsnd_c",
		"sounds/player/footsteps/puddle_03.vsnd_c",
		"sounds/player/footsteps/puddle_04.vsnd_c",
		"sounds/player/footsteps/puddle_05.vsnd_c",
		"sounds/player/footsteps/puddle_06.vsnd_c",
		"sounds/player/footsteps/puddle_07.vsnd_c",
		"sounds/player/footsteps/puddle_08.vsnd_c",
		"sounds/player/footsteps/puddle_09.vsnd_c",
	},
	"step puddle_small": {
		"sounds/player/footsteps/puddle_small_01.vsnd_c",
		"sounds/player/footsteps/puddle_small_02.vsnd_c",
		"sounds/player/footsteps/puddle_small_03.vsnd_c",
		"sounds/player/footsteps/puddle_small_04.vsnd_c",
		"sounds/player/footsteps/puddle_small_05.vsnd_c",
		"sounds/player/footsteps/puddle_small_06.vsnd_c",
		"sounds/player/footsteps/puddle_small_07.vsnd_c",
	},
	"step rubber": {
		"sounds/player/footsteps/rubber_03.vsnd_c",
		"sounds/player/footsteps/rubber_04.vsnd_c",
		"sounds/player/footsteps/rubber_05.vsnd_c",
		"sounds/player/footsteps/rubber_06.vsnd_c",
		"sounds/player/footsteps/rubber_07.vsnd_c",
		"sounds/player/footsteps/rubber_08.vsnd_c",
		"sounds/player/footsteps/rubber_11.vsnd_c",
		"sounds/player/footsteps/rubber_12.vsnd_c",
	},
	"step sand": {
		"sounds/player/footsteps/sand_01.vsnd_c",
		"sounds/player/footsteps/sand_02.vsnd_c",
		"sounds/player/footsteps/sand_03.vsnd_c",
		"sounds/player/footsteps/sand_04.vsnd_c",
		"sounds/player/footsteps/sand_05.vsnd_c",
		"sounds/player/footsteps/sand_06.vsnd_c",
		"sounds/player/footsteps/sand_07.vsnd_c",
		"sounds/player/footsteps/sand_08.vsnd_c",
		"sounds/player/footsteps/sand_09.vsnd_c",
		"sounds/player/footsteps/sand_10.vsnd_c",
		"sounds/player/footsteps/sand_11.vsnd_c",
		"sounds/player/footsteps/sand_12.vsnd_c",
	},
	"step snow": {
		"sounds/player/footsteps/snow_01.vsnd_c",
		"sounds/player/footsteps/snow_02.vsnd_c",
		"sounds/player/footsteps/snow_03.vsnd_c",
		"sounds/player/footsteps/snow_04.vsnd_c",
		"sounds/player/footsteps/snow_05.vsnd_c",
		"sounds/player/footsteps/snow_06.vsnd_c",
		"sounds/player/footsteps/snow_07.vsnd_c",
		"sounds/player/footsteps/snow_08.vsnd_c",
		"sounds/player/footsteps/snow_09.vsnd_c",
		"sounds/player/footsteps/snow_10.vsnd_c",
		"sounds/player/footsteps/snow_11.vsnd_c",
	},
	"step tile": {
		"sounds/player/footsteps/tile_01.vsnd_c",
		"sounds/player/footsteps/tile_02.vsnd_c",
		"sounds/player/footsteps/tile_03.vsnd_c",
		"sounds/player/footsteps/tile_04.vsnd_c",
		"sounds/player/footsteps/tile_05.vsnd_c",
		"sounds/player/footsteps/tile_06.vsnd_c",
		"sounds/player/footsteps/tile_07.vsnd_c",
		"sounds/player/footsteps/tile_08.vsnd_c",
		"sounds/player/footsteps/tile_09.vsnd_c",
		"sounds/player/footsteps/tile_10.vsnd_c",
		"sounds/player/footsteps/tile_11.vsnd_c",
		"sounds/player/footsteps/tile_12.vsnd_c",
		"sounds/player/footsteps/tile_13.vsnd_c",
		"sounds/player/footsteps/tile_14.vsnd_c",
	},
	"step water_entry": {
		"sounds/player/footsteps/water_entry_01.vsnd_c",
		"sounds/player/footsteps/water_entry_02.vsnd_c",
		"sounds/player/footsteps/water_entry_03.vsnd_c",
		"sounds/player/footsteps/water_entry_04.vsnd_c",
		"sounds/player/footsteps/water_entry_06.vsnd_c",
	},
	"step water_exit": {
		"sounds/player/footsteps/water_exit_01.vsnd_c",
		"sounds/player/footsteps/water_exit_02.vsnd_c",
		"sounds/player/footsteps/water_exit_03.vsnd_c",
		"sounds/player/footsteps/water_exit_04.vsnd_c",
		"sounds/player/footsteps/water_exit_05.vsnd_c",
		"sounds/player/footsteps/water_exit_06.vsnd_c",
	},
	"step water_wade": {
		"sounds/player/footsteps/water_wade_01.vsnd_c",
		"sounds/player/footsteps/water_wade_02.vsnd_c",
		"sounds/player/footsteps/water_wade_03.vsnd_c",
		"sounds/player/footsteps/water_wade_04.vsnd_c",
		"sounds/player/footsteps/water_wade_05.vsnd_c",
		"sounds/player/footsteps/water_wade_06.vsnd_c",
	},
	"step wet": {
		"sounds/player/footsteps/wet_01.vsnd_c",
		"sounds/player/footsteps/wet_02.vsnd_c",
		"sounds/player/footsteps/wet_03.vsnd_c",
		"sounds/player/footsteps/wet_04.vsnd_c",
		"sounds/player/footsteps/wet_05.vsnd_c",
		"sounds/player/footsteps/wet_06.vsnd_c",
	},
	"step wood": {
		"sounds/player/footsteps/wood_01.vsnd_c",
		"sounds/player/footsteps/wood_02.vsnd_c",
		"sounds/player/footsteps/wood_03.vsnd_c",
		"sounds/player/footsteps/wood_04.vsnd_c",
		"sounds/player/footsteps/wood_05.vsnd_c",
		"sounds/player/footsteps/wood_06.vsnd_c",
		"sounds/player/footsteps/wood_07.vsnd_c",
		"sounds/player/footsteps/wood_08.vsnd_c",
		"sounds/player/footsteps/wood_09.vsnd_c",
		"sounds/player/footsteps/wood_10.vsnd_c",
		"sounds/player/footsteps/wood_11.vsnd_c",
		"sounds/player/footsteps/wood_12.vsnd_c",
		"sounds/player/footsteps/wood_13.vsnd_c",
		"sounds/player/footsteps/wood_14.vsnd_c",
		"sounds/player/footsteps/wood_15.vsnd_c",
	},
	// Landings: the `land_*` sets (per-material, same probe as the steps),
	// the jump LAUNCH cue, the team gear landings (Gear.JumpLand.CT/T's own
	// file sets — suit_ct has no _10 in the install) and the fall-damage
	// set (Player.DamageFall's sounds/player/damage1..3).
	"land concrete": {"sounds/player/footsteps/land_concrete_01.vsnd_c"},
	"jump":          {"sounds/player/footsteps/jump_launch_01.vsnd_c"},
	"gear CT": {
		"sounds/player/footsteps/suit_ct_01.vsnd_c",
		"sounds/player/footsteps/suit_ct_02.vsnd_c",
		"sounds/player/footsteps/suit_ct_03.vsnd_c",
		"sounds/player/footsteps/suit_ct_04.vsnd_c",
		"sounds/player/footsteps/suit_ct_05.vsnd_c",
		"sounds/player/footsteps/suit_ct_06.vsnd_c",
		"sounds/player/footsteps/suit_ct_07.vsnd_c",
		"sounds/player/footsteps/suit_ct_08.vsnd_c",
		"sounds/player/footsteps/suit_ct_09.vsnd_c",
	},
	"gear T": {
		"sounds/player/footsteps/suit_t_01.vsnd_c",
		"sounds/player/footsteps/suit_t_02.vsnd_c",
		"sounds/player/footsteps/suit_t_03.vsnd_c",
		"sounds/player/footsteps/suit_t_04.vsnd_c",
		"sounds/player/footsteps/suit_t_05.vsnd_c",
		"sounds/player/footsteps/suit_t_06.vsnd_c",
		"sounds/player/footsteps/suit_t_07.vsnd_c",
		"sounds/player/footsteps/suit_t_08.vsnd_c",
		"sounds/player/footsteps/suit_t_09.vsnd_c",
		"sounds/player/footsteps/suit_t_10.vsnd_c",
		"sounds/player/footsteps/suit_t_11.vsnd_c",
		"sounds/player/footsteps/suit_t_12.vsnd_c",
	},
	"falldamage": {
		"sounds/player/damage1.vsnd_c",
		"sounds/player/damage2.vsnd_c",
		"sounds/player/damage3.vsnd_c",
	},
	// ---- Headshot KILL cues (the replay's lethal-headshot pair) --------
	// sfx.js headshotKillCues keys these two OFF a kill row's
	// victimHelmet stamp — the game plays ONE distinct impact per headshot
	// depending on what the victim's head was wearing (CS2.md "Headshot
	// impact sounds…"): the metallic DINK on a helmeted head, the
	// no-armor sample on a bare one. Event→file mapping read from the
	// local install's soundevents (cs2find events, 2026-11-11):
	//   Player.DeathHeadShot.Dink / .Victim.Dink /
	//     Player.DamageHeadShotArmor.* → headshot_armor_e1 (SINGLE file —
	//     the dink group is deliberately one sample, like the beep/
	//     lifecycle groups: one distinct moment, not a variant)
	//   Player.DeathHeadShot.AttackerFeedback / .Onlooker / .Spectator /
	//     .Victim, Player.DamageHeadShot.* → headshot_noarmor_01..05
	//     (the 5-variant set — pickVariant keeps them all and chooses one
	//     per play, so repeated kills never loop one sample)
	// The sibling Player.DeathHeadShotArmor.* family (→ headshot_armor_01
	// / player_damagebody_05..07) is an UNRESOLVED mapping (CS2.md —
	// non-blocking: it plays no role in the dink/bare decision) and is
	// deliberately NOT extracted. Both files decode PCM16 44100 stereo
	// (cs2find sound, 2026-11-11).
	"Headshot dink": {
		"sounds/player/headshot_armor_e1.vsnd_c",
	},
	"Headshot bare": {
		"sounds/player/headshot_noarmor_01.vsnd_c",
		"sounds/player/headshot_noarmor_02.vsnd_c",
		"sounds/player/headshot_noarmor_03.vsnd_c",
		"sounds/player/headshot_noarmor_04.vsnd_c",
		"sounds/player/headshot_noarmor_05.vsnd_c",
	},
}

// internalSoundGroups — the ONE list of soundTable keys that are neither
// an iconTable canonical name nor one + " throw": replay-internal sound
// groups the frontend addresses by literal name (sfx.js builds those
// names itself — the C4 beep scheduler's `C4 beep <site>`).
// Registering a group HERE is the whole widening:
// TestSoundTableKeysInIconTable accepts exactly iconTable names,
// " throw" groups and these, so a future group with no equipment
// spelling (the plant/defuse cue workstream's, for example) never needs
// a new rule — and the reverse index's global stem uniqueness plus the
// sounds/ path rule still apply to every entry.
var internalSoundGroups = map[string]bool{
	"C4 beep A": true, // site A's planted-C4 beep
	"C4 beep B": true, // site B's (the lower-pitched, longer one)
	// The plant/defuse cue groups — the four lifecycle moments sfx.js's
	// bombActionCues addresses by literal name (one file each; see the
	// soundTable entries for the soundevent → file mapping).
	"C4 plant start":     true, // bomb_plant_begin → c4.initiate
	"C4 plant complete":  true, // bomb_plant → c4.plant
	"C4 defuse start":    true, // bomb_defuse_start → c4.disarmstart
	"C4 defuse complete": true, // bomb_defuse → c4.disarmfinish
	// The five ANNOUNCER lines (owner-provided mapping 2026-11-09,
	// unverified): the keys sfx.js's round-end/plant/defuse announcer
	// cue builders address by literal name (roundEndCues →
	// ctwin/terwin/rounddraw, bombAnnouncerCues → bombpl/bombdef).
	"ctwin":     true,
	"terwin":    true,
	"rounddraw": true,
	"bombpl":    true,
	"bombdef":   true,
	// The match-POINT stinger (sfx.js matchPointCues) — cs2find-
	// discovered, existence-verified 2026-11-09 (NOT owner-provided;
	// see the soundTable entry for the Music.Match.MatchPoint event →
	// file mapping).
	"matchpoint": true,
	// The five grenade BOUNCE groups (the replay's bounce cues for the
	// models.EventGrenadeBounce rows — soundTable carries each bounce
	// soundevent's own file set).
	"HE Grenade bounce":         true,
	"Flashbang bounce":          true,
	"Smoke Grenade bounce":      true,
	"Molotov bounce":            true,
	"Incendiary Grenade bounce": true,
	// The four FIRE-CUE groups (the replay's smoke⇄fire / air-burst /
	// fade cues for the models.EventExtinguish …
	// EventFadeOut rows — soundTable carries each cue soundevent's file
	// set; the extinguish/fade groups are nade-neutral, the air-burst
	// pair is addressed through the row's weapon column).
	"Fire extinguish":                 true,
	"Molotov start failed":            true,
	"Incendiary Grenade start failed": true,
	"Fire fade out":                   true,
	// The two HEADSHOT-kill cue groups (sfx.js headshotKillCues — the
	// dink/bare pair stamped off the kill row's victimHelmet). Opaque
	// names with no equipment spelling, so they register HERE (the whole
	// widening mechanism — see the comment above); the files' basenames
	// are globally unique, so soundStems needs no prefixing.
	"Headshot dink": true,
	"Headshot bare": true,
	// The player-sound groups (the asset side of sound_events): one
	// `step <material>` group per footsteps file family, plus the land /
	// jump / gear / fall-damage sets. Keys are the literal names the
	// frontend playback wave addresses (see the soundTable section for
	// how the file lists were derived).
	"land concrete":        true,
	"jump":                 true,
	"gear CT":              true,
	"gear T":               true,
	"falldamage":           true,
	"step bass":            true,
	"step carpet":          true,
	"step concrete_ct":     true,
	"step dirt":            true,
	"step glass":           true,
	"step grass":           true,
	"step gravel":          true,
	"step ladder":          true,
	"step ladder_wood":     true,
	"step metal_auto":      true,
	"step metal_chainlink": true,
	"step metal_grate":     true,
	"step metal_railing_a": true,
	"step metal_solid":     true,
	"step metal_vent":      true,
	"step mud":             true,
	"step plastic_barrel":  true,
	"step puddle":          true,
	"step puddle_small":    true,
	"step rubber":          true,
	"step sand":            true,
	"step snow":            true,
	"step tile":            true,
	"step water_entry":     true,
	"step water_exit":      true,
	"step water_wade":      true,
	"step wet":             true,
	"step wood":            true,
}

// soundTableNames is soundTable's keys in sorted order, so extraction
// (and the error lists it produces) is deterministic.
var soundTableNames = func() []string {
	keys := make([]string, 0, len(soundTable))
	for name := range soundTable {
		keys = append(keys, name)
	}
	sort.Strings(keys)
	return keys
}()

// soundFileToNames is the reverse index for manifest building: extracted
// filename ("ak47_01.wav") → canonical name(s). Built once from
// soundTable through the ONE naming rule (soundStem — a shared basename
// is disambiguated there, so two groups never share a filename); a slice
// because two names COULD still share a whole VPK path (none do today —
// TestSoundTableKeysInIconTable pins the no-collision property).
var soundFileToNames = func() map[string][]string {
	m := make(map[string][]string)
	for name, paths := range soundTable {
		for _, vp := range paths {
			stem := soundStem(vp) // THE output naming rule (soundStems)
			// The extension is only known after decoding, so index BOTH
			// candidate names here; SoundFiles keeps the one on disk.
			for _, ext := range []string{soundExtWAV, soundExtMP3} {
				m[stem+ext] = append(m[stem+ext], name)
			}
		}
	}
	return m
}()

// soundStems maps every soundTable VPK path to its UNIQUE output filename
// stem. The rule (ONE naming rule — soundStem below is its only reader):
// the file's basename, PREFIXED with its parent directory when that
// basename is shared with another table entry. A shared basename would
// otherwise make the extractor overwrite one group's audio with the
// other's and merge them in the reverse index — measured when the two
// bounce groups landed (flashbang/grenade_hit1 vs smokegrenade/
// grenade_hit1). Stems that need no disambiguation are byte-identical to
// the plain basename, so every previously extracted file keeps its name.
var soundStems = buildSoundStems(soundTable)

// buildSoundStems derives soundStems from a table (unit-testable on small
// tables). Result depends only on the SET of paths, never map order; the
// test re-checks the derived stems for uniqueness, so a rule that ever
// produced a second collision fails TestSoundTableKeysInIconTable instead
// of shipping an overwrite.
func buildSoundStems(table map[string][]string) map[string]string {
	byBase := map[string][]string{}
	total := 0
	for _, paths := range table {
		total += len(paths)
		for _, vp := range paths {
			base := strings.TrimSuffix(path.Base(vp), soundSuffix)
			byBase[base] = append(byBase[base], vp)
		}
	}
	out := make(map[string]string, total)
	for base, paths := range byBase {
		if len(paths) == 1 {
			out[paths[0]] = base
			continue
		}
		for _, vp := range paths {
			dir := strings.ReplaceAll(strings.TrimSuffix(path.Dir(vp), "/"), "/", "_")
			out[vp] = dir + "_" + base
		}
	}
	return out
}

// soundStem returns the output filename stem for a VPK path
// ("sounds/weapons/ak47/ak47_01.vsnd_c" → "ak47_01"; a basename shared
// with another table entry → "<dir>_<basename>", see soundStems). Paths
// outside soundTable (the dev tool's single-file decodes) keep the plain
// basename — they are written one at a time and never enter the index.
func soundStem(vpkPath string) string {
	if s, ok := soundStems[vpkPath]; ok {
		return s
	}
	return strings.TrimSuffix(path.Base(vpkPath), soundSuffix)
}

// ExtractSounds extracts every sound in soundTable from the CS2 install at
// cs2Dir into outDir (created if needed) as <stem>.wav / <stem>.mp3 files.
// Idempotent — re-running after a game update refreshes the sounds. A
// canonical name whose file is missing from the VPK, or whose resource the
// decoder rejects, lands in errs (the manifest simply omits that variant);
// only a failure to open the VPK itself is fatal. Returns the canonical
// names with at least one extracted variant, sorted for determinism.
// opts.Progress, when set, fires once per canonical sound attempted
// (ExtractOption).
func ExtractSounds(cs2Dir, outDir string, opts ...ExtractOption) (names []string, errs []string, err error) {
	extractMu.Lock()
	defer extractMu.Unlock()
	var cfg extractConfig
	for _, opt := range opts {
		opt(&cfg)
	}
	pak := resolvePak(cs2Dir)
	if pak == "" {
		return nil, nil, fmt.Errorf("couldn't read the replay sounds in that CS2 folder (%s)", cs2Dir)
	}
	v, err := openVPK(pak)
	if err != nil {
		return nil, nil, err
	}
	defer v.close()

	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return nil, nil, err
	}
	for i, name := range soundTableNames {
		ok := 0
		for _, vp := range soundTable[name] {
			raw, found, rerr := v.read(vp)
			if rerr != nil {
				errs = append(errs, fmt.Sprintf("%s: %s: %v", name, vp, rerr))
				continue
			}
			if !found {
				errs = append(errs, fmt.Sprintf("%s: %s not in VPK", name, vp))
				continue
			}
			data, ext, derr := decodeVSnd(raw)
			if derr != nil {
				errs = append(errs, fmt.Sprintf("%s: %s: %v", name, vp, derr))
				continue
			}
			out := filepath.Join(outDir, soundStem(vp)+ext)
			if werr := writeFileAtomic(out, data); werr != nil {
				errs = append(errs, fmt.Sprintf("%s: %s: %v", name, vp, werr))
				continue
			}
			ok++
		}
		if ok > 0 {
			names = append(names, name)
		}
		// Progress after every canonical name — the variant loop above
		// only `continue`s itself, so the end of this body always runs.
		if cfg.progress != nil {
			cfg.progress(i+1, len(soundTableNames))
		}
	}
	if len(names) == 0 && len(errs) > 0 {
		return nil, errs, fmt.Errorf("couldn't read the replay sounds — your game files may have changed format (%d errors)", len(errs))
	}
	return names, errs, nil
}

// SoundFiles lists the extracted sounds in dir: canonical name → the
// filenames of its variants, rebuilt from a fresh directory listing on
// every call so the served manifest never goes stale (the variant order
// is os.ReadDir's filename order — deterministic). Files that aren't in
// the reverse table (strays, older game versions) are ignored.
func SoundFiles(dir string) map[string][]string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return map[string][]string{}
	}
	out := map[string][]string{}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		for _, name := range soundFileToNames[e.Name()] {
			out[name] = append(out[name], e.Name())
		}
	}
	return out
}

// decodeVSnd turns one .vsnd_c resource into playable bytes: PCM16/PCM8
// get the standard 44-byte RIFF/WAV header prepended (Valve strips it —
// VRF does the same in Sound.GetSound()), MP3 is returned as the raw
// stream, ADPCM is rejected (no table entry ships it; see CS2.md
// "Sound assets (.vsnd_c)"). Returns the file bytes and the extension to
// write them under. THE one .vsnd_c decoder — decodeVSndV4/decodeVSndV5
// below are its two resource-version branches, not alternatives.
func decodeVSnd(raw []byte) ([]byte, string, error) {
	if len(raw) < 8 {
		return nil, "", fmt.Errorf("vsnd: %d bytes is too short for a header", len(raw))
	}
	if hv := binary.LittleEndian.Uint16(raw[4:6]); hv != 12 {
		return nil, "", fmt.Errorf("vsnd: header version %d (want 12)", hv)
	}
	fileSize := int(binary.LittleEndian.Uint32(raw[0:4]))
	if fileSize < 8 || fileSize > len(raw) {
		return nil, "", fmt.Errorf("vsnd: payload offset %d outside %d-byte file", fileSize, len(raw))
	}
	// Structured size only: the audio payload starts at FileSize (the
	// same convention as vtex — CS2.md).
	payload := raw[fileSize:]
	switch v := binary.LittleEndian.Uint16(raw[6:8]); v {
	case 4:
		return decodeVSndV4(raw, payload)
	case 5:
		return decodeVSndV5(raw, payload)
	default:
		return nil, "", fmt.Errorf("vsnd: unsupported resource version %d", v)
	}
}

// vsndFormat names the four format codes the v4 DATA header uses (CS2.md:
// 0=PCM16, 1=PCM8, 2=MP3, 3=ADPCM).
func vsndFormatName(code byte) string {
	switch code {
	case 0:
		return "PCM16"
	case 1:
		return "PCM8"
	case 2:
		return "MP3"
	case 3:
		return "ADPCM"
	default:
		return fmt.Sprintf("format#%d", code)
	}
}

// decodeVSndV4 reads the fixed 32+-byte header inside the DATA block:
// u16 rate, u8 format, u8 channels, …, u32 audioBytes@28 (= payload
// length). CS2.md verified this layout against the local build.
func decodeVSndV4(raw, payload []byte) ([]byte, string, error) {
	off, size, err := resourceDataBlock(raw, "vsnd")
	if err != nil {
		return nil, "", err
	}
	if size < 32 {
		return nil, "", fmt.Errorf("vsnd: DATA block %d bytes < 32", size)
	}
	d := raw[off : off+size]
	rate := uint32(binary.LittleEndian.Uint16(d[0:2]))
	format := d[2]
	channels := uint32(d[3])
	audioBytes := binary.LittleEndian.Uint32(d[28:32])
	if audioBytes > 0 {
		if uint64(audioBytes) > uint64(len(payload)) {
			return nil, "", fmt.Errorf("vsnd: audioBytes %d > payload %d", audioBytes, len(payload))
		}
		payload = payload[:audioBytes]
	}
	return finishVSnd(format, rate, channels, payload)
}

// finishVSnd is the shared tail of both version branches: validate the
// decoded format and package the payload (WAV header for PCM, raw bytes
// for MP3).
func finishVSnd(format byte, rate, channels uint32, payload []byte) ([]byte, string, error) {
	switch format {
	case 0: // PCM16
		if err := checkPCM(rate, channels, 16, payload); err != nil {
			return nil, "", err
		}
		return append(wavHeader(rate, channels, 16, uint32(len(payload))), payload...), soundExtWAV, nil
	case 1: // PCM8
		if err := checkPCM(rate, channels, 8, payload); err != nil {
			return nil, "", err
		}
		return append(wavHeader(rate, channels, 8, uint32(len(payload))), payload...), soundExtWAV, nil
	case 2: // MP3 — already a raw stream, write it as-is
		if len(payload) == 0 {
			return nil, "", fmt.Errorf("vsnd: empty MP3 payload")
		}
		return payload, soundExtMP3, nil
	case 3:
		return nil, "", fmt.Errorf("vsnd: ADPCM unsupported (%s)", vsndFormatName(format))
	default:
		return nil, "", fmt.Errorf("vsnd: unknown %s", vsndFormatName(format))
	}
}

func checkPCM(rate, channels, bits uint32, payload []byte) error {
	if rate < 1024 || rate > 384000 {
		return fmt.Errorf("vsnd: implausible rate %d", rate)
	}
	if channels < 1 || channels > 8 {
		return fmt.Errorf("vsnd: implausible channels %d", channels)
	}
	bps := bits / 8
	if uint64(channels)*uint64(bps) == 0 || uint64(len(payload))%(uint64(channels)*uint64(bps)) != 0 {
		return fmt.Errorf("vsnd: payload %d is not a whole number of %dHz/%dch frames",
			len(payload), rate, channels)
	}
	return nil
}

// wavHeader builds the canonical 44-byte RIFF/WAVE header for interleaved
// integer PCM. Valve strips this header from the .vsnd_c payload (CS2.md;
// VRF re-adds the same one), so every PCM sound we serve needs it back —
// byte layout pinned by TestDecodeVSndV4WAVHeader.
func wavHeader(rate, channels, bits, dataLen uint32) []byte {
	byteRate := rate * channels * bits / 8
	blockAlign := channels * bits / 8
	h := make([]byte, 44)
	copy(h[0:4], "RIFF")
	binary.LittleEndian.PutUint32(h[4:8], 36+dataLen)
	copy(h[8:12], "WAVE")
	copy(h[12:16], "fmt ")
	binary.LittleEndian.PutUint32(h[16:20], 16) // PCM fmt chunk size
	binary.LittleEndian.PutUint16(h[20:22], 1)  // format = PCM
	binary.LittleEndian.PutUint16(h[22:24], uint16(channels))
	binary.LittleEndian.PutUint32(h[24:28], rate)
	binary.LittleEndian.PutUint32(h[28:32], byteRate)
	binary.LittleEndian.PutUint16(h[32:34], uint16(blockAlign))
	binary.LittleEndian.PutUint16(h[34:36], uint16(bits))
	copy(h[36:40], "data")
	binary.LittleEndian.PutUint32(h[40:44], dataLen)
	return h
}

// vsndCtrlHeaderSize is the fixed size of a v5 CTRL block's header: the
// KV3 magic (4), the format GUID (16), u32 compression (1 = LZ4) and the
// size/count fields — the four buffer sizes live at 72/76/80/84 and the
// first LZ4 block starts at 120 (verified against every v5 file under
// sounds/weapons/ in the local build; CS2.md).
const (
	vsndCtrlHeaderSize   = 120
	vsndCtrlOffUnc1      = 72
	vsndCtrlOffComp1     = 76
	vsndCtrlOffUnc2      = 80
	vsndCtrlOffComp2     = 84
	vsndKV3TrailerLength = 4 // 00 dd ee ff — u32 0xFFEEDD00 LE
)

// decodeVSndV5 walks the CTRL block: binary KV3 (magic, GUID,
// compression=1) → two LZ4-compressed raw blocks — buffer 1 is the NUL
// string table, buffer 2 the object/value/type lanes ending in the
// 0xFFEEDD00 trailer. VRF's BinaryKV3.cs is the reference parser; this is
// the minimal reader that recovers the four fields playback needs (CS2.md
// "Sound assets (.vsnd_c)"). KV3 format byte 0x05 only: the 0x04 variant
// that occurs under sounds/ambient/train lays its buffer sizes out
// differently and no table entry points there.
func decodeVSndV5(raw, payload []byte) ([]byte, string, error) {
	off, size, err := resourceBlock(raw, "CTRL", "vsnd")
	if err != nil {
		return nil, "", err
	}
	ctrl := raw[off : off+size]
	formatName, rate, channels, err := parseVSndKV3(ctrl, len(payload))
	if err != nil {
		return nil, "", err
	}
	switch formatName {
	case "PCM16", "PCM8":
		bits := uint32(16)
		if formatName == "PCM8" {
			bits = 8
		}
		// channels is 0 only when parseVSndKV3 could not recover it —
		// checkPCM below rejects that (never a silent guess).
		return finishVSnd(bitsToFormat(bits), rate, channels, payload)
	case "MP3":
		return finishVSnd(2, 0, 0, payload)
	case "ADPCM":
		return nil, "", fmt.Errorf("vsnd: ADPCM unsupported")
	default:
		return nil, "", fmt.Errorf("vsnd: unknown v5 format %q", formatName)
	}
}

func bitsToFormat(bits uint32) byte {
	if bits == 8 {
		return 1
	}
	return 0
}

// parseVSndKV3 decodes a v5 CTRL block: validates the KV3 header, LZ4
// decompresses the two raw blocks (buffer 1 = NUL string table, buffer 2
// = the object lanes + trailer), then walks the pair stream —
// [2×u32 header][key, value…] where a key is a property-name string
// index and a following u32 that is itself the NEXT property name means
// the property is absent (or an inline object, whose pairs continue in
// the same stream). Float-typed values live in their own 8-byte lane
// after the pairs, so a duration never masquerades as an int.
//
// Returns the format name ("PCM16"/"MP3"/…) plus m_nRate/m_nChannels
// (0 = absent). m_nStreamingSize is cross-checked against the payload
// length — a mismatch means the parser drifted, so it errors instead of
// serving mis-framed audio.
func parseVSndKV3(ctrl []byte, payloadLen int) (format string, rate, channels uint32, err error) {
	if len(ctrl) < vsndCtrlHeaderSize+8 {
		return "", 0, 0, fmt.Errorf("vsnd: CTRL block %d bytes is too short", len(ctrl))
	}
	// magic: <kv3-version> 33 56 4b ("KV3" reversed after the version
	// byte); 0x05 is the variant this decoder walks.
	if ctrl[0] != 0x05 || ctrl[1] != 0x33 || ctrl[2] != 0x56 || ctrl[3] != 0x4b {
		return "", 0, 0, fmt.Errorf("vsnd: CTRL magic % x is not KV3 v5", ctrl[:4])
	}
	u32 := func(o int) uint32 { return binary.LittleEndian.Uint32(ctrl[o : o+4]) }
	if comp := u32(20); comp != 1 {
		return "", 0, 0, fmt.Errorf("vsnd: CTRL compression %d (want 1 = LZ4)", comp)
	}
	unc1, comp1 := int(u32(vsndCtrlOffUnc1)), int(u32(vsndCtrlOffComp1))
	unc2, comp2 := int(u32(vsndCtrlOffUnc2)), int(u32(vsndCtrlOffComp2))
	start := vsndCtrlHeaderSize
	if start+comp1+comp2 > len(ctrl) || unc1 < 0 || unc2 < 0 {
		return "", 0, 0, fmt.Errorf("vsnd: CTRL buffer sizes overrun the block")
	}
	// A 4-byte 0xFFEEDD00 trailer may follow the two blocks (present in
	// all but a handful of resources) — tolerate either shape.
	if rest := len(ctrl) - (start + comp1 + comp2); rest != 0 && rest != vsndKV3TrailerLength {
		return "", 0, 0, fmt.Errorf("vsnd: CTRL has %d trailing bytes (want 0 or %d)", rest, vsndKV3TrailerLength)
	}
	strs, pairs, err := lz4Buffers(ctrl[start:start+comp1], unc1, ctrl[start+comp1:start+comp1+comp2], unc2)
	if err != nil {
		return "", 0, 0, err
	}
	if ss, ok := pairs["m_nStreamingSize"]; ok && int(ss) != payloadLen {
		return "", 0, 0, fmt.Errorf("vsnd: m_nStreamingSize %d != payload %d", ss, payloadLen)
	}
	format = ""
	if fi, ok := pairs["m_nFormat"]; ok {
		if int(fi) >= len(strs) {
			return "", 0, 0, fmt.Errorf("vsnd: m_nFormat index %d outside string table", fi)
		}
		format = strs[fi]
	}
	if format == "" {
		return "", 0, 0, fmt.Errorf("vsnd: CTRL has no m_nFormat")
	}
	rate = pairs["m_nRate"]
	channels = pairs["m_nChannels"]
	if channels == 0 && (format == "PCM16" || format == "PCM8") {
		// Defaulted-away channel count: the frame math recovers it
		// exactly (payload = sampleCount × channels × bytes/sample).
		sc := pairs["m_nSampleCount"]
		bps := uint32(2)
		if format == "PCM8" {
			bps = 1
		}
		if sc == 0 || uint64(sc)*uint64(bps) > uint64(payloadLen) ||
			uint64(payloadLen)%(uint64(sc)*uint64(bps)) != 0 {
			return "", 0, 0, fmt.Errorf("vsnd: cannot recover m_nChannels (sampleCount=%d payload=%d)", sc, payloadLen)
		}
		channels = uint32(uint64(payloadLen) / (uint64(sc) * uint64(bps)))
	}
	return format, rate, channels, nil
}

// lz4Buffers decompresses the two CTRL raw blocks and walks buffer 2's
// pair stream (see parseVSndKV3).
func lz4Buffers(b1 []byte, unc1 int, b2 []byte, unc2 int) ([]string, map[string]uint32, error) {
	if unc1 <= 0 || unc2 <= 0 {
		return nil, nil, fmt.Errorf("vsnd: CTRL buffer sizes %d/%d", unc1, unc2)
	}
	s1 := make([]byte, unc1)
	if n, err := lz4.UncompressBlock(b1, s1); err != nil || n != unc1 {
		return nil, nil, fmt.Errorf("vsnd: CTRL string buffer: %v", err)
	}
	s2 := make([]byte, unc2)
	if n, err := lz4.UncompressBlock(b2, s2); err != nil || n != unc2 {
		return nil, nil, fmt.Errorf("vsnd: CTRL object buffer: %v", err)
	}
	// Trailer 00 dd ee ff (u32 0xFFEEDD00 LE) is the KV3 terminator.
	if len(s2) < vsndKV3TrailerLength+8 {
		return nil, nil, fmt.Errorf("vsnd: CTRL object buffer %d bytes is too short", len(s2))
	}
	tail := s2[len(s2)-vsndKV3TrailerLength:]
	if tail[0] != 0x00 || tail[1] != 0xdd || tail[2] != 0xee || tail[3] != 0xff {
		return nil, nil, fmt.Errorf("vsnd: CTRL object buffer has no KV3 trailer (tail % x)", tail)
	}
	strs := strings.Split(string(s1), "\x00")
	content := s2[:len(s2)-vsndKV3TrailerLength]
	u := make([]uint32, len(content)/4)
	for i := range u {
		u[i] = binary.LittleEndian.Uint32(content[i*4:])
	}
	return strs, walkKVPairs(strs, u), nil
}

// isKVProperty reports whether a string-table index names an object
// property ("_class" / "m_*") rather than a string VALUE ("PCM16",
// "CVoiceContainerDefault") — the pair walker's key test.
func isKVProperty(strs []string, idx uint32) bool {
	if int(idx) >= len(strs) {
		return false
	}
	s := strs[idx]
	return s == "_class" || strings.HasPrefix(s, "m_")
}

// walkKVPairs folds the object lane into name → value pairs. A key whose
// next u32 is ANOTHER property name has no stored value (absent property
// or an inline object — its pairs simply continue), which is what keeps
// small values (channels = 2, null = 0) from being mistaken for keys.
func walkKVPairs(strs []string, u []uint32) map[string]uint32 {
	pairs := map[string]uint32{}
	// Two header u32s precede the pair stream (counts the writer emits;
	// their values are not needed to walk it).
	for i := 2; i < len(u); {
		key := u[i]
		i++
		if !isKVProperty(strs, key) {
			break // reached the float lane / type lanes
		}
		if i >= len(u) {
			break
		}
		v := u[i]
		if v > key && isKVProperty(strs, v) {
			continue // no stored value — v is the next key
		}
		i++
		pairs[strs[key]] = v
	}
	return pairs
}

// ValidSoundFileBase reports whether base (a "<stem>.wav"/"<stem>.mp3"
// filename) is a safe sound filename: lowercase letters/digits/underscore/
// hyphen plus a whitelisted suffix, no path segments — the /api/sounds
// route whitelist. Hyphens are allowed (unlike the icon whitelist) because
// Valve's own basenames carry them: "nova-1", "sawedoff-1",
// "revolver-1_01". Mirrors ValidIconFileBase.
func ValidSoundFileBase(base string) bool {
	name, ok := strings.CutSuffix(base, soundExtWAV)
	if !ok {
		name, ok = strings.CutSuffix(base, soundExtMP3)
	}
	if !ok || name == "" || len(base) > 64 {
		return false
	}
	for _, c := range name {
		if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '_' && c != '-' {
			return false
		}
	}
	return true
}
