package mappack

import (
	"encoding/binary"
	"encoding/json"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"github.com/pierrec/lz4/v4"
)

// Test fixtures are built byte-by-byte in code: synthetic vtex_c
// resources, synthetic VPKs, synthetic Steam library layouts. No Valve
// assets are committed (the acquisition posture forbids it).

// --- synthetic vtex_c ---------------------------------------------------

// buildVTex constructs a minimal Source 2 texture resource: 28-byte
// header, one DATA block (texture header + optional COMPRESSED_MIP_SIZE
// extra data), and pixel bytes after the block.
func buildVTex(t *testing.T, w, h, format int, rawPix []byte, compress bool) []byte {
	t.Helper()
	bpp := pixelBPP(format)
	if bpp == 0 {
		t.Fatalf("bad format %d", format)
	}
	want := imageSize(w, h, bpp)
	if len(rawPix) != want {
		t.Fatalf("fixture pixels %d != expected %d", len(rawPix), want)
	}

	stored := rawPix
	var mipMethod uint32 = mipCompressNone
	if compress {
		dst := make([]byte, lz4.CompressBlockBound(len(rawPix)))
		n, err := lz4.CompressBlock(rawPix, dst, nil)
		// Real files only mark a mip compressed when that shrinks it
		// (VRF: compressed >= uncompressed ⇒ stored raw); mirror that —
		// small synthetic buffers often don't compress.
		if err == nil && n > 0 && n < len(rawPix) {
			stored = dst[:n]
			mipMethod = mipCompressLZ4
		}
	}

	// DATA block: texture header (40 bytes) + extra data (one
	// COMPRESSED_MIP_SIZE entry + its 12-byte header + 1 mip size).
	const texHdr = 40
	extraHdr := 12 + 12 // entry header + method/mipsOffset/mips
	sizes := 4          // one int32 (mip 0)
	dataBlockSize := texHdr + extraHdr + sizes
	// Offsets inside extra data: entry at dataBlock+40, payload base at
	// entryEnd + eoff - 8, sizes at base + 4 + mipsOff.

	buf := make([]byte, 0, 64+dataBlockSize+len(stored))
	// resource header (16 bytes: fileSize, headerVersion, version,
	// blockOffset, blockCount) — see s2v.app read-resource guide
	hdr := make([]byte, 16)
	binary.LittleEndian.PutUint32(hdr[0:4], uint32(16+12+dataBlockSize+len(stored)))
	binary.LittleEndian.PutUint16(hdr[4:6], 12) // header version
	binary.LittleEndian.PutUint16(hdr[6:8], 1)  // resource version
	binary.LittleEndian.PutUint32(hdr[8:12], 8) // blockOffset (table at 8+8=16)
	binary.LittleEndian.PutUint32(hdr[12:16], 1)
	buf = append(buf, hdr...)
	// block index entry: "DATA", offset relative to the offset field
	// (position 20), pointing at 28 → rel = 8
	entry := make([]byte, 12)
	copy(entry[0:4], "DATA")
	binary.LittleEndian.PutUint32(entry[4:8], 8)
	binary.LittleEndian.PutUint32(entry[8:12], uint32(dataBlockSize))
	buf = append(buf, entry...)

	// DATA block
	data := make([]byte, dataBlockSize)
	binary.LittleEndian.PutUint16(data[0:2], 1)           // texture version
	binary.LittleEndian.PutUint16(data[20:22], uint16(w)) // width
	binary.LittleEndian.PutUint16(data[22:24], uint16(h)) // height
	binary.LittleEndian.PutUint16(data[24:26], 1)         // depth
	data[26] = byte(format)
	data[27] = 1                                  // numMips
	binary.LittleEndian.PutUint32(data[32:36], 8) // extraDataOffset
	binary.LittleEndian.PutUint32(data[36:40], 1) // extraDataCount

	// extra entry at 40: type=4, offset such that payload sits right
	// after the entry (entryEnd=52, payload base must equal 52 →
	// 52 = 52 + eoff - 8 → eoff = 8)
	binary.LittleEndian.PutUint32(data[40:44], 4) // COMPRESSED_MIP_SIZE
	binary.LittleEndian.PutUint32(data[44:48], 8) // eoff
	binary.LittleEndian.PutUint32(data[48:52], uint32(extraHdr-12+sizes))
	// payload at 52: method, mipsOff, mips
	binary.LittleEndian.PutUint32(data[52:56], mipMethod)
	binary.LittleEndian.PutUint32(data[56:60], 8) // mipsOff: sizes at 52+4+8=64
	binary.LittleEndian.PutUint32(data[60:64], 1) // mips
	// sizes at 64: stored size
	binary.LittleEndian.PutUint32(data[64:68], uint32(len(stored)))

	buf = append(buf, data...)
	buf = append(buf, stored...)
	return buf
}

// bgraPix builds a BGRA8888 buffer with a per-pixel gradient.
func bgraPix(w, h int) []byte {
	pix := make([]byte, w*h*4)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			o := (y*w + x) * 4
			pix[o+0] = byte(x * 7)  // B
			pix[o+1] = byte(y * 11) // G
			pix[o+2] = byte(x + y)  // R
			pix[o+3] = 255          // A
		}
	}
	return pix
}

// --- synthetic VPK ------------------------------------------------------

// buildVPK writes a pak01_dir.vpk (plus numbered archives) into dir and
// returns the dir-file path. files maps "<dir>/<name>.<ext>" → contents;
// every file lands in numbered archives (CS2's own layout — the embedded
// path is spec-derived and unused by real CS2 data).
func buildVPK(t *testing.T, dir string, files map[string][]byte) string {
	t.Helper()
	// Group by (ext, dir) for the tree.
	type fileRec struct {
		name string
		ext  string
		dir  string
		data []byte
	}
	var recs []fileRec
	for full, data := range files {
		d := filepath.Dir(full)
		base := filepath.Base(full)
		ext := ""
		if i := len(base) - 1; i > 0 {
			for j := i; j >= 0; j-- {
				if base[j] == '.' {
					ext = base[j+1:]
					base = base[:j]
					break
				}
			}
		}
		if ext == "" {
			t.Fatalf("no extension in %q", full)
		}
		recs = append(recs, fileRec{name: base, ext: ext, dir: d, data: data})
	}

	// Emit data into numbered archives (64 KiB chunks per archive to
	// exercise multi-archive indexing).
	const archiveCap = 64 << 10
	archiveIdx := 0
	archiveOff := 0
	var archiveData []byte
	// offset/length per record, filled while packing
	type packed struct {
		fileRec
		archiveIndex uint16
		offset       uint32
		length       uint32
	}
	var out []packed
	for _, r := range recs {
		if archiveOff+len(r.data) > archiveCap && len(archiveData) > 0 {
			writeArchive(t, dir, archiveIdx, archiveData)
			archiveIdx++
			archiveOff = 0
			archiveData = nil
		}
		out = append(out, packed{
			fileRec:      r,
			archiveIndex: uint16(archiveIdx),
			offset:       uint32(archiveOff),
			length:       uint32(len(r.data)),
		})
		archiveData = append(archiveData, r.data...)
		archiveOff += len(r.data)
	}
	if len(archiveData) > 0 {
		writeArchive(t, dir, archiveIdx, archiveData)
	}

	// Build the tree grouped ext → dir → files (sorted for
	// determinism — map iteration isn't deterministic).
	byExt := map[string]map[string][]string{}
	for _, p := range out {
		if byExt[p.ext] == nil {
			byExt[p.ext] = map[string][]string{}
		}
		byExt[p.ext][p.dir] = append(byExt[p.ext][p.dir], p.name)
	}
	packedByName := map[string]packed{}
	for _, p := range out {
		packedByName[p.dir+"/"+p.name+"."+p.ext] = p
	}

	var tree []byte
	putStr := func(s string) {
		tree = append(tree, s...)
		tree = append(tree, 0)
	}
	for _, ext := range sortedKeys(byExt) {
		putStr(ext)
		for _, d := range sortedKeys(byExt[ext]) {
			putStr(d)
			for _, name := range sortedStrings(byExt[ext][d]) {
				putStr(name)
				p := packedByName[d+"/"+name+"."+ext]
				var raw [18]byte
				binary.LittleEndian.PutUint16(raw[4:6], 0) // no preload
				binary.LittleEndian.PutUint16(raw[6:8], p.archiveIndex)
				binary.LittleEndian.PutUint32(raw[8:12], p.offset)
				binary.LittleEndian.PutUint32(raw[12:16], p.length)
				binary.LittleEndian.PutUint16(raw[16:18], 0xffff)
				tree = append(tree, raw[:]...)
			}
			tree = append(tree, 0) // end of paths
		}
		tree = append(tree, 0) // end of paths for this ext
	}
	tree = append(tree, 0) // end of extensions

	hdr := make([]byte, vpkHeaderSize)
	binary.LittleEndian.PutUint32(hdr[0:4], vpkMagic)
	binary.LittleEndian.PutUint32(hdr[4:8], 2)
	binary.LittleEndian.PutUint32(hdr[8:12], uint32(len(tree)))
	dirPath := filepath.Join(dir, "pak01_dir.vpk")
	if err := os.WriteFile(dirPath, append(hdr, tree...), 0o644); err != nil {
		t.Fatal(err)
	}
	return dirPath
}

func writeArchive(t *testing.T, dir string, idx int, data []byte) {
	t.Helper()
	name := filepath.Join(dir, "pak01_"+pad3(idx)+".vpk")
	if err := os.WriteFile(name, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func pad3(n int) string {
	s := []byte{'0', '0', '0'}
	v := n
	for i := 2; i >= 0; i-- {
		s[i] = byte('0' + v%10)
		v /= 10
	}
	return string(s)
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sortStrings(out)
	return out
}

func sortedStrings(s []string) []string {
	out := append([]string{}, s...)
	sortStrings(out)
	return out
}

// --- tests --------------------------------------------------------------

func TestParseKV(t *testing.T) {
	data := []byte(`
"AppState"
{
	"appid"		"730"
	"installdir"	"Counter-Strike Global Offensive"	// comment
	"nested"
	{
		"key"	"value with \"quotes\" and \\ backslash"
	}
}
`)
	kv, err := parseKV(data)
	if err != nil {
		t.Fatal(err)
	}
	state := kv["AppState"].(map[string]kvValue)
	if v, _ := kvString(state, "appid"); v != "730" {
		t.Errorf("appid = %q", v)
	}
	if v, _ := kvString(state, "installdir"); v != "Counter-Strike Global Offensive" {
		t.Errorf("installdir = %q", v)
	}
	nested := state["nested"].(map[string]kvValue)
	if v, _ := kvString(nested, "key"); v != `value with "quotes" and \ backslash` {
		t.Errorf("nested key = %q", v)
	}
}

func TestParseOverview(t *testing.T) {
	data := []byte(`"de_fixture"
{
	"pos_x"		"-2476"
	"pos_y"		"3239"
	"scale"		"4.4"
	"bombA_x"	"0.54"
	"bombA_y"	"0.76"
	"bombB_x"	"0.23"
	"bombB_y"	"0.28"
	"CTSpawn_x"	"0.28"
	"CTSpawn_y"	"0.70"
	"TSpawn_x"	"0.87"
	"TSpawn_y"	"0.36"
}
`)
	ov, err := parseOverview(data)
	if err != nil {
		t.Fatal(err)
	}
	if ov.PosX != -2476 || ov.PosY != 3239 || ov.Scale != 4.4 {
		t.Errorf("transform = %+v", ov)
	}
	if !ov.HasSites || ov.BombA != [2]float64{0.54, 0.76} || ov.BombB != [2]float64{0.23, 0.28} {
		t.Errorf("sites = %+v", ov)
	}
	if !ov.HasSpawns || ov.CTSpawn != [2]float64{0.28, 0.70} {
		t.Errorf("spawns = %+v", ov)
	}
}

func TestParseOverviewMissingTransform(t *testing.T) {
	if _, err := parseOverview([]byte(`"x" { "scale" "1" }`)); err == nil {
		t.Error("want error for missing pos_x")
	}
}

func TestDecodeVTexBGRA(t *testing.T) {
	const w, h = 8, 8
	// Flat bands compress well under LZ4, so the compressed iteration
	// genuinely exercises the decompress path (a gradient often expands
	// and would silently fall back to raw).
	pix := make([]byte, w*h*4)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			o := (y*w + x) * 4
			pix[o+0] = byte(x / 2) // B
			pix[o+1] = byte(y / 2) // G
			pix[o+2] = byte(9)     // R
			pix[o+3] = 255         // A
		}
	}
	for _, compress := range []bool{false, true} {
		data := buildVTex(t, w, h, vtexFormatBGRA8888, pix, compress)
		img, err := decodeVTex(data)
		if err != nil {
			t.Fatalf("compress=%v: %v", compress, err)
		}
		if img.Bounds().Dx() != w || img.Bounds().Dy() != h {
			t.Fatalf("compress=%v: bounds %v", compress, img.Bounds())
		}
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				want := color.NRGBA{R: 9, G: byte(y / 2), B: byte(x / 2), A: 255}
				got := img.NRGBAAt(x, y)
				if got != want {
					t.Fatalf("compress=%v: pixel (%d,%d) = %v, want %v", compress, x, y, got, want)
				}
			}
		}
	}
}

// dxt5Block encodes one 4×4 block: flat color + flat alpha.
func dxt5Block(r, g, b, a byte) []byte {
	blk := make([]byte, 16)
	blk[0] = a // a0
	blk[1] = a // a1 (equal → 3-color mode, but indices all select 0)
	// alpha indices all 0 (bytes 2..7 zero)
	// color: c0 = c1 = exact RGB565 of (r,g,b); index 0 → c0.
	c := rgb565Exact(r, g, b)
	binary.LittleEndian.PutUint16(blk[8:10], c)
	binary.LittleEndian.PutUint16(blk[10:12], c)
	return blk
}

func rgb565Exact(r, g, b byte) uint16 {
	return uint16(r>>3)<<11 | uint16(g>>2)<<5 | uint16(b>>3)
}

func TestDecodeVTexDXT5(t *testing.T) {
	const w, h = 4, 4
	var pix []byte
	for i := 0; i < (w/4)*(h/4); i++ {
		pix = append(pix, dxt5Block(200, 100, 50, 255)...)
	}
	for _, compress := range []bool{false, true} {
		data := buildVTex(t, w, h, vtexFormatDXT5, pix, compress)
		img, err := decodeVTex(data)
		if err != nil {
			t.Fatalf("compress=%v: %v", compress, err)
		}
		// RGB565 round-trip loses low bits: expansion is v<<3|v>>2.
		er, eg, eb := 200>>3, 100>>2, 50>>3
		want := color.NRGBA{
			R: byte(er<<3 | er>>2),
			G: byte(eg<<2 | eg>>4),
			B: byte(eb<<3 | eb>>2),
			A: 255,
		}
		got := img.NRGBAAt(2, 2)
		if got != want {
			t.Fatalf("compress=%v: center pixel = %v, want %v", compress, got, want)
		}
	}
}

func TestVPKRoundTrip(t *testing.T) {
	dir := t.TempDir()
	files := map[string][]byte{
		"panorama/images/overheadmaps/de_fixture_radar_psd.vtex_c":       []byte("radar-bytes"),
		"resource/overviews/de_fixture.txt":                              []byte("overview-text"),
		"panorama/images/overheadmaps/de_fixture_lower_radar_psd.vtex_c": []byte("lower"),
	}
	dirPath := buildVPK(t, dir, files)
	v, err := openVPK(dirPath)
	if err != nil {
		t.Fatal(err)
	}
	defer v.close()
	for name, want := range files {
		got, found, err := v.read(name)
		if err != nil || !found {
			t.Fatalf("read %s: found=%v err=%v", name, found, err)
		}
		if string(got) != string(want) {
			t.Errorf("read %s = %q, want %q", name, got, want)
		}
	}
	if _, found, _ := v.read("nope/nope.txt"); found {
		t.Error("unexpectedly found missing file")
	}
	// names() filters prefix+suffix and is sorted.
	names := v.names(radarPrefix, radarSuffix)
	if len(names) != 2 || names[0] > names[1] {
		t.Errorf("names = %v", names)
	}
}

func TestMapNameFromRadar(t *testing.T) {
	cases := map[string]string{
		"panorama/images/overheadmaps/de_mirage_radar_psd.vtex_c":        "de_mirage",
		"panorama/images/overheadmaps/de_nuke_lower_radar_psd.vtex_c":    "",
		"panorama/images/overheadmaps/de_ancient_night_radar_psd.vtex_c": "de_ancient_night",
	}
	for in, want := range cases {
		if got := mapNameFromRadar(in); got != want {
			t.Errorf("mapNameFromRadar(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestExtractMapPacks(t *testing.T) {
	// Synthetic CS2 install: steam layout + VPK with one radar + overview.
	install := t.TempDir()
	csgo := filepath.Join(install, "game", "csgo")
	if err := os.MkdirAll(csgo, 0o755); err != nil {
		t.Fatal(err)
	}
	const w, h = 8, 8
	radar := buildVTex(t, w, h, vtexFormatBGRA8888, bgraPix(w, h), true)
	buildVPK(t, csgo, map[string][]byte{
		"panorama/images/overheadmaps/de_fixture_radar_psd.vtex_c": radar,
		"resource/overviews/de_fixture.txt": []byte(`"de_fixture"
{
	"pos_x"		"-100"
	"pos_y"		"200"
	"scale"		"4.0"
	"bombA_x"	"0.5"
	"bombA_y"	"0.6"
	"bombB_x"	"0.2"
	"bombB_y"	"0.3"
	"CTSpawn_x"	"0.1"
	"CTSpawn_y"	"0.2"
	"TSpawn_x"	"0.8"
	"TSpawn_y"	"0.9"
}
`),
	})

	out := t.TempDir()
	maps, errs, err := ExtractMapPacks(install, out)
	if err != nil {
		t.Fatal(err)
	}
	if len(errs) > 0 {
		t.Fatalf("unexpected errors: %v", errs)
	}
	if len(maps) != 1 || maps[0].Map != "de_fixture" {
		t.Fatalf("maps = %+v", maps)
	}

	// PNG decodes back to the right size.
	f, err := os.Open(filepath.Join(out, "de_fixture", "radar.png"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	img, err := png.Decode(f)
	if err != nil {
		t.Fatal(err)
	}
	if img.Bounds().Dx() != w || img.Bounds().Dy() != h {
		t.Errorf("png bounds = %v", img.Bounds())
	}

	// meta.json has transform + markers.
	metaRaw, err := os.ReadFile(filepath.Join(out, "de_fixture", "meta.json"))
	if err != nil {
		t.Fatal(err)
	}
	var meta packMeta
	if err := json.Unmarshal(metaRaw, &meta); err != nil {
		t.Fatal(err)
	}
	if meta.SchemaVersion != 1 || meta.Transform == nil {
		t.Fatalf("meta = %+v", meta)
	}
	if meta.Transform.PosX != -100 || meta.Transform.Scale != 4 {
		t.Errorf("transform = %+v", meta.Transform)
	}
	if meta.Radar == nil || meta.Radar.Width != w || meta.Radar.File != "radar.png" {
		t.Errorf("radar = %+v", meta.Radar)
	}
	if meta.Sites.A == nil || meta.Sites.A.X != 0.5 || meta.Spawns.CT == nil {
		t.Errorf("markers = %+v", meta)
	}
}

func TestFindCS2FromSteamRoot(t *testing.T) {
	// Synthetic Steam root: libraryfolders.vdf + appmanifest + install.
	root := t.TempDir()
	lib := filepath.Join(root, "steamapps")
	if err := os.MkdirAll(lib, 0o755); err != nil {
		t.Fatal(err)
	}
	vdf := []byte(`"libraryfolders"
{
	"0" { "path" "` + root + `" }
}
`)
	if err := os.WriteFile(filepath.Join(lib, "libraryfolders.vdf"), vdf, 0o644); err != nil {
		t.Fatal(err)
	}
	acf := []byte(`"AppState"
{
	"appid"		"730"
	"installdir"	"Counter-Strike Global Offensive"
}
`)
	if err := os.WriteFile(filepath.Join(lib, "appmanifest_730.acf"), acf, 0o644); err != nil {
		t.Fatal(err)
	}
	pak := filepath.Join(lib, "common", "Counter-Strike Global Offensive", "game", "csgo")
	if err := os.MkdirAll(pak, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pak, "pak01_dir.vpk"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	// steamLibraries sees the root itself + the vdf path; pakInLibrary
	// resolves through the manifest.
	libs := steamLibraries(root)
	if len(libs) < 1 {
		t.Fatal("no libraries")
	}
	got := pakInLibrary(root)
	if got != filepath.Join(pak, "pak01_dir.vpk") {
		t.Errorf("pakInLibrary = %q", got)
	}
	// resolvePak accepts the csgo dir directly.
	if p := resolvePak(pak); p != filepath.Join(pak, "pak01_dir.vpk") {
		t.Errorf("resolvePak(csgo dir) = %q", p)
	}
	// resolvePak accepts the VPK file itself.
	if p := resolvePak(filepath.Join(pak, "pak01_dir.vpk")); p == "" {
		t.Error("resolvePak(pak file) = empty")
	}
}
