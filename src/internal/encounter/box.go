package encounter

import "math"

// Box parameterizes the enemy sample box. The production rule is ProductionBox.
// Heights are absolute, above the enemy's origin (feet). Lat and Fwd shift the
// centre along the enemy's right and forward directions (from their yaw).
type Box struct {
	HalfWidth float64
	TopStand  float64 // top sample height when standing
	TopCrouch float64 // top sample height when crouching
	Frac      float64 // mid-height samples at Frac * top
	Lat, Fwd  float64
	Grid      bool // dense 5x5 grid at four heights, not the 8 corners
}

// ProductionBox is the rule in production: 16 half-width, top at eye + 8 (72
// standing, 54 crouching), mid at half the top, no shift, corners.
var ProductionBox = Box{HalfWidth: 16, TopStand: 72, TopCrouch: 54, Frac: 0.5}

// TargetsBox returns the enemy's sample points for a box.
func TargetsBox(p Pos, b Box) [][3]float64 {
	top := b.TopStand
	if p.Duck {
		top = b.TopCrouch
	}
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
	for _, hz := range []float64{top * b.Frac, top} {
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
