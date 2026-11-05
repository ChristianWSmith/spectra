package main

import "math"

// Heatmap rastering: every heatmap kind (presence, the kill/death/damage
// events, and the signed kd combine) plots world points into the SAME
// fixed grid, so the shared arithmetic lives here — sampled extents →
// ±heatmapPad bounds → per-axis cell sizes → per-sample delta splat →
// separable Gaussian convolution → max cell. Each sample deposits its
// weight at its cell, then one horizontal and one vertical pass of the
// precomputed 1D taps spread it (the 2D kernel is separable, so this is
// identical to splatting the full 2D kernel per sample at a fraction of
// the cost — resolution stays affordable, which is what lets the grid
// track the renderer's display resolution). The presence kind weighs
// each kept point by the frame dwell (dt), the event kinds by 1; the kd
// kind differences the kills and deaths rasters (GetHeatmapKD below).
// Everything else is identical.

// heatmapGridSide is the raster resolution per axis (128×128): the
// renderer interpolates between cell centers, and 128 cells across the
// padded map span puts a 3σ blob (900u) on ~18 cells — enough that the
// interpolated field reads as a continuous glow instead of the blocky
// upscale a coarser grid forces. Cells also halve vs a 64-side grid, so
// the kd combine's resample steps and the wire payload stay small
// (~16k cells).
const heatmapGridSide = 128

// heatmapSigmaWorld is the kernel standard deviation in world units — the
// "radiation" distance. 150u reads as a soft blob on the radar (a player
// is ~48u wide; the 3σ reach of 450u is about half a bomb site), so a
// handful of nearby events merge into one glow while lone samples stay
// faint. The sigma is honored in world units at every extent — it is
// scaled into cell space uncapped (the convolution cost is per grid, not
// per sample, so a tiny extent needs no tap-count cap).
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

// heatmapRaster is one bounds→cells mapping: the padded bounds, the cell
// sizes (floored at one world unit so a tiny extent still fills the
// grid), the precomputed separable kernel taps for this cell size, the
// row-major heatmapGridSide² delta buffer (add) and the convolved result
// (grid).
type heatmapRaster struct {
	minX, minY float64
	maxX, maxY float64
	cellW      float64
	cellH      float64
	kX         []float64 // 1D x taps — center tap = 1 (peak-normalized)
	kY         []float64 // 1D y taps
	deltas     []float64
	cells      []float64
	rendered   bool
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
		deltas: make([]float64, heatmapGridSide*heatmapGridSide),
		cells:  make([]float64, heatmapGridSide*heatmapGridSide),
	}
	g.buildKernel()
	return g
}

// gaussianTap is one separable kernel weight: a Gaussian (σ in cell
// space) windowed by (1−u²)² with u = |offset| / (3σ) — the window is 1
// (and flat) at the center and exactly 0 at the 3σ reach, so a splat
// ends in transparency instead of the hard ring an abruptly truncated
// Gaussian would leave (the renderer's √ intensity curve amplifies a
// bare e^−4.5 ≈ 1%-of-peak cutoff to a clearly visible edge).
func gaussianTap(offset int, sigmaCells float64) float64 {
	u := math.Abs(float64(offset)) / (heatmapKernelSigmas * sigmaCells)
	if u >= 1 {
		return 0
	}
	w := math.Exp(-0.5 * float64(offset*offset) / (sigmaCells * sigmaCells))
	t := 1 - u*u
	return w * t * t
}

// buildKernel precomputes the separable Gaussian taps for the raster's
// per-axis cell sizes (the 2D kernel is kX·kY). Weights are
// peak-normalized (the center tap is gaussianTap(0) = 1): an isolated
// sample still reads as ~1 in its cell — the legend's count/dwell-seconds
// scale is unchanged — while the mass spreads across the blob instead of
// piling into one cell. The sigma is the world-unit target scaled into
// cell space (uncapped — see heatmapSigmaWorld); taps run to the 3σ
// reach, which equals heatmapPad in world units.
func (g *heatmapRaster) buildKernel() {
	build := func(sigmaCells float64) []float64 {
		r := int(math.Ceil(heatmapKernelSigmas * sigmaCells))
		k := make([]float64, 2*r+1)
		for d := -r; d <= r; d++ {
			k[d+r] = gaussianTap(d, sigmaCells)
		}
		return k
	}
	g.kX = build(heatmapSigmaWorld / g.cellW)
	g.kY = build(heatmapSigmaWorld / g.cellH)
}

// add deposits the weight of the world point (x, y) at its cell and
// reports whether the point landed inside the grid (points outside the
// padded bounds are dropped, mirroring the previous behavior of both
// kinds; the pad ≥ kernel reach keeps every in-extent blob whole). The
// blob itself is painted once, in convolve.
func (g *heatmapRaster) add(x, y, weight float64) bool {
	cx := int((x - g.minX) / g.cellW)
	cy := int((y - g.minY) / g.cellH)
	if cx < 0 || cx >= heatmapGridSide || cy < 0 || cy >= heatmapGridSide {
		return false
	}
	g.deltas[cy*heatmapGridSide+cx] += weight
	return true
}

// convolve spreads the accumulated deltas through the separable kernel —
// a horizontal pass with kX, then a vertical pass with kY (taps are
// clipped at the raster border, exactly as the per-sample splat did).
// It runs once, at grid time.
func (g *heatmapRaster) convolve() {
	side := heatmapGridSide
	rx := (len(g.kX) - 1) / 2
	ry := (len(g.kY) - 1) / 2
	tmp := make([]float64, side*side)
	for r := 0; r < side; r++ {
		row := r * side
		for c := 0; c < side; c++ {
			var sum float64
			for dx := -rx; dx <= rx; dx++ {
				if tx := c + dx; tx >= 0 && tx < side {
					sum += g.kX[dx+rx] * g.deltas[row+tx]
				}
			}
			tmp[row+c] = sum
		}
	}
	for r := 0; r < side; r++ {
		row := r * side
		for c := 0; c < side; c++ {
			var sum float64
			for dy := -ry; dy <= ry; dy++ {
				if ty := r + dy; ty >= 0 && ty < side {
					sum += g.kY[dy+ry] * tmp[ty*side+c]
				}
			}
			g.cells[row+c] = sum
		}
	}
	g.rendered = true
}

// grid renders the raster as the wire HeatmapGrid (kind and Samples are the
// caller's: presence counts the points it actually accumulated, events
// report the pre-raster sample count). It is the terminal operation: the
// first call convolves the deltas into cells.
func (g *heatmapRaster) grid(kind string, samples int) HeatmapGrid {
	if !g.rendered {
		g.convolve()
	}
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
// minus the deaths field at the cell center (bilinear — both fields
// already carry the same world-unit kernel, so they subtract directly).
// Output cells hold net kills (positive) / net deaths (negative); Samples
// is the signed point count and Max the largest magnitude (maxAbsCell).
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

// sampleHeatmapCell reads the field at the world point (x, y) by
// bilinear interpolation between the four surrounding cell centers —
// the smooth resample the signed combine needs: nearest-neighbour
// sampling left center-to-center steps in the union-bounds raster, and
// the renderer's interpolation could not smooth steps baked into the
// data. Cell centers sit at (i+0.5); points outside the raster (or a
// degenerate grid) read 0 — the union bounds extend past each
// population's own bounds — and cells beyond the border extend the edge
// value (constant extension, matching "the cell containing the point"
// within half a cell of the border).
func sampleHeatmapCell(g HeatmapGrid, x, y float64) float64 {
	if g.W <= 0 || g.H <= 0 || len(g.Cells) < g.W*g.H {
		return 0
	}
	cw := (g.MaxX - g.MinX) / float64(g.W)
	ch := (g.MaxY - g.MinY) / float64(g.H)
	if !(cw > 0) || !(ch > 0) {
		return 0
	}
	if x < g.MinX || x >= g.MaxX || y < g.MinY || y >= g.MaxY {
		return 0
	}
	u := (x-g.MinX)/cw - 0.5
	v := (y-g.MinY)/ch - 0.5
	i0, j0 := int(math.Floor(u)), int(math.Floor(v))
	fx, fy := u-float64(i0), v-float64(j0)
	read := func(i, j int) float64 {
		if i < 0 {
			i = 0
		} else if i >= g.W {
			i = g.W - 1
		}
		if j < 0 {
			j = 0
		} else if j >= g.H {
			j = g.H - 1
		}
		return g.Cells[j*g.W+i]
	}
	top := read(i0, j0) + (read(i0+1, j0)-read(i0, j0))*fx
	bot := read(i0, j0+1) + (read(i0+1, j0+1)-read(i0, j0+1))*fx
	return top + (bot-top)*fy
}
