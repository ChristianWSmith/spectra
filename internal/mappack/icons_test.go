package mappack

import (
	"encoding/binary"
	"hash/crc32"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/common"
)

// --- fixtures -------------------------------------------------------------

// buildVSVG constructs a minimal .vsvg_c silhouette resource: 16-byte
// resource header, one DATA block whose payload is the 6-byte prefix
// (u32 CRC32 of the SVG text + u16 0) followed by the raw SVG — the
// layout CS2.md documents and real CS2 files use.
func buildVSVG(t *testing.T, svg string) []byte {
	t.Helper()
	payload := make([]byte, 6+len(svg))
	binary.LittleEndian.PutUint32(payload[0:4], crc32.ChecksumIEEE([]byte(svg)))
	copy(payload[6:], svg)

	buf := make([]byte, 0, 16+12+len(payload))
	hdr := make([]byte, 16)
	binary.LittleEndian.PutUint32(hdr[0:4], uint32(16+12+len(payload))) // fileSize
	binary.LittleEndian.PutUint16(hdr[4:6], 12)                         // header version
	binary.LittleEndian.PutUint16(hdr[6:8], 1)                          // resource version
	binary.LittleEndian.PutUint32(hdr[8:12], 8)                         // blockOffset (table at 8+8=16)
	binary.LittleEndian.PutUint32(hdr[12:16], 1)                        // blockCount
	buf = append(buf, hdr...)

	entry := make([]byte, 12) // DATA; offset is relative to the offset field (pos 20 → payload at 28: rel 8)
	copy(entry[0:4], "DATA")
	binary.LittleEndian.PutUint32(entry[4:8], 8)
	binary.LittleEndian.PutUint32(entry[8:12], uint32(len(payload)))
	buf = append(buf, entry...)
	return append(buf, payload...)
}

// --- tests ----------------------------------------------------------------

// TestIconTableCanonicalNames pins the ONE icon table: every key is
// exactly a string demoinfocs' EquipmentType.String() produces (the
// vocabulary the replay state stream and models.IsUtilityWeapon use),
// every basename is a safe lowercase file stem, and the table is 1:1 so
// the reverse manifest index can't collide.
func TestIconTableCanonicalNames(t *testing.T) {
	valid := map[string]bool{}
	for i := 0; i <= 600; i++ { // enum range: pistols..grenades (501-506)
		if s := common.EquipmentType(i).String(); s != "" {
			valid[s] = true
		}
	}
	seenBases := map[string]string{}
	for name, base := range iconTable {
		if !valid[name] {
			t.Errorf("iconTable key %q is not an EquipmentType.String() output", name)
		}
		if base == "" || !ValidIconFileBase(base+iconExt) {
			t.Errorf("iconTable[%q] = %q is not a safe file stem", name, base)
		}
		if prev, dup := seenBases[base]; dup {
			t.Errorf("iconTable basenames not 1:1: %q and %q share %q", prev, name, base)
		}
		seenBases[base] = name
	}

	// Spot pins: the names other layers key on, mapped to the VPK
	// basenames verified against a real install.
	want := map[string]string{
		"AK-47":              "ak47",
		"USP-S":              "usp_silencer",
		"M4A4":               "m4a1",
		"M4A1":               "m4a1_silencer",
		"Glock-18":           "glock",
		"SSG 08":             "ssg08",
		"SG 553":             "sg556",
		"HE Grenade":         "hegrenade",
		"Flashbang":          "flashbang",
		"Smoke Grenade":      "smokegrenade",
		"Molotov":            "molotov",
		"Incendiary Grenade": "incgrenade",
		"Decoy Grenade":      "decoy",
		"C4":                 "c4",
		"Zeus x27":           "taser",
		"Kevlar Vest":        "kevlar",
		"Kevlar + Helmet":    "armor_helmet",
		"Defuse Kit":         "defuser",
	}
	for name, base := range want {
		if got := iconTable[name]; got != base {
			t.Errorf("iconTable[%q] = %q, want %q", name, got, base)
		}
	}
	// The utility set is exactly what models.IsUtilityWeapon keys on —
	// thrown-utility animation in the render area depends on all six.
	for _, name := range []string{
		"HE Grenade", "Flashbang", "Smoke Grenade",
		"Molotov", "Incendiary Grenade", "Decoy Grenade",
	} {
		if _, ok := iconTable[name]; !ok {
			t.Errorf("utility name %q has no icon mapping", name)
		}
	}
	// Pseudo-items the UI never renders stay unmapped on purpose.
	for _, name := range []string{"UNKNOWN", "World"} {
		if _, ok := iconTable[name]; ok {
			t.Errorf("pseudo-item %q must not be in iconTable", name)
		}
	}
}

func TestDecodeVSVG(t *testing.T) {
	const svg = `<?xml version="1.0" encoding="utf-8"?>` + "\n" +
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 32"><path d="M0 0"/></svg>` + "\n"
	got, err := decodeVSVG(buildVSVG(t, svg))
	if err != nil {
		t.Fatalf("decodeVSVG: %v", err)
	}
	if string(got) != svg {
		t.Errorf("round trip = %q, want %q", got, svg)
	}

	// A minimal <svg>-headed payload (the second shape real files use).
	short := []byte(`<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>`)
	if _, err := decodeVSVG(buildVSVG(t, string(short))); err != nil {
		t.Errorf("short svg: %v", err)
	}

	// Corrupt CRC → rejected (never write a broken icon to disk).
	bad := buildVSVG(t, svg)
	bad[len(bad)-1] ^= 0xff
	if _, err := decodeVSVG(bad); err == nil {
		t.Error("corrupt payload: want CRC error")
	}

	// Truncated container → rejected.
	if _, err := decodeVSVG(buildVSVG(t, svg)[:20]); err == nil {
		t.Error("truncated: want error")
	}

	// Non-SVG payload with a valid CRC → rejected (CRC proves integrity,
	// the prefix/suffix checks prove it's actually renderable SVG).
	junk := []byte("not an svg at all")
	junkPayload := make([]byte, 6+len(junk))
	binary.LittleEndian.PutUint32(junkPayload[0:4], crc32.ChecksumIEEE(junk))
	copy(junkPayload[6:], junk)
	// Rebuild the container around the junk payload.
	hdr := buildVSVG(t, svg)[:28]
	binary.LittleEndian.PutUint32(hdr[0:4], uint32(16+12+len(junkPayload)))
	binary.LittleEndian.PutUint32(hdr[24:28], uint32(len(junkPayload)))
	if _, err := decodeVSVG(append(hdr, junkPayload...)); err == nil {
		t.Error("non-SVG payload: want error")
	}
}

// TestExtractIconsSynthetic runs the pipeline against a synthetic CS2
// install: one mapped icon present (extracted + manifested), one absent
// (reported in errs, omitted from the manifest — the frontend's
// text-label fallback path).
func TestExtractIconsSynthetic(t *testing.T) {
	install := t.TempDir()
	csgo := filepath.Join(install, "game", "csgo")
	if err := os.MkdirAll(csgo, 0o755); err != nil {
		t.Fatal(err)
	}
	const akSVG = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><path d="M1 1"/></svg>` + "\n"
	buildVPK(t, csgo, map[string][]byte{
		iconPrefix + "ak47" + iconSuffix: buildVSVG(t, akSVG),
	})

	out := t.TempDir()
	names, errs, err := ExtractIcons(install, out)
	if err != nil {
		t.Fatalf("ExtractIcons: %v", err)
	}
	if len(names) != 1 || names[0] != "AK-47" {
		t.Fatalf("names = %v, want [AK-47]", names)
	}
	// Every other mapped icon is absent from this fixture VPK: each must
	// surface as a per-name error, not a fatal one.
	if len(errs) != len(iconTable)-1 {
		t.Errorf("errs = %d entries, want %d", len(errs), len(iconTable)-1)
	}
	if !strings.Contains(strings.Join(errs, "\n"), "Smoke Grenade") {
		t.Errorf("errs should name missing icons: %v", errs)
	}

	data, err := os.ReadFile(filepath.Join(out, "ak47.svg"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != akSVG {
		t.Errorf("ak47.svg = %q, want %q", data, akSVG)
	}

	// Manifest from the dir listing: only extracted, table-known files.
	files := IconFiles(out)
	if len(files) != 1 || files["AK-47"] != "ak47.svg" {
		t.Errorf("IconFiles = %v", files)
	}
	// Strays (older game versions, hand-dropped files) are never listed.
	if err := os.WriteFile(filepath.Join(out, "flair0.svg"), []byte("<svg/>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if files := IconFiles(out); len(files) != 1 {
		t.Errorf("IconFiles with stray = %v", files)
	}
	// A missing dir reads as an empty manifest, not an error.
	if files := IconFiles(filepath.Join(out, "nope")); len(files) != 0 {
		t.Errorf("IconFiles(missing dir) = %v", files)
	}
}

func TestExtractIconsNoInstall(t *testing.T) {
	_, _, err := ExtractIcons(filepath.Join(t.TempDir(), "no-cs2"), t.TempDir())
	if err == nil {
		t.Fatal("want error for an install without pak01_dir.vpk")
	}
}

func TestValidIconFileBase(t *testing.T) {
	good := []string{"ak47.svg", "armor_helmet.svg", "c4.svg", "usp_silencer.svg", "a.svg"}
	for _, s := range good {
		if !ValidIconFileBase(s) {
			t.Errorf("ValidIconFileBase(%q) = false, want true", s)
		}
	}
	bad := []string{
		"", ".svg", "AK47.svg", "ak-47.svg", "ak47.png", "ak47.svg.tmp",
		"../ak47.svg", "sub/ak47.svg", "/etc/passwd", "ak47", "..",
		strings.Repeat("a", 61) + ".svg", // over the 64-byte cap with suffix
	}
	for _, s := range bad {
		if ValidIconFileBase(s) {
			t.Errorf("ValidIconFileBase(%q) = true, want false", s)
		}
	}
}
