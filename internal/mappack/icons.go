package mappack

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Equipment-icon extraction: the killfeed/HUD SVG silhouettes in
// panorama/images/icons/equipment/<name>.vsvg_c → plain <name>.svg files
// in the app data dir (data.IconsDir()). One icon per canonical
// equipment name, keyed the way the rest of spectra spells equipment:
// demoinfocs' common.EquipmentType.String() — the same strings the
// replay state stream's weapon/inventory fields and
// models.IsUtilityWeapon use. Assets the UI needs but has no canonical
// name for (planted_c4, knife variants) are NOT extracted: the frontend
// tints/chooses per render site. Valve IP never ships — extraction runs
// locally on demand (frontend/public/maps/README.md acquisition posture).
// Format facts: CS2.md "Weapon/inventory icons in a CS2 install".

const (
	iconPrefix = "panorama/images/icons/equipment/"
	iconSuffix = ".vsvg_c"
	iconExt    = ".svg"
)

// iconTable is the ONE canonical-name → VPK-basename table (keys are
// exact EquipmentType.String() outputs, values are the .vsvg_c basenames
// under iconPrefix). Pinned by TestIconTableCanonicalNames against the
// demoinfocs enum and TestExtractRealCS2Icons against a real install.
//
// Deliberately omitted: "UNKNOWN" and "World" (pseudo-items the UI never
// renders, no icon needed) and every equipment type whose String() is ""
// (Danger-Zone-only items: shield, tablet, fists, …). A canonical name
// whose VPK file vanished in a game update is skipped by extraction —
// the frontend falls back to a text label.
//
// SVG silhouettes rather than the rendered base_weapons PNGs
// (weapon_<name>_png.vtex_c): the SVG set is the only one covering every
// asset we need — armor, defuser and the bomb have no PNG — so one
// format covers the whole contract (CS2.md, verified 2026-11-05).
var iconTable = map[string]string{
	// Pistols
	"P2000":         "hkp2000",
	"Glock-18":      "glock",
	"P250":          "p250",
	"Desert Eagle":  "deagle",
	"Five-SeveN":    "fiveseven",
	"Dual Berettas": "elite",
	"Tec-9":         "tec9",
	"CZ75 Auto":     "cz75a",
	"USP-S":         "usp_silencer",
	"R8 Revolver":   "revolver",
	// SMGs
	"MP7":      "mp7",
	"MP9":      "mp9",
	"PP-Bizon": "bizon",
	"MAC-10":   "mac10",
	"UMP-45":   "ump45",
	"P90":      "p90",
	"MP5-SD":   "mp5sd",
	// Heavy
	"Sawed-Off": "sawedoff",
	"Nova":      "nova",
	"MAG-7":     "mag7",
	"XM1014":    "xm1014",
	"M249":      "m249",
	"Negev":     "negev",
	// Rifles
	"Galil AR": "galilar",
	"FAMAS":    "famas",
	"AK-47":    "ak47",
	"M4A4":     "m4a1", // entity weapon_m4a1 = M4A4; the suppressed variant is m4a1_silencer
	"M4A1":     "m4a1_silencer",
	"SSG 08":   "ssg08",
	"SG 553":   "sg556", // demoinfocs spells it "SG 553", the VPK keeps the sg556 basename
	"AUG":      "aug",
	"AWP":      "awp",
	"SCAR-20":  "scar20",
	"G3SG1":    "g3sg1",
	// Equipment
	"Zeus x27":        "taser",
	"Kevlar Vest":     "kevlar",       // item_kevlar (armor, no helmet)
	"Kevlar + Helmet": "armor_helmet", // the vest+helmet silhouette
	"C4":              "c4",           // dropped/planted bomb art — the renderer tints it (white/red)
	"Knife":           "knife",        // generic; per-model variants exist but demos name only "Knife"
	"Defuse Kit":      "defuser",
	// Grenades (thrown utility in the render area — lib/replay icons)
	"Decoy Grenade":      "decoy",
	"Molotov":            "molotov",
	"Incendiary Grenade": "incgrenade",
	"Flashbang":          "flashbang",
	"Smoke Grenade":      "smokegrenade",
	"HE Grenade":         "hegrenade",
}

// iconTableNames is iconTable's keys in sorted order, so extraction
// (and the error lists it produces) is deterministic.
var iconTableNames = func() []string {
	keys := make([]string, 0, len(iconTable))
	for name := range iconTable {
		keys = append(keys, name)
	}
	sort.Strings(keys)
	return keys
}()

// iconFileToName is the reverse index for manifest building: extracted
// filename ("ak47.svg") → canonical name ("AK-47"). Built once from
// iconTable; the table is 1:1 by TestIconTableCanonicalNames.
var iconFileToName = func() map[string]string {
	m := make(map[string]string, len(iconTable))
	for name, base := range iconTable {
		m[base+iconExt] = name
	}
	return m
}()

// ExtractIcons extracts every icon in iconTable from the CS2 install at
// cs2Dir into outDir (created if needed) as <basename>.svg files.
// Idempotent — re-running after a game update refreshes the icons. A
// canonical name whose file is missing from the VPK lands in errs (the
// manifest simply omits it); only a failure to open the VPK itself is
// fatal. Returns the canonical names written, sorted for determinism.
func ExtractIcons(cs2Dir, outDir string) (names []string, errs []string, err error) {
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
	for _, name := range iconTableNames {
		base := iconTable[name]
		raw, found, rerr := v.read(iconPrefix + base + iconSuffix)
		if rerr != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", name, rerr))
			continue
		}
		if !found {
			errs = append(errs, fmt.Sprintf("%s: %s%s not in VPK", name, base, iconSuffix))
			continue
		}
		svg, derr := decodeVSVG(raw)
		if derr != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", name, derr))
			continue
		}
		if werr := writeFileAtomic(filepath.Join(outDir, base+iconExt), svg); werr != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", name, werr))
			continue
		}
		names = append(names, name)
	}
	if len(names) == 0 && len(errs) > 0 {
		return nil, errs, fmt.Errorf("no icons extracted (%d errors)", len(errs))
	}
	return names, errs, nil
}

// IconFiles lists the extracted icons in dir: canonical name → filename
// ("ak47.svg"), rebuilt from a fresh directory listing on every call so
// the served manifest never goes stale. Files that aren't in the reverse
// table (strays, older game versions) are ignored.
func IconFiles(dir string) map[string]string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return map[string]string{}
	}
	out := map[string]string{}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if name, ok := iconFileToName[e.Name()]; ok {
			out[name] = e.Name()
		}
	}
	return out
}

// decodeVSVG extracts the raw SVG text from a .vsvg_c silhouette
// resource. The DATA block payload is a 6-byte prefix — u32 CRC32 of the
// raw SVG text + u16 0 (reads 0 in every CS2 file; reserved) — followed
// by the SVG itself, starting at "<?xml"/"<svg" through "</svg>", with no
// external references, so extraction is slice-and-verify-and-write
// (CS2.md: CRC matches on all 101 equipment files).
func decodeVSVG(data []byte) ([]byte, error) {
	off, size, err := resourceDataBlock(data, "vsvg")
	if err != nil {
		return nil, err
	}
	if size < 6 {
		return nil, fmt.Errorf("vsvg: DATA block %d bytes < 6", size)
	}
	body := data[off : off+size]
	want := binary.LittleEndian.Uint32(body[0:4])
	svg := body[6:] // CRC covers the raw payload after the 6-byte prefix
	if crc32.ChecksumIEEE(svg) != want {
		return nil, fmt.Errorf("vsvg: CRC mismatch (want %#08x)", want)
	}
	probe := bytes.TrimLeft(svg, "\xef\xbb\xbf \t\r\n")
	if !bytes.HasPrefix(probe, []byte("<?xml")) && !bytes.HasPrefix(probe, []byte("<svg")) {
		return nil, fmt.Errorf("vsvg: payload is not an SVG (head %.16q)", probe)
	}
	if !bytes.Contains(svg, []byte("</svg>")) {
		return nil, fmt.Errorf("vsvg: payload has no </svg> terminator")
	}
	return svg, nil
}

// writeFileAtomic writes data via a temp file + rename so a crash
// mid-write can't leave a truncated SVG for the frontend to render.
// (The image-flavoured twin is writePNGAtomic in extract.go — same
// rename discipline, different payload.)
func writeFileAtomic(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// ValidIconFileBase reports whether base (a "<name>.svg" filename) is a
// safe icon filename: lowercase letters/digits/underscore plus the .svg
// suffix, no path segments — the /api/icons route whitelist. Mirrors
// validPackName in main.go for the map-pack route.
func ValidIconFileBase(base string) bool {
	name, ok := strings.CutSuffix(base, iconExt)
	if !ok || name == "" || len(base) > 64 {
		return false
	}
	for _, c := range name {
		if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '_' {
			return false
		}
	}
	return true
}
