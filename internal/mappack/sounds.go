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
// soundTable; a slice because two names COULD share a path (none do today
// — TestSoundTableFileNamesPinned pins the no-collision property).
var soundFileToNames = func() map[string][]string {
	m := make(map[string][]string)
	for name, paths := range soundTable {
		for _, vp := range paths {
			stem := strings.TrimSuffix(path.Base(vp), soundSuffix)
			// The extension is only known after decoding, so index BOTH
			// candidate names here; SoundFiles keeps the one on disk.
			for _, ext := range []string{soundExtWAV, soundExtMP3} {
				m[stem+ext] = append(m[stem+ext], name)
			}
		}
	}
	return m
}()

// soundStem returns the output filename stem for a VPK path
// ("sounds/weapons/ak47/ak47_01.vsnd_c" → "ak47_01").
func soundStem(vpkPath string) string {
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
// (ExtractOptions).
func ExtractSounds(cs2Dir, outDir string, opts ...ExtractOptions) (names []string, errs []string, err error) {
	o := firstOptions(opts)
	pak := resolvePak(cs2Dir)
	if pak == "" {
		return nil, nil, fmt.Errorf("no pak01_dir.vpk under %s", cs2Dir)
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
		if o.Progress != nil {
			o.Progress(i+1, len(soundTableNames))
		}
	}
	if len(names) == 0 && len(errs) > 0 {
		return nil, errs, fmt.Errorf("no sounds extracted (%d errors)", len(errs))
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
