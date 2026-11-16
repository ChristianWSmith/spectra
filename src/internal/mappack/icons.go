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
// 'throughsmoke', 'wallbang', 'airborne', 'suicide', 'explosion', plus
// the kill feed's 'disconnect' line glyph) — non-equipment keys, so they
// live in their own table and never join iconTable
// (TestIconTableCanonicalNames pins that one to the demoinfocs enum). A
// THIRD family rides the same pipeline: the game's per-map square logos
// (mapIconPrefix → map_icon_<map>.svg), keyed by MAP NAME rather than by
// any table — enumerated from the VPK per install, so it has no static
// reverse index — for the Library's map column (CS2.md "Map icon logos
// in a CS2 install"). Assets the UI needs but has no
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
	// mapIconPrefix is the THIRD family's dir: the game's per-map square
	// logos at panorama/images/map_icons/map_icon_<map>.vsvg_c — 26 files
	// in the 2026-11-16 probe of pak01_dir.vpk, square (32×32, two night
	// variants 32×33, cs_italy 31×31), and the SAME 6-byte CRC32 + SVG
	// container as the equipment silhouettes, so decodeVSVG decodes them
	// with no new decoder (CS2.md "Map icon logos in a CS2 install").
	mapIconPrefix = "panorama/images/map_icons/"
	// mapIconFilePrefix is the stem BOTH sides of this family share: the
	// VPK basename (map_icon_<map>.vsvg_c) and the extracted file
	// (map_icon_<map>.svg). Keeping the stem verbatim means a map icon
	// can never collide with an equipment/notice stem in the one
	// extracted-files namespace, and the name stays inside the
	// ValidIconFileBase whitelist the /api/icons route enforces.
	mapIconFilePrefix = "map_icon_"
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
// the killer, 'suicide' on the suicide row). 'explosion' (the hud blast
// pip) is still extracted but NO LONGER drawn: since 2026-11-12 the
// feed's C4 row shows the shared 'C4' weapon image beside the victim
// instead (see renderer.js's C4 branch). 'disconnect' is the kill feed's
// glyph for a player_disconnect row (renderer.js's disconnect branch —
// the glyph + leaver's name line): NOT a deathnotice-dir file — the game
// ships it in the EQUIPMENT dir (iconPrefix), where the feed's weapon
// glyphs live, because hud/deathnotice/ has no disconnect glyph at all
// (verified 2026-11-14, see noticePrefixes). The values are
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
	"disconnect":   "disconnect",     // panorama/images/icons/equipment/disconnect.vsvg_c (see noticePrefixes)
}

// noticePrefixes overrides the VPK directory for noticeIconTable keys that
// do NOT live under noticePrefix. Two keys:
//   - 'explosion': the deathnotice dir has no explosion glyph
//     (huddeathnotice.vxml_c binds bomb deaths to Suicide + the weapon
//     slot — CS2.md "Kill-feed indicator glyphs"), so the hud
//     kill-context "blast" pip — panorama/images/hud/kill_pip_blast.vsvg_c
//     (decodes with decodeVSVG, verified 2026-11-07) — is what got extracted
//     here. It stays in the manifest even though the feed stopped drawing it
//     (2026-11-12: the C4 row shows the shared 'C4' weapon image instead).
//     Swap point: a true deathnotice explosion glyph would replace this entry
//     wholesale.
//   - 'disconnect': the feed's glyph+name line for a player_disconnect row
//     (renderer.js's disconnect branch). hud/deathnotice/ ships NO
//     disconnect glyph (find --prefix, 12 files, verified 2026-11-14); the
//     game's symbol lives in the EQUIPMENT dir beside the kill-feed weapon
//     glyphs — panorama/images/icons/equipment/disconnect.vsvg_c (one of
//     three disconnect assets in the install; CS2.md "Disconnect glyph
//     assets"). The two other candidates are the UI/top-level
//     panoramas/icons/{ui/,}disconnect.vsvg_c, likely a settings glyph —
//     deliberately NOT extracted (one glyph, one key).
var noticePrefixes = map[string]string{
	"explosion":  hudPrefix,
	"disconnect": iconPrefix,
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

// mapIconFile is the extracted file name for a map icon key: the VPK
// basename's stem kept verbatim (map_icon_de_mirage.svg), so the name is
// namespaced away from every equipment/notice stem and stays whitelist
// safe (ValidIconFileBase).
func mapIconFile(key string) string {
	return mapIconFilePrefix + key + iconExt
}

// mapIconKeyProblem is THE map-icon guard, shared by both halves of the
// family (the extraction path deriving a key from a VPK path, and the
// listing path deriving one from an extracted file name): a map name is
// servable only when its file passes the /api/icons whitelist
// (ValidIconFileBase — lowercase, no path segments, ≤64 bytes) and the
// key does not collide with the static extractTable's manifest-key
// namespace (a collision would silently shadow a canonical name in the
// one flat manifest). Returns "" when servable, else the problem the
// caller reports before skipping — an unservable file is never written
// and never listed.
func mapIconKeyProblem(key string) string {
	if key == "" {
		return "map icon file has an empty map name"
	}
	if !ValidIconFileBase(mapIconFile(key)) {
		return "map icon file name is not servable"
	}
	if _, dup := extractTable[key]; dup {
		return "map name already used by an icon key"
	}
	return ""
}

// mapIconKey derives a map icon's manifest key (the map name, e.g.
// "de_mirage") from its VPK path under mapIconPrefix. Two miss shapes:
//
//	("", "")      the entry is not a map icon (no map_icon_ stem) —
//	              skipped silently, it is another asset in that dir
//	              (the install ships e.g. mapgroup_icon_rush.vsvg_c);
//	("", problem) it IS a map icon but cannot be served — a subdirectory
//	              entry or a key mapIconKeyProblem rejects. The caller
//	              reports the problem and skips it.
func mapIconKey(path string) (key string, problem string) {
	rest, ok := strings.CutPrefix(path, mapIconPrefix)
	if !ok {
		return "", "" // not under the map-icons dir (defensive)
	}
	stem, ok := strings.CutSuffix(rest, iconSuffix)
	if !ok {
		return "", "" // not a compiled SVG — not this family's asset
	}
	if strings.Contains(stem, "/") {
		return "", "map icon sits in a subdirectory"
	}
	stem, ok = strings.CutPrefix(stem, mapIconFilePrefix)
	if !ok {
		return "", "" // another asset in the dir — not a map icon
	}
	if problem = mapIconKeyProblem(stem); problem != "" {
		return "", problem
	}
	return stem, ""
}

// mapIconFileKey derives the map name from an EXTRACTED file name
// ("map_icon_de_mirage.svg" → "de_mirage"), or "" when the name is not
// a servable map icon (the same mapIconKeyProblem guard, so IconFiles
// only ever lists files the /api/icons route will actually serve).
func mapIconFileKey(file string) string {
	stem, ok := strings.CutPrefix(file, mapIconFilePrefix)
	if !ok || !strings.HasSuffix(stem, iconExt) {
		return ""
	}
	key := strings.TrimSuffix(stem, iconExt)
	if mapIconKeyProblem(key) != "" {
		return ""
	}
	return key
}

// IsMapIconFile reports whether an extracted file name belongs to the
// map-icon family — the routing predicate buildIconManifest splits the
// flat IconFiles listing with (map icons → IconManifest.Maps, everything
// else → Icons).
func IsMapIconFile(file string) bool {
	return mapIconFileKey(file) != ""
}

// iconJob is ONE ExtractIcons attempt: the manifest key it writes under
// (a canonical equipment/notice name or a map name), the file it writes,
// and the VPK path it reads. The whole job list is built before the loop
// so the progress denominator counts exactly what this run attempts —
// the static table (sorted) plus the map icons the VPK actually carries
// (v.names is sorted too).
type iconJob struct {
	name    string // manifest key
	file    string // extracted file name (<base>.svg)
	vpkPath string // full VPK path to read
}

// ExtractIcons extracts every icon the manifest serves — the static
// extractTable (equipment silhouettes + death-notice glyphs) AND every
// map icon the VPK carries (mapIconPrefix) — from the CS2 install at
// cs2Dir into outDir (created if needed) as <basename>.svg files.
// Idempotent — re-running after a game update refreshes the icons. A
// canonical name whose file is missing from the VPK lands in errs (the
// manifest simply omits it); a map-icon entry that cannot be served is
// reported and skipped the same way; only a failure to open the VPK
// itself is fatal. Returns the canonical names written, sorted for
// determinism. opts.Progress, when set, fires once per job attempted
// (ExtractOption), against the full job count known before the first
// one.
func ExtractIcons(cs2Dir, outDir string, opts ...ExtractOption) (names []string, errs []string, err error) {
	extractMu.Lock()
	defer extractMu.Unlock()
	var cfg extractConfig
	for _, opt := range opts {
		opt(&cfg)
	}
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

	// The job list is complete BEFORE the loop (after openVPK — the map
	// half is enumerated from the VPK's own tree), so the progress
	// denominator is honest from the first call. Map entries that cannot
	// be served are reported here and never become jobs.
	jobs := make([]iconJob, 0, len(extractTableNames))
	for _, name := range extractTableNames {
		jobs = append(jobs, iconJob{
			name:    name,
			file:    extractTable[name] + iconExt,
			vpkPath: iconVPKPath(name),
		})
	}
	for _, path := range v.names(mapIconPrefix, iconSuffix) {
		key, problem := mapIconKey(path)
		if problem != "" {
			errs = append(errs, fmt.Sprintf("%s: %s", path, problem))
			continue
		}
		if key == "" {
			continue // another asset in the dir — not a map icon
		}
		jobs = append(jobs, iconJob{name: key, file: mapIconFile(key), vpkPath: path})
	}
	for i, job := range jobs {
		if msg := extractIcon(v, outDir, job); msg != "" {
			errs = append(errs, msg)
		} else {
			names = append(names, job.name)
		}
		if cfg.progress != nil {
			cfg.progress(i+1, len(jobs))
		}
	}
	sort.Strings(names)
	if len(names) == 0 && len(errs) > 0 {
		return nil, errs, fmt.Errorf("couldn't read the icons — your game files may have changed format (%d errors)", len(errs))
	}
	return names, errs, nil
}

// extractIcon does ONE job's read → decode → write — the body of the
// ExtractIcons loop, split out so the loop can report progress after
// EVERY item (the failure paths are returns here, not `continue`s,
// which would skip it). Returns the message to record in errs, or "" when
// the icon was written.
func extractIcon(v *vpk, outDir string, job iconJob) string {
	raw, found, rerr := v.read(job.vpkPath)
	if rerr != nil {
		return fmt.Sprintf("%s: %v", job.name, rerr)
	}
	if !found {
		return fmt.Sprintf("%s: %s not in VPK", job.name, filepath.Base(job.vpkPath))
	}
	svg, derr := decodeVSVG(raw)
	if derr != nil {
		return fmt.Sprintf("%s: %v", job.name, derr)
	}
	if werr := writeFileAtomic(filepath.Join(outDir, job.file), svg); werr != nil {
		return fmt.Sprintf("%s: %v", job.name, werr)
	}
	return ""
}

// IconFiles lists the extracted icons in dir: manifest key → filename
// ("ak47.svg", "blind_kill.svg" — both static families resolve through
// the one reverse index; "map_icon_de_mirage.svg" resolves through the
// map-icon pattern instead, since that family's set is enumerated per
// install and has no static index), rebuilt from a fresh directory
// listing on every call so the served manifest never goes stale. Files
// that are neither table-known nor a servable map icon (strays, older
// game versions, the retired elevation glyphs) are ignored.
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
			continue
		}
		// The map-icon family: a pattern branch, so the static reverse
		// index stays exactly extractTable (TestNoElevIconTable pins
		// that 1:1) while map icons still list for the manifest.
		if key := mapIconFileKey(e.Name()); key != "" {
			out[key] = e.Name()
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
