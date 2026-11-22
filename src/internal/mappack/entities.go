package mappack

import (
	"fmt"
	"path/filepath"

	"github.com/ChristianWSmith/spectra/internal/source2"
)

// EntityPoint is one map entity's class and world origin (Hammer units).
type EntityPoint struct {
	Class  string
	Origin [3]float64
}

// EntityOrigins reads the map's entity lump (maps/<map>/entities/*.vents_c) and
// returns every entity's classname and origin. Used for analysis (doors and other
// interactable geometry), not for collision.
func EntityOrigins(cs2, mapName string) ([]EntityPoint, error) {
	v, err := openVPK(filepath.Join(cs2, "maps", mapName+".vpk"))
	if err != nil {
		return nil, err
	}
	defer v.close()
	names := v.names("maps/"+mapName+"/entities/", ".vents_c")
	if len(names) == 0 {
		return nil, fmt.Errorf("entities: %s has no entity lump", mapName)
	}
	data, found, err := v.read(names[0])
	if err != nil || !found {
		return nil, fmt.Errorf("entities: read %s: %v", names[0], err)
	}
	blocks, err := source2.ParseResource(data)
	if err != nil {
		return nil, err
	}
	dataBlock, ok := source2.FindBlock(blocks, "DATA")
	if !ok {
		return nil, fmt.Errorf("entities: no DATA block")
	}
	kv, err := source2.Decode(dataBlock)
	if err != nil {
		return nil, err
	}
	root, _ := kv.Root.(map[string]any)
	ents, _ := root["m_entityKeyValues"].([]any)
	var out []EntityPoint
	for _, e := range ents {
		em, _ := e.(map[string]any)
		kvd, _ := em["keyValues3Data"].(map[string]any)
		vals, _ := kvd["values"].(map[string]any)
		class, _ := vals["classname"].(string)
		o, ok := vec3Value(vals["origin"])
		if !ok {
			continue
		}
		out = append(out, EntityPoint{Class: class, Origin: o})
	}
	return out, nil
}

// vec3Value reads a three-number array value from an entity's key values.
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
