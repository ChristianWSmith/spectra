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
// enum spelling would silently never play. Also pins the per-name VPK
// paths' shape and the output-filename uniqueness the reverse index needs.
func TestSoundTableKeysInIconTable(t *testing.T) {
	if len(soundTable) == 0 {
		t.Fatal("soundTable is empty")
	}
	seen := map[string]string{}
	for name, paths := range soundTable {
		if _, ok := iconTable[name]; !ok {
			t.Errorf("soundTable key %q is not in iconTable (the frontend's canonical names)", name)
		}
		if len(paths) == 0 {
			t.Errorf("soundTable[%q] has no paths", name)
		}
		for _, vp := range paths {
			if !strings.HasSuffix(vp, soundSuffix) {
				t.Errorf("soundTable[%q] path %q lacks %s", name, vp, soundSuffix)
			}
			if !strings.HasPrefix(vp, "sounds/weapons/") {
				t.Errorf("soundTable[%q] path %q is outside sounds/weapons/", name, vp)
			}
			// Extracted filenames collide across names only if two VPK
			// paths share a basename — the reverse index would merge them.
			stem := soundStem(vp)
			if prev, dup := seen[stem]; dup {
				t.Errorf("output filename %q shared by %q and %q", stem, prev, name)
			}
			seen[stem] = name
		}
	}

	// Spot pins on the mappings other layers key on (verified against a
	// real install by TestExtractRealCS2Sounds).
	want := map[string][]string{
		"AK-47":         {"sounds/weapons/ak47/ak47_01.vsnd_c", "sounds/weapons/ak47/ak47_02.vsnd_c", "sounds/weapons/ak47/ak47_04.vsnd_c"},
		"M4A1":          {"sounds/weapons/m4a1/m4a1_silencer_01.vsnd_c"},
		"Desert Eagle":  {"sounds/weapons/deagle/deagle_01.vsnd_c", "sounds/weapons/deagle/deagle_02.vsnd_c"},
		"C4":            {"sounds/weapons/c4/c4_explode1.vsnd_c"},
		"HE Grenade":    {"sounds/weapons/hegrenade/hegrenade_detonate_02.vsnd_c", "sounds/weapons/hegrenade/hegrenade_detonate_03.vsnd_c"},
		"Smoke Grenade": {"sounds/weapons/smokegrenade/smoke_emit.vsnd_c"},
		"Zeus x27":      {"sounds/weapons/taser/taser_shoot.vsnd_c"},
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
	}
	for name, paths := range want {
		got := soundTable[name]
		if strings.Join(got, ",") != strings.Join(paths, ",") {
			t.Errorf("soundTable[%q] = %v, want %v", name, got, paths)
		}
	}
	// The decoy has no detonation sound in the game — its absence is the
	// contract (the replay's decoy visuals stay silent).
	if _, ok := soundTable["Decoy Grenade"]; ok {
		t.Error("Decoy Grenade must have no soundTable entry (no such sound exists)")
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
		// The knife group's MP3: decodeVSnd hands back the raw stream
		// (no WAV header), so rate/channels stay unchecked here — they
		// are container facts (ffprobe: MP3 44,100 stereo) and the frame
		// header below proves the payload is playable audio.
		{"knife_hit_light_flesh_01", "sounds/weapons/knife/knife_hit_light_flesh_01.vsnd_c", soundExtMP3, 0, 0},
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
	for _, key := range []string{"AK-47", "Desert Eagle", "C4", "HE Grenade", "Smoke Grenade"} {
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
