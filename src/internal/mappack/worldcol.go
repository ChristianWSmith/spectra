package mappack

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/ChristianWSmith/spectra/internal/source2"
)

// ExtractWorldCollision reads a map's world collision meshes from the local
// CS2 install and writes them to outDir/<map>.worldcol (atomic write). cs2Dir
// is the folder holding pak01_dir.vpk (see FindCS2); the map VPK is
// <cs2Dir>/maps/<map>.vpk. The world model is found through the map's
// manifest (the RED2 block of maps/<map>.vmap_c), not a hard-coded name.
// Returns the output path and the number of meshes written.
func ExtractWorldCollision(cs2Dir, mapName, outDir string) (string, int, error) {
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
		return "", 0, fmt.Errorf("worldcol: %s lists no world_physics.vmdl", mapName)
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
