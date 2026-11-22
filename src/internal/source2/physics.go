package source2

// Portions of this package follow ValveResourceFormat (MIT License, Copyright
// (c) 2015 ValveResourceFormat Contributors). The license text is in
// LICENSE-VRF.txt in this directory.

import (
	"encoding/binary"
	"fmt"
	"math"
)

// Vec3 is a float32 triple as stored in physics vertex blobs.
type Vec3 [3]float32

// Triangle is three vertex indices (RnTriangle_t: three int32).
type Triangle [3]int32

// Mesh is one physics triangle mesh of a PHYS block.
type Mesh struct {
	Min, Max  Vec3
	Vertices  []Vec3
	Triangles []Triangle
	Nodes     []Node
}

// Node is one kd-tree node of a mesh (RnNode_t, 32 bytes). Type 0..2 is a
// split on X/Y/Z whose second child is at index+ChildOffset (the first child is
// the next node, depth-first layout). Type 3 is a leaf: ChildOffset is the triangle count and
// TriangleOffset the index of its first triangle.
type Node struct {
	Min, Max       Vec3
	Type           uint8
	ChildOffset    uint32
	TriangleOffset uint32
}

// PhysicsMeshes returns the triangle meshes in the first part of a PHYS block's
// decoded KV3 root (the world collision of a *_physics.vmdl). Hulls are not
// returned: they are convex pieces, counted separately by the caller.
func PhysicsMeshes(kv *KV3) ([]Mesh, error) {
	root, ok := kv.Root.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("physics: root is not an object")
	}
	parts, _ := root["m_parts"].([]any)
	var out []Mesh
	for _, p := range parts {
		part, _ := p.(map[string]any)
		shape, _ := part["m_rnShape"].(map[string]any)
		meshes, _ := shape["m_meshes"].([]any)
		for _, m := range meshes {
			holder, _ := m.(map[string]any)
			mesh, _ := holder["m_Mesh"].(map[string]any)
			mm, err := parseMesh(mesh)
			if err != nil {
				return nil, err
			}
			out = append(out, mm)
		}
	}
	return out, nil
}

func parseMesh(m map[string]any) (Mesh, error) {
	var out Mesh
	var err error
	if out.Min, err = vec3Of(m["m_vMin"]); err != nil {
		return out, err
	}
	if out.Max, err = vec3Of(m["m_vMax"]); err != nil {
		return out, err
	}
	vb, ok := m["m_Vertices"].([]byte)
	if !ok || len(vb)%12 != 0 {
		return out, fmt.Errorf("physics: m_Vertices is not a float3 blob")
	}
	out.Vertices = make([]Vec3, len(vb)/12)
	for i := range out.Vertices {
		out.Vertices[i] = vec3Bytes(vb[i*12:])
	}
	tb, ok := m["m_Triangles"].([]byte)
	if !ok || len(tb)%12 != 0 {
		return out, fmt.Errorf("physics: m_Triangles is not a 3-index blob")
	}
	out.Triangles = make([]Triangle, len(tb)/12)
	for i := range out.Triangles {
		for k := 0; k < 3; k++ {
			out.Triangles[i][k] = int32(binary.LittleEndian.Uint32(tb[i*12+k*4:]))
		}
	}
	nb, ok := m["m_Nodes"].([]byte)
	if !ok || len(nb)%32 != 0 {
		return out, fmt.Errorf("physics: m_Nodes is not a 32-byte node blob")
	}
	out.Nodes = make([]Node, len(nb)/32)
	for i := range out.Nodes {
		b := nb[i*32:]
		packed := binary.LittleEndian.Uint32(b[12:])
		out.Nodes[i] = Node{
			Min:            vec3Bytes(b[0:]),
			Max:            vec3Bytes(b[16:]),
			Type:           uint8(packed >> 30),
			ChildOffset:    packed & 0x3FFFFFFF,
			TriangleOffset: binary.LittleEndian.Uint32(b[28:]),
		}
	}
	return out, nil
}

func vec3Bytes(b []byte) Vec3 {
	return Vec3{
		math.Float32frombits(binary.LittleEndian.Uint32(b[0:])),
		math.Float32frombits(binary.LittleEndian.Uint32(b[4:])),
		math.Float32frombits(binary.LittleEndian.Uint32(b[8:])),
	}
}

func vec3Of(v any) (Vec3, error) {
	arr, ok := v.([]any)
	if !ok || len(arr) != 3 {
		return Vec3{}, fmt.Errorf("physics: bad vector")
	}
	var out Vec3
	for i, c := range arr {
		f, ok := c.(float64)
		if !ok {
			return Vec3{}, fmt.Errorf("physics: vector component %d is %T", i, c)
		}
		out[i] = float32(f)
	}
	return out, nil
}

// Validate checks every triangle index against its mesh's vertex count and
// returns the first bad triangle, or -1.
func (m Mesh) Validate() int {
	n := int32(len(m.Vertices))
	for i, t := range m.Triangles {
		for _, idx := range t {
			if idx < 0 || idx >= n {
				return i
			}
		}
	}
	return -1
}

// Hull is one convex physics hull: its face planes as (nx, ny, nz, d), with a
// point x inside the hull when n.x - d <= 0 for every plane (the plane is
// n.x = d; verified on de_anubis: the hull centroid satisfies all planes).
type Hull struct {
	Planes   [][4]float32
	Centroid Vec3 // mean of the hull's vertices, an interior point
	Min, Max Vec3 // vertex bounds in local space
}

// PhysicsShapes returns the convex hulls and triangle meshes of every part of a
// PHYS block's root (a prop, or any single physics model).
func PhysicsShapes(kv *KV3) ([]Hull, []Mesh, error) {
	root, ok := kv.Root.(map[string]any)
	if !ok {
		return nil, nil, fmt.Errorf("physics: root is not an object")
	}
	parts, _ := root["m_parts"].([]any)
	var hulls []Hull
	var meshes []Mesh
	for _, p := range parts {
		part, _ := p.(map[string]any)
		shape, _ := part["m_rnShape"].(map[string]any)
		hs, _ := shape["m_hulls"].([]any)
		for _, h := range hs {
			holder, _ := h.(map[string]any)
			hull, _ := holder["m_Hull"].(map[string]any)
			pb, ok := hull["m_Planes"].([]byte)
			if !ok || len(pb)%16 != 0 {
				return nil, nil, fmt.Errorf("physics: hull m_Planes is not a plane blob")
			}
			hh := Hull{Planes: make([][4]float32, len(pb)/16)}
			if vb, ok := hull["m_VertexPositions"].([]byte); ok && len(vb) >= 12 {
				hh.Centroid, hh.Min, hh.Max = vertexStats(vb)
			} else if vb, ok := hull["m_Vertices"].([]byte); ok && len(vb) >= 12 {
				hh.Centroid, hh.Min, hh.Max = vertexStats(vb)
			}
			for i := range hh.Planes {
				for k := 0; k < 4; k++ {
					hh.Planes[i][k] = math.Float32frombits(binary.LittleEndian.Uint32(pb[i*16+k*4:]))
				}
			}
			hulls = append(hulls, hh)
		}
		ms, _ := shape["m_meshes"].([]any)
		for _, m := range ms {
			holder, _ := m.(map[string]any)
			mesh, _ := holder["m_Mesh"].(map[string]any)
			mm, err := parseMesh(mesh)
			if err != nil {
				return nil, nil, err
			}
			meshes = append(meshes, mm)
		}
	}
	return hulls, meshes, nil
}

// SegmentHitsHull reports whether the segment a-b enters the convex hull with
// its interior strictly between the endpoints (clipping against each plane).
func SegmentHitsHull(h Hull, a, b Vec3) bool {
	t0, t1 := 0.0, 1.0
	for _, pl := range h.Planes {
		fa := float64(pl[0])*float64(a[0]) + float64(pl[1])*float64(a[1]) + float64(pl[2])*float64(a[2]) - float64(pl[3])
		fb := float64(pl[0])*float64(b[0]) + float64(pl[1])*float64(b[1]) + float64(pl[2])*float64(b[2]) - float64(pl[3])
		if fa > 0 && fb > 0 {
			return false
		}
		if fa <= 0 && fb <= 0 {
			continue
		}
		t := fa / (fa - fb)
		if fa > 0 {
			if t > t0 {
				t0 = t
			}
		} else if t < t1 {
			t1 = t
		}
		if t0 >= t1 {
			return false
		}
	}
	return t1-t0 > 1e-9 && t1 > 1e-6 && t0 < 1-1e-6
}

// vertexStats returns the mean, min and max of a float3 vertex blob.
func vertexStats(vb []byte) (mean, lo, hi Vec3) {
	n := len(vb) / 12
	var sum [3]float64
	for i := 0; i < n; i++ {
		v := vec3Bytes(vb[i*12:])
		for k := 0; k < 3; k++ {
			sum[k] += float64(v[k])
			if i == 0 || v[k] < lo[k] {
				lo[k] = v[k]
			}
			if i == 0 || v[k] > hi[k] {
				hi[k] = v[k]
			}
		}
	}
	for k := 0; k < 3; k++ {
		mean[k] = float32(sum[k] / float64(n))
	}
	return mean, lo, hi
}
