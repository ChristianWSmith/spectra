package mappack

import (
	"errors"
	"fmt"
	"math/bits"
	"strings"

	"github.com/ChristianWSmith/spectra/internal/source2"
)

// worldNodeStats counts what the world-node assembly placed and dropped.
type worldNodeStats struct {
	SceneObjects, Identity, Placed int
	Unresolved                     int // scene or aggregate models that could not be read
	Aggregates, Fragments          int // fragments placed
	FragmentsLOD                   int // fragments dropped for being a lower level of detail
}

// worldNodeGeometry assembles a map's world the way the engine does: each scene
// object is one model placed by its transform, and each aggregate object is cut
// into its fragments, keeping the highest level of detail and applying each
// fragment's own transform when it has one. Returns the meshes, each triangle's
// material id, and counts.
func worldNodeGeometry(v resourceReader, mapName string, nodes []string, rm *renderMaterials) ([]source2.Mesh, [][]uint16, worldNodeStats, error) {
	var out []source2.Mesh
	var outMats [][]uint16
	var st worldNodeStats
	for _, node := range nodes {
		data, found, err := v.read(node + "_c")
		if err != nil || !found {
			return nil, nil, st, fmt.Errorf("world node %s: found=%v err=%v", node, found, err)
		}
		blocks, err := source2.ParseResource(data)
		if err != nil {
			return nil, nil, st, err
		}
		d, ok := source2.FindBlock(blocks, "DATA")
		if !ok {
			return nil, nil, st, fmt.Errorf("world node %s: no DATA", node)
		}
		kv, err := source2.Decode(d)
		if err != nil {
			return nil, nil, st, err
		}
		root, _ := kv.Root.(map[string]any)
		objs, _ := root["m_sceneObjects"].([]any)
		for _, o := range objs {
			om, _ := o.(map[string]any)
			model := modelPath(om["m_renderableModel"])
			if model == "" || strings.Contains(model, "skybox") {
				continue
			}
			st.SceneObjects++
			ms, mats, err := renderModelMeshes(v, model, rm)
			if err != nil {
				st.Unresolved++

				continue
			}
			tf := matrixFrom(om["m_vTransform"])
			if tf.identity {
				st.Identity++
			} else {
				st.Placed++
			}
			for i := range ms {
				out = append(out, transformMesh(ms[i], tf.affine))
				outMats = append(outMats, mats[i])
			}
		}
		aobjs, _ := root["m_aggregateSceneObjects"].([]any)
		for _, o := range aobjs {
			om, _ := o.(map[string]any)
			model := modelPath(om["m_renderableModel"])
			if model == "" || strings.Contains(model, "skybox") {
				continue
			}
			m, mats, draws, err := renderModelRaw(v, model, rm)
			if err != nil {
				st.Unresolved++
				continue
			}
			st.Aggregates++
			fm, fmats, nf, nl, err := aggregateFragments(m, mats, draws, om)
			if err != nil {
				return nil, nil, st, fmt.Errorf("aggregate %s: %w", model, err)
			}
			st.Fragments += nf
			st.FragmentsLOD += nl
			for i := range fm {
				out = append(out, fm[i])
				outMats = append(outMats, fmats[i])
			}
		}
	}
	// A world model that cannot be read is a hole in the geometry, not a detail:
	// the extraction fails rather than leave it out.
	if st.Unresolved > 0 {
		return nil, nil, st, fmt.Errorf("%d world models could not be read (see the first error with -v)", st.Unresolved)
	}
	return out, outMats, st, nil
}

// modelPath normalises a model name from a scene object: no compiled suffix,
// forward slashes.
func modelPath(v any) string {
	s, _ := v.(string)
	s = strings.ReplaceAll(s, "\\", "/")
	return strings.TrimSuffix(s, "_c")
}

// placed is a 3x4 transform, row-major, with whether it is the identity.
type placed struct {
	affine   affine
	identity bool
}

// identityPlacement is the identity transform: the axes are x, y and z themselves.
func identityPlacement() placed {
	return placed{affine: affine{
		fwd:   [3]float64{1, 0, 0},
		left:  [3]float64{0, 1, 0},
		up:    [3]float64{0, 0, 1},
		scale: [3]float64{1, 1, 1},
	}, identity: true}
}

// matrixFrom reads a 3x4 row-major transform: rows of (xx, xy, xz, tx) etc.
func matrixFrom(v any) placed {
	list, _ := v.([]any)
	var m [3][4]float64
	ok := false
	switch {
	case len(list) == 3:
		// Nested rows: [[a b c t] [d e f t] [g h i t]].
		ok = true
		for i := 0; ok && i < 3; i++ {
			r, _ := list[i].([]any)
			if len(r) != 4 {
				ok = false
				break
			}
			for j := 0; j < 4; j++ {
				m[i][j] = entityNumber(r[j])
			}
		}
	case len(list) == 12:
		// Flat, row-major: a b c t d e f t g h i t.
		ok = true
		for i := 0; i < 3; i++ {
			for j := 0; j < 4; j++ {
				m[i][j] = entityNumber(list[i*4+j])
			}
		}
	}
	if !ok {
		return identityPlacement()
	}
	var a affine
	a.origin = [3]float64{m[0][3], m[1][3], m[2][3]}
	// Row i of the matrix is the i-th output axis; column j is the j-th input axis.
	for k := 0; k < 3; k++ {
		a.fwd[k] = m[k][0] // input x
		a.left[k] = m[k][1]
		a.up[k] = m[k][2]
	}
	a.scale = [3]float64{1, 1, 1}
	id := true
	for i := 0; i < 3 && id; i++ {
		for j := 0; j < 4; j++ {
			want := 0.0
			if i == j {
				want = 1
			}
			if m[i][j] != want {
				id = false
				break
			}
		}
	}
	return placed{affine: a, identity: id}
}

// renderModelRaw returns a single-mesh render model's mesh, the triangle
// materials, and its draw calls. Models with other than one embedded mesh are
// rejected: the fragment logic assumes one.
func renderModelRaw(v resourceReader, model string, rm *renderMaterials) (source2.Mesh, []uint16, []drawCall, error) {
	ms, mats, draws, err := renderModelParts(v, model, rm)
	if err != nil {
		return source2.Mesh{}, nil, nil, err
	}
	if len(ms) != 1 {
		return source2.Mesh{}, nil, nil, fmt.Errorf("%d embedded meshes, want 1", len(ms))
	}
	return ms[0], mats[0], draws[0], nil
}

// aggregateFragments cuts an aggregate object into its fragments. Each fragment
// is one draw call of the model, kept when its level of detail is the lowest set
// level of the object, with its own transform when it has one.
func aggregateFragments(m source2.Mesh, mats []uint16, draws []drawCall, om map[string]any) ([]source2.Mesh, [][]uint16, int, int, error) {
	frags, _ := om["m_aggregateMeshes"].([]any)
	fTrans, _ := om["m_fragmentTransforms"].([]any)
	// Combined level-of-detail mask per setup, over all fragments.
	combined := map[int]uint64{}
	for _, f := range frags {
		fm, _ := f.(map[string]any)
		setup := kvInt(fm["m_nLODSetupIndex"])
		if _, ok := fm["m_nLODSetupIndex"]; !ok {
			setup = -1
		}
		combined[setup] |= uint64(kvInt(fm["m_nLODGroupMask"]))
	}
	var out []source2.Mesh
	var outMats [][]uint16
	kept, lodDropped := 0, 0
	ti := 0
	for _, f := range frags {
		fm, _ := f.(map[string]any)
		dci := kvInt(fm["m_nDrawCallIndex"])
		if dci < 0 || dci >= len(draws) {
			return nil, nil, 0, 0, fmt.Errorf("draw call %d of %d", dci, len(draws))
		}
		tf := identityPlacement()
		if b, _ := fm["m_bHasTransform"].(bool); b {
			if ti >= len(fTrans) {
				return nil, nil, 0, 0, errors.New("fragment transform missing")
			}
			tf = matrixFrom(fTrans[ti])
			ti++
		}
		setup := kvInt(fm["m_nLODSetupIndex"])
		if _, ok := fm["m_nLODSetupIndex"]; !ok {
			setup = -1
		}
		lodMask := uint64(kvInt(fm["m_nLODGroupMask"]))
		if lodMask != 0 && !inLowestSetLevel(lodMask, combined[setup]) {
			lodDropped++
			continue
		}
		kept++
		sub, submats := drawSubmesh(m, mats, draws[dci])
		if len(sub.Triangles) == 0 {
			continue
		}
		out = append(out, transformMesh(sub, tf.affine))
		outMats = append(outMats, submats)
	}
	return out, outMats, kept, lodDropped, nil
}

// inLowestSetLevel is ModelLodInfo.IsInLowestSetLevel: a mask of 0 is always
// present; otherwise the mask must include the lowest level set in the combined mask.
func inLowestSetLevel(mask, combined uint64) bool {
	lowest := 0
	if combined != 0 {
		lowest = bits.TrailingZeros64(combined)
	}
	return mask == 0 || mask&(1<<lowest) != 0
}

// drawSubmesh copies one draw call's triangles into a compact mesh of its own
// vertices.
func drawSubmesh(m source2.Mesh, mats []uint16, d drawCall) (source2.Mesh, []uint16) {
	remap := map[int32]int32{}
	var out source2.Mesh
	var outMats []uint16
	first := d.start / 3
	last := (d.start + d.count) / 3
	if last > len(m.Triangles) {
		last = len(m.Triangles)
	}
	for t := first; t < last; t++ {
		var tri source2.Triangle
		for k := 0; k < 3; k++ {
			vi := m.Triangles[t][k]
			ni, ok := remap[vi]
			if !ok {
				ni = int32(len(out.Vertices))
				out.Vertices = append(out.Vertices, m.Vertices[vi])
				remap[vi] = ni
			}
			tri[k] = ni
		}
		out.Triangles = append(out.Triangles, tri)
		outMats = append(outMats, mats[t])
	}
	out.Min, out.Max = bounds(out.Vertices)
	return out, outMats
}
