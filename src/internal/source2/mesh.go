package source2

// Portions of this package follow ValveResourceFormat (MIT License, Copyright
// (c) 2015 ValveResourceFormat Contributors). The license text is in
// LICENSE-VRF.txt in this directory.

// Vec3 is a float32 triple as stored in vertex blobs.
type Vec3 [3]float32

// Triangle is three vertex indices (RnTriangle_t: three int32).
type Triangle [3]int32

// Mesh is one triangle mesh: the geometry the render extractor builds and the
// render cache stores (WriteMeshes/ReadMeshes). Nodes is the kd-tree the cache
// format carries; the render path leaves it empty.
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
