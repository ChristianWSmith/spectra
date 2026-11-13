package mappack

import (
	"encoding/binary"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pierrec/lz4/v4"
)

// --- fixtures -------------------------------------------------------------

// buildVSndV4 constructs a minimal v4 .vsnd_c resource: the 16-byte
// resource header, one DATA block whose payload is the fixed 32-byte
// audio header (CS2.md "Sound assets (.vsnd_c)"), then the raw audio —
// byte-for-byte the layout the real deagle/hegrenade files use.
func buildVSndV4(t *testing.T, rate uint16, format, channels byte, sampleCount uint32, audio []byte) []byte {
	t.Helper()
	body := make([]byte, 32)
	binary.LittleEndian.PutUint16(body[0:2], rate)
	body[2] = format
	body[3] = channels
	binary.LittleEndian.PutUint32(body[4:8], ^uint32(0)) // loopStart = -1
	binary.LittleEndian.PutUint32(body[8:12], sampleCount)
	binary.LittleEndian.PutUint32(body[12:16], math.Float32bits(1.5))
	binary.LittleEndian.PutUint32(body[16:20], 0) // streamingSize = 0 (v4)
	binary.LittleEndian.PutUint32(body[28:32], uint32(len(audio)))

	const structured = 16 + 12 + 32
	buf := make([]byte, 0, structured+len(audio))
	hdr := make([]byte, 16)
	binary.LittleEndian.PutUint32(hdr[0:4], structured) // FileSize: payload offset
	binary.LittleEndian.PutUint16(hdr[4:6], 12)         // header version
	binary.LittleEndian.PutUint16(hdr[6:8], 4)          // resource version
	binary.LittleEndian.PutUint32(hdr[8:12], 8)         // block table at 8+8
	binary.LittleEndian.PutUint32(hdr[12:16], 1)        // one block
	buf = append(buf, hdr...)

	entry := make([]byte, 12) // offset relative to the offset field (pos 20 → body at 28)
	copy(entry[0:4], "DATA")
	binary.LittleEndian.PutUint32(entry[4:8], 8)
	binary.LittleEndian.PutUint32(entry[8:12], uint32(len(body)))
	buf = append(buf, entry...)
	buf = append(buf, body...)
	return append(buf, audio...)
}

// buildVSndV5 constructs a minimal v5 .vsnd_c resource: a CTRL block
// holding binary KV3 (magic + GUID + compression=1) whose two LZ4 raw
// buffers are the NUL string table and the object lane
// ([2×u32 header][key/value pairs] + a float-lane stand-in + type bytes +
// the 0xFFEEDD00 trailer), then the audio payload after the structured
// size. This is the portable half of the v5 coverage — the real-install
// test below proves the same decoder against ak47_01's actual bytes.
func buildVSndV5(t *testing.T, strs []string, stream []uint32, audio []byte) []byte {
	t.Helper()
	b1 := []byte(strings.Join(strs, "\x00") + "\x00")

	content := make([]byte, 0, len(stream)*4+16)
	for _, u := range stream {
		content = binary.LittleEndian.AppendUint32(content, u)
	}
	// Float lane (real files carry an f64 here whose first u32 is never a
	// valid property index — that is what ends the pair walk) + a couple
	// of type bytes + the KV3 trailer.
	content = append(content, 0x00, 0x00, 0x00, 0x60, 0x8b, 0x90, 0x03, 0x40)
	content = append(content, 0x09, 0x06, 0x07)
	content = append(content, 0x00, 0xdd, 0xee, 0xff)

	comp := func(raw []byte) []byte {
		dst := make([]byte, lz4.CompressBlockBound(len(raw)))
		n, err := lz4.CompressBlock(raw, dst, nil)
		if err != nil || n == 0 {
			t.Fatalf("lz4 compress %d bytes: n=%d err=%v", len(raw), n, err)
		}
		return dst[:n]
	}
	b1c, b2c := comp(b1), comp(content)

	ctrl := make([]byte, vsndCtrlHeaderSize, vsndCtrlHeaderSize+len(b1c)+len(b2c))
	ctrl[0], ctrl[1], ctrl[2], ctrl[3] = 0x05, 0x33, 0x56, 0x4b // KV3 v5 magic
	binary.LittleEndian.PutUint32(ctrl[20:24], 1)               // compression = LZ4
	binary.LittleEndian.PutUint32(ctrl[vsndCtrlOffUnc1:], uint32(len(b1)))
	binary.LittleEndian.PutUint32(ctrl[vsndCtrlOffComp1:], uint32(len(b1c)))
	binary.LittleEndian.PutUint32(ctrl[vsndCtrlOffUnc2:], uint32(len(content)))
	binary.LittleEndian.PutUint32(ctrl[vsndCtrlOffComp2:], uint32(len(b2c)))
	ctrl = append(ctrl, b1c...)
	ctrl = append(ctrl, b2c...)

	structured := 16 + 12 + len(ctrl)
	buf := make([]byte, 0, structured+len(audio))
	hdr := make([]byte, 16)
	binary.LittleEndian.PutUint32(hdr[0:4], uint32(structured))
	binary.LittleEndian.PutUint16(hdr[4:6], 12)
	binary.LittleEndian.PutUint16(hdr[6:8], 5)
	binary.LittleEndian.PutUint32(hdr[8:12], 8)
	binary.LittleEndian.PutUint32(hdr[12:16], 1)
	buf = append(buf, hdr...)
	entry := make([]byte, 12)
	copy(entry[0:4], "CTRL")
	binary.LittleEndian.PutUint32(entry[4:8], 8)
	binary.LittleEndian.PutUint32(entry[8:12], uint32(len(ctrl)))
	buf = append(buf, entry...)
	buf = append(buf, ctrl...)
	return append(buf, audio...)
}

// --- tests ----------------------------------------------------------------

// TestDecodeVSndV4WAVHeader pins the RIFF header decodeVSnd prepends to a
// v4 PCM resource: every field a browser's AudioDecoder reads, plus the
// payload passthrough and the MP3/ADPCM branches.
func TestDecodeVSndV4WAVHeader(t *testing.T) {
	audio := make([]byte, 16) // 4 frames of stereo PCM16
	for i := range audio {
		audio[i] = byte(i)
	}
	raw := buildVSndV4(t, 44100, 0 /*PCM16*/, 2, 4, audio)
	data, ext, err := decodeVSnd(raw)
	if err != nil {
		t.Fatalf("decodeVSnd: %v", err)
	}
	if ext != soundExtWAV {
		t.Fatalf("ext = %q, want %q", ext, soundExtWAV)
	}
	if len(data) != 44+len(audio) {
		t.Fatalf("len = %d, want %d", len(data), 44+len(audio))
	}
	u32 := func(o int) uint32 { return binary.LittleEndian.Uint32(data[o : o+4]) }
	u16 := func(o int) uint16 { return binary.LittleEndian.Uint16(data[o : o+2]) }
	checks := []struct {
		what string
		got  any
		want any
	}{
		{"RIFF tag", string(data[0:4]), "RIFF"},
		{"RIFF size", u32(4), uint32(36 + len(audio))},
		{"WAVE tag", string(data[8:12]), "WAVE"},
		{"fmt tag", string(data[12:16]), "fmt "},
		{"fmt size", u32(16), uint32(16)},
		{"audio format", u16(20), uint16(1)}, // PCM
		{"channels", u16(22), uint16(2)},
		{"sample rate", u32(24), uint32(44100)},
		{"byte rate", u32(28), uint32(44100 * 2 * 2)},
		{"block align", u16(32), uint16(4)},
		{"bits", u16(34), uint16(16)},
		{"data tag", string(data[36:40]), "data"},
		{"data size", u32(40), uint32(len(audio))},
	}
	for _, c := range checks {
		if c.got != c.want {
			t.Errorf("%s = %v, want %v", c.what, c.got, c.want)
		}
	}
	if string(data[44:]) != string(audio) {
		t.Error("payload bytes did not survive the header prepend")
	}

	// MP3: the raw stream is returned untouched with the .mp3 extension.
	mp3Audio := []byte{0xff, 0xfb, 0x90, 0x00, 0x00}
	data, ext, err = decodeVSnd(buildVSndV4(t, 44100, 2 /*MP3*/, 1, 100, mp3Audio))
	if err != nil {
		t.Fatalf("mp3: %v", err)
	}
	if ext != soundExtMP3 || string(data) != string(mp3Audio) {
		t.Errorf("mp3 = (%q, %d bytes), want (%q, raw stream)", ext, len(data), soundExtMP3)
	}

	// ADPCM is rejected, never written half-decoded.
	if _, _, err := decodeVSnd(buildVSndV4(t, 44100, 3 /*ADPCM*/, 1, 100, mp3Audio)); err == nil {
		t.Error("ADPCM: want an error")
	}
}

// TestDecodeVSndV5Synthetic covers the CTRL/binary-KV3 branch on a
// hand-built resource (CI has no CS2 install — see the real-install test
// for the shipped-bytes half).
func TestDecodeVSndV5Synthetic(t *testing.T) {
	audio := make([]byte, 8) // 2 frames of stereo PCM16
	strs := []string{
		"_class", "CVoiceContainerDefault", "m_vSound",
		"m_nRate", "m_nFormat", "PCM16", "m_nChannels", "m_nStreamingSize",
	}
	stream := []uint32{
		3, 8, // header (counts the writer emits)
		0, 1, // _class = "CVoiceContainerDefault"
		2,        // m_vSound → inline object, pairs continue
		3, 44100, // m_nRate
		4, 5, // m_nFormat = string[5] "PCM16"
		6, 2, // m_nChannels = 2
		7, uint32(len(audio)), // m_nStreamingSize = payload length
	}
	data, ext, err := decodeVSnd(buildVSndV5(t, strs, stream, audio))
	if err != nil {
		t.Fatalf("decodeVSnd(v5): %v", err)
	}
	if ext != soundExtWAV {
		t.Fatalf("ext = %q, want %q", ext, soundExtWAV)
	}
	if got := binary.LittleEndian.Uint32(data[24:28]); got != 44100 {
		t.Errorf("sample rate = %d, want 44100", got)
	}
	if got := binary.LittleEndian.Uint16(data[22:24]); got != 2 {
		t.Errorf("channels = %d, want 2", got)
	}
	if string(data[44:]) != string(audio) {
		t.Error("payload bytes did not survive the header prepend")
	}

	// A drifting m_nStreamingSize is a parse bug — it must fail loudly
	// rather than serve mis-framed audio.
	bad := buildVSndV5(t, strs, append(append([]uint32{}, stream[:len(stream)-1]...), 999), audio)
	if _, _, err := decodeVSnd(bad); err == nil || !strings.Contains(err.Error(), "m_nStreamingSize") {
		t.Errorf("streamingSize mismatch: want an m_nStreamingSize error, got %v", err)
	}
}

// TestSoundTableKeysInIconTable pins the frontend lookup vocabulary: the
// replay keys sounds off the SAME canonical equipment names the icon
// manifest uses (iconTable), so a soundTable key that drifts from the
// enum spelling would silently never play. TWO extensions are legal:
// THROW groups (a key may be an iconTable name + " throw" — Feature A —
// sfx.js throwCues builds cue names as `${weapon} throw`, so the
// manifest must carry exactly that key) and INTERNAL sound groups
// (internalSoundGroups — replay-addressed groups with no equipment
// spelling, e.g. the C4 beeps sfx.js's scheduler addresses as
// `C4 beep <site>`; a new group registers there, the rule never
// widens again). Also pins the per-name VPK paths' shape and the
// output-filename uniqueness the reverse index needs.
func TestSoundTableKeysInIconTable(t *testing.T) {
	if len(soundTable) == 0 {
		t.Fatal("soundTable is empty")
	}
	seen := map[string]string{}
	for name, paths := range soundTable {
		// Key rule: an internal sound group, an iconTable canonical
		// name, or one + " throw".
		base, isThrow := strings.CutSuffix(name, " throw")
		if !internalSoundGroups[name] {
			if _, ok := iconTable[base]; !ok {
				t.Errorf("soundTable key %q is not an iconTable name, one + \" throw\", or an internal sound group", name)
			}
			if isThrow && base == "" {
				t.Errorf("soundTable key %q has an empty base name", name)
			}
		}
		if len(paths) == 0 {
			t.Errorf("soundTable[%q] has no paths", name)
		}
		for _, vp := range paths {
			if !strings.HasSuffix(vp, soundSuffix) {
				t.Errorf("soundTable[%q] path %q lacks %s", name, vp, soundSuffix)
			}
			// The extractor walks the sounds/ tree — the HE throw lives
			// under sounds/items/ (weapon_hegrenade_throw.vsnd_c), so the
			// old sounds/weapons/ pin had to widen to sounds/ for Feature
			// A; anything outside sounds/ is still a drift.
			if !strings.HasPrefix(vp, "sounds/") {
				t.Errorf("soundTable[%q] path %q is outside sounds/", name, vp)
			}
			// Extracted filenames collide across names only if two VPK
			// paths produce the SAME output stem — the reverse index would
			// merge them and the extractor would overwrite one group's
			// audio. soundStem is THE naming rule: the basename, prefixed
			// with the parent directory when the basename is shared (the
			// flashbang/smokegrenade grenade_hit1 pair the bounce groups
			// introduced), so a collision here means the RULE failed to
			// separate two paths — e.g. the same VPK path listed under two
			// groups. The throw groups ride this same loop, so their stems
			// (weapon_hegrenade_throw, flashbang_throw_03,
			// smoke_grenade_throw_04, molotov_throw_01..06,
			// inc_grenade_throw_fire_01..03, decoy_throw_06) are checked
			// against every detonation/fire/bounce stem too — no collision.
			stem := soundStem(vp)
			if prev, dup := seen[stem]; dup {
				t.Errorf("output filename %q shared by %q and %q", stem, prev, name)
			}
			seen[stem] = name
		}
	}

	// Every registered internal group must actually exist — a stale
	// registration would silently keep working while the manifest lost
	// the key the frontend builds its name from.
	for group := range internalSoundGroups {
		if _, ok := soundTable[group]; !ok {
			t.Errorf("internalSoundGroups lists %q, which soundTable does not have", group)
		}
	}

	// Spot pins on the mappings other layers key on (verified against a
	// real install by TestExtractRealCS2Sounds).
	want := map[string][]string{
		"AK-47":        {"sounds/weapons/ak47/ak47_01.vsnd_c", "sounds/weapons/ak47/ak47_02.vsnd_c", "sounds/weapons/ak47/ak47_04.vsnd_c"},
		"M4A1":         {"sounds/weapons/m4a1/m4a1_silencer_01.vsnd_c"},
		"Desert Eagle": {"sounds/weapons/deagle/deagle_01.vsnd_c", "sounds/weapons/deagle/deagle_02.vsnd_c"},
		"C4":           {"sounds/weapons/c4/c4_explode1.vsnd_c"},
		// The C4 beep groups — one deterministic sample per site key;
		// the pair is the game's C4.PlantSound / C4.PlantSoundB
		// events' files (sfx.js's beep scheduler builds these key
		// names).
		"C4 beep A": {"sounds/weapons/c4/c4_beep2.vsnd_c"},
		"C4 beep B": {"sounds/weapons/c4/c4_beep3.vsnd_c"},
		// The plant/defuse cue groups — ONE file per cue (each is its
		// own soundevent — c4.initiate / c4.plant / c4.disarmstart /
		// c4.disarmfinish — never a variant of another; see the
		// soundTable comment), keyed by sfx.js bombActionCues.
		"C4 plant start":     {"sounds/weapons/c4/c4_initiate.vsnd_c"},
		"C4 plant complete":  {"sounds/weapons/c4/c4_plant.vsnd_c"},
		"C4 defuse start":    {"sounds/weapons/c4/c4_disarmstart.vsnd_c"},
		"C4 defuse complete": {"sounds/weapons/c4/c4_disarmfinish.vsnd_c"},
		// The announcer lines (owner-provided mapping 2026-11-09,
		// unverified) — the literal keys sfx.js's announcer cue builders
		// build, so neither side can drift alone.
		"ctwin":     {"sounds/vo/announcer/cs2_classic/ctwin.vsnd_c"},
		"terwin":    {"sounds/vo/announcer/cs2_classic/terwin.vsnd_c"},
		"rounddraw": {"sounds/vo/announcer/cs2_classic/rounddraw.vsnd_c"},
		"bombpl":    {"sounds/vo/announcer/cs2_classic/bombpl.vsnd_c"},
		"bombdef":   {"sounds/vo/announcer/cs2_classic/bombdef.vsnd_c"},
		// The match-POINT stinger (sfx.js matchPointCues) — the ONE
		// cs2find-discovered entry here (2026-11-09): no match-point
		// line exists under sounds/vo/announcer/cs2_classic/, so the
		// game's own Music.Match.MatchPoint soundevent's file is the
		// asset (existence-verified by TestExtractRealCS2Sounds below).
		"matchpoint": {"sounds/music/cs_stinger.vsnd_c"},
		"HE Grenade": {"sounds/weapons/hegrenade/hegrenade_detonate_02.vsnd_c", "sounds/weapons/hegrenade/hegrenade_detonate_03.vsnd_c"},
		// The HE THROW group pins the sounds/items/ path — the one entry
		// outside sounds/weapons/ (Feature A).
		"HE Grenade throw": {"sounds/items/weapon_hegrenade_throw.vsnd_c"},
		"Smoke Grenade":    {"sounds/weapons/smokegrenade/smoke_emit.vsnd_c"},
		"Zeus x27":         {"sounds/weapons/taser/taser_shoot.vsnd_c"},
		// The knife group is the networked flesh-hit set (MP3) — swings
		// are client-local foley and never cue (sfx.js knifeCues).
		"Knife": {
			"sounds/weapons/knife/knife_hit_light_flesh_01.vsnd_c",
			"sounds/weapons/knife/knife_hit_light_flesh_02.vsnd_c",
			"sounds/weapons/knife/knife_hit_light_flesh_03.vsnd_c",
			"sounds/weapons/knife/knife_hit_light_flesh_04.vsnd_c",
			"sounds/weapons/knife/knife_hit_light_flesh_06.vsnd_c",
			"sounds/weapons/knife/knife_hit_light_flesh_07.vsnd_c",
			"sounds/weapons/knife/knife_hit_light_flesh_08.vsnd_c",
			"sounds/weapons/knife/knife_hit_light_flesh_09.vsnd_c",
			"sounds/weapons/knife/knife_hit_light_flesh_10.vsnd_c",
			"sounds/weapons/knife/heavy_hit_flesh_01.vsnd_c",
			"sounds/weapons/knife/heavy_hit_flesh_04.vsnd_c",
			"sounds/weapons/knife/heavy_hit_flesh_08.vsnd_c",
			"sounds/weapons/knife/heavy_hit_flesh_09.vsnd_c",
			"sounds/weapons/knife/heavy_hit_flesh_10.vsnd_c",
			"sounds/weapons/knife/knife_hit_light_backstab_flesh_01.vsnd_c",
			"sounds/weapons/knife/knife_hit_light_backstab_flesh_02.vsnd_c",
			"sounds/weapons/knife/knife_hit_light_backstab_flesh_03.vsnd_c",
			"sounds/weapons/knife/knife_hit_light_backstab_flesh_04.vsnd_c",
			"sounds/weapons/knife/knife_hit_light_backstab_flesh_05.vsnd_c",
			"sounds/weapons/knife/knife_hit_light_backstab_flesh_06.vsnd_c",
		},
		// The headshot KILL cue groups (sfx.js headshotKillCues — the
		// dink/bare pair keyed off the kill row's victimHelmet). Pin the
		// event→file mapping (cs2find events, 2026-11-11) so neither side
		// drifts alone: Player.DeathHeadShot[.Dink]/Player.DamageHeadShot*
		// → these files (the sibling Player.DeathHeadShotArmor.* family is
		// unresolved and deliberately absent — see soundTable).
		"Headshot dink": {"sounds/player/headshot_armor_e1.vsnd_c"},
		"Headshot bare": {
			"sounds/player/headshot_noarmor_01.vsnd_c",
			"sounds/player/headshot_noarmor_02.vsnd_c",
			"sounds/player/headshot_noarmor_03.vsnd_c",
			"sounds/player/headshot_noarmor_04.vsnd_c",
			"sounds/player/headshot_noarmor_05.vsnd_c",
		},
		// ---- the Wave A grenade BOUNCE groups (each the bounce soundevent's own file set, cs2find events bounce) ----
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
		// ---- the Wave C FIRE-CUE groups (each the cue soundevent's own
		// file set; cs2find events + VPK existence, 2026-11-12) ----
		// The extinguish/fade groups are nade-neutral (one sound for both
		// Molotov and Incendiary fires — no Incendiary variant exists);
		// the air-burst and container-break groups are per-nade and keyed
		// through the row's weapon column (sfx.js fireCueName).
		"Fire extinguish":                 {"sounds/weapons/molotov/molotov_extinguish.vsnd_c"},
		"Molotov start failed":            {"sounds/weapons/molotov/molotov_detonate_air_01.vsnd_c"},
		"Incendiary Grenade start failed": {"sounds/weapons/incgrenade/inc_grenade_detonate_air_01.vsnd_c"},
		"Molotov smash": {
			"sounds/weapons/molotov/molotov_smash_01.vsnd_c",
			"sounds/weapons/molotov/molotov_smash_02.vsnd_c",
			"sounds/weapons/molotov/molotov_smash_03.vsnd_c",
			"sounds/weapons/molotov/molotov_smash_04.vsnd_c",
		},
		// The incendiary detonation-body twin: no IncGrenade.Smash exists
		// (grep over all install soundevent names) — Pop is the only
		// container-break sound in the family; 0× in the pool, wired per
		// the owner's manual-verification flow.
		"Incendiary Grenade pop": {"sounds/weapons/incgrenade/inc_grenade_pop_03.vsnd_c"},
		"Fire fade out":          {"sounds/weapons/molotov/fire_loop_fadeout_01.vsnd_c"},
		// ---- the Wave B player-sound groups (file lists = the READ-ONLY cs2find footsteps probe) ----
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
	}
	for name, paths := range want {
		got := soundTable[name]
		if strings.Join(got, ",") != strings.Join(paths, ",") {
			t.Errorf("soundTable[%q] = %v, want %v", name, got, paths)
		}
	}
	// The decoy has no DETONATION sound in the game — its absence is the
	// contract (the exploding decoy plays BaseGrenade.Explode, so sfx.js
	// remaps its cue to the "HE Grenade" group; CS2.md "Sound assets").
	// Its THROW group IS legal and ships (Feature A): Decoy.Throw →
	// decoy_throw_06 — pinned here so neither side drifts alone.
	if _, ok := soundTable["Decoy Grenade"]; ok {
		t.Error("Decoy Grenade must have no soundTable entry (no such detonation sound exists)")
	}
	if got := soundTable["Decoy Grenade throw"]; strings.Join(got, ",") != "sounds/weapons/decoy/decoy_throw_06.vsnd_c" {
		t.Errorf("Decoy Grenade throw = %v, want [sounds/weapons/decoy/decoy_throw_06.vsnd_c]", got)
	}
	// Sorted extraction order is deterministic.
	if len(soundTableNames) != len(soundTable) {
		t.Errorf("soundTableNames has %d entries, want %d", len(soundTableNames), len(soundTable))
	}
	for i := 1; i < len(soundTableNames); i++ {
		if soundTableNames[i-1] >= soundTableNames[i] {
			t.Errorf("soundTableNames not sorted: %q before %q", soundTableNames[i-1], soundTableNames[i])
			break
		}
	}
}

func TestExtractSoundsNoInstall(t *testing.T) {
	_, _, err := ExtractSounds(filepath.Join(t.TempDir(), "no-cs2"), t.TempDir())
	if err == nil {
		t.Fatal("want error for an install without pak01_dir.vpk")
	}
}

func TestValidSoundFileBase(t *testing.T) {
	good := []string{
		"ak47_01.wav", "nova-1.wav", "revolver-1_01.mp3", "taser_shoot.wav",
		"hegrenade_detonate_02.wav", "a.wav", "glock_02.mp3",
	}
	for _, s := range good {
		if !ValidSoundFileBase(s) {
			t.Errorf("ValidSoundFileBase(%q) = false, want true", s)
		}
	}
	bad := []string{
		"", ".wav", "AK47.wav", "ak47.png", "ak47.mp3.tmp",
		"../ak47.wav", "sub/ak47.wav", "/etc/passwd", "ak47", "..", "ak47.WAV",
		strings.Repeat("a", 61) + ".wav", // over the 64-byte cap with suffix
	}
	for _, s := range bad {
		if ValidSoundFileBase(s) {
			t.Errorf("ValidSoundFileBase(%q) = true, want false", s)
		}
	}
}

// TestExtractRealCS2Sounds runs the shipped-bytes half of the acceptance
// suite against a real local Counter-Strike 2 install (FindCS2
// auto-detects): the four resource shapes the table spans — a v5
// CTRL/KV3 file (ak47_01), a v4 DATA file with a stereo payload
// (deagle_01), a v4 grenade detonation (hegrenade_detonate_02) and a v5
// MP3 (the knife flesh set's knife_hit_light_flesh_01) — then the whole
// ExtractSounds pipeline. Skipped when CS2 isn't installed (CI never has
// it; the synthetic fixtures above carry the portable coverage).
// Output goes to a temp dir; nothing Valve-derived is kept.
func TestExtractRealCS2Sounds(t *testing.T) {
	cs2Dir := FindCS2("")
	if cs2Dir == "" {
		t.Skip("no local CS2 install found")
	}
	v, err := openVPK(resolvePak(cs2Dir))
	if err != nil {
		t.Fatal(err)
	}
	defer v.close()

	// (stem, VPK path, expected extension, expected rate, expected channels)
	want := []struct {
		stem, vpk, ext string
		rate, channels uint32
	}{
		{"ak47_01", "sounds/weapons/ak47/ak47_01.vsnd_c", soundExtWAV, 44100, 2},                                  // v5
		{"deagle_01", "sounds/weapons/deagle/deagle_01.vsnd_c", soundExtWAV, 44100, 2},                            // v4
		{"hegrenade_detonate_02", "sounds/weapons/hegrenade/hegrenade_detonate_02.vsnd_c", soundExtWAV, 44100, 2}, // v4
		// Feature A's HE throw: the ONE table path under sounds/items/
		// and a resource-v5 MP3 (raw stream like the knife set — rate /
		// channels are container facts, the frame header below proves
		// the payload is playable audio).
		{"weapon_hegrenade_throw", "sounds/items/weapon_hegrenade_throw.vsnd_c", soundExtMP3, 0, 0},
		// The knife group's MP3: decodeVSnd hands back the raw stream
		// (no WAV header), so rate/channels stay unchecked here — they
		// are container facts (ffprobe: MP3 44,100 stereo) and the frame
		// header below proves the payload is playable audio.
		{"knife_hit_light_flesh_01", "sounds/weapons/knife/knife_hit_light_flesh_01.vsnd_c", soundExtMP3, 0, 0},
		// The plant/defuse cue resources: all four decode to PCM WAV —
		// c4_plant is MONO 44.1 kHz, the other three stereo (the exact
		// shapes the soundTable comment records).
		{"c4_initiate", "sounds/weapons/c4/c4_initiate.vsnd_c", soundExtWAV, 44100, 2},
		{"c4_plant", "sounds/weapons/c4/c4_plant.vsnd_c", soundExtWAV, 44100, 1},
		{"c4_disarmstart", "sounds/weapons/c4/c4_disarmstart.vsnd_c", soundExtWAV, 44100, 2},
		{"c4_disarmfinish", "sounds/weapons/c4/c4_disarmfinish.vsnd_c", soundExtWAV, 44100, 2},
		// The headshot kill cue pair's files (dink single-file, bare set's
		// first variant): both PCM16 44.1 kHz stereo (cs2find sound,
		// 2026-11-11).
		{"headshot_armor_e1", "sounds/player/headshot_armor_e1.vsnd_c", soundExtWAV, 44100, 2},
		{"headshot_noarmor_01", "sounds/player/headshot_noarmor_01.vsnd_c", soundExtWAV, 44100, 2},
	}
	for _, tc := range want {
		raw, found, rerr := v.read(tc.vpk)
		if rerr != nil || !found {
			t.Fatalf("%s: found=%v err=%v", tc.vpk, found, rerr)
		}
		data, ext, derr := decodeVSnd(raw)
		if derr != nil {
			t.Fatalf("%s: decode: %v", tc.stem, derr)
		}
		if ext != tc.ext {
			t.Errorf("%s: ext = %q, want %q", tc.stem, ext, tc.ext)
		}
		if len(data) <= 44 {
			t.Fatalf("%s: decoded %d bytes, no audio", tc.stem, len(data))
		}
		if ext == soundExtWAV {
			if string(data[0:4]) != "RIFF" || string(data[8:12]) != "WAVE" {
				t.Errorf("%s: not a RIFF/WAVE file (head %.12q)", tc.stem, data[:12])
			}
			if got := binary.LittleEndian.Uint32(data[24:28]); got != tc.rate {
				t.Errorf("%s: rate = %d, want %d", tc.stem, got, tc.rate)
			}
			if got := binary.LittleEndian.Uint16(data[22:24]); got != uint16(tc.channels) {
				t.Errorf("%s: channels = %d, want %d", tc.stem, got, tc.channels)
			}
			// The declared data chunk must match the bytes after it.
			dataLen := binary.LittleEndian.Uint32(data[40:44])
			if int(dataLen) != len(data)-44 {
				t.Errorf("%s: data chunk %d != %d trailing bytes", tc.stem, dataLen, len(data)-44)
			}
		}
		if ext == soundExtMP3 {
			// Raw MP3 stream: a frame-sync byte or an ID3 tag — anything
			// else would mean the payload handed to the browser is not
			// playable audio.
			if data[0] != 0xFF && string(data[:3]) != "ID3" {
				t.Errorf("%s: payload is not an MP3 stream (head % x)", tc.stem, data[:4])
			}
		}
	}

	// Whole pipeline: every table entry extracts, no per-file errors.
	out := t.TempDir()
	names, errs, err := ExtractSounds(cs2Dir, out)
	if err != nil {
		t.Fatalf("ExtractSounds: %v", err)
	}
	if len(errs) > 0 {
		t.Errorf("per-file errors: %v", errs)
	}
	if len(names) != len(soundTable) {
		t.Errorf("extracted %d names, want %d (the whole table)", len(names), len(soundTable))
	}
	files := SoundFiles(out)
	for _, key := range []string{
		"AK-47", "Desert Eagle", "C4",
		"C4 beep A", "C4 beep B",
		"HE Grenade", "Smoke Grenade", "HE Grenade throw",
		"Headshot dink", "Headshot bare",
	} {
		if len(files[key]) == 0 {
			t.Errorf("manifest key %q missing (have %d keys)", key, len(files))
		}
	}
	// Every written file satisfies the route whitelist and is non-empty.
	written := 0
	for _, fs := range files {
		for _, f := range fs {
			written++
			if !ValidSoundFileBase(f) {
				t.Errorf("%s fails the route whitelist", f)
			}
			info, serr := os.Stat(filepath.Join(out, f))
			if serr != nil || info.Size() == 0 {
				t.Errorf("%s: stat=%v size=%v", f, serr, info)
			}
		}
	}
	if written < 50 {
		t.Errorf("only %d variant files written, want ≥50", written)
	}
	// A stray file is never manifested (same rule as IconFiles).
	if err := os.WriteFile(filepath.Join(out, "flair0.wav"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := SoundFiles(out); len(got) != len(files) {
		t.Errorf("SoundFiles with stray = %d keys, want %d", len(got), len(files))
	}
}
