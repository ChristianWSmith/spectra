package source2

import "sort"

// BVH is a bounding-volume hierarchy over one mesh's triangles, built by
// median splits on the longest axis of the triangle centroids. It answers the
// same question as Mesh.Blocked, with a ray visiting only the boxes it crosses.
type BVH struct {
	mesh  *Mesh
	nodes []bvhNode
	order []int32 // triangle indices, grouped by leaf
}

type bvhNode struct {
	lo, hi Vec3
	first  int32 // leaf: first index into order
	count  int32 // leaf: number of triangles (0 for an inner node)
	right  int32 // inner: index of the right child (the left child is the next node)
}

const bvhLeafSize = 8

// BuildBVH builds the hierarchy for m. m must not change afterwards.
func BuildBVH(m *Mesh) *BVH {
	b := &BVH{mesh: m, order: make([]int32, len(m.Triangles))}
	for i := range b.order {
		b.order[i] = int32(i)
	}
	cent := make([]Vec3, len(m.Triangles))
	for i, t := range m.Triangles {
		for k := 0; k < 3; k++ {
			cent[i][k] = (m.Vertices[t[0]][k] + m.Vertices[t[1]][k] + m.Vertices[t[2]][k]) / 3
		}
	}
	if len(m.Triangles) > 0 {
		b.build(0, len(b.order), cent)
	}
	return b
}

func (b *BVH) build(start, end int, cent []Vec3) int32 {
	idx := int32(len(b.nodes))
	b.nodes = append(b.nodes, bvhNode{})
	var lo, hi Vec3
	var clo, chi Vec3
	seen := 0 // vertices and centroids folded into the bounds so far
	for _, ti := range b.order[start:end] {
		t := b.mesh.Triangles[ti]
		for _, vi := range t {
			v := b.mesh.Vertices[vi]
			for k := 0; k < 3; k++ {
				if seen == 0 || v[k] < lo[k] {
					lo[k] = v[k]
				}
				if seen == 0 || v[k] > hi[k] {
					hi[k] = v[k]
				}
			}
			seen++
		}
	}
	seen = 0
	for _, ti := range b.order[start:end] {
		c := cent[ti]
		for k := 0; k < 3; k++ {
			if seen == 0 || c[k] < clo[k] {
				clo[k] = c[k]
			}
			if seen == 0 || c[k] > chi[k] {
				chi[k] = c[k]
			}
		}
		seen++
	}
	n := end - start
	if n <= bvhLeafSize {
		b.nodes[idx] = bvhNode{lo: lo, hi: hi, first: int32(start), count: int32(n)}
		return idx
	}
	axis := 0
	for k := 1; k < 3; k++ {
		if chi[k]-clo[k] > chi[axis]-clo[axis] {
			axis = k
		}
	}
	part := b.order[start:end]
	sort.Slice(part, func(i, j int) bool { return cent[part[i]][axis] < cent[part[j]][axis] })
	mid := start + n/2
	b.build(start, mid, cent)
	right := b.build(mid, end, cent)
	b.nodes[idx] = bvhNode{lo: lo, hi: hi, right: right}
	return idx
}

// Blocked reports whether any triangle of the mesh is hit by the segment.
func (b *BVH) Blocked(seg Segment) bool {
	_, ok := b.BlockedBy(seg)
	return ok
}

// BlockedBy returns the index (into Triangles) of a triangle the segment hits, if
// any. Which hit is returned when there are several is unspecified.
func (b *BVH) BlockedBy(seg Segment) (int, bool) {
	if len(b.nodes) == 0 {
		return -1, false
	}
	var stack [128]int32
	sp := 0
	stack[sp] = 0
	sp++
	for sp > 0 {
		sp--
		i := stack[sp]
		n := &b.nodes[i]
		if !segHitsBox(seg, n.lo, n.hi) {
			continue
		}
		if n.count > 0 {
			for _, ti := range b.order[n.first : n.first+n.count] {
				t := b.mesh.Triangles[ti]
				if segHitsTri(seg, b.mesh.Vertices[t[0]], b.mesh.Vertices[t[1]], b.mesh.Vertices[t[2]]) {
					return int(ti), true
				}
			}
			continue
		}
		// Left child is the next node (built first); right child is stored.
		stack[sp] = n.right
		sp++
		stack[sp] = i + 1
		sp++
	}
	return -1, false
}
