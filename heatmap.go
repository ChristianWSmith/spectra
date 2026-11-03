package main

// Heatmap rastering: both heatmap kinds (presence and the kill/death/damage
// events) plot world points into the SAME fixed grid, so the shared
// arithmetic lives here — sampled extents → ±heatmapPad bounds → per-axis
// cell sizes → cell index → max cell. The presence kind weighs each kept
// point by the frame dwell (dt), the event kinds by 1; everything else is
// identical.

// heatmapGridSide is the raster resolution per axis (plan: 64×64).
const heatmapGridSide = 64

// heatmapPad is the world-unit padding added around the sampled extents.
const heatmapPad = 2.0

// heatmapRaster is one bounds→cells mapping: the padded bounds, the cell
// sizes (floored at one world unit so a tiny extent still fills the grid)
// and the row-major heatmapGridSide² accumulation buffer.
type heatmapRaster struct {
	minX, minY float64
	maxX, maxY float64
	cellW      float64
	cellH      float64
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
	return heatmapRaster{
		minX: minX, minY: minY, maxX: maxX, maxY: maxY,
		cellW: cellW, cellH: cellH,
		cells: make([]float64, heatmapGridSide*heatmapGridSide),
	}
}

// add accumulates weight at the world point (x, y) and reports whether the
// point landed inside the grid (points outside the padded bounds are
// dropped, mirroring the previous behavior of both kinds).
func (g *heatmapRaster) add(x, y, weight float64) bool {
	cx := int((x - g.minX) / g.cellW)
	cy := int((y - g.minY) / g.cellH)
	if cx < 0 || cx >= heatmapGridSide || cy < 0 || cy >= heatmapGridSide {
		return false
	}
	g.cells[cy*heatmapGridSide+cx] += weight
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
