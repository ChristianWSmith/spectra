package mappack

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/source2"
)

// TestSource2SpikeDeCacheWorld is the DMX/KV3 spike's end-to-end check on the
// real install: maps/de_cache.vmap_c's manifest (RED2) must list the world
// collision model, and that model's PHYS block must decode to triangle meshes
// whose indices and vertices are in range. Skips when the install is absent.
func TestSource2SpikeDeCacheWorld(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home directory")
	}
	vpkPath := filepath.Join(home, ".steam/steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/maps/de_cache.vpk")
	if _, err := os.Stat(vpkPath); err != nil {
		t.Skip("CS2 map VPK not installed")
	}
	v, err := openVPK(vpkPath)
	if err != nil {
		t.Fatalf("openVPK: %v", err)
	}
	defer v.close()

	// The map manifest: RED2 holds the KV3 tree; DATA is empty for this map.
	mapData, found, err := v.read("maps/de_cache.vmap_c")
	if err != nil || !found {
		t.Fatalf("read vmap_c: found=%v err=%v", found, err)
	}
	mapBlocks, err := source2.ParseResource(mapData)
	if err != nil {
		t.Fatalf("ParseResource(vmap_c): %v", err)
	}
	red2, ok := source2.FindBlock(mapBlocks, "RED2")
	if !ok {
		t.Fatal("vmap_c has no RED2 block")
	}
	manifest, err := source2.Decode(red2)
	if err != nil {
		t.Fatalf("Decode(RED2): %v", err)
	}
	children, _ := manifest.Root.(map[string]any)["m_ChildResourceList"].([]any)
	listed := false
	for _, c := range children {
		if c == "maps/de_cache/world_physics.vmdl" {
			listed = true
		}
	}
	if !listed {
		t.Fatalf("manifest does not list maps/de_cache/world_physics.vmdl (%d children)", len(children))
	}

	// The world collision model.
	physData, found, err := v.read("maps/de_cache/world_physics.vmdl_c")
	if err != nil || !found {
		t.Fatalf("read world_physics.vmdl_c: found=%v err=%v", found, err)
	}
	blocks, err := source2.ParseResource(physData)
	if err != nil {
		t.Fatalf("ParseResource(world_physics): %v", err)
	}
	phys, ok := source2.FindBlock(blocks, "PHYS")
	if !ok {
		t.Fatal("world_physics.vmdl_c has no PHYS block")
	}
	kv, err := source2.Decode(phys)
	if err != nil {
		t.Fatalf("Decode(PHYS): %v", err)
	}
	meshes, err := source2.PhysicsMeshes(kv)
	if err != nil {
		t.Fatalf("PhysicsMeshes: %v", err)
	}
	var verts, tris int
	for i, m := range meshes {
		verts += len(m.Vertices)
		tris += len(m.Triangles)
		if at := m.Validate(); at >= 0 {
			t.Errorf("mesh %d triangle %d has an index out of range", i, at)
		}
	}
	fmt.Printf("de_cache world collision: %d children listed, %d meshes, %d vertices, %d triangles\n",
		len(children), len(meshes), verts, tris)
	if len(meshes) != 11 || tris != 1543751 {
		t.Errorf("world collision = %d meshes / %d triangles, want 11 / 1543751 (spike baseline)", len(meshes), tris)
	}
}
