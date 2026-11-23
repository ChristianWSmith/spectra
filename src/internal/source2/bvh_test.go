package source2

import (
	"math/rand"
	"testing"
)

// TestBVHMatchesBrute checks the hierarchy against a scan of every triangle, on
// random triangles and random segments.
func TestBVHMatchesBrute(t *testing.T) {
	rng := rand.New(rand.NewSource(3))
	r := func() float32 { return float32(rng.Float64()*2000 - 1000) }
	m := &Mesh{}
	for i := 0; i < 600; i++ {
		base := int32(len(m.Vertices))
		cx, cy, cz := r(), r(), r()*0.2
		for k := 0; k < 3; k++ {
			m.Vertices = append(m.Vertices, Vec3{cx + float32(rng.Float64()*120-60), cy + float32(rng.Float64()*120-60), cz + float32(rng.Float64()*120-60)})
		}
		m.Triangles = append(m.Triangles, Triangle{base, base + 1, base + 2})
	}
	b := BuildBVH(m)
	mismatch, hits := 0, 0
	for i := 0; i < 4000; i++ {
		seg := Segment{A: Vec3{r(), r(), r() * 0.2}, B: Vec3{r(), r(), r() * 0.2}}
		_, brute := m.FirstHit(seg)
		tree := b.Blocked(seg)
		if brute {
			hits++
		}
		if brute != tree {
			mismatch++
		}
	}
	if mismatch != 0 {
		t.Fatalf("BVH disagrees with brute force on %d of 4000 segments", mismatch)
	}
	if hits < 100 {
		t.Fatalf("test too weak: only %d segments hit", hits)
	}
}
