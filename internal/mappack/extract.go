package mappack

import (
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/image/draw"
)

// Extraction: from a CS2 install dir, enumerate radar textures in
// pak01_dir.vpk, decode each to PNG, pair with its overview txt, and
// write a map pack (meta.json + radar.png) per map into the output
// directory — the same on-disk contract as frontend/public/maps/, so the
// frontend needs no per-source logic beyond lookup order.

const (
	radarPrefix  = "panorama/images/overheadmaps/"
	radarSuffix  = "_radar_psd.vtex_c"
	overviewPfx  = "resource/overviews/"
	packRadarPNG = "radar.png"
	packMetaJSON = "meta.json"
	// radarUpscale is the pixel multiplier every written radar/layer PNG
	// gets. The source vtex decodes to 1024×1024 with a single mip (see
	// vtex.go — there is no larger source), which reads grainy at high
	// zoom; the webview can only sample the pixels the file actually
	// holds. The resample is Lanczos-3 (lanczos3 below, golang.org/x/
	// image/draw) followed by a modest unsharp mask (unsharpMask) —
	// deterministic, offline, no AI model, so extraction stays portable.
	//
	// 3× (3072²), NOT 4×: measured per-map total written bytes (radar.png
	// + layer PNGs) over the 18 official maps on a real CS2 install
	// (2026-11-08): 3× → 29.67 MB total, largest map ar_shoots 3.14 MB;
	// 4× → 48.98 MB total, ar_shoots 5.00 MB (de_train 4.46, de_overpass
	// 3.86) — several maps at or past the ~5 MB/map line, and decoded
	// texture memory grows quadratically with them (3072² RGBA ≈ 37 MB
	// per layer vs 4096² ≈ 67 MB) for a gain only the deepest zooms
	// show. meta.json keeps the LOGICAL size (the decoded source
	// bounds): the frontend maps world→image in that space and draws the
	// file destination-size (mapxform.js makeTransform, renderer.js
	// drawRadar, HeatmapLayer), so 3× pixels only improve sampling at
	// every zoom without moving anything.
	radarUpscale = 3

	// Unsharp-mask parameters for the post-Lanczos sharpen (applied at
	// the UPSCALED resolution — see unsharpMask): a 1-px-radius box
	// blur (3×3 at every upscale factor) is the "blur" the detail is
	// measured against; amount 0.5 pushes RGB halfway from blur back
	// toward the pixel — crisp at zoom without visible halos. Kept
	// deliberately small: Lanczos-3 already rings slightly at hard
	// edges (crisper radar art), so the mask only tops it up.
	unsharpRadius = 1
	unsharpAmount = 0.5
)

// ExtractResult reports one extracted map pack.
type ExtractResult struct {
	Map  string `json:"map"`
	File string `json:"file"` // radar.png path
}

// packMeta is the meta.json written next to radar.png — schema_version 1,
// matching frontend/public/maps/README.md. The Layers field is an
// ADDITIVE optional key (schema_version stays 1): a pack without it is
// the single-layer contract that predates it, byte-identical to before
// when the overview declares no verticalsections.
type packMeta struct {
	SchemaVersion int         `json:"schema_version"`
	Radar         *packRadar  `json:"radar,omitempty"`
	Transform     *packXform  `json:"transform,omitempty"`
	Sites         packMarkers `json:"sites"`
	Spawns        packMarkers `json:"spawns"`
	Source        packSource  `json:"source"`
	// Layers: one entry per verticalsections radar floor (default first),
	// each with its own image + world-Z band. Absent for single-floor
	// maps.
	Layers []packLayer `json:"layers,omitempty"`
	// ElevationRegions are world-space boxes with their own thresholds —
	// the ONLY source of T/⊥ indicator thresholds (region-only design;
	// per-floor `elevation` keys were dropped from the contract). The
	// extractor writes none — they are user-supplied in-game data,
	// carried across re-extraction by preserveElevation (which also
	// silently DROPS any stale elevation key on refresh).
	ElevationRegions []packRegion `json:"elevation_regions,omitempty"`
}

// packLayer is one radar layer (panel) in a multi-floor pack.
type packLayer struct {
	ID   string `json:"id"`   // the verticalsections name ("default", "lower")
	Name string `json:"name"` // display label ("Upper", "Lower")
	File string `json:"file"` // radar.png / radar_<section>.png
	// Width/Height: real pixel size of that layer's image.
	Width  int `json:"width"`
	Height int `json:"height"`
	// ZMin/ZMax: the section's AltitudeMin/AltitudeMax world-Z band —
	// REAL extracted values (CS2.md "verticalsections").
	ZMin float64 `json:"z_min"`
	ZMax float64 `json:"z_max"`
	// Transform: optional per-layer override of the pack's shared
	// transform (rare — both Nuke radars share one transform, verified).
	// The extractor never writes it; hand-authored packs may.
	Transform *packXform `json:"transform,omitempty"`
}

// packRegion is a world-space bounding box (X/Y, MIN-CORNER + size) with
// its own elevation thresholds — THE threshold source for entities
// inside the box (the layer they're drawn on carries none). Optional
// ZMin/ZMax scope the box to one floor (half-open [ZMin, ZMax), the
// band convention — e.g. Nuke's catwalk ring ends where the upper band
// begins); nil = unconstrained. User-supplied (never written by the
// extractor; carried across re-extraction by preserveElevation).
type packRegion struct {
	X          float64  `json:"x"`
	Y          float64  `json:"y"`
	W          float64  `json:"w"`
	H          float64  `json:"h"`
	ReferenceZ float64  `json:"reference_z"`
	Above      float64  `json:"above"`
	Below      float64  `json:"below"`
	ZMin       *float64 `json:"z_min,omitempty"`
	ZMax       *float64 `json:"z_max,omitempty"`
}

type packRadar struct {
	File   string `json:"file"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

type packXform struct {
	PosX  float64 `json:"pos_x"`
	PosY  float64 `json:"pos_y"`
	Scale float64 `json:"scale"`
}

// packMarkers holds optional fractional (0..1) radar-space anchors.
type packMarkers struct {
	A  *fracPoint `json:"a,omitempty"`
	B  *fracPoint `json:"b,omitempty"`
	CT *fracPoint `json:"ct,omitempty"`
	T  *fracPoint `json:"t,omitempty"`
}

type fracPoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type packSource struct {
	Note string `json:"note"`
}

// ExtractMapPacks extracts every official-map radar from the CS2 install
// at cs2Dir into outDir (created if needed), one subdirectory per map.
// Existing packs are overwritten (idempotent re-extract after game
// updates). Individual map failures are reported in errs but don't abort
// the rest; a failure to even open the VPK is fatal.
func ExtractMapPacks(cs2Dir, outDir string) (maps []ExtractResult, errs []string, err error) {
	pak := resolvePak(cs2Dir)
	if pak == "" {
		return nil, nil, fmt.Errorf("no pak01_dir.vpk under %s", cs2Dir)
	}
	v, err := openVPK(pak)
	if err != nil {
		return nil, nil, err
	}
	defer v.close()

	for _, radarPath := range v.names(radarPrefix, radarSuffix) {
		base := radarBase(radarPath)
		if base == "" {
			continue
		}
		// Section radars (<map>_<section>_radar) are LAYERS of another
		// map's pack, extracted by extractOne from that map's
		// verticalsections — never packs of their own. The check is
		// data-driven (the overview declares which suffixes are
		// sections), so a section name is never hardcoded here.
		if _, _, isSection := sectionRadar(v, base); isSection {
			continue
		}
		mapName := base
		if err := extractOne(v, mapName, radarPath, outDir); err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", mapName, err))
			continue
		}
		maps = append(maps, ExtractResult{
			Map:  mapName,
			File: filepath.Join(outDir, mapName, packRadarPNG),
		})
	}
	if len(maps) == 0 && len(errs) > 0 {
		return nil, errs, fmt.Errorf("no map packs extracted (%d errors)", len(errs))
	}
	return maps, errs, nil
}

// radarBase derives a map/section name from a radar path:
// panorama/images/overheadmaps/de_mirage_radar_psd.vtex_c → de_mirage.
// Returns "" for a path that does not sit directly under radarPrefix or
// whose stem is empty (defensive — a VPK path with extra directories
// would otherwise smuggle separators into the pack dir name).
func radarBase(path string) string {
	base := strings.TrimPrefix(path, radarPrefix)
	if base == path {
		return ""
	}
	name := strings.TrimSuffix(base, radarSuffix)
	if name == "" || name == base || strings.ContainsAny(name, "/\\") {
		return ""
	}
	return name
}

// readOverview loads and parses resource/overviews/<map>.txt. A read
// error comes back as err (the caller decides whether that is fatal); a
// MISSING or UNPARSABLE overview is (nil, nil) — both degrade to "no
// overview" (the transform is optional in the pack contract).
func readOverview(v *vpk, mapName string) (*Overview, error) {
	data, found, err := v.read(overviewPfx + mapName + ".txt")
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, nil
	}
	ov, err := parseOverview(data)
	if err != nil {
		return nil, nil // malformed → degrade, never fatal
	}
	return ov, nil
}

// sectionRadar reports whether base ("<map>_<section>") names a section
// radar of an existing overview: some prefix of base must be a map whose
// verticalsections declares the remaining suffix. Longest prefix first
// ("de_ancient_night" checks de_ancient/night before de/ancient_night),
// so a real map name wins over an accidental split. Data-driven — no
// section name is ever hardcoded (CS2.md "verticalsections": the overview
// is the authority for which suffixes are floors).
func sectionRadar(v *vpk, base string) (mapName, section string, ok bool) {
	for i := strings.LastIndex(base, "_"); i > 0; i = strings.LastIndex(base[:i], "_") {
		m, sec := base[:i], base[i+1:]
		ov, err := readOverview(v, m)
		if err != nil || ov == nil {
			continue
		}
		for _, s := range ov.Sections {
			if s.Name == sec {
				return m, sec, true
			}
		}
	}
	return "", "", false
}

// extractOne decodes one map's radar + overview into outDir/<map>/.
// When the overview declares verticalsections, each section's radar
// texture is decoded as an extra layer image (radar.png for the default
// section, radar_<section>.png for the rest) and recorded in meta.Layers.
func extractOne(v *vpk, mapName, radarPath, outDir string) error {
	raw, found, err := v.read(radarPath)
	if err != nil {
		return err
	}
	if !found {
		return fmt.Errorf("radar vanished from tree")
	}
	img, err := decodeVTex(raw)
	if err != nil {
		return err
	}

	meta := packMeta{
		SchemaVersion: 1,
		Radar: &packRadar{
			File:   packRadarPNG,
			Width:  img.Bounds().Dx(),
			Height: img.Bounds().Dy(),
		},
		Source: packSource{
			Note: "extracted from local CS2 install (pak01_dir.vpk)",
		},
	}

	// Overview txt supplies the transform + icon anchors + the
	// verticalsections layers; optional (some community/workshop maps
	// lack one) — without it the pack still ships radar pixels, and the
	// frontend falls back to a world grid.
	ov, err := readOverview(v, mapName)
	if err != nil {
		return fmt.Errorf("overview: %w", err)
	}
	var layerImgs []layerImage
	if ov != nil {
		meta.Transform = &packXform{PosX: ov.PosX, PosY: ov.PosY, Scale: ov.Scale}
		if ov.HasSites {
			meta.Sites.A = &fracPoint{X: ov.BombA[0], Y: ov.BombA[1]}
			meta.Sites.B = &fracPoint{X: ov.BombB[0], Y: ov.BombB[1]}
		}
		if ov.HasSpawns {
			meta.Spawns.CT = &fracPoint{X: ov.CTSpawn[0], Y: ov.CTSpawn[1]}
			meta.Spawns.T = &fracPoint{X: ov.TSpawn[0], Y: ov.TSpawn[1]}
		}
		if len(ov.Sections) > 0 {
			meta.Layers, layerImgs = extractLayers(v, mapName, ov, img)
		}
	}

	dir := filepath.Join(outDir, mapName)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if err := writePNGAtomic(filepath.Join(dir, packRadarPNG), img); err != nil {
		return err
	}
	for _, li := range layerImgs {
		if err := writePNGAtomic(filepath.Join(dir, li.file), li.img); err != nil {
			return err
		}
	}
	// The user's hand-authored elevation_regions live only in meta.json —
	// re-extraction must not wipe them (stale per-floor elevation keys
	// from the old contract are dropped by the unmarshal/rewrite).
	preserveElevation(dir, &meta)
	metaJSON, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, packMetaJSON), append(metaJSON, '\n'), 0o644)
}

// layerImage is one decoded non-default layer radar awaiting its write.
type layerImage struct {
	file string
	img  *image.NRGBA
}

// packLayerFile is the on-disk image name for a section: the default
// section IS the pack's radar.png, every other section gets
// radar_<section>.png. ok=false for a section name that cannot be a
// valid pack file (the /api/mappack whitelist is [a-z0-9_] only — a name
// outside it would produce an unservable file, so the section is skipped
// rather than written into a dead path).
func packLayerFile(section string) (file string, ok bool) {
	if section == "default" {
		return packRadarPNG, true
	}
	if section == "" || len(section) > 32 {
		return "", false
	}
	for _, c := range section {
		if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '_' {
			return "", false
		}
	}
	return "radar_" + section + ".png", true
}

// extractLayers turns the overview's verticalsections into meta.Layers
// (default first — parseOverview's sortSections order) plus the decoded
// images of every non-default section. A section whose radar texture is
// absent from the VPK — or fails to decode — is skipped, not fatal: the
// pack still extracts with the remaining layers.
func extractLayers(v *vpk, mapName string, ov *Overview, defaultImg *image.NRGBA) ([]packLayer, []layerImage) {
	var layers []packLayer
	var imgs []layerImage
	for _, sec := range ov.Sections {
		file, ok := packLayerFile(sec.Name)
		if !ok {
			continue
		}
		layerImg := defaultImg
		if file != packRadarPNG {
			raw, found, rerr := v.read(radarPrefix + mapName + "_" + sec.Name + radarSuffix)
			if rerr != nil || !found {
				continue // texture absent → skip this layer, keep the pack
			}
			decoded, derr := decodeVTex(raw)
			if derr != nil {
				continue // undecodable texture treated as absent
			}
			layerImg = decoded
			imgs = append(imgs, layerImage{file: file, img: decoded})
		}
		layers = append(layers, packLayer{
			ID:     sec.Name,
			Name:   sectionLabel(sec, ov.Sections),
			File:   file,
			Width:  layerImg.Bounds().Dx(),
			Height: layerImg.Bounds().Dy(),
			ZMin:   sec.ZMin,
			ZMax:   sec.ZMax,
		})
	}
	return layers, imgs
}

// sectionLabel is a layer's display name. Only ever VISIBLE on packs
// with more than one layer (the renderer labels multi-panel layouts
// only), and there the bands say which is which: highest ZMin → "Upper",
// lowest → "Lower" (the default section is the upper radar in every
// verified multi-section map — CS2.md "verticalsections"), anything else
// title-cases the section name. Never hardcoded per map.
func sectionLabel(s Section, all []Section) string {
	if len(all) < 2 {
		return s.Name // single section — no label is ever drawn
	}
	hi, lo := all[0], all[0]
	for _, o := range all {
		if o.ZMin > hi.ZMin {
			hi = o
		}
		if o.ZMin < lo.ZMin {
			lo = o
		}
	}
	switch {
	case s.Name == hi.Name && hi.ZMin != lo.ZMin:
		return "Upper"
	case s.Name == lo.Name && hi.ZMin != lo.ZMin:
		return "Lower"
	}
	r := []rune(s.Name)
	if len(r) > 0 && r[0] >= 'a' && r[0] <= 'z' {
		r[0] = r[0] - 'a' + 'A'
	}
	return string(r)
}

// preserveElevation carries the user-SUPPLIED elevation_regions (the
// in-game measurements: ambiguous-XY boxes with their thresholds) from
// the pack's existing meta.json into the fresh one. Re-extraction
// rewrites the radar pixels and Z bands but must never wipe numbers the
// user typed in — meta.json is their only home
// (frontend/public/maps/README.md). Per-floor `elevation` keys are NOT
// carried (dropped from the contract — the unmarshal/rewrite removes any
// stale ones). Absent or unparseable old meta → nothing to carry (first
// extract).
func preserveElevation(dir string, meta *packMeta) {
	oldRaw, err := os.ReadFile(filepath.Join(dir, packMetaJSON))
	if err != nil {
		return
	}
	var old packMeta
	if err := json.Unmarshal(oldRaw, &old); err != nil {
		return
	}
	if len(old.ElevationRegions) > 0 {
		meta.ElevationRegions = old.ElevationRegions
	}
}

// lanczos3 is the Lanczos-3 kernel (a = 3): L(t) = sinc(t)·sinc(t/3),
// 1 at t = 0, zero crossings at every nonzero integer t (the a=3 lobe
// of sinc(t/3) crosses at t = 3, which is the support edge). Drawn
// from the closed form rather than a table so the weights are exact;
// golang.org/x/image/draw v0.45.0 ships no ready-made Lanczos scaler
// and no NewKernel helper — a *draw.Kernel with exported Support/At
// fields is the package's extension point. Negative t is handled
// (mathematically the kernel is even) even though the scaler only
// calls At with t ∈ [0, Support).
var lanczos3 = &draw.Kernel{
	Support: 3,
	At: func(t float64) float64 {
		if t < 0 {
			t = -t
		}
		if t == 0 {
			return 1
		}
		if t >= 3 {
			return 0
		}
		return sinc(t) * sinc(t/3)
	},
}

// sinc is the normalized cardinal sine sin(πx)/(πx), with the
// removable singularity at 0 filled in (sinc(0) = 1).
func sinc(x float64) float64 {
	if x == 0 {
		return 1
	}
	px := math.Pi * x
	return math.Sin(px) / px
}

// upscaleRadar resamples a decoded radar/layer image to radarUpscale ×
// its logical size with Lanczos-3 (lanczos3 above), then applies a
// modest unsharp mask (unsharpMask) — deterministic, offline, no model
// to ship, so extraction stays portable. See radarUpscale for why the
// extra pixels exist and why meta.json must NOT see them.
func upscaleRadar(img *image.NRGBA) *image.NRGBA {
	src := img.Bounds()
	dst := image.NewNRGBA(image.Rect(0, 0, src.Dx()*radarUpscale, src.Dy()*radarUpscale))
	lanczos3.Scale(dst, dst.Bounds(), img, src, draw.Src, nil)
	unsharpMask(dst, unsharpRadius, unsharpAmount)
	return dst
}

// unsharpMask sharpens img IN PLACE: out = clamp(p + amount·(p − blur))
// per RGB channel, alpha untouched, where blur is a separable box blur
// of the given radius (2·radius+1 taps per axis, edge samples clamped
// — no wraparound). Pure integer/float Go, deterministic, no
// dependencies; the radius is in pixels of the ALREADY-UPSCALED image
// (see radarUpscale), so 1 stays a 3×3 neighbourhood at any factor.
// Returns img for call-chaining.
func unsharpMask(img *image.NRGBA, radius int, amount float64) *image.NRGBA {
	if radius < 1 || amount == 0 {
		return img
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	tmp := make([]uint8, w*h*3)  // horizontal pass (RGB only)
	blur := make([]uint8, w*h*3) // vertical pass result
	n := 2*radius + 1

	// Horizontal pass: for each row, average n clamped samples per channel.
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var sum [3]int
			for k := -radius; k <= radius; k++ {
				sx := x + k
				if sx < 0 {
					sx = 0
				} else if sx >= w {
					sx = w - 1
				}
				o := img.PixOffset(b.Min.X+sx, b.Min.Y+y)
				sum[0] += int(img.Pix[o])
				sum[1] += int(img.Pix[o+1])
				sum[2] += int(img.Pix[o+2])
			}
			o := (y*w + x) * 3
			tmp[o] = uint8(sum[0] / n)
			tmp[o+1] = uint8(sum[1] / n)
			tmp[o+2] = uint8(sum[2] / n)
		}
	}

	// Vertical pass: average the horizontal result down each column.
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var sum [3]int
			for k := -radius; k <= radius; k++ {
				sy := y + k
				if sy < 0 {
					sy = 0
				} else if sy >= h {
					sy = h - 1
				}
				o := (sy*w + x) * 3
				sum[0] += int(tmp[o])
				sum[1] += int(tmp[o+1])
				sum[2] += int(tmp[o+2])
			}
			o := (y*w + x) * 3
			blur[o] = uint8(sum[0] / n)
			blur[o+1] = uint8(sum[1] / n)
			blur[o+2] = uint8(sum[2] / n)
		}
	}

	// Combine: p + amount·(p − blur), clamped to [0,255]; alpha copied
	// through untouched (radar PNGs are fully opaque, but a transparent
	// pixel must never gain/lose coverage from sharpening).
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			po := img.PixOffset(b.Min.X+x, b.Min.Y+y)
			bo := (y*w + x) * 3
			for c := 0; c < 3; c++ {
				p := float64(img.Pix[po+c])
				v := p + amount*(p-float64(blur[bo+c]))
				switch {
				case v < 0:
					img.Pix[po+c] = 0
				case v > 255:
					img.Pix[po+c] = 255
				default:
					img.Pix[po+c] = uint8(v + 0.5)
				}
			}
			// img.Pix[po+3] (alpha) deliberately untouched.
		}
	}
	return img
}

// writePNGAtomic writes a radar/layer image at radarUpscale × its
// logical (decoded) size, via temp file + rename so a crash mid-write
// can't leave a truncated PNG that the frontend would happily decode.
// Its only callers are pack radar pixels (radar.png + section layers),
// so the upscale lives HERE — one choke point no radar file can escape
// — while meta.json capture in extractOne/extractLayers keeps reading
// the decoded bounds before the write and therefore stays logical.
func writePNGAtomic(path string, img *image.NRGBA) error {
	tmp := path + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if err := png.Encode(f, upscaleRadar(img)); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}
