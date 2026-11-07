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

// TestNoticeIconTable pins the SECOND extraction family: the death-notice
// glyphs renderer.js drawKillFeed consumes (iconFor('blind_kill') before
// the killer's name, iconFor('headshot') after the weapon). Both entries
// must decode-ready through the shared pipeline (their exact VPK paths
// under noticePrefix → <base>.svg written and re-manifested by
// TestExtractIconsSynthetic), keep safe file stems for the /api/icons
// whitelist, and never collide with the equipment table — iconFileToName
// is ONE map over both families, so a collision would silently drop a
// manifest key.
func TestNoticeIconTable(t *testing.T) {
	// Exact VPK paths (verified against a real install 2026-11-07: both
	// files decode with decodeVSVG).
	wantPaths := map[string]string{
		"headshot":   noticePrefix + "icon_headshot" + iconSuffix,
		"blind_kill": noticePrefix + "blind_kill" + iconSuffix,
	}
	if len(noticeIconTable) != len(wantPaths) {
		t.Errorf("noticeIconTable has %d entries, want %d", len(noticeIconTable), len(wantPaths))
	}
	for key, path := range wantPaths {
		base, ok := noticeIconTable[key]
		if !ok {
			t.Errorf("noticeIconTable has no %q entry (the feed asks iconFor(%q))", key, key)
			continue
		}
		if got := noticePrefix + base + iconSuffix; got != path {
			t.Errorf("noticeIconTable[%q] path = %q, want %q", key, got, path)
		}
		// Lowercase + underscore only — the same whitelist rule the
		// equipment stems pass (icon_headshot.svg, blind_kill.svg).
		if !ValidIconFileBase(base + iconExt) {
			t.Errorf("noticeIconTable[%q] = %q is not a safe file stem", key, base)
		}
	}

	// One merged extraction set: no key or basename overlap with the
	// equipment table (a basename clash would overwrite a manifest entry).
	equipBases := map[string]string{}
	for n, b := range iconTable {
		equipBases[b] = n
	}
	for key, base := range noticeIconTable {
		if _, dup := iconTable[key]; dup {
			t.Errorf("key %q collides between the icon tables", key)
		}
		if prev, dup := equipBases[base]; dup {
			t.Errorf("basename %q shared by noticeIconTable[%q] and iconTable[%q]", base, key, prev)
		}
	}
	if got, want := len(iconFileToName), len(extractTable); got != want {
		t.Errorf("iconFileToName has %d entries, want %d (a collision dropped one)", got, want)
	}

	// The reverse index the manifest builds from must resolve both
	// families — this is the contract iconservice.buildIconManifest rides.
	if got := iconFileToName["icon_headshot.svg"]; got != "headshot" {
		t.Errorf(`iconFileToName["icon_headshot.svg"] = %q, want "headshot"`, got)
	}
	if got := iconFileToName["blind_kill.svg"]; got != "blind_kill" {
		t.Errorf(`iconFileToName["blind_kill.svg"] = %q, want "blind_kill"`, got)
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
// install: two equipment + both death-notice icons present (extracted +
// manifested), the rest absent (reported in errs, omitted from the
// manifest — the frontend's text-label fallback path).
func TestExtractIconsSynthetic(t *testing.T) {
	install := t.TempDir()
	csgo := filepath.Join(install, "game", "csgo")
	if err := os.MkdirAll(csgo, 0o755); err != nil {
		t.Fatal(err)
	}
	const akSVG = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><path d="M1 1"/></svg>` + "\n"
	const hsSVG = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><path d="M2 2"/></svg>` + "\n"
	const blindSVG = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><path d="M3 3"/></svg>` + "\n"
	buildVPK(t, csgo, map[string][]byte{
		iconPrefix + "ak47" + iconSuffix: buildVSVG(t, akSVG),
		// the second family: the death-notice glyphs ride the same
		// extraction pass (noticePrefix), decode-ready through decodeVSVG
		noticePrefix + "icon_headshot" + iconSuffix: buildVSVG(t, hsSVG),
		noticePrefix + "blind_kill" + iconSuffix:    buildVSVG(t, blindSVG),
	})

	out := t.TempDir()
	names, errs, err := ExtractIcons(install, out)
	if err != nil {
		t.Fatalf("ExtractIcons: %v", err)
	}
	// Sorted: "AK-47" < "blind_kill" < "headshot" — both families in ONE
	// extraction pass.
	want := []string{"AK-47", "blind_kill", "headshot"}
	if len(names) != len(want) {
		t.Fatalf("names = %v, want %v", names, want)
	}
	for i, n := range want {
		if names[i] != n {
			t.Errorf("names[%d] = %q, want %q", i, names[i], n)
		}
	}
	// Every other mapped icon is absent from this fixture VPK: each must
	// surface as a per-name error, not a fatal one.
	if len(errs) != len(extractTable)-len(want) {
		t.Errorf("errs = %d entries, want %d", len(errs), len(extractTable)-len(want))
	}
	if !strings.Contains(strings.Join(errs, "\n"), "Smoke Grenade") {
		t.Errorf("errs should name missing icons: %v", errs)
	}

	// The three written files round-trip their exact payload.
	for file, wantSVG := range map[string]string{
		"ak47.svg":          akSVG,
		"icon_headshot.svg": hsSVG,
		"blind_kill.svg":    blindSVG,
	} {
		data, err := os.ReadFile(filepath.Join(out, file))
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != wantSVG {
			t.Errorf("%s = %q, want %q", file, data, wantSVG)
		}
	}

	// Manifest from the dir listing: only extracted, table-known files —
	// BOTH families resolve to their manifest keys (iconFileToName).
	files := IconFiles(out)
	if len(files) != len(want) {
		t.Fatalf("IconFiles = %v", files)
	}
	if files["AK-47"] != "ak47.svg" {
		t.Errorf(`IconFiles["AK-47"] = %q, want "ak47.svg"`, files["AK-47"])
	}
	if files["headshot"] != "icon_headshot.svg" {
		t.Errorf(`IconFiles["headshot"] = %q, want "icon_headshot.svg"`, files["headshot"])
	}
	if files["blind_kill"] != "blind_kill.svg" {
		t.Errorf(`IconFiles["blind_kill"] = %q, want "blind_kill.svg"`, files["blind_kill"])
	}
	// Strays (older game versions, hand-dropped files) are never listed.
	if err := os.WriteFile(filepath.Join(out, "flair0.svg"), []byte("<svg/>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if files := IconFiles(out); len(files) != len(want) {
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
	good := []string{
		"ak47.svg", "armor_helmet.svg", "c4.svg", "usp_silencer.svg", "a.svg",
		// the death-notice glyphs: lowercase + underscore only
		"icon_headshot.svg", "blind_kill.svg",
	}
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
