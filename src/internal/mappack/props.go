package mappack

import (
	"fmt"
	"math"
	"path/filepath"
	"strings"

	"github.com/ChristianWSmith/spectra/internal/source2"
)

// Prop is one entity placed in a map that carries a physics model.
type Prop struct {
	Model  string     // e.g. maps/de_anubis/entities/unnamed_2_20341.vmdl
	Origin [3]float64 // world position (Hammer units)
	Angles [3]float64 // pitch, yaw, roll in degrees (Source convention)
	Scale  float64    // uniform scale (the first scale component)
}

// LoadProps reads the map's entity lump and returns the entities with a model.
// The lump is maps/<map>/entities/*.vents_c; each entity's values carry origin,
// angles, scales and model.
func LoadProps(v *vpk, mapName string) ([]Prop, error) {
	names := v.names("maps/"+mapName+"/entities/", ".vents_c")
	if len(names) == 0 {
		return nil, fmt.Errorf("props: %s has no entity lump", mapName)
	}
	data, found, err := v.read(names[0])
	if err != nil || !found {
		return nil, fmt.Errorf("props: read %s: %v", names[0], err)
	}
	blocks, err := source2.ParseResource(data)
	if err != nil {
		return nil, err
	}
	dataBlock, ok := source2.FindBlock(blocks, "DATA")
	if !ok {
		return nil, fmt.Errorf("props: entity lump has no DATA block")
	}
	kv, err := source2.Decode(dataBlock)
	if err != nil {
		return nil, err
	}
	root, _ := kv.Root.(map[string]any)
	ents, _ := root["m_entityKeyValues"].([]any)
	var out []Prop
	for _, e := range ents {
		em, _ := e.(map[string]any)
		kvd, _ := em["keyValues3Data"].(map[string]any)
		vals, _ := kvd["values"].(map[string]any)
		model, _ := vals["model"].(string)
		if !strings.HasSuffix(model, ".vmdl") {
			continue
		}
		origin, ok1 := vec3Value(vals["origin"])
		angles, ok2 := vec3Value(vals["angles"])
		scales, _ := vec3Value(vals["scales"])
		if !ok1 {
			continue
		}
		if !ok2 {
			angles = [3]float64{}
		}
		scale := scales[0]
		if scale == 0 {
			scale = 1
		}
		out = append(out, Prop{Model: model, Origin: origin, Angles: angles, Scale: scale})
	}
	return out, nil
}

func vec3Value(v any) ([3]float64, bool) {
	arr, ok := v.([]any)
	if !ok || len(arr) != 3 {
		return [3]float64{}, false
	}
	var out [3]float64
	for i, c := range arr {
		f, ok := c.(float64)
		if !ok {
			return [3]float64{}, false
		}
		out[i] = f
	}
	return out, true
}

// PropShape is a model's physics in its own (local) space.
type PropShape struct {
	Hulls  []source2.Hull
	Meshes []source2.Mesh
}

// LoadShape reads a model's PHYS block from the VPK.
func LoadShape(v *vpk, model string) (PropShape, error) {
	data, found, err := v.read(model + "_c")
	if err != nil || !found {
		return PropShape{}, fmt.Errorf("props: %s_c: found=%v err=%v", model, found, err)
	}
	blocks, err := source2.ParseResource(data)
	if err != nil {
		return PropShape{}, err
	}
	phys, ok := source2.FindBlock(blocks, "PHYS")
	if !ok {
		return PropShape{}, fmt.Errorf("props: %s has no PHYS", model)
	}
	kv, err := source2.Decode(phys)
	if err != nil {
		return PropShape{}, err
	}
	hulls, meshes, err := source2.PhysicsShapes(kv)
	if err != nil {
		return PropShape{}, err
	}
	return PropShape{Hulls: hulls, Meshes: meshes}, nil
}

// angleMatrix is Source's AngleMatrix: local to world rotation for pitch, yaw
// and roll in degrees.
func angleMatrix(pitch, yaw, roll float64) [3][3]float64 {
	const d = math.Pi / 180
	sp, cp := math.Sincos(pitch * d)
	sy, cy := math.Sincos(yaw * d)
	sr, cr := math.Sincos(roll * d)
	return [3][3]float64{
		{cp * cy, sr*sp*cy - cr*sy, cr*sp*cy + sr*sy},
		{cp * sy, sr*sp*sy + cr*cy, cr*sp*sy - sr*cy},
		{-sp, sr * cp, cr * cp},
	}
}

// ToLocal maps a world point into the prop's local frame (inverse of the
// rotation, then undo the scale and origin).
func (p Prop) ToLocal(w [3]float64, r [3][3]float64) source2.Vec3 {
	d := [3]float64{w[0] - p.Origin[0], w[1] - p.Origin[1], w[2] - p.Origin[2]}
	var out source2.Vec3
	for i := 0; i < 3; i++ {
		// R^T row i = column i of R
		v := r[0][i]*d[0] + r[1][i]*d[1] + r[2][i]*d[2]
		out[i] = float32(v / p.Scale)
	}
	return out
}

// Blocks reports whether the segment a-b is blocked by the prop's shape.
func (p Prop) Blocks(s PropShape, a, b [3]float64) bool {
	r := angleMatrix(p.Angles[0], p.Angles[1], p.Angles[2])
	la, lb := p.ToLocal(a, r), p.ToLocal(b, r)
	for _, h := range s.Hulls {
		if source2.SegmentHitsHull(h, la, lb) {
			return true
		}
	}
	seg := source2.Segment{A: la, B: lb}
	for i := range s.Meshes {
		if s.Meshes[i].Blocked(seg) {
			return true
		}
	}
	return false
}

// PropOccluder returns a segment-blocked query over the world and every prop
// of the map, with prop shapes loaded once. Used for visibility; the world
// occluder comes from the world collision cache.
func PropOccluder(cs2, mapName string, worldBlocked func(a, b [3]float64) bool) (func(a, b [3]float64) bool, int, error) {
	vpkPath := filepath.Join(cs2, "maps", mapName+".vpk")
	v, err := openVPK(vpkPath)
	if err != nil {
		return nil, 0, err
	}
	defer v.close()
	props, err := LoadProps(v, mapName)
	if err != nil {
		return nil, 0, err
	}
	shapes := map[string]PropShape{}
	var placed []struct {
		p Prop
		s PropShape
	}
	for _, p := range props {
		s, ok := shapes[p.Model]
		if !ok {
			s, err = LoadShape(v, p.Model)
			if err != nil {
				continue // a model without physics contributes nothing
			}
			shapes[p.Model] = s
		}
		if len(s.Hulls) == 0 && len(s.Meshes) == 0 {
			continue
		}
		placed = append(placed, struct {
			p Prop
			s PropShape
		}{p, s})
	}
	return func(a, b [3]float64) bool {
		if worldBlocked(a, b) {
			return true
		}
		for _, pl := range placed {
			if pl.p.Blocks(pl.s, a, b) {
				return true
			}
		}
		return false
	}, len(placed), nil
}
