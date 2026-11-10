package mappack

import (
	"bytes"
	"encoding/binary"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pierrec/lz4/v4"
)

// cs2find tests: every case runs the CLI against a synthetic
// pak01_dir.vpk (buildVPK + the fixtures the mappack suite already has),
// so nothing here needs a CS2 install and nothing Valve-derived is kept —
// output only ever lands in t.TempDir().

// runDevToolForTest runs the CLI with an explicit install (manual) and
// returns (exit code, stdout, stderr). manual is the synthetic pak path,
// or "" for the real FindCS2 auto-detect (the install-gated test).
func runDevToolForTest(t *testing.T, manual string, args ...string) (int, string, string) {
	t.Helper()
	var out, errOut bytes.Buffer
	code := runDevTool(args, &out, &errOut, manual)
	return code, out.String(), errOut.String()
}

// devToolPK writes a synthetic install (a pak01_dir.vpk holding files)
// and returns the path the CLI is pointed at.
func devToolPK(t *testing.T, files map[string][]byte) string {
	t.Helper()
	return buildVPK(t, t.TempDir(), files)
}

// --- where / help / no-install -------------------------------------------

func TestDevToolNoInstall(t *testing.T) {
	// A pointed install without a pak must fail with the developer-facing
	// wording (the extractors phrase the same failure for players) — and
	// must not fall back to whatever install happens to be on the machine.
	code, _, stderr := runDevToolForTest(t, filepath.Join(t.TempDir(), "no-cs2"), "where")
	if code == 0 {
		t.Fatalf("exit 0 with no install; stderr=%q", stderr)
	}
	if !strings.Contains(stderr, "no pak01_dir.vpk") {
		t.Errorf("stderr = %q, want it to mirror \"no pak01_dir.vpk under <dir>\"", stderr)
	}
}

func TestDevToolUsage(t *testing.T) {
	code, stdout, stderr := runDevToolForTest(t, "")
	if code != 2 {
		t.Errorf("no args: exit %d, want 2", code)
	}
	if !strings.Contains(stderr, "READ-ONLY") || !strings.Contains(stderr, "Valve IP") {
		t.Errorf("usage (stderr) must state the READ-ONLY + Valve-IP posture, got:\n%s", stderr)
	}
	if stdout != "" {
		t.Errorf("no args: stdout = %q, want the usage on stderr", stdout)
	}
	// The two new commands' help must cite the CS2.md entries their
	// facts come from, so nobody re-derives the hash seed.
	code, stdout, _ = runDevToolForTest(t, "", "hash", "--help")
	if code != 0 {
		t.Errorf("hash --help: exit %d", code)
	}
	if !strings.Contains(stdout, "0x53524332") || !strings.Contains(stdout, "CS2.md") {
		t.Errorf("hash --help must cite the CS2.md seed entry, got:\n%s", stdout)
	}
	code, stdout, _ = runDevToolForTest(t, "", "events", "--help")
	if code != 0 {
		t.Errorf("events --help: exit %d", code)
	}
	for _, want := range []string{"binary-KV3", "CS2.md", "vsnd_files"} {
		if !strings.Contains(stdout, want) {
			t.Errorf("events --help missing %q:\n%s", want, stdout)
		}
	}
}

// --- where -----------------------------------------------------------------

func TestDevToolWhere(t *testing.T) {
	pak := devToolPK(t, map[string][]byte{
		"sounds/weapons/c4/c4_beep2.vsnd_c": {1},
	})
	code, stdout, stderr := runDevToolForTest(t, pak, "where")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, stderr)
	}
	if got := strings.TrimSpace(stdout); got != pak {
		t.Errorf("where = %q, want %q", got, pak)
	}
}

// --- find ------------------------------------------------------------------

func TestDevToolFind(t *testing.T) {
	pak := devToolPK(t, map[string][]byte{
		"sounds/weapons/c4/c4_beep2.vsnd_c":           {1},
		"sounds/weapons/c4/c4_beep3.vsnd_c":           {2},
		"sounds/weapons/ak47/ak47_01.vsnd_c":          {3},
		"panorama/images/icons/equipment/ak47.vsvg_c": {4},
		"resource/overviews/de_fixture.txt":           []byte(`"de_fixture" {}`),
	})
	all := "panorama/images/icons/equipment/ak47.vsvg_c\n" +
		"resource/overviews/de_fixture.txt\n" +
		"sounds/weapons/ak47/ak47_01.vsnd_c\n" +
		"sounds/weapons/c4/c4_beep2.vsnd_c\n" +
		"sounds/weapons/c4/c4_beep3.vsnd_c\n"
	sounds := "sounds/weapons/ak47/ak47_01.vsnd_c\n" +
		"sounds/weapons/c4/c4_beep2.vsnd_c\n" +
		"sounds/weapons/c4/c4_beep3.vsnd_c\n"

	tests := []struct {
		name string
		args []string
		want int
		out  string
	}{
		{"prefix", []string{"find", "--prefix", "sounds/"}, 0, sounds},
		// Arguments are lowercased first: matching is case-insensitive.
		{"prefix upper", []string{"find", "--prefix", "SOUNDS/", "--suffix", ".VSND_C"}, 0, sounds},
		{"prefix+suffix", []string{"find", "--prefix", "sounds/weapons/c4/", "--suffix", "beep3.vsnd_c"}, 0,
			"sounds/weapons/c4/c4_beep3.vsnd_c\n"},
		{"contains", []string{"find", "--contains", "C4_BEEP"}, 0,
			"sounds/weapons/c4/c4_beep2.vsnd_c\nsounds/weapons/c4/c4_beep3.vsnd_c\n"},
		{"contains all", []string{"find", "--contains", "."}, 0, all},
		{"empty contains", []string{"find", "--contains", ""}, 2, ""},
		{"no match", []string{"find", "--prefix", "no/such/"}, 1, ""},
		{"no flags", []string{"find"}, 2, ""},
		{"mixed modes", []string{"find", "--contains", "x", "--prefix", "y"}, 2, ""},
		{"bad flag", []string{"find", "--nope", "y"}, 2, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			code, stdout, stderr := runDevToolForTest(t, pak, tc.args...)
			if code != tc.want {
				t.Errorf("exit %d, want %d (stderr=%q)", code, tc.want, stderr)
			}
			if stdout != tc.out {
				t.Errorf("stdout =\n%q\nwant\n%q", stdout, tc.out)
			}
		})
	}
}

// --- get (vtex → PNG at NATIVE size) --------------------------------------

func TestDevToolGetVTex(t *testing.T) {
	const w, h = 8, 6
	bgra := buildVTex(t, w, h, vtexFormatBGRA8888, bgraPix(w, h), false)
	// DXT5: block-compressed, 8×8 → two 4×4 blocks per axis.
	dxt := buildVTex(t, 8, 8, vtexFormatDXT5, make([]byte, imageSize(8, 8, 16)), false)
	pak := devToolPK(t, map[string][]byte{
		"panorama/images/overheadmaps/de_a_radar_psd.vtex_c": bgra,
		"panorama/images/overheadmaps/de_b_radar_psd.vtex_c": dxt,
	})

	// -o <file>: an explicit PNG path.
	file := filepath.Join(t.TempDir(), "bgra.png")
	code, stdout, stderr := runDevToolForTest(t, pak,
		"get", "panorama/images/overheadmaps/de_a_radar_psd.vtex_c", "-o", file)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, stderr)
	}
	if !strings.Contains(stdout, "8x6 (native)") {
		t.Errorf("stdout = %q, want the native bounds", stdout)
	}
	if !strings.Contains(stdout, "Valve IP") {
		t.Errorf("stdout = %q, want the Valve-IP notice", stdout)
	}
	checkPNG := func(path string, wantW, wantH int) {
		t.Helper()
		f, err := os.Open(path)
		if err != nil {
			t.Fatalf("open %s: %v", path, err)
		}
		defer func() { _ = f.Close() }()
		img, err := png.Decode(f)
		if err != nil {
			t.Fatalf("decode %s: %v", path, err)
		}
		// NATIVE size pins the no-upscale contract: writePNGAtomic (the
		// shipped radar path) would have written 2× this.
		if img.Bounds().Dx() != wantW || img.Bounds().Dy() != wantH {
			t.Errorf("%s = %v, want %dx%d (native, not upscaled)", path, img.Bounds(), wantW, wantH)
		}
	}
	checkPNG(file, w, h)

	// -o <dir/> (trailing separator): the file lands inside the dir.
	dir := filepath.Join(t.TempDir(), "out") + string(os.PathSeparator)
	code, _, stderr = runDevToolForTest(t, pak,
		"get", "panorama/images/overheadmaps/de_b_radar_psd.vtex_c", "-o", dir)
	if code != 0 {
		t.Fatalf("dxt5 exit %d: %s", code, stderr)
	}
	checkPNG(filepath.Join(dir, "de_b_radar_psd.png"), 8, 8)

	// A missing -o resolves to <tmp>/cs2find/ — never the repo tree —
	// and that default is computed without writing anywhere.
	if got, want := devToolDest("", "de_a_radar_psd", ".png", true),
		filepath.Join(os.TempDir(), "cs2find", "de_a_radar_psd.png"); got != want {
		t.Errorf("default dest = %q, want %q", got, want)
	}

	// Not a texture: the decode error surfaces, nothing is written.
	code, _, stderr = runDevToolForTest(t, pak, "get", "resource/overviews/de_fixture.txt")
	if code == 0 {
		t.Errorf("non-vtex: exit 0 (stderr=%q)", stderr)
	}
}

// --- sound (.vsnd_c → .wav) -----------------------------------------------

func TestDevToolSound(t *testing.T) {
	pcm := make([]byte, 8) // 4 frames of mono PCM16
	v4 := buildVSndV4(t, 44100, 0 /*PCM16*/, 1, 4, pcm)
	v5 := buildVSndV5(t,
		[]string{
			"_class", "CVoiceContainerDefault", "m_vSound",
			"m_nRate", "m_nFormat", "PCM16", "m_nChannels", "m_nStreamingSize",
		},
		[]uint32{
			3, 8, // header
			0, 1, // _class
			2,        // m_vSound → inline object
			3, 44100, // m_nRate
			4, 5, // m_nFormat = "PCM16"
			6, 2, // m_nChannels
			7, 8, // m_nStreamingSize == payload
		},
		make([]byte, 8))
	adpcm := buildVSndV4(t, 44100, 3 /*ADPCM*/, 1, 4, pcm)
	pak := devToolPK(t, map[string][]byte{
		"sounds/weapons/c4/c4_beep2.vsnd_c":  v4,
		"sounds/weapons/ak47/ak47_01.vsnd_c": v5,
		"sounds/weapons/bad/bad.vsnd_c":      adpcm,
	})

	dir := filepath.Join(t.TempDir(), "v4") + string(os.PathSeparator)
	code, stdout, stderr := runDevToolForTest(t, pak, "sound", "sounds/weapons/c4/c4_beep2.vsnd_c", "-o", dir)
	if code != 0 {
		t.Fatalf("v4 exit %d: %s", code, stderr)
	}
	if !strings.Contains(stdout, "format=PCM16 rate=44100 channels=1") {
		t.Errorf("v4 stdout = %q, want the container format/rate/channels", stdout)
	}
	if !strings.Contains(stdout, "Valve IP") {
		t.Errorf("v4 stdout = %q, want the Valve-IP notice", stdout)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "c4_beep2.wav"))
	if err != nil {
		t.Fatalf("v4 output: %v", err)
	}
	if string(raw[0:4]) != "RIFF" || !strings.Contains(string(raw[:44]), "fmt ") {
		t.Errorf("v4 output is not a RIFF/WAVE file (head %.12q)", raw[:12])
	}

	// v5 (CTRL/binary-KV3) branch.
	dir = filepath.Join(t.TempDir(), "v5") + string(os.PathSeparator)
	code, _, stderr = runDevToolForTest(t, pak, "sound", "sounds/weapons/ak47/ak47_01.vsnd_c", "-o", dir)
	if code != 0 {
		t.Fatalf("v5 exit %d: %s", code, stderr)
	}
	raw, err = os.ReadFile(filepath.Join(dir, "ak47_01.wav"))
	if err != nil {
		t.Fatalf("v5 output: %v", err)
	}
	if string(raw[0:4]) != "RIFF" {
		t.Errorf("v5 output head = %.12q, want RIFF", raw[:12])
	}

	// ADPCM is rejected cleanly (decodeVSnd's own error, nothing written).
	code, _, stderr = runDevToolForTest(t, pak, "sound", "sounds/weapons/bad/bad.vsnd_c",
		"-o", filepath.Join(t.TempDir(), "adpcm")+string(os.PathSeparator))
	if code == 0 {
		t.Fatalf("ADPCM: exit 0 (stderr=%q)", stderr)
	}
	if !strings.Contains(stderr, "ADPCM") {
		t.Errorf("ADPCM stderr = %q, want the decoder's ADPCM error", stderr)
	}
	if entries, _ := os.ReadDir(filepath.Join(t.TempDir(), "adpcm")); len(entries) != 0 {
		t.Errorf("ADPCM wrote %d files", len(entries))
	}
}

// --- overview ---------------------------------------------------------------

func TestDevToolOverview(t *testing.T) {
	fixture := `"de_fixture"
{
	"pos_x"		"-2476"
	"pos_y"		"3239"
	"scale"		"4.4"
	"rotate"	"1"
	"bombA_x"	"0.54"
	"bombA_y"	"0.76"
	"bombB_x"	"0.23"
	"bombB_y"	"0.28"
	"CTSpawn_x"	"0.28"
	"CTSpawn_y"	"0.70"
	"TSpawn_x"	"0.87"
	"TSpawn_y"	"0.36"
	"verticalsections"
	{
		"lower"
		{
			"AltitudeMin"	"-10000"
			"AltitudeMax"	"-495"
		}
		"default"
		{
			"AltitudeMin"	"-495"
			"AltitudeMax"	"10000"
		}
	}
}
`
	pak := devToolPK(t, map[string][]byte{
		"resource/overviews/de_fixture.txt": []byte(fixture),
	})
	code, stdout, stderr := runDevToolForTest(t, pak, "overview", "de_fixture")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, stderr)
	}
	// Every key the pack contract reads must be printed, with the
	// verticalsections in parseOverview's order (default first).
	for _, want := range []string{
		"pos_x     -2476",
		"pos_y     3239",
		"scale     4.4",
		"rotate    1",
		"sites     A=(0.54, 0.76) B=(0.23, 0.28)",
		"spawns    CT=(0.28, 0.7) T=(0.87, 0.36)",
		"sections  default [-495, 10000]; lower [-10000, -495]",
	} {
		if !strings.Contains(stdout, want) {
			t.Errorf("stdout missing %q:\n%s", want, stdout)
		}
	}

	// A map with no overview is reported, not printed as empty.
	code, _, stderr = runDevToolForTest(t, pak, "overview", "de_missing")
	if code == 0 {
		t.Errorf("missing overview: exit 0 (stderr=%q)", stderr)
	}
}

// --- table / icon (the canonical tables, read-only) -------------------------

func TestDevToolTable(t *testing.T) {
	// No install needed: these only READ the canonical tables.
	beforeSounds, beforeIcons := len(soundTable), len(extractTable)
	code, stdout, stderr := runDevToolForTest(t, "", "table", "sounds")
	if code != 0 {
		t.Fatalf("table sounds: exit %d: %s", code, stderr)
	}
	if !strings.Contains(stdout, "AK-47\tsounds/weapons/ak47/ak47_01.vsnd_c\n") {
		t.Errorf("table sounds missing the AK-47 mapping:\n%s", stdout)
	}
	if strings.Count(stdout, "\n") != countSoundTablePaths() {
		t.Errorf("table sounds printed %d rows, want %d", strings.Count(stdout, "\n"), countSoundTablePaths())
	}
	code, stdout, stderr = runDevToolForTest(t, "", "table", "icons")
	if code != 0 {
		t.Fatalf("table icons: exit %d: %s", code, stderr)
	}
	if !strings.Contains(stdout, "AK-47\tpanorama/images/icons/equipment/ak47.vsvg_c\n") {
		t.Errorf("table icons missing the AK-47 mapping:\n%s", stdout)
	}
	if code, _, _ = runDevToolForTest(t, "", "table", "nope"); code != 2 {
		t.Errorf("table nope: exit %d, want 2", code)
	}
	// Read-only: dumping must not touch the tables.
	if len(soundTable) != beforeSounds || len(extractTable) != beforeIcons {
		t.Errorf("tables mutated by a dump: soundTable %d→%d, extractTable %d→%d",
			beforeSounds, len(soundTable), beforeIcons, len(extractTable))
	}
}

func countSoundTablePaths() int {
	n := 0
	for _, paths := range soundTable {
		n += len(paths)
	}
	return n
}

func TestDevToolIcon(t *testing.T) {
	code, stdout, stderr := runDevToolForTest(t, "", "icon", "AK-47")
	if code != 0 {
		t.Fatalf("icon AK-47: exit %d: %s", code, stderr)
	}
	for _, want := range []string{"AK-47", "equipment", "panorama/images/icons/equipment/ak47.vsvg_c", "in extractTable"} {
		if !strings.Contains(stdout, want) {
			t.Errorf("icon AK-47 missing %q: %s", want, stdout)
		}
	}
	// The death-notice family resolves through its own prefix.
	code, stdout, _ = runDevToolForTest(t, "", "icon", "explosion")
	if code != 0 || !strings.Contains(stdout, "deathnotice") ||
		!strings.Contains(stdout, "panorama/images/hud/kill_pip_blast.vsvg_c") {
		t.Errorf("icon explosion: exit %d out=%q", code, stdout)
	}
	// An unknown key is a miss, never a path built from an empty name.
	code, stdout, _ = runDevToolForTest(t, "", "icon", "Nope")
	if code == 0 {
		t.Errorf("unknown icon: exit 0 (out=%q)", stdout)
	}
	if !strings.Contains(stdout, "not in extractTable") {
		t.Errorf("unknown icon out = %q, want the miss", stdout)
	}
}

// --- hash -------------------------------------------------------------------

func TestMurmurHash2(t *testing.T) {
	// The published vector CS2.md recorded for the packed_params seed —
	// the gate `hash` runs before printing anything.
	if got := murmur2([]byte("public.volume"), 0x31415926); got != 0xbd6054e9 {
		t.Errorf("murmur2(public.volume, 0x31415926) = %#08x, want 0xBD6054E9", got)
	}
	if err := murmurSelfCheck(); err != nil {
		t.Errorf("murmurSelfCheck: %v", err)
	}
	// The demo hashes the LOWERCASED name: both spellings are one hash.
	if soundEventHash("Weapon_AK47.Single") != soundEventHash("weapon_ak47.single") {
		t.Error("lowercase fold: Weapon_AK47.Single and weapon_ak47.single must hash alike")
	}
	// …and the CLI prints the same digest for both.
	_, outUpper, _ := runDevToolForTest(t, "", "hash", "Weapon_AK47.Single")
	_, outLower, _ := runDevToolForTest(t, "", "hash", "weapon_ak47.single")
	hexOf := func(s string) string {
		_, h, ok := strings.Cut(strings.TrimSpace(s), " = ")
		if !ok {
			return ""
		}
		return h
	}
	if hexOf(outUpper) == "" || hexOf(outUpper) != hexOf(outLower) {
		t.Errorf("hash digests differ:\n%q\n%q", outUpper, outLower)
	}
	// The seed is part of the contract: another seed is another digest.
	if murmur2([]byte("public.volume"), 0x53524332) == 0xbd6054e9 {
		t.Error("seed0x53524332 must not reproduce the 0x31415926 vector")
	}
}

// --- events / hash --resolve (synthetic vsndevts) ---------------------------

// buildVSndevts constructs a synthetic soundevents/*.vsndevts_c
// resource: 16-byte resource header, one DATA block holding the 120-byte
// binary-KV3 header (magic, GUID, compression, the four buffer sizes at
// 72/76/80/84) and the two buffers — the NUL string table, then the u32
// pair stream plus the 0xFFEEDD00 trailer. raw=false LZ4-compresses both
// buffers (the shape every shipped file but one uses), raw=true stores
// them uncompressed (soundevents/soundevents_from_tools.vsndevts_c's
// shape).
func buildVSndevts(t *testing.T, strs []string, stream []uint32, raw bool) []byte {
	t.Helper()
	b1 := []byte(strings.Join(strs, "\x00") + "\x00")
	var b2 []byte
	for _, u := range stream {
		b2 = binary.LittleEndian.AppendUint32(b2, u)
	}
	b2 = append(b2, 0x00, 0xdd, 0xee, 0xff)

	unc1, unc2 := len(b1), len(b2)
	stored1, stored2 := unc1, unc2
	comp := uint32(0)
	if !raw {
		comp = 1
		b1, b2 = lz4TestCompress(t, b1), lz4TestCompress(t, b2)
		stored1, stored2 = len(b1), len(b2)
	}

	block := make([]byte, vsndCtrlHeaderSize, vsndCtrlHeaderSize+stored1+stored2)
	block[0], block[1], block[2], block[3] = 0x05, 0x33, 0x56, 0x4b // KV3 v5 magic
	binary.LittleEndian.PutUint32(block[20:24], comp)
	binary.LittleEndian.PutUint32(block[vsndCtrlOffUnc1:], uint32(unc1))
	binary.LittleEndian.PutUint32(block[vsndCtrlOffUnc2:], uint32(unc2))
	if comp == 1 {
		binary.LittleEndian.PutUint32(block[vsndCtrlOffComp1:], uint32(stored1))
		binary.LittleEndian.PutUint32(block[vsndCtrlOffComp2:], uint32(stored2))
	}
	block = append(block, b1...)
	block = append(block, b2...)

	structured := 16 + 12 + len(block)
	buf := make([]byte, 0, structured)
	hdr := make([]byte, 16)
	binary.LittleEndian.PutUint32(hdr[0:4], uint32(structured)) // FileSize: payload offset
	binary.LittleEndian.PutUint16(hdr[4:6], 12)                 // header version
	binary.LittleEndian.PutUint16(hdr[6:8], 1)                  // resource version (not read here)
	binary.LittleEndian.PutUint32(hdr[8:12], 8)                 // block table at 8+8
	binary.LittleEndian.PutUint32(hdr[12:16], 1)                // one block
	buf = append(buf, hdr...)

	entry := make([]byte, 12) // offset relative to the offset field (pos 20 → block at 28)
	copy(entry[0:4], "DATA")
	binary.LittleEndian.PutUint32(entry[4:8], 8)
	binary.LittleEndian.PutUint32(entry[8:12], uint32(len(block)))
	buf = append(buf, entry...)
	return append(buf, block...)
}

// lz4TestCompress is LZ4 for the fixture; a 0 return (incompressible)
// fails the test rather than silently shipping an unreadable fixture.
func lz4TestCompress(t *testing.T, raw []byte) []byte {
	t.Helper()
	dst := make([]byte, lz4.CompressBlockBound(len(raw)))
	n, err := lz4.CompressBlock(raw, dst, nil)
	if err != nil || n == 0 {
		t.Fatalf("lz4 compress of %d bytes: n=%d err=%v", len(raw), n, err)
	}
	return dst[:n]
}

// vsndevtsFixture is a two-event stream pinning the walker's rules:
// c4.initiate owns its vsnd_files, the soundevent_01 run (c4.child) is a
// REFERENCE — not a definition — and c4.child is defined right after it
// with a file of its own. If references were read as definitions,
// c4.initiate would come out file-less.
func vsndevtsFixture() (strs []string, stream []uint32) {
	strs = []string{
		"c4.initiate",                        // 0
		"vsnd_files_track_01",                // 1
		"sounds/weapons/c4/c4_initiate.vsnd", // 2
		"soundevent_01",                      // 3
		"c4.child",                           // 4
		"mixgroup",                           // 5
		"Explosions",                         // 6
		"sounds/weapons/c4/c4_child.vsnd",    // 7
		strings.Repeat("padpadpad", 16),      // 8 — keeps the fixture LZ4-compressible
	}
	stream = []uint32{
		uint32(len(strs)), 2, // the stream's own header u32s
		0,    // KEY c4.initiate → defines the event
		1, 2, //   vsnd_files_track_01 = its file
		3, 4, //   soundevent_01 = c4.child (a REFERENCE)
		5, 6, //   mixgroup = "Explosions" (ends the reference run)
		4,    // KEY c4.child → defines the second event
		1, 7, //   vsnd_files_track_01 = its file
	}
	// Padding keeps LZ4's compressor interested without changing the walk:
	// raw numbers are neither names nor paths.
	for i := 0; i < 32; i++ {
		stream = append(stream, 0x7fffffff)
	}
	return strs, stream
}

func TestDevToolEvents(t *testing.T) {
	strs, stream := vsndevtsFixture()
	pak := devToolPK(t, map[string][]byte{
		"soundevents/game_sounds_test.vsndevts_c": buildVSndevts(t, strs, stream, false),
		// The one shipped file with uncompressed buffers.
		"soundevents/soundevents_from_tools.vsndevts_c": buildVSndevts(t,
			[]string{"raw.event", "vsnd_files_track_01", "sounds/raw/event.vsnd",
				strings.Repeat("padpadpad", 16)},
			[]uint32{3, 2, 0, 1, 2}, true),
	})

	code, stdout, stderr := runDevToolForTest(t, pak, "events")
	if code != 0 {
		t.Fatalf("events: exit %d: %s", code, stderr)
	}
	for _, want := range []string{
		"c4.child\tsounds/weapons/c4/c4_child.vsnd\n",
		"c4.initiate\tsounds/weapons/c4/c4_initiate.vsnd\n",
		"raw.event\tsounds/raw/event.vsnd\n",
	} {
		if !strings.Contains(stdout, want) {
			t.Errorf("events missing %q:\n%s", want, stdout)
		}
	}
	// Sorted, and the reference (c4.child inside c4.initiate's object) is
	// listed ONCE — as its own definition.
	if strings.Count(stdout, "c4.child\t") != 1 {
		t.Errorf("c4.child listed %d times:\n%s", strings.Count(stdout, "c4.child\t"), stdout)
	}

	// The pattern filter.
	code, stdout, stderr = runDevToolForTest(t, pak, "events", "C4.")
	if code != 0 {
		t.Fatalf("events c4.: exit %d: %s", code, stderr)
	}
	if strings.Contains(stdout, "raw.event") {
		t.Errorf("pattern filter leaked raw.event:\n%s", stdout)
	}
	// No match is an error, not an empty success.
	if code, _, _ := runDevToolForTest(t, pak, "events", "no.such.event"); code == 0 {
		t.Error("events with no match: exit 0")
	}

	// name → hash → resolve → name, through the CLI.
	_, out, _ := runDevToolForTest(t, pak, "hash", "c4.initiate")
	hex := strings.TrimSpace(strings.TrimPrefix(out, "c4.initiate = "))
	if !strings.HasPrefix(hex, "0x") {
		t.Fatalf("hash output = %q", out)
	}
	code, stdout, stderr = runDevToolForTest(t, pak, "hash", "--resolve", hex)
	if code != 0 {
		t.Fatalf("resolve: exit %d: %s", code, stderr)
	}
	if !strings.Contains(stdout, "c4.initiate") {
		t.Errorf("resolve(%s) = %q, want c4.initiate", hex, stdout)
	}
	// An unknown hash is an error, never a invented name.
	if code, _, _ := runDevToolForTest(t, pak, "hash", "--resolve", "deadbeef"); code == 0 {
		t.Error("resolve of an unknown hash: exit 0")
	}
}

// --- real install (skipped where CS2 isn't installed) -----------------------

// TestDevToolRealInstall runs cs2find against a real local Counter-Strike
// 2 install (FindCS2 auto-detect) — the shipped-bytes half of the suite.
// Skipped when CS2 isn't installed (CI never has it; the synthetic
// fixtures above carry the portable coverage). Output goes to temp dirs;
// nothing Valve-derived is kept.
func TestDevToolRealInstall(t *testing.T) {
	if FindCS2("") == "" {
		t.Skip("no local CS2 install found")
	}
	out := t.TempDir()

	// find over the C4 sounds.
	code, stdout, stderr := runDevToolForTest(t, "", "find", "--prefix", "sounds/weapons/c4/")
	if code != 0 {
		t.Fatalf("find: exit %d: %s", code, stderr)
	}
	if !strings.Contains(stdout, "sounds/weapons/c4/c4_beep2.vsnd_c") {
		t.Errorf("find output missing c4_beep2.vsnd_c:\n%s", stdout)
	}

	// get: the PNG must be the NATIVE size (writePNGAtomic would double
	// it — this pins that `get` bypasses the upscale).
	getDir := filepath.Join(out, "png") + string(os.PathSeparator)
	code, stdout, stderr = runDevToolForTest(t, "",
		"get", "panorama/images/overheadmaps/de_nuke_radar_psd.vtex_c", "-o", getDir)
	if code != 0 {
		t.Fatalf("get: exit %d: %s", code, stderr)
	}
	if !strings.Contains(stdout, "1024x1024 (native)") {
		t.Errorf("get stdout = %q, want 1024x1024 (native)", stdout)
	}
	f, err := os.Open(filepath.Join(getDir, "de_nuke_radar_psd.png"))
	if err != nil {
		t.Fatalf("get output: %v", err)
	}
	img, err := png.Decode(f)
	_ = f.Close()
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if img.Bounds().Dx() != 1024 || img.Bounds().Dy() != 1024 {
		t.Errorf("radar bounds = %v, want 1024x1024 (native)", img.Bounds())
	}

	// sound into a temp dir.
	soundDir := filepath.Join(out, "snd") + string(os.PathSeparator)
	code, _, stderr = runDevToolForTest(t, "", "sound", "sounds/weapons/c4/c4_beep2.vsnd_c", "-o", soundDir)
	if code != 0 {
		t.Fatalf("sound: exit %d: %s", code, stderr)
	}
	raw, err := os.ReadFile(filepath.Join(soundDir, "c4_beep2.wav"))
	if err != nil {
		t.Fatalf("sound output: %v", err)
	}
	if string(raw[0:4]) != "RIFF" {
		t.Errorf("sound output head = %.12q, want RIFF", raw[:12])
	}

	// Validation gate for the two new implementations: the walker parses
	// the local install's vsndevts cleanly, and a name hashes → resolves
	// → comes back.
	code, stdout, stderr = runDevToolForTest(t, "", "events", "c4.")
	if code != 0 {
		t.Fatalf("events: exit %d: %s", code, stderr)
	}
	if !strings.Contains(stdout, "c4.initiate\tsounds/weapons/c4/c4_initiate.vsnd") {
		t.Errorf("events missing c4.initiate → c4_initiate.vsnd:\n%s", stdout)
	}
	_, out, _ = runDevToolForTest(t, "", "hash", "c4.initiate")
	hex := strings.TrimSpace(strings.TrimPrefix(out, "c4.initiate = "))
	if !strings.HasPrefix(hex, "0x") {
		t.Fatalf("hash output = %q", out)
	}
	code, stdout, stderr = runDevToolForTest(t, "", "hash", "--resolve", hex)
	if code != 0 {
		t.Fatalf("resolve: exit %d: %s", code, stderr)
	}
	if !strings.Contains(stdout, "c4.initiate") {
		t.Errorf("resolve(%s) = %q, want c4.initiate", hex, stdout)
	}

	// Table-level roundtrip over a sample: every name resolves back to
	// itself (or a same-hash twin).
	pak, err := devToolPak("")
	if err != nil {
		t.Fatal(err)
	}
	v, err := openVPK(pak)
	if err != nil {
		t.Fatal(err)
	}
	defer v.close()
	tbl, err := loadVSndEvents(v)
	if err != nil {
		t.Fatalf("loadVSndEvents: %v", err)
	}
	if len(tbl) < 10000 {
		t.Errorf("only %d soundevents parsed, want the install's ~21k", len(tbl))
	}
	names := make([]string, 0, len(tbl))
	for name := range tbl {
		names = append(names, name)
	}
	sortStrings(names)
	for i := 0; i < len(names); i += 500 {
		hits := resolveSoundEvent(tbl, soundEventHash(names[i]))
		found := false
		for _, h := range hits {
			if h == names[i] {
				found = true
			}
		}
		if !found {
			t.Errorf("roundtrip: %q (hash %#08x) did not resolve back (hits %v)",
				names[i], soundEventHash(names[i]), hits)
		}
	}
}
