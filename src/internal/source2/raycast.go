package source2

// Portions of this package follow ValveResourceFormat (MIT License, Copyright
// (c) 2015 ValveResourceFormat Contributors). The license text is in
// LICENSE-VRF.txt in this directory.

import "math"

// Segment is a line from A to B for visibility queries.
type Segment struct{ A, B Vec3 }

// Blocked reports whether any triangle of the mesh is hit by the segment,
// excluding the endpoints (t in (eps, 1-eps)). It walks the kd-tree.
func (m *Mesh) Blocked(seg Segment) bool {
	if len(m.Nodes) == 0 {
		return m.bruteBlocked(seg)
	}
	var stack [128]uint32
	sp := 0
	stack[sp] = 0
	sp++
	for sp > 0 {
		sp--
		idx := stack[sp]
		n := &m.Nodes[idx]
		if !segHitsBox(seg, n.Min, n.Max) {
			continue
		}
		if n.Type == 3 {
			for k := uint32(0); k < n.ChildOffset; k++ {
				t := m.Triangles[n.TriangleOffset+k]
				if segHitsTri(seg, m.Vertices[t[0]], m.Vertices[t[1]], m.Vertices[t[2]]) {
					return true
				}
			}
			continue
		}
		// Push the second child, then the first, so the first is popped next.
		stack[sp] = idx + n.ChildOffset
		sp++
		stack[sp] = idx + 1
		sp++
	}
	return false
}

// bruteBlocked tests every triangle; used to validate the tree.
func (m *Mesh) bruteBlocked(seg Segment) bool {
	for _, t := range m.Triangles {
		if segHitsTri(seg, m.Vertices[t[0]], m.Vertices[t[1]], m.Vertices[t[2]]) {
			return true
		}
	}
	return false
}

// BruteBlocked is the reference query over all triangles.
func (m *Mesh) BruteBlocked(seg Segment) bool { return m.bruteBlocked(seg) }

const segEps = 1e-6

func segHitsBox(seg Segment, mn, mx Vec3) bool {
	tmin, tmax := 0.0, 1.0
	for k := 0; k < 3; k++ {
		o := float64(seg.A[k])
		d := float64(seg.B[k]) - o
		lo, hi := float64(mn[k]), float64(mx[k])
		if math.Abs(d) < 1e-12 {
			if o < lo || o > hi {
				return false
			}
			continue
		}
		t1 := (lo - o) / d
		t2 := (hi - o) / d
		if t1 > t2 {
			t1, t2 = t2, t1
		}
		if t1 > tmin {
			tmin = t1
		}
		if t2 < tmax {
			tmax = t2
		}
		if tmin > tmax {
			return false
		}
	}
	return true
}

// segHitsTri is Möller–Trumbore on the segment, with hits only in the open
// interval (eps, 1-eps) so the endpoints do not count.
func segHitsTri(seg Segment, v0, v1, v2 Vec3) bool {
	ax, ay, az := float64(seg.A[0]), float64(seg.A[1]), float64(seg.A[2])
	dx := float64(seg.B[0]) - ax
	dy := float64(seg.B[1]) - ay
	dz := float64(seg.B[2]) - az
	e1x, e1y, e1z := float64(v1[0]-v0[0]), float64(v1[1]-v0[1]), float64(v1[2]-v0[2])
	e2x, e2y, e2z := float64(v2[0]-v0[0]), float64(v2[1]-v0[1]), float64(v2[2]-v0[2])
	px := dy*e2z - dz*e2y
	py := dz*e2x - dx*e2z
	pz := dx*e2y - dy*e2x
	det := e1x*px + e1y*py + e1z*pz
	if math.Abs(det) < 1e-12 {
		return false
	}
	inv := 1 / det
	tx, ty, tz := ax-float64(v0[0]), ay-float64(v0[1]), az-float64(v0[2])
	u := (tx*px + ty*py + tz*pz) * inv
	if u < 0 || u > 1 {
		return false
	}
	qx := ty*e1z - tz*e1y
	qy := tz*e1x - tx*e1z
	qz := tx*e1y - ty*e1x
	v := (dx*qx + dy*qy + dz*qz) * inv
	if v < 0 || u+v > 1 {
		return false
	}
	t := (e2x*qx + e2y*qy + e2z*qz) * inv
	return t > segEps && t < 1-segEps
}
