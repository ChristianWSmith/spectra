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

// Icon extraction: the killfeed/HUD SVG silhouettes in
// panorama/images/icons/equipment/<name>.vsvg_c → plain <name>.svg files
// in the app data dir (data.IconsDir()). One icon per canonical
// equipment name, keyed the way the rest of spectra spells equipment:
// demoinfocs' common.EquipmentType.String() — the same strings the
// replay state stream's weapon/inventory fields and
// models.IsUtilityWeapon use. A SECOND family rides the same pipeline:
// the game's own death-notice glyphs under panorama/images/hud/deathnotice/
// (noticeIconTable), keyed the way renderer.js drawKillFeed asks for them
// ('blind_kill'/'headshot' plus the round-4 indicator keys 'noscope',
// 'throughsmoke', 'wallbang', 'airborne', 'suicide', 'explosion') —
// non-equipment keys, so they live in their
// own table and never join iconTable (TestIconTableCanonicalNames pins
// that one to the demoinfocs enum). Assets the UI needs but has no
// canonical name for (planted_c4, knife variants) are NOT extracted: the
// frontend tints/chooses per render site — that includes the radar
// elevation marks (T / ⊥), which renderer.js draws from canvas paths
// rather than shipping Valve's glyphs. Valve IP never ships —
// extraction runs locally on demand (frontend/public/maps/README.md
// acquisition posture). Format facts: CS2.md "Weapon/inventory icons in
// a CS2 install".

const (
	iconPrefix   = "panorama/images/icons/equipment/"
	noticePrefix = "panorama/images/hud/deathnotice/"
	// hudPrefix is the death-notice glyphs' PARENT dir — one glyph
	// (kill_pip_blast) lives there instead of inside deathnotice/; see
	// noticePrefixes.
	hudPrefix  = "panorama/images/hud/"
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

// noticeIconTable is the SECOND extraction family: the game's own
// death-notice glyphs, keyed the way renderer.js drawKillFeed asks for
// them (iconFor('blind_kill') before the killer's name, iconFor('headshot')
// after the weapon — the other keys are the feed's round-4 indicators:
// 'noscope'/'throughsmoke'/'wallbang' after the weapon, 'airborne' after
// the killer, 'suicide'/'explosion' on the icon-only rows). The values are
// the .vsvg_c basenames — same container format as the equipment set,
// verified to decode with decodeVSVG on a real install (2026-11-07).
//
// These keys are NOT EquipmentType.String() outputs, so they must never
// join iconTable — that table is pinned to the demoinfocs enum by
// TestIconTableCanonicalNames; TestNoticeIconTable pins THIS one.
//
// Existing extracted installs gain the new glyphs only by re-extracting
// (Settings → "Extract all CS2 assets"): until then IconFiles omits them
// and the kill feed draws its rows without the indicators (the renderer
// skips a missing glyph without reserving any space).
var noticeIconTable = map[string]string{
	"headshot":     "icon_headshot",  // panorama/images/hud/deathnotice/icon_headshot.vsvg_c
	"blind_kill":   "blind_kill",     // panorama/images/hud/deathnotice/blind_kill.vsvg_c
	"noscope":      "noscope",        // panorama/images/hud/deathnotice/noscope.vsvg_c
	"throughsmoke": "smoke_kill",     // panorama/images/hud/deathnotice/smoke_kill.vsvg_c
	"wallbang":     "penetrate",      // panorama/images/hud/deathnotice/penetrate.vsvg_c
	"airborne":     "inairkill",      // panorama/images/hud/deathnotice/inairkill.vsvg_c
	"suicide":      "icon_suicide",   // panorama/images/hud/deathnotice/icon_suicide.vsvg_c
	"explosion":    "kill_pip_blast", // panorama/images/hud/kill_pip_blast.vsvg_c (see noticePrefixes)
}

// noticePrefixes overrides the VPK directory for noticeIconTable keys that
// do NOT live under noticePrefix. Only 'explosion': the deathnotice dir has
// no explosion glyph (huddeathnotice.vxml_c binds bomb deaths to Suicide +
// the weapon slot), so the feed's C4 row uses the hud kill-context "blast"
// pip — panorama/images/hud/kill_pip_blast.vsvg_c (decodes with decodeVSVG,
// verified 2026-11-07). Swap point: put a true deathnotice explosion
// glyph in noticeIconTable and drop this entry.
var noticePrefixes = map[string]string{
	"explosion": hudPrefix,
}

// extractTable is BOTH families merged — the one map ExtractIcons walks
// and the one reverse index builds from. The tables stay separate
// (canonical-name vocabulary vs. renderer glyph keys) but extract as one
// set so a single extraction pass and a single manifest serve both.
// TestNoticeIconTable proves the two never collide on key or basename.
var extractTable = func() map[string]string {
	m := make(map[string]string, len(iconTable)+len(noticeIconTable))
	for name, base := range iconTable {
		m[name] = base
	}
	for name, base := range noticeIconTable {
		m[name] = base
	}
	return m
}()

// extractTableNames is extractTable's keys in sorted order, so extraction
// (and the error lists it produces) is deterministic.
var extractTableNames = func() []string {
	keys := make([]string, 0, len(extractTable))
	for name := range extractTable {
		keys = append(keys, name)
	}
	sort.Strings(keys)
	return keys
}()

// iconFileToName is the reverse index for manifest building: extracted
// filename ("ak47.svg") → manifest key ("AK-47"; "blind_kill.svg" →
// "blind_kill"). Built once from extractTable so BOTH families resolve
// through IconFiles; the tables are 1:1 by TestIconTableCanonicalNames /
// TestNoticeIconTable.
var iconFileToName = func() map[string]string {
	m := make(map[string]string, len(extractTable))
	for name, base := range extractTable {
		m[base+iconExt] = name
	}
	return m
}()

// iconVPKPath — the full VPK path of a manifest key: the FAMILY prefix
// (equipment silhouettes vs death-notice glyphs) + the table's basename.
// extractTable merges every table, so the prefix must follow the family
// the key belongs to instead of assuming iconPrefix.
func iconVPKPath(name string) string {
	if base, ok := noticeIconTable[name]; ok {
		dir := noticePrefix
		if d, ok := noticePrefixes[name]; ok {
			dir = d
		}
		return dir + base + iconSuffix
	}
	return iconPrefix + iconTable[name] + iconSuffix
}

// ExtractIcons extracts every icon in extractTable (all families) from
// the CS2 install at cs2Dir into outDir (created if needed) as
// <basename>.svg files. Idempotent — re-running after a game update
// refreshes the icons. A canonical name whose file is missing from the
// VPK lands in errs (the manifest simply omits it); only a failure to
// open the VPK itself is fatal. Returns the canonical names written,
// sorted for determinism. opts.Progress, when set, fires once per
// canonical icon attempted (ExtractOptions).
func ExtractIcons(cs2Dir, outDir string, opts ...ExtractOptions) (names []string, errs []string, err error) {
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
	for i, name := range extractTableNames {
		if msg := extractIcon(v, outDir, name); msg != "" {
			errs = append(errs, msg)
		} else {
			names = append(names, name)
		}
		if o.Progress != nil {
			o.Progress(i+1, len(extractTableNames))
		}
	}
	if len(names) == 0 && len(errs) > 0 {
		return nil, errs, fmt.Errorf("no icons extracted (%d errors)", len(errs))
	}
	return names, errs, nil
}

// extractIcon does ONE canonical icon's read → decode → write — the body
// of the ExtractIcons loop, split out so the loop can report progress
// after EVERY item (the failure paths are returns here, not `continue`s,
// which would skip it). Returns the message to record in errs, or "" when
// the icon was written.
func extractIcon(v *vpk, outDir, name string) string {
	base := extractTable[name]
	raw, found, rerr := v.read(iconVPKPath(name))
	if rerr != nil {
		return fmt.Sprintf("%s: %v", name, rerr)
	}
	if !found {
		return fmt.Sprintf("%s: %s%s not in VPK", name, base, iconSuffix)
	}
	svg, derr := decodeVSVG(raw)
	if derr != nil {
		return fmt.Sprintf("%s: %v", name, derr)
	}
	if werr := writeFileAtomic(filepath.Join(outDir, base+iconExt), svg); werr != nil {
		return fmt.Sprintf("%s: %v", name, werr)
	}
	return ""
}

// IconFiles lists the extracted icons in dir: manifest key → filename
// ("ak47.svg", "blind_kill.svg" — both families resolve through the one
// reverse index), rebuilt from a fresh
// directory listing on every call
// so the served manifest never goes stale. Files that aren't in the
// reverse table (strays, older game versions, the retired elevation
// glyphs) are ignored.
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
