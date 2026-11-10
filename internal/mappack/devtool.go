package mappack

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/pierrec/lz4/v4"
)

// cs2find is the in-repo dev tool (cmd/cs2find): search and decode the
// user's local CS2 install, and dump spectra's canonical tables. It lives
// in THIS package on purpose — every subcommand calls the same
// internals the extractors use (openVPK / (*vpk).names / read,
// decodeVTex, decodeVSnd, soundTable, iconVPKPath, parseOverview,
// resourceBlock), so there is no export churn and never a second decoder.
//
// READ-ONLY by construction: it never writes into the install and never
// mutates soundTable / iconTable (`table` only prints them); decoded
// bytes go where -o says, defaulting to <tmp>/cs2find/ — never the repo
// tree (-o inside the working tree warns instead of failing), and every
// decode prints the Valve-IP notice.
//
// `hash` and `events` are the ONLY new implementations here (MurmurHash2
// and the soundevents/*.vsndevts_c walk). Their facts are CS2.md's: the
// seed + lowercase rule and the verification vector live in "Sound-event
// names ↔ demo soundevent_hash" (≈lines 366-387); the .vsndevts_c layout
// ("the same 120-byte binary-KV3 + 2×LZ4 as a v5 .vsnd CTRL, and the
// string table puts an event name immediately followed by its .vsnd
// path") in "C4 plant/defuse sound events ↔ files" (≈lines 989-1013),
// "C4 beep sounds" (≈lines 1114-1117) and the CTRL layout entry
// (≈lines 744-763). Measured refinement of that adjacency: a name's
// object runs to the NEXT name in the pair stream (a name is also written
// as a value of the soundevent_01 child list), see vsndEventDefs — pure
// table adjacency misses canonical events such as BaseGrenade.Explode.
// Both commands self-check before they print: a plausible-but-wrong
// digest is never emitted.

// devToolUsage is `cs2find --help`. The Posture block is the part an
// agent must read before running anything.
const devToolUsage = `cs2find — search and decode the local CS2 install (READ-ONLY)

Usage: cs2find <command> [args]

Commands
  where                             resolved pak01_dir.vpk path (FindCS2 auto-detect)
  find --prefix <p> [--suffix <s>]  VPK names, sorted (arguments lowercased → case-insensitive)
  find --contains <substr>          substring over every VPK name (~137k)
  get <vpk-path> [-o file.png]      decode .vtex_c → PNG at NATIVE size (never upscaled)
  sound <vpk-path> [-o dir/]        decode .vsnd_c → .wav/.mp3, print format/rate/channels
  overview <map>                    resource/overviews/<map>.txt: pos_x/pos_y/scale/rotate,
                                    spawns, sites, verticalsections
  icon <name>                       icon VPK path + family + whether extractTable knows it
  table sounds|icons                dump the canonical table mappings (read-only)
  hash <dotted-event-name>          MurmurHash2-32, LOWERCASED name, seed 0x53524332
  hash --resolve <hex>              reverse: hash → soundevent name
  events [pattern]                  soundevent names (+ .vsnd paths) from soundevents/*.vsndevts_c

Posture
  READ-ONLY over the install: nothing here writes into the game folder,
  and soundTable / iconTable remain THE canonical mappings (table only
  prints them). Decodes write only with -o; without it they land in
  <tmp>/cs2find/ — never the repo tree (-o inside the working tree warns,
  it does not fail). Every decode then prints:
  Valve IP — files under <dir> are from the user's local install; never
  commit them.
  events / hash --resolve are EXPLORATORY: they walk the local install's
  soundevents/*.vsndevts_c, which CS2.md documents as containing orphan
  events and the *_distant* far layer — soundTable stays the product's
  truth. "hash --help" and "events --help" cite the CS2.md entries the
  seed and the vsndevts layout come from.
`

// devToolHashHelp is `cs2find hash --help`; it MUST cite the CS2.md
// entries so nobody re-derives the seed.
const devToolHashHelp = `hash — MurmurHash2-32 of a soundevent name

  cs2find hash <dotted-event-name>
  cs2find hash --resolve <hex>

A demo carries only a fixed32 soundevent_hash. The hash is MurmurHash2-32
over the LOWERCASED event name with seed 0x53524332 — CS2.md "Sound-event
names ↔ demo soundevent_hash" (≈lines 366-387), which also records the
verification (126/127 distinct hashes resolve against the local vsndevts
names; CRC32, which some proto docs claim, matches 0). So
"Weapon_AK47.Single" and "weapon_ak47.single" hash identically.

--resolve reverses it against the local install's
soundevents/*.vsndevts_c name table — see "cs2find events --help" for
that layout (CS2.md ≈lines 989-1013, 1114-1117, 744-763).
`

// devToolEventsHelp is `cs2find events --help`; it MUST cite the CS2.md
// entries the walker is built from.
const devToolEventsHelp = `events — soundevent names from soundevents/*.vsndevts_c

  cs2find events [pattern]

Layout (CS2.md): a .vsndevts_c DATA block is the same 120-byte binary-KV3
+ 2×LZ4 layout as a v5 .vsnd CTRL block, and in its string table an event
name sits beside its .vsnd path — the adjacency this command starts from.
Sources: CS2.md "C4 plant/defuse sound events ↔ files" (≈lines 989-1013),
"C4 beep sounds — assets, events, cadence…" (≈lines 1114-1117) and the
".vsnd_c v5 CTRL block decode (binary KV3, LZ4)" layout entry (≈lines
744-763). The hash that pairs with these names is CS2.md "Sound-event
names ↔ demo soundevent_hash" (≈lines 366-387).

Refinement measured against a local install (all 183 files): a name is
also written as a value of the soundevent_01 child list, and an event's
object runs to the NEXT name in the pair stream — so the walker reads the
pair stream and takes every .vsnd path in that event's region (pure table
adjacency misses canonical events such as BaseGrenade.Explode).

Output: name<TAB>file1,file2 (a name whose object carries no vsnd_files
prints alone). EXPLORATORY: the install contains orphan events and
*_distant* far-layer files — soundTable is the product's mapping and is
untouched by this command.
`

// devToolUsageLine is `<cmd> -h` for the subcommands without their own
// help text (hash and events carry the CS2.md citations above).
var devToolUsageLine = map[string]string{
	"where":    "usage: cs2find where",
	"find":     "usage: cs2find find --prefix <p> [--suffix <s>]   |   cs2find find --contains <substr>",
	"get":      "usage: cs2find get <vpk-path> [-o file.png]  (PNG at native size; -o defaults to <tmp>/cs2find/)",
	"sound":    "usage: cs2find sound <vpk-path> [-o dir/]    (.wav/.mp3; -o defaults to <tmp>/cs2find/)",
	"overview": "usage: cs2find overview <map>   (e.g. cs2find overview de_nuke)",
	"icon":     "usage: cs2find icon <name>   (e.g. cs2find icon AK-47)",
	"table":    "usage: cs2find table sounds|icons",
}

// RunDevTool runs cs2find. args excludes the program name, stdout/stderr
// are the output streams, and the return value is the process exit code
// (0 = success, 1 = not found / decode failure, 2 = usage).
func RunDevTool(args []string, stdout, stderr io.Writer) int {
	return runDevTool(args, stdout, stderr, "")
}

// runDevTool is RunDevTool with an explicit install (manual = a folder,
// the csgo dir, or pak01_dir.vpk itself — the tests point it at a
// synthetic VPK). "" is the real session open: FindCS2("") auto-detect,
// exactly like the product's extractors. A non-empty manual NEVER falls
// back to auto-detection: pointing at a folder without a pak must say so
// (the error TestExtractSoundsNoInstall pins), not silently read whatever
// install happens to be on the machine.
func runDevTool(args []string, stdout, stderr io.Writer, manual string) int {
	dt := &devTool{stdout: stdout, stderr: stderr, manual: manual}
	return dt.run(args)
}

// devTool carries one invocation's streams and install override.
type devTool struct {
	stdout io.Writer
	stderr io.Writer
	manual string
}

// printf/errorf write to this invocation's streams. The write error is
// discarded HERE, once, rather than at every call site: the streams are
// injectable io.Writers (tests capture them), and a consumer closing the
// pipe early (`cs2find find | head`) must not change the exit code.
func (dt *devTool) printf(format string, a ...any) {
	_, _ = fmt.Fprintf(dt.stdout, format, a...)
}

func (dt *devTool) errorf(format string, a ...any) {
	_, _ = fmt.Fprintf(dt.stderr, format, a...)
}

func (dt *devTool) run(args []string) int {
	if len(args) == 0 {
		dt.errorf("%s", devToolUsage)
		return 2
	}
	cmd, rest := args[0], args[1:]
	switch cmd {
	case "-h", "--help", "help":
		dt.printf("%s", devToolUsage)
		return 0
	case "where":
		return dt.cmdWhere()
	case "table":
		return dt.cmdTable(rest)
	case "icon":
		return dt.cmdIcon(rest)
	case "hash":
		return dt.cmdHash(rest)
	case "find", "get", "sound", "overview", "events":
		// Help first: it must work without a CS2 install (and without
		// paying for the 137k-entry VPK index).
		if devToolHelpRequested(rest) {
			if cmd == "events" {
				dt.printf("%s", devToolEventsHelp)
			} else {
				dt.printf("%s\n", devToolUsageLine[cmd])
			}
			return 0
		}
		v, code := dt.openSession()
		if code != 0 {
			return code
		}
		defer v.close()
		switch cmd {
		case "find":
			return dt.cmdFind(v, rest)
		case "get":
			return dt.cmdGet(v, rest)
		case "sound":
			return dt.cmdSound(v, rest)
		case "overview":
			return dt.cmdOverview(v, rest)
		default: // "events"
			return dt.cmdEvents(v, rest)
		}
	}
	dt.errorf("cs2find: unknown command %q (try cs2find --help)\n", cmd)
	return 2
}

// devToolPak resolves the pak01_dir.vpk this invocation reads — the one
// place the session is opened from.
func devToolPak(manual string) (string, error) {
	if manual != "" {
		pak := resolvePak(manual)
		if pak == "" {
			return "", fmt.Errorf("no pak01_dir.vpk under %s", manual)
		}
		return pak, nil
	}
	dir := FindCS2("")
	if dir == "" {
		return "", fmt.Errorf("no pak01_dir.vpk found (no local CS2 install)")
	}
	pak := resolvePak(dir)
	if pak == "" {
		return "", fmt.Errorf("no pak01_dir.vpk under %s", dir)
	}
	return pak, nil
}

// openSession is the session open every VPK-touching subcommand goes
// through: devToolPak → openVPK. Returns (vpk, 0) or (nil, exitCode)
// after reporting the failure.
func (dt *devTool) openSession() (*vpk, int) {
	pak, err := devToolPak(dt.manual)
	if err != nil {
		dt.errorf("cs2find: %v\n", err)
		return nil, 1
	}
	v, err := openVPK(pak)
	if err != nil {
		dt.errorf("cs2find: %v\n", err)
		return nil, 1
	}
	return v, 0
}

// devToolHelpRequested reports whether args ask for `<cmd> -h`.
func devToolHelpRequested(args []string) bool {
	for _, a := range args {
		if a == "-h" || a == "--help" {
			return true
		}
	}
	return false
}

func (dt *devTool) printUsageLine(cmd string) int {
	dt.printf("%s\n", devToolUsageLine[cmd])
	return 0
}

// --- where / table / icon (no VPK open) ---------------------------------

func (dt *devTool) cmdWhere() int {
	pak, err := devToolPak(dt.manual)
	if err != nil {
		dt.errorf("cs2find: %v\n", err)
		return 1
	}
	dt.printf("%s\n", pak)
	return 0
}

// cmdTable dumps one of the canonical tables — read-only, no install
// needed. soundTable / iconTable stay THE mappings; this only prints.
func (dt *devTool) cmdTable(args []string) int {
	if devToolHelpRequested(args) {
		return dt.printUsageLine("table")
	}
	if len(args) != 1 {
		dt.errorf("%s\n", devToolUsageLine["table"])
		return 2
	}
	switch args[0] {
	case "sounds":
		for _, name := range soundTableNames {
			for _, vp := range soundTable[name] {
				dt.printf("%s\t%s\n", name, vp)
			}
		}
	case "icons":
		for _, name := range extractTableNames {
			dt.printf("%s\t%s\n", name, iconVPKPath(name))
		}
	default:
		dt.errorf("%s\n", devToolUsageLine["table"])
		return 2
	}
	return 0
}

// cmdIcon answers "which VPK path, which family, does extractTable know
// it" for one manifest key — a pure table lookup, so no install is
// opened. An unknown key prints the miss and exits 1 (never a path built
// from an empty basename).
func (dt *devTool) cmdIcon(args []string) int {
	if devToolHelpRequested(args) {
		return dt.printUsageLine("icon")
	}
	if len(args) != 1 {
		dt.errorf("%s\n", devToolUsageLine["icon"])
		return 2
	}
	name := args[0]
	if _, known := extractTable[name]; !known {
		dt.printf("%s\t-\tnot in extractTable\n", name)
		return 1
	}
	family := "equipment" // iconTable — the canonical-name family
	if _, ok := noticeIconTable[name]; ok {
		family = "deathnotice"
	}
	dt.printf("%s\t%s\t%s\tin extractTable\n", name, family, iconVPKPath(name))
	return 0
}

// --- find ----------------------------------------------------------------

// cmdFind lists VPK names: --prefix/--suffix through the canonical
// v.names (sorted, entries already lowercase), --contains as a substring
// over the whole sorted listing. Arguments are lowercased first, so
// matching is case-insensitive in both modes.
func (dt *devTool) cmdFind(v *vpk, args []string) int {
	if devToolHelpRequested(args) {
		return dt.printUsageLine("find")
	}
	var prefix, suffix, contains string
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--prefix" || a == "--suffix" || a == "--contains" {
			if i+1 >= len(args) {
				dt.errorf("find: %s needs a value\n", a)
				return 2
			}
			i++
			switch a {
			case "--prefix":
				prefix = args[i]
			case "--suffix":
				suffix = args[i]
			default:
				contains = args[i]
			}
			continue
		}
		dt.errorf("find: unexpected argument %q\n", a)
		return 2
	}
	if contains != "" && (prefix != "" || suffix != "") {
		dt.errorf("find: --contains cannot be combined with --prefix/--suffix\n")
		return 2
	}
	if contains == "" && prefix == "" && suffix == "" {
		dt.errorf("%s\n", devToolUsageLine["find"])
		return 2
	}

	var names []string
	if contains != "" {
		needle := strings.ToLower(contains)
		for _, n := range v.names("", "") {
			if strings.Contains(n, needle) {
				names = append(names, n)
			}
		}
	} else {
		names = v.names(strings.ToLower(prefix), strings.ToLower(suffix))
	}
	for _, n := range names {
		dt.printf("%s\n", n)
	}
	if len(names) == 0 {
		dt.errorf("find: no matches\n")
		return 1
	}
	return 0
}

// --- get / sound (the decodes) ------------------------------------------

// decodeArgs parses the shared decode shape `<vpk-path> [-o target]`
// (help is handled by the caller first). Returns the positional path,
// the -o value ("" = the <tmp>/cs2find/ default) and an exit code
// (0 = proceed).
func (dt *devTool) decodeArgs(cmd string, args []string) (pos, out string, code int) {
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "-o" || a == "--out":
			if i+1 >= len(args) {
				dt.errorf("%s: %s needs a value\n", cmd, a)
				return "", "", 2
			}
			i++
			out = args[i]
		case strings.HasPrefix(a, "-") && a != "-":
			dt.errorf("%s: unknown flag %q\n", cmd, a)
			return "", "", 2
		default:
			if pos != "" {
				dt.errorf("%s: unexpected argument %q\n", cmd, a)
				return "", "", 2
			}
			pos = a
		}
	}
	if pos == "" {
		dt.errorf("%s\n", devToolUsageLine[cmd])
		return "", "", 2
	}
	return pos, out, 0
}

// devToolDest resolves a decode's output path. "" means the
// <tmp>/cs2find/ default — never the repo tree. allowFile (get only)
// makes an -o ending in the target extension name a FILE; any other
// value (and every sound -o) is a directory holding <name><ext>.
func devToolDest(outFlag, name, ext string, allowFile bool) string {
	if outFlag == "" {
		return filepath.Join(os.TempDir(), "cs2find", name+ext)
	}
	last := byte(0)
	if n := len(outFlag); n > 0 {
		last = outFlag[n-1]
	}
	isDir := last == '/' || last == os.PathSeparator
	if allowFile && !isDir && strings.HasSuffix(strings.ToLower(outFlag), ext) {
		return outFlag
	}
	return filepath.Join(outFlag, name+ext)
}

// write prepares and writes one decoded file: the directory, the
// working-tree warning (a warning, never a failure — Valve IP just must
// not be committed), then the canonical atomic write.
func (dt *devTool) write(dest string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	dt.warnRepoWrite(dest)
	return writeFileAtomic(dest, data)
}

// warnRepoWrite warns when a decode's -o target sits inside the
// working tree: Valve-derived bytes must never be committed there.
func (dt *devTool) warnRepoWrite(dest string) {
	cwd, err := os.Getwd()
	if err != nil {
		return
	}
	abs, err := filepath.Abs(dest)
	if err != nil {
		return
	}
	rel, err := filepath.Rel(cwd, abs)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return
	}
	dt.errorf("warning: writing Valve-derived bytes into the working tree (%s) — never commit them\n", rel)
}

// devToolValveIP is the notice EVERY decode prints (posture rule).
func devToolValveIP(dest string) string {
	return fmt.Sprintf("Valve IP — files under %s are from the user's local install; never commit them.", filepath.Dir(dest))
}

// cmdGet decodes one .vtex_c to a PNG at its NATIVE size — a bare
// png.Encode, deliberately NOT writePNGAtomic (which upscales ×2 with an
// unsharp mask for the shipped radar packs; a dev probe wants the source
// pixels).
func (dt *devTool) cmdGet(v *vpk, args []string) int {
	if devToolHelpRequested(args) {
		return dt.printUsageLine("get")
	}
	vpkPath, out, code := dt.decodeArgs("get", args)
	if code != 0 {
		return code
	}
	raw, found, err := v.read(vpkPath)
	if err != nil {
		dt.errorf("get: %v\n", err)
		return 1
	}
	if !found {
		dt.errorf("get: %s not in VPK\n", vpkPath)
		return 1
	}
	img, err := decodeVTex(raw)
	if err != nil {
		dt.errorf("get: %s: %v\n", vpkPath, err)
		return 1
	}
	name := strings.TrimSuffix(filepath.Base(vpkPath), ".vtex_c")
	if name == "" || name == filepath.Base(vpkPath) {
		name = strings.TrimSuffix(filepath.Base(vpkPath), filepath.Ext(vpkPath))
	}
	dest := devToolDest(out, name, ".png", true)

	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		dt.errorf("get: encode: %v\n", err)
		return 1
	}
	if err := dt.write(dest, buf.Bytes()); err != nil {
		dt.errorf("get: %v\n", err)
		return 1
	}
	dt.printf("%s: %dx%d (native)\n", vpkPath, img.Bounds().Dx(), img.Bounds().Dy())
	dt.printf("wrote %s\n", dest)
	dt.printf("%s\n", devToolValveIP(dest))
	return 0
}

// cmdSound decodes one .vsnd_c through THE decoder (decodeVSnd) and
// writes the playable bytes, printing the container's format/rate/
// channels.
func (dt *devTool) cmdSound(v *vpk, args []string) int {
	if devToolHelpRequested(args) {
		return dt.printUsageLine("sound")
	}
	vpkPath, out, code := dt.decodeArgs("sound", args)
	if code != 0 {
		return code
	}
	raw, found, err := v.read(vpkPath)
	if err != nil {
		dt.errorf("sound: %v\n", err)
		return 1
	}
	if !found {
		dt.errorf("sound: %s not in VPK\n", vpkPath)
		return 1
	}
	data, ext, err := decodeVSnd(raw)
	if err != nil {
		dt.errorf("sound: %s: %v\n", vpkPath, err)
		return 1
	}
	dest := devToolDest(out, soundStem(vpkPath), ext, false)
	if err := dt.write(dest, data); err != nil {
		dt.errorf("sound: %v\n", err)
		return 1
	}

	format, rate, channels, ok := devToolSoundInfo(raw, data, ext)
	if ok {
		dt.printf("%s: format=%s rate=%s channels=%s → %s\n",
			vpkPath, format, devToolNum(rate), devToolNum(channels), filepath.Base(dest))
	} else {
		dt.printf("%s: format=? rate=? channels=? → %s\n", vpkPath, filepath.Base(dest))
	}
	dt.printf("wrote %s\n", dest)
	dt.printf("%s\n", devToolValveIP(dest))
	return 0
}

// devToolNum prints a container field, "?" for 0 (an ABSENT value the
// decoder recovered nothing for — never a fake 0 Hz / 0 channels).
func devToolNum(v uint32) string {
	if v == 0 {
		return "?"
	}
	return strconv.FormatUint(uint64(v), 10)
}

// devToolSoundInfo reports format/rate/channels for the `sound` printout.
// A WAV answers from the RIFF header decodeVSnd produced (exact); an MP3
// (which the decoder returns as a raw stream) answers from the container
// header — v4's DATA block, v5's CTRL KV3 — through the SAME canonical
// parsers (resourceDataBlock / parseVSndKV3), never a second decoder.
func devToolSoundInfo(raw, decoded []byte, ext string) (format string, rate, channels uint32, ok bool) {
	if ext == soundExtWAV && len(decoded) >= 44 && string(decoded[0:4]) == "RIFF" {
		channels = uint32(binary.LittleEndian.Uint16(decoded[22:24]))
		rate = binary.LittleEndian.Uint32(decoded[24:28])
		switch binary.LittleEndian.Uint16(decoded[34:36]) {
		case 16:
			format = "PCM16"
		case 8:
			format = "PCM8"
		}
		return format, rate, channels, format != ""
	}
	// MP3 (or anything else the WAV header can't describe).
	if len(raw) < 8 {
		return "", 0, 0, false
	}
	switch binary.LittleEndian.Uint16(raw[6:8]) {
	case 4: // resource v4: the fixed DATA header (rate, format, channels)
		off, size, err := resourceDataBlock(raw, "vsnd")
		if err != nil || size < 32 {
			return "", 0, 0, false
		}
		d := raw[off : off+size]
		return vsndFormatName(d[2]), uint32(binary.LittleEndian.Uint16(d[0:2])), uint32(d[3]), true
	case 5: // resource v5: m_nFormat/m_nRate/m_nChannels from the CTRL KV3
		off, size, err := resourceBlock(raw, "CTRL", "vsnd")
		if err != nil {
			return "", 0, 0, false
		}
		fileSize := int(binary.LittleEndian.Uint32(raw[0:4]))
		if fileSize < 8 || fileSize > len(raw) {
			return "", 0, 0, false
		}
		format, rate, channels, err := parseVSndKV3(raw[off:off+size], len(raw)-fileSize)
		if err != nil {
			return "", 0, 0, false
		}
		return format, rate, channels, true
	}
	return "", 0, 0, false
}

// --- overview ------------------------------------------------------------

// cmdOverview parses resource/overviews/<map>.txt and prints every key a
// pack is built from. parseOverview is THE parser; `rotate` (which the
// Overview struct deliberately doesn't carry) is read from the same
// parseKV tree.
func (dt *devTool) cmdOverview(v *vpk, args []string) int {
	if devToolHelpRequested(args) {
		return dt.printUsageLine("overview")
	}
	if len(args) != 1 {
		dt.errorf("%s\n", devToolUsageLine["overview"])
		return 2
	}
	path := overviewPfx + args[0] + ".txt"
	raw, found, err := v.read(path)
	if err != nil {
		dt.errorf("overview: %v\n", err)
		return 1
	}
	if !found {
		dt.errorf("overview: %s not in VPK\n", path)
		return 1
	}
	ov, err := parseOverview(raw)
	if err != nil {
		dt.errorf("overview: %s: %v\n", args[0], err)
		return 1
	}

	dt.printf("%s\n", path)
	dt.printf("%-9s %s\n", "pos_x", devToolFloat(ov.PosX))
	dt.printf("%-9s %s\n", "pos_y", devToolFloat(ov.PosY))
	dt.printf("%-9s %s\n", "scale", devToolFloat(ov.Scale))
	dt.printf("%-9s %s\n", "rotate", devToolOverviewRotate(raw))
	if ov.HasSites {
		dt.printf("%-9s A=(%s, %s) B=(%s, %s)\n", "sites",
			devToolFloat(ov.BombA[0]), devToolFloat(ov.BombA[1]),
			devToolFloat(ov.BombB[0]), devToolFloat(ov.BombB[1]))
	} else {
		dt.printf("%-9s (absent)\n", "sites")
	}
	if ov.HasSpawns {
		dt.printf("%-9s CT=(%s, %s) T=(%s, %s)\n", "spawns",
			devToolFloat(ov.CTSpawn[0]), devToolFloat(ov.CTSpawn[1]),
			devToolFloat(ov.TSpawn[0]), devToolFloat(ov.TSpawn[1]))
	} else {
		dt.printf("%-9s (absent)\n", "spawns")
	}
	if len(ov.Sections) == 0 {
		dt.printf("%-9s (none)\n", "sections")
	} else {
		parts := make([]string, 0, len(ov.Sections))
		for _, s := range ov.Sections {
			parts = append(parts, fmt.Sprintf("%s [%s, %s]", s.Name, devToolFloat(s.ZMin), devToolFloat(s.ZMax)))
		}
		dt.printf("%-9s %s\n", "sections", strings.Join(parts, "; "))
	}
	return 0
}

// devToolOverviewRotate reads the optional `rotate` key (the overview
// files carry it — CS2.md "Radar/overview assets"; parseOverview's
// transform contract doesn't need it).
func devToolOverviewRotate(data []byte) string {
	kv, err := parseKV(data)
	if err != nil {
		return "(absent)"
	}
	for _, v := range kv {
		if obj, ok := v.(map[string]kvValue); ok {
			if s, ok := kvString(obj, "rotate"); ok {
				return s
			}
		}
	}
	return "(absent)"
}

// devToolFloat formats a parsed overview number without trailing zeros.
func devToolFloat(f float64) string {
	return strconv.FormatFloat(f, 'g', -1, 64)
}

// --- hash / events (the only new implementations) -----------------------

// murmur2 is MurmurHash2-32 — the hash behind the demo's
// soundevent_hash and packed_params names (CS2.md "Sound-event names ↔
// demo soundevent_hash"): seed^len, 4-byte little-endian blocks with the
// 0x5bd1e995 mix, the 1/2/3-byte tail, then the 13/15 finalizer.
func murmur2(data []byte, seed uint32) uint32 {
	const m uint32 = 0x5bd1e995
	const r = 24
	h := seed ^ uint32(len(data))
	i := 0
	for ; len(data)-i >= 4; i += 4 {
		k := binary.LittleEndian.Uint32(data[i:])
		k *= m
		k ^= k >> r
		k *= m
		h *= m
		h ^= k
	}
	switch len(data) - i {
	case 3:
		h ^= uint32(data[i+2]) << 16
		fallthrough
	case 2:
		h ^= uint32(data[i+1]) << 8
		fallthrough
	case 1:
		h ^= uint32(data[i])
		h *= m
	}
	h ^= h >> 13
	h *= m
	h ^= h >> 15
	return h
}

// soundEventHash is THE demo-side hash of an event name: MurmurHash2-32
// over the LOWERCASED name with seed 0x53524332 (CS2.md ≈lines 366-387).
// The lowercase fold is why "Weapon_AK47.Single" ≡ "weapon_ak47.single".
func soundEventHash(name string) uint32 {
	return murmur2([]byte(strings.ToLower(name)), 0x53524332)
}

// SoundEventHash is the ONE public entry to that same rule — the hash the
// demo's CMsgSosStartSoundEvent carries, over a sound-event name. It exists
// for internal/extract's SOS handler (grenade bounces + player sounds), which
// resolves fixed32 hashes to names at import time with NO access to a CS2
// install (mappack has zero internal dependencies, so extract importing this
// package cannot cycle). cs2find reaches the identical rule through
// soundEventHash above — ONE implementation, never a second copy of the
// seed/lowercase rule. Test vectors: devtool_test.go (public.volume →
// BD6054E9 at seed 0x31415926, Weapon_AK47.Single ≡ weapon_ak47.single).
func SoundEventHash(name string) uint32 {
	return soundEventHash(name)
}

// murmurSelfCheck pins the one published vector CS2.md recorded for the
// packed_params seed (murmur2("public.volume", 0x31415926) → BD6054E9,
// the byte-reverse of Valve's published E9 54 60 BD sample). It runs
// before any hash is printed so a regression can never emit a
// plausible-but-wrong digest.
func murmurSelfCheck() error {
	if got := murmur2([]byte("public.volume"), 0x31415926); got != 0xbd6054e9 {
		return fmt.Errorf("murmur2 self-check failed: got %08X, want BD6054E9", got)
	}
	return nil
}

// cmdHash is `hash <name>` (pure) or `hash --resolve <hex>` (needs the
// install's vsndevts name table).
func (dt *devTool) cmdHash(args []string) int {
	if devToolHelpRequested(args) {
		dt.printf("%s", devToolHashHelp)
		return 0
	}
	if err := murmurSelfCheck(); err != nil {
		dt.errorf("cs2find: %v\n", err)
		return 1
	}
	if len(args) > 0 && args[0] == "--resolve" {
		if len(args) != 2 {
			dt.errorf("%s", devToolHashHelp)
			return 2
		}
		v, code := dt.openSession()
		if code != 0 {
			return code
		}
		defer v.close()
		return dt.cmdHashResolve(v, args[1])
	}
	if len(args) != 1 {
		dt.errorf("%s", devToolHashHelp)
		return 2
	}
	dt.printf("%s = 0x%08X\n", args[0], soundEventHash(args[0]))
	return 0
}

// cmdHashResolve reverses the hash against the locally built event
// table. Every name in that table hashes to the key it is stored under,
// so a hit is exact; 0 hits is an error (an unresolvable hash — CS2.md
// records one runtime-generated name like that), never a guess.
func (dt *devTool) cmdHashResolve(v *vpk, arg string) int {
	target, err := strconv.ParseUint(strings.TrimPrefix(strings.TrimPrefix(arg, "0x"), "0X"), 16, 32)
	if err != nil {
		dt.errorf("hash --resolve: bad hex %q\n", arg)
		return 2
	}
	tbl, err := loadVSndEvents(v)
	if err != nil {
		dt.errorf("hash --resolve: %v\n", err)
		return 1
	}
	hits := resolveSoundEvent(tbl, uint32(target))
	if len(hits) == 0 {
		dt.errorf("hash --resolve: 0x%08X matches no soundevent name in the local install\n", target)
		return 1
	}
	for _, name := range hits {
		dt.printf("0x%08X = %s\n", target, name)
	}
	return 0
}

// cmdEvents lists the local install's soundevent names (pattern is a
// case-insensitive substring filter) with the .vsnd files each event's
// object carries. An event whose object carries no vsnd_files prints its
// name alone (never an invented path).
func (dt *devTool) cmdEvents(v *vpk, args []string) int {
	if devToolHelpRequested(args) {
		dt.printf("%s", devToolEventsHelp)
		return 0
	}
	if len(args) > 1 {
		dt.errorf("%s", devToolEventsHelp)
		return 2
	}
	tbl, err := loadVSndEvents(v)
	if err != nil {
		dt.errorf("events: %v\n", err)
		return 1
	}
	if len(tbl) == 0 {
		dt.errorf("events: the soundevents/*.vsndevts_c files parsed to 0 events — refusing to print an empty table as if it were complete\n")
		return 1
	}
	pattern, raw := "", ""
	if len(args) == 1 {
		raw, pattern = args[0], strings.ToLower(args[0])
	}
	names := make([]string, 0, len(tbl))
	for name := range tbl {
		if pattern == "" || strings.Contains(strings.ToLower(name), pattern) {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	for _, name := range names {
		files := tbl[name]
		if len(files) == 0 {
			dt.printf("%s\n", name)
			continue
		}
		dt.printf("%s\t%s\n", name, strings.Join(files, ","))
	}
	if len(names) == 0 {
		dt.errorf("events: no soundevent matches %q\n", raw)
		return 1
	}
	return 0
}

// vsndEvent is one soundevent definition: its name plus the .vsnd files
// its object's vsnd_files arrays carry (CS2.md: "each value carries
// vsnd_files_track_01[] .vsnd paths").
type vsndEvent struct {
	name  string
	vsnds []string
}

// loadVSndEvents walks EVERY soundevents/*.vsndevts_c in the VPK and
// returns event name → its .vsnd files. Strict on purpose: one
// unreadable or unparsable file fails the whole load (a partial table
// would silently mis-resolve hashes — never fake output).
func loadVSndEvents(v *vpk) (map[string][]string, error) {
	files := v.names("soundevents/", ".vsndevts_c")
	if len(files) == 0 {
		return nil, fmt.Errorf("no soundevents/*.vsndevts_c in the VPK")
	}
	out := make(map[string][]string, 4096)
	for _, f := range files {
		raw, found, err := v.read(f)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", f, err)
		}
		if !found {
			return nil, fmt.Errorf("%s: vanished from the tree", f)
		}
		events, err := parseVSndevts(raw)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", f, err)
		}
		for _, e := range events {
			// First definition wins: the files are walked in sorted
			// order, so the table is deterministic if two files ever
			// redefine a name.
			if _, dup := out[e.name]; !dup {
				out[e.name] = e.vsnds
			}
		}
	}
	return out, nil
}

// parseVSndevts turns one .vsndevts_c resource into its event
// definitions. The KV3 payload sits in the DATA block (CS2.md ≈989-1013
// / ≈1114-1117); a CTRL block is accepted too — the two carry the same
// 120-byte binary-KV3 + 2×LZ4 body as a v5 .vsnd (≈744-763), and which
// fourCC holds it is the only difference.
func parseVSndevts(raw []byte) ([]vsndEvent, error) {
	strs, u, err := vsndevtsKV3(raw)
	if err != nil {
		return nil, err
	}
	return vsndEventsFromStream(strs, u), nil
}

// vsndevtsKV3 decodes one .vsndevts_c resource to (NUL string table,
// raw u32 pair stream). The body is the v5 .vsnd CTRL layout — magic
// `KV3\x05`, GUID, compression at 20, the four buffer sizes at
// 72/76/80/84, buffers from offset vsndCtrlHeaderSize — but both
// buffers are decoded HERE instead of through lz4Buffers for two
// reasons: lz4Buffers folds buffer 2 through walkKVPairs, whose key test
// (_class / m_*) only fits .vsnd objects while vsndevts root keys are
// event names; and it rejects the one shipped file whose buffer 2 has no
// 0xFFEEDD00 trailer (soundevents/soundevents_from_tools.vsndevts_c —
// all 183 files verified 2026-11-09). compression=1 is LZ4 (every .vsnd
// CTRL shape); compression=0 stores both buffers raw, which is that one
// file's shape.
func vsndevtsKV3(raw []byte) ([]string, []uint32, error) {
	off, size, err := resourceBlock(raw, "DATA", "vsndevts")
	if err != nil {
		off, size, err = resourceBlock(raw, "CTRL", "vsndevts")
	}
	if err != nil {
		return nil, nil, err
	}
	block := raw[off : off+size]
	if len(block) < vsndCtrlHeaderSize+8 {
		return nil, nil, fmt.Errorf("vsndevts: KV3 block %d bytes is too short", len(block))
	}
	if block[0] != 0x05 || block[1] != 0x33 || block[2] != 0x56 || block[3] != 0x4b {
		return nil, nil, fmt.Errorf("vsndevts: KV3 magic % x is not KV3 v5", block[:4])
	}
	u32 := func(o int) uint32 { return binary.LittleEndian.Uint32(block[o : o+4]) }
	comp := u32(20)
	if comp != 0 && comp != 1 {
		return nil, nil, fmt.Errorf("vsndevts: compression %d (want 0 = raw or 1 = LZ4)", comp)
	}
	unc1, comp1 := int(u32(vsndCtrlOffUnc1)), int(u32(vsndCtrlOffComp1))
	unc2, comp2 := int(u32(vsndCtrlOffUnc2)), int(u32(vsndCtrlOffComp2))
	if unc1 <= 0 || unc2 <= 0 {
		return nil, nil, fmt.Errorf("vsndevts: KV3 buffer sizes %d/%d", unc1, unc2)
	}
	stored1, stored2 := unc1, unc2 // compression 0: stored == uncompressed
	if comp == 1 {
		stored1, stored2 = comp1, comp2
	}
	start := vsndCtrlHeaderSize
	if start+stored1+stored2 > len(block) {
		return nil, nil, fmt.Errorf("vsndevts: KV3 buffer sizes overrun the block")
	}
	s1, err := vsndevtsBuffer(block[start:start+stored1], unc1, comp)
	if err != nil {
		return nil, nil, err
	}
	s2, err := vsndevtsBuffer(block[start+stored1:start+stored1+stored2], unc2, comp)
	if err != nil {
		return nil, nil, err
	}
	// The pair stream may end in the 4-byte 0xFFEEDD00 trailer (present
	// in every LZ4 file, absent in the raw one) — drop it when there.
	if len(s2) >= vsndKV3TrailerLength {
		tail := s2[len(s2)-vsndKV3TrailerLength:]
		if tail[0] == 0x00 && tail[1] == 0xdd && tail[2] == 0xee && tail[3] == 0xff {
			s2 = s2[:len(s2)-vsndKV3TrailerLength]
		}
	}
	// Trailing sub-word bytes (the writer's type lane) are not pairs.
	u := make([]uint32, len(s2)/4)
	for i := range u {
		u[i] = binary.LittleEndian.Uint32(s2[i*4:])
	}
	return strings.Split(string(s1), "\x00"), u, nil
}

// vsndevtsBuffer expands one KV3 raw buffer: LZ4 for compression 1, the
// bytes as-is for compression 0 (stored size == uncompressed size).
func vsndevtsBuffer(src []byte, unc int, comp uint32) ([]byte, error) {
	if comp == 0 {
		return src, nil
	}
	dst := make([]byte, unc)
	if n, err := lz4.UncompressBlock(src, dst); err != nil || n != unc {
		return nil, fmt.Errorf("vsndevts: LZ4 buffer: %v (decoded %d, want %d)", err, n, unc)
	}
	return dst, nil
}

// soundeventRefProp is the property whose values are OTHER event names
// (a child-event list — measured as the only property in the install
// followed by name-valued u32s; its run is the reference list of one
// event, see vsndEventDefs).
const soundeventRefProp = "soundevent_01"

// isVSndEventName reports whether a string is shaped like a soundevent
// name: dotted (c4.initiate, Weapon_AK47.Single) and never containing a
// path separator. Property keys (vsnd_files_track_01) are undotted and
// .vsnd paths contain "/", so the three shapes never collide.
func isVSndEventName(s string) bool {
	return strings.Contains(s, ".") && !strings.Contains(s, "/")
}

// isVSndFilePath reports whether a string is a .vsnd file path.
func isVSndFilePath(s string) bool {
	return strings.HasSuffix(s, ".vsnd") || strings.HasSuffix(s, ".vsnd_c")
}

// vsndEventDefs marks which pair-stream positions DEFINE an event.
//
// The pair stream is [key][value?] per property — a key stores a value
// u32 only for string values (numbers live in a separate lane) — so an
// event's object runs from its name to the next name. The naive "every
// dotted u32 is a name" rule is wrong in one specific way, measured
// across all 183 files of a local install (2026-11-09): an event name is
// ALSO written as a value of soundevent_01, and that property holds a
// LIST — [soundevent_01, ref, ref, …] until the next non-name u32 (e.g.
// BaseGrenade.Explode = soundevent_01 → [BaseGrenade.ExplodeDistant,
// BaseExplosionEffect.Sound] before its own vsnd_files). Every other
// property that precedes a name in the stream is a float/bool key, a raw
// number or a path — i.e. a genuine definition boundary — so a name in
// the soundevent_01 run is a REFERENCE and every other name DEFINES.
// (The string table alone cannot do this: strings are numbered by first
// use, so a reference's table neighbour is whatever string preceded it
// in the file, not the property holding it.)
func vsndEventDefs(strs []string, u []uint32) []bool {
	def := make([]bool, len(u))
	refProp := -1
	for i, s := range strs {
		if s == soundeventRefProp {
			refProp = i
			break
		}
	}
	refRun := false
	for i := 2; i < len(u); i++ { // 2 = the stream's own header u32s
		if int(u[i]) >= len(strs) {
			refRun = false // a raw number ends any run
			continue
		}
		s := strs[u[i]]
		if refRun {
			if isVSndEventName(s) {
				continue // still inside the reference list
			}
			refRun = false
		}
		if refProp >= 0 && int(u[i]) == refProp {
			refRun = true
			continue
		}
		if isVSndEventName(s) {
			def[i] = true
		}
	}
	return def
}

// vsndEventsFromStream folds the pair stream into definitions: each
// DEFINING name owns the region up to the next definition, and every
// .vsnd path in that region is one of its vsnd_files.
func vsndEventsFromStream(strs []string, u []uint32) []vsndEvent {
	def := vsndEventDefs(strs, u)
	var out []vsndEvent
	for i := 2; i < len(u); i++ {
		if !def[i] {
			continue
		}
		var files []string
		for j := i + 1; j < len(u) && !def[j]; j++ {
			if int(u[j]) >= len(strs) {
				continue
			}
			if s := strs[u[j]]; isVSndFilePath(s) {
				files = append(files, s)
			}
		}
		out = append(out, vsndEvent{name: strs[u[i]], vsnds: files})
	}
	return out
}

// resolveSoundEvent reverses soundEventHash over a built table: every
// name whose hash equals h, sorted (a 32-bit hash can collide, so this
// returns all candidates rather than one arbitrary winner).
func resolveSoundEvent(tbl map[string][]string, h uint32) []string {
	var hits []string
	for name := range tbl {
		if soundEventHash(name) == h {
			hits = append(hits, name)
		}
	}
	sort.Strings(hits)
	return hits
}
