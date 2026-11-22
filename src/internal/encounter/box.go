package encounter

import "math"

// Box parameterizes the enemy sample box. The production rule is DefaultBox.
// HalfWidth is the half-width of the box (units). TopAdd is the top of the box
// above the eye (units). Lat and Fwd shift the box centre, in units, along the
// enemy's right and forward directions (from their yaw), so a lean is expressed
// relative to where they face.
type Box struct {
	HalfWidth float64
	TopAdd    float64
	Lat, Fwd  float64
	Grid      bool // sample a dense 5x5 grid across the box at 4 heights, not the 8 corners
}

// DefaultBox is the production sample: 16 half-width, top at eye + 8, no shift.
var DefaultBox = Box{HalfWidth: 16, TopAdd: 8}

// TargetsBox returns the enemy's sample points for a box: four corners at mid
// height and four at the top, 8 points, shifted by Lat and Fwd.
func TargetsBox(p Pos, b Box) [][3]float64 {
	top := eyeZ(p) + b.TopAdd
	yaw := p.Yaw * math.Pi / 180
	fx, fy := math.Cos(yaw), math.Sin(yaw)
	rx, ry := math.Sin(yaw), -math.Cos(yaw) // right of facing
	cx := p.X + b.Fwd*fx + b.Lat*rx
	cy := p.Y + b.Fwd*fy + b.Lat*ry
	if b.Grid {
		out := make([][3]float64, 0, 100)
		for _, fz := range []float64{0.25, 0.5, 0.75, 1} {
			for _, fx := range []float64{-1, -0.5, 0, 0.5, 1} {
				for _, fy := range []float64{-1, -0.5, 0, 0.5, 1} {
					out = append(out, [3]float64{cx + fx*b.HalfWidth, cy + fy*b.HalfWidth, p.Z + top*fz})
				}
			}
		}
		return out
	}
	out := make([][3]float64, 0, 8)
	for _, hz := range []float64{top * 0.5, top} {
		for _, dx := range []float64{-b.HalfWidth, b.HalfWidth} {
			for _, dy := range []float64{-b.HalfWidth, b.HalfWidth} {
				out = append(out, [3]float64{cx + dx, cy + dy, p.Z + hz})
			}
		}
	}
	return out
}

// AnyClearBox reports whether the eye reaches any of the box's sample points.
func AnyClearBox(from [3]float64, p Pos, b Box, occ Occluder) bool {
	for _, t := range TargetsBox(p, b) {
		if !occ(from, t) {
			return true
		}
	}
	return false
}
