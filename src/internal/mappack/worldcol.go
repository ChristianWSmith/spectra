package mappack

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/ChristianWSmith/spectra/internal/source2"
)

// supportedMaps is the supported set: the maps that have been in the
// competitive pool. Other install maps are not extracted.
var supportedMaps = map[string]bool{
	"de_ancient": true, "de_anubis": true, "de_cache": true, "de_dust2": true,
	"de_inferno": true, "de_mirage": true, "de_nuke": true, "de_overpass": true,
	"de_train": true, "de_vertigo": true,
}

// SupportedWorldCollisionMaps returns the supported map names, sorted.
func SupportedWorldCollisionMaps() []string {
	out := make([]string, 0, len(supportedMaps))
	for m := range supportedMaps {
		out = append(out, m)
	}
	sort.Strings(out)
	return out
}

// ExtractWorldCollision reads a map's world collision meshes from the local
// CS2 install and writes them to outDir/<map>.worldcol (atomic write). cs2Dir
// is the folder holding pak01_dir.vpk (see FindCS2); the map VPK is
// <cs2Dir>/maps/<map>.vpk. The world model is found through the map's
// manifest (the RED2 block of maps/<map>.vmap_c), not a hard-coded name.
// Returns the output path and the number of meshes written.
func ExtractWorldCollision(cs2Dir, mapName, outDir string) (string, int, error) {
	if !supportedMaps[mapName] {
		return "", 0, fmt.Errorf("worldcol: %s is not a supported map", mapName)
	}
	vpkPath := filepath.Join(cs2Dir, "maps", mapName+".vpk")
	v, err := openVPK(vpkPath)
	if err != nil {
		return "", 0, fmt.Errorf("worldcol: %w", err)
	}
	defer v.close()

	mapData, found, err := v.read("maps/" + mapName + ".vmap_c")
	if err != nil || !found {
		return "", 0, fmt.Errorf("worldcol: map resource maps/%s.vmap_c: found=%v err=%v", mapName, found, err)
	}
	blocks, err := source2.ParseResource(mapData)
	if err != nil {
		return "", 0, fmt.Errorf("worldcol: %w", err)
	}
	red2, ok := source2.FindBlock(blocks, "RED2")
	if !ok {
		return "", 0, fmt.Errorf("worldcol: %s has no manifest block", mapName)
	}
	manifest, err := source2.Decode(red2)
	if err != nil {
		return "", 0, fmt.Errorf("worldcol: manifest: %w", err)
	}
	root, _ := manifest.Root.(map[string]any)
	children, _ := root["m_ChildResourceList"].([]any)
	worldModel := ""
	for _, c := range children {
		name, _ := c.(string)
		if strings.HasSuffix(name, "/world_physics.vmdl") {
			worldModel = name
			break
		}
	}
	if worldModel == "" {
		// Some maps (de_anubis, de_inferno, de_vertigo) ship the model in the
		// VPK but do not list it in the top manifest. The conventional path
		// is then the only source.
		if fileExistsInVPK(v, "maps/"+mapName+"/world_physics.vmdl_c") {
			worldModel = "maps/" + mapName + "/world_physics.vmdl"
		} else {
			return "", 0, fmt.Errorf("worldcol: %s has no world_physics.vmdl", mapName)
		}
	}

	modelData, found, err := v.read(worldModel + "_c")
	if err != nil || !found {
		return "", 0, fmt.Errorf("worldcol: %s_c: found=%v err=%v", worldModel, found, err)
	}
	modelBlocks, err := source2.ParseResource(modelData)
	if err != nil {
		return "", 0, fmt.Errorf("worldcol: %w", err)
	}
	phys, ok := source2.FindBlock(modelBlocks, "PHYS")
	if !ok {
		return "", 0, fmt.Errorf("worldcol: %s has no PHYS block", worldModel)
	}
	kv, err := source2.Decode(phys)
	if err != nil {
		return "", 0, fmt.Errorf("worldcol: PHYS: %w", err)
	}
	meshes, err := source2.PhysicsMeshes(kv)
	if err != nil {
		return "", 0, fmt.Errorf("worldcol: %w", err)
	}

	// Refuse output whose triangles point outside their mesh: that means a
	// decode error, not a map.
	for i, m := range meshes {
		if at := m.Validate(); at >= 0 {
			return "", 0, fmt.Errorf("worldcol: %s mesh %d triangle %d indexes outside its vertices", mapName, i, at)
		}
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return "", 0, err
	}
	out := filepath.Join(outDir, mapName+".worldcol")
	tmp, err := os.CreateTemp(outDir, mapName+".worldcol.*.tmp")
	if err != nil {
		return "", 0, err
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	if err := source2.WriteMeshes(tmp, meshes); err != nil {
		_ = tmp.Close()
		return "", 0, err
	}
	if err := tmp.Close(); err != nil {
		return "", 0, err
	}
	if err := os.Rename(tmp.Name(), out); err != nil {
		return "", 0, err
	}
	return out, len(meshes), nil
}

// fileExistsInVPK reports whether the VPK holds the named file (case-insensitive).
func fileExistsInVPK(v *vpk, name string) bool {
	_, ok := v.entries[strings.ToLower(name)]
	return ok
}
