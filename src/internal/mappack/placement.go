package mappack

import (
	"fmt"
	"math"
	"strings"

	"github.com/ChristianWSmith/spectra/internal/source2"
)

// placedMeshes returns the render meshes of the entities that place a model
// (brush entities and props under maps/<map>/entities), each instance moved to
// map space by its origin, angles and scales. Entity models are local to their
// entity, so each instance is transformed, not shared.
func placedMeshes(v resourceReader, mapName string, manifestChildren []any, rm *renderMaterials) ([]source2.Mesh, [][]uint16, int, error) {
	var out []source2.Mesh
	var outMats [][]uint16
	cache := map[string][]source2.Mesh{}
	cacheMats := map[string][][]uint16{}
	instances := 0
	for _, c := range manifestChildren {
		vents, _ := c.(string)
		if !strings.HasSuffix(vents, ".vents") || !strings.Contains(vents, "/entities/") {
			continue
		}
		data, found, err := v.read(vents + "_c")
		if err != nil || !found {
			return nil, nil, 0, fmt.Errorf("entities %s: found=%v err=%v", vents, found, err)
		}
		blocks, err := source2.ParseResource(data)
		if err != nil {
			return nil, nil, 0, err
		}
		d, ok := source2.FindBlock(blocks, "DATA")
		if !ok {
			return nil, nil, 0, fmt.Errorf("entities %s: no DATA", vents)
		}
		kv, err := source2.Decode(d)
		if err != nil {
			return nil, nil, 0, err
		}
		root, _ := kv.Root.(map[string]any)
		ents, _ := root["m_entityKeyValues"].([]any)
		for _, e := range ents {
			em, _ := e.(map[string]any)
			kvd, _ := em["keyValues3Data"].(map[string]any)
			vals, _ := kvd["values"].(map[string]any)
			model, ok := vals["model"].(string)
			if !ok || model == "" {
				continue
			}
			if excluded(fmt.Sprint(vals["classname"])) {
				continue
			}
			model = strings.TrimSuffix(model, "_c")
			if !strings.HasSuffix(model, ".vmdl") {
				continue
			}
			ms, ok := cache[model]
			mt := cacheMats[model]
			if !ok {
				kind, err := modelKind(v, model)
				if err != nil {
					// Unreadable here: left out of the geometry.
					kind = "skip"
				}
				if kind == "render" {
					ms, mt, err = modelMeshesAt(v, model, rm)
					if err != nil {
						ms, mt = nil, nil
					}
				}
				cache[model], cacheMats[model] = ms, mt
			}
			tf := placement(vals)
			instances++
			for i := range ms {
				out = append(out, transformMesh(ms[i], tf))
				outMats = append(outMats, mt[i])
			}
		}
	}
	return out, outMats, instances, nil
}

// modelMeshesAt reads one entity model's render meshes and their material ids.
func modelMeshesAt(v resourceReader, model string, rm *renderMaterials) ([]source2.Mesh, [][]uint16, error) {
	return renderModelMeshes(v, model, rm)
}

// affine is a placement: map space = origin + x*fwd + y*left + z*up, after scale.
type affine struct {
	origin        [3]float64
	fwd, left, up [3]float64
	scale         [3]float64
}

// placement builds an entity's transform from its origin, angles (pitch, yaw,
// roll in degrees, Source convention) and scales.
func placement(vals map[string]any) affine {
	origin := vec3Of(vals["origin"], [3]float64{})
	angles := vec3Of(vals["angles"], [3]float64{})
	scale := vec3Of(vals["scales"], [3]float64{1, 1, 1})
	pitch, yaw, roll := angles[0]*math.Pi/180, angles[1]*math.Pi/180, angles[2]*math.Pi/180
	sp, cp := math.Sin(pitch), math.Cos(pitch)
	sy, cy := math.Sin(yaw), math.Cos(yaw)
	sr, cr := math.Sin(roll), math.Cos(roll)
	// Source's AngleMatrix: forward, left (= -right) and up.
	fwd := [3]float64{cp * cy, cp * sy, -sp}
	left := [3]float64{sr*sp*cy - cr*sy, sr*sp*sy + cr*cy, sr * cp}
	up := [3]float64{cr*sp*cy + sr*sy, cr*sp*sy - sr*cy, cr * cp}
	return affine{origin: origin, fwd: fwd, left: left, up: up, scale: scale}
}

func transformMesh(m source2.Mesh, tf affine) source2.Mesh {
	out := source2.Mesh{Triangles: m.Triangles, Vertices: make([]source2.Vec3, len(m.Vertices))}
	for i, v := range m.Vertices {
		x := float64(v[0]) * tf.scale[0]
		y := float64(v[1]) * tf.scale[1]
		z := float64(v[2]) * tf.scale[2]
		var w [3]float64
		for k := 0; k < 3; k++ {
			w[k] = tf.origin[k] + x*tf.fwd[k] + y*tf.left[k] + z*tf.up[k]
		}
		out.Vertices[i] = source2.Vec3{float32(w[0]), float32(w[1]), float32(w[2])}
	}
	out.Min, out.Max = bounds(out.Vertices)
	return out
}

// vec3Of reads a 3-vector from a KV3 list of numbers, or returns def.
func vec3Of(v any, def [3]float64) [3]float64 {
	l, ok := v.([]any)
	if !ok || len(l) != 3 {
		return def
	}
	var out [3]float64
	for i, e := range l {
		out[i] = entityNumber(e)
	}
	return out
}

func entityNumber(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case float32:
		return float64(x)
	case int64:
		return float64(x)
	case uint64:
		return float64(x)
	case int:
		return float64(x)
	}
	return 0
}

// modelKind classifies a model: "render" when it has render meshes in the
// embedded (MDAT) form, "classic" when it lists classic render meshes instead,
// "physics" when it has no render meshes at all.
func modelKind(v resourceReader, model string) (string, error) {
	data, found, err := v.read(model + "_c")
	if err != nil || !found {
		return "", fmt.Errorf("read: found=%v err=%v", found, err)
	}
	blocks, err := source2.ParseResource(data)
	if err != nil {
		return "", err
	}
	if _, ok := source2.FindBlock(blocks, "MDAT"); ok {
		return "render", nil
	}
	d, ok := source2.FindBlock(blocks, "DATA")
	if !ok {
		return "physics", nil
	}
	kv, err := source2.Decode(d)
	if err != nil {
		return "", err
	}
	root, _ := kv.Root.(map[string]any)
	if refs, _ := root["m_refMeshes"].([]any); len(refs) > 0 {
		return "classic", nil
	}
	return "physics", nil
}

// resourceReader reads a file of a VPK set by its full path.
type resourceReader interface {
	read(name string) (data []byte, found bool, err error)
}

// chainedVPK reads from the map's archive, then from the shared archive.
type chainedVPK struct {
	first, second *vpk
}

func (c chainedVPK) read(name string) ([]byte, bool, error) {
	data, found, err := c.first.read(name)
	if err != nil || found {
		return data, found, err
	}
	return c.second.read(name)
}

// excluded reports whether an entity class is left out of the render geometry.
func excluded(class string) bool {
	return renderExcludedClasses[class]
}
