package main

import "math"

// Heatmap rastering: every heatmap kind (presence, the kill/death/damage
// events, and the signed kd combine) plots world points into the SAME
// fixed grid, so the shared arithmetic lives here — sampled extents →
// ±heatmapPad bounds → per-axis cell sizes → Gaussian kernel splat →
// cell index → max cell. Each sample is splatted as a soft, overlapping
// blob (sigma heatmapSigmaWorld world units) instead of a single-cell
// delta, so nearby heat radiates together rather than reading as
// isolated dots. The presence kind weighs each kept point by the frame
// dwell (dt), the event kinds by 1; the kd kind differences the kills
// and deaths rasters (GetHeatmapKD below). Everything else is identical.

// heatmapGridSide is the raster resolution per axis (plan: 64×64).
const heatmapGridSide = 64

// heatmapSigmaWorld is the kernel standard deviation in world units — the
// "radiation" distance. 150u reads as a soft blob on the radar (a player
// is ~48u wide; the 3σ reach of 450u is about half a bomb site), so a
// handful of nearby events merge into one glow while lone samples stay
// faint.
const heatmapSigmaWorld = 150.0

// heatmapKernelSigmas is the kernel radius in standard deviations.
const heatmapKernelSigmas = 3.0

// heatmapKernelReach is the full kernel reach (3σ). It doubles as the
// padding around the sampled extents, so a point at the very edge of the
// extent still paints a whole blob instead of a clipped half — every
// in-extent kernel fits entirely inside the padded grid.
const heatmapKernelReach = heatmapKernelSigmas * heatmapSigmaWorld // 450

// heatmapPad is the world-unit padding added around the sampled extents
// (= the kernel reach, so blobs never clip at the raster border).
const heatmapPad = heatmapKernelReach

// heatmapMaxSigmaCells caps the kernel sigma in cell space: on a tiny
// extent (a tightly filtered slice of the map) 150 world units would
// span most of the grid, so the cap bounds the per-sample tap count
// (cost) while the pad keeps the blob whole.
const heatmapMaxSigmaCells = 6.0

// heatmapRaster is one bounds→cells mapping: the padded bounds, the cell
// sizes (floored at one world unit so a tiny extent still fills the
// grid), the precomputed Gaussian kernel taps for this cell size, and
// the row-major heatmapGridSide² accumulation buffer.
type heatmapRaster struct {
	minX, minY float64
	maxX, maxY float64
	cellW      float64
	cellH      float64
	kOffX      []int // kernel tap offsets from the center cell
	kOffY      []int
	kW         []float64 // tap weights — center tap = 1 (peak-normalized)
	cells      []float64
}

// newHeatmapRaster derives the raster from the already-filtered sampled
// extents of the points that will be plotted (the caller owns the
// filtering; an empty extent set is an early return, not a raster).
func newHeatmapRaster(minX, minY, maxX, maxY float64) heatmapRaster {
	minX, minY, maxX, maxY = minX-heatmapPad, minY-heatmapPad, maxX+heatmapPad, maxY+heatmapPad
	cellW := (maxX - minX) / heatmapGridSide
	cellH := (maxY - minY) / heatmapGridSide
	if cellW <= 0 {
		cellW = 1
	}
	if cellH <= 0 {
		cellH = 1
	}
	g := heatmapRaster{
		minX: minX, minY: minY, maxX: maxX, maxY: maxY,
		cellW: cellW, cellH: cellH,
		cells: make([]float64, heatmapGridSide*heatmapGridSide),
	}
	g.buildKernel()
	return g
}

// buildKernel precomputes the Gaussian tap offsets/weights for the
// raster's cell size. Weights are peak-normalized (the center tap is
// exp(0) = 1): an isolated sample still reads as ~1 in its cell — the
// legend's count/dwell-seconds scale is unchanged — while the mass
// spreads across the blob instead of piling into one cell. The sigma is
// the world-unit target scaled into cell space and capped at
// heatmapMaxSigmaCells so the tap count stays bounded.
func (g *heatmapRaster) buildKernel() {
	sx := heatmapSigmaWorld / g.cellW
	if sx > heatmapMaxSigmaCells {
		sx = heatmapMaxSigmaCells
	}
	sy := heatmapSigmaWorld / g.cellH
	if sy > heatmapMaxSigmaCells {
		sy = heatmapMaxSigmaCells
	}
	rx := int(math.Ceil(heatmapKernelSigmas * sx))
	ry := int(math.Ceil(heatmapKernelSigmas * sy))
	n := (2*rx + 1) * (2*ry + 1)
	g.kOffX = make([]int, 0, n)
	g.kOffY = make([]int, 0, n)
	g.kW = make([]float64, 0, n)
	for dy := -ry; dy <= ry; dy++ {
		for dx := -rx; dx <= rx; dx++ {
			g.kOffX = append(g.kOffX, dx)
			g.kOffY = append(g.kOffY, dy)
			g.kW = append(g.kW, math.Exp(-0.5*(float64(dx*dx)/(sx*sx)+float64(dy*dy)/(sy*sy))))
		}
	}
}

// add splats the weight of the world point (x, y) across the Gaussian
// kernel centered on the point's cell and reports whether the point
// landed inside the grid (points outside the padded bounds are dropped,
// mirroring the previous behavior of both kinds; the pad ≥ kernel reach
// keeps every in-extent blob whole).
func (g *heatmapRaster) add(x, y, weight float64) bool {
	cx := int((x - g.minX) / g.cellW)
	cy := int((y - g.minY) / g.cellH)
	if cx < 0 || cx >= heatmapGridSide || cy < 0 || cy >= heatmapGridSide {
		return false
	}
	for i, w := range g.kW {
		tx := cx + g.kOffX[i]
		ty := cy + g.kOffY[i]
		if tx < 0 || tx >= heatmapGridSide || ty < 0 || ty >= heatmapGridSide {
			continue
		}
		g.cells[ty*heatmapGridSide+tx] += weight * w
	}
	return true
}

// grid renders the raster as the wire HeatmapGrid (kind and Samples are the
// caller's: presence counts the points it actually accumulated, events
// report the pre-raster sample count).
func (g *heatmapRaster) grid(kind string, samples int) HeatmapGrid {
	return HeatmapGrid{
		Kind: kind, W: heatmapGridSide, H: heatmapGridSide,
		MinX: g.minX, MinY: g.minY, MaxX: g.maxX, MaxY: g.maxY,
		Max: maxCell(g.cells), Samples: samples, Cells: g.cells,
	}
}

// maxCell returns the largest value in a raster.
func maxCell(cells []float64) float64 {
	m := 0.0
	for _, v := range cells {
		if v > m {
			m = v
		}
	}
	return m
}

// maxAbsCell returns the largest magnitude in a (signed) raster — the kd
// grid's normalization radius: cells are signed, so the renderer
// normalizes by |v|max (see signedIntensity in lib/heatramp.js).
func maxAbsCell(cells []float64) float64 {
	m := 0.0
	for _, v := range cells {
		if a := math.Abs(v); a > m {
			m = a
		}
	}
	return m
}

// GetHeatmapKD is the signed "kd" heatmap: +1 at each kill position and
// −1 at each death position (a signed density field; cells read as net
// kills / net deaths at the kernel's peak-normalized scale). It reuses
// heatmapEvents (analyticservice.go) for BOTH populations — the same
// round/player/team filtering and attacker/victim position sourcing as
// the kills and deaths kinds — so the filter semantics cannot drift from
// those kinds; it lives beside the raster math here as a sibling of
// GetHeatmap rather than a case in its kind switch.
//
// The two populations rasterize over their own sampled bounds, so the
// combine differences them on the union of those bounds (each output
// cell samples the kills field minus the deaths field at its center).
func (s *AnalyticsService) GetHeatmapKD(matchID int64, f HeatmapFilter) (HeatmapGrid, error) {
	// Team filters resolve sides from the extractor's exact per-round
	// freeze-end samples (same helper GetHeatmap uses; sides are never
	// guessed from final sides here).
	exact, err := s.st.GetRoundPlayerSides(matchID)
	if err != nil {
		return HeatmapGrid{}, err
	}
	sideAt := func(steamID string, round int) string { return exact[round][steamID] }
	kills, err := s.heatmapEvents(matchID, "kills", f, sideAt)
	if err != nil {
		return HeatmapGrid{}, err
	}
	deaths, err := s.heatmapEvents(matchID, "deaths", f, sideAt)
	if err != nil {
		return HeatmapGrid{}, err
	}
	return combineSignedHeatmaps(kills, deaths), nil
}

// combineSignedHeatmaps differences two same-resolution rasters over the
// union of their world bounds. Each output cell samples the kills field
// minus the deaths field at the cell center (nearest source cell — both
// fields already carry the same world-unit kernel, so they subtract
// directly). Output cells hold net kills (positive) / net deaths
// (negative); Samples is the signed point count and Max the largest
// magnitude (maxAbsCell).
func combineSignedHeatmaps(kills, deaths HeatmapGrid) HeatmapGrid {
	kOK, dOK := heatmapHasSignal(kills), heatmapHasSignal(deaths)
	if !kOK && !dOK {
		return HeatmapGrid{Kind: "kd", W: heatmapGridSide, H: heatmapGridSide,
			Cells: make([]float64, heatmapGridSide*heatmapGridSide)}
	}
	minX, minY := math.Inf(1), math.Inf(1)
	maxX, maxY := math.Inf(-1), math.Inf(-1)
	for _, side := range []struct {
		ok bool
		g  HeatmapGrid
	}{{kOK, kills}, {dOK, deaths}} {
		if !side.ok {
			continue
		}
		minX, minY = math.Min(minX, side.g.MinX), math.Min(minY, side.g.MinY)
		maxX, maxY = math.Max(maxX, side.g.MaxX), math.Max(maxY, side.g.MaxY)
	}
	cellW := (maxX - minX) / heatmapGridSide
	cellH := (maxY - minY) / heatmapGridSide
	cells := make([]float64, heatmapGridSide*heatmapGridSide)
	for r := 0; r < heatmapGridSide; r++ {
		y := minY + (float64(r)+0.5)*cellH
		for c := 0; c < heatmapGridSide; c++ {
			x := minX + (float64(c)+0.5)*cellW
			v := 0.0
			if kOK {
				v += sampleHeatmapCell(kills, x, y)
			}
			if dOK {
				v -= sampleHeatmapCell(deaths, x, y)
			}
			cells[r*heatmapGridSide+c] = v
		}
	}
	samples := 0
	if kOK {
		samples += kills.Samples
	}
	if dOK {
		samples += deaths.Samples
	}
	return HeatmapGrid{Kind: "kd", W: heatmapGridSide, H: heatmapGridSide,
		MinX: minX, MinY: minY, MaxX: maxX, MaxY: maxY,
		Max: maxAbsCell(cells), Samples: samples, Cells: cells}
}

// heatmapHasSignal reports whether a raster carries data (the empty
// early-return has zero bounds and Max; a real raster's peak-normalized
// kernel always leaves a positive Max).
func heatmapHasSignal(g HeatmapGrid) bool { return g.Max > 0 }

// sampleHeatmapCell reads the cell containing the world point (the grid
// contract: row 0 at MinY, cell size (Max−Min)/side); points outside the
// raster read 0 — the union bounds extend past each population's own
// bounds.
func sampleHeatmapCell(g HeatmapGrid, x, y float64) float64 {
	cw := (g.MaxX - g.MinX) / float64(g.W)
	ch := (g.MaxY - g.MinY) / float64(g.H)
	if !(cw > 0) || !(ch > 0) {
		return 0
	}
	cx := int((x - g.MinX) / cw)
	cy := int((y - g.MinY) / ch)
	if cx < 0 || cx >= g.W || cy < 0 || cy >= g.H {
		return 0
	}
	return g.Cells[cy*g.W+cx]
}
