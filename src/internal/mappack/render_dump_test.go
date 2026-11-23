package mappack

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/source2"
)

// TestDumpRenderChildren lists the map manifest's child resources that look like
// render geometry (vmesh, vmdl, vmap) for SPECTRA_MAP. Opt-in: SPECTRA_RENDER_DUMP=1.
func TestDumpRenderChildren(t *testing.T) {
	if os.Getenv("SPECTRA_RENDER_DUMP") == "" {
		t.Skip("set SPECTRA_RENDER_DUMP=1")
	}
	mp := envOr("SPECTRA_MAP", "de_ancient")
	home, _ := os.UserHomeDir()
	v, err := openVPK(filepath.Join(home, ".steam/steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/maps/"+mp+".vpk"))
	if err != nil {
		t.Fatal(err)
	}
	defer v.close()
	data, found, err := v.read("maps/" + mp + ".vmap_c")
	if err != nil || !found {
		t.Fatalf("vmap: %v %v", found, err)
	}
	blocks, err := source2.ParseResource(data)
	if err != nil {
		t.Fatal(err)
	}
	red2, _ := source2.FindBlock(blocks, "RED2")
	man, err := source2.Decode(red2)
	if err != nil {
		t.Fatal(err)
	}
	root, _ := man.Root.(map[string]any)
	children, _ := root["m_ChildResourceList"].([]any)
	counts := map[string]int{}
	for _, c := range children {
		name, _ := c.(string)
		ext := filepath.Ext(name)
		counts[ext]++
		if strings.Contains(name, "world") || ext == ".vmesh" {
			fmt.Println("RENDERCHILD", name)
		}
	}
	fmt.Println("RENDERCOUNTS", counts)
}

// TestDumpPhysMaterials prints, per PHYS mesh, the per-triangle material counts
// (m_Materials) for SPECTRA_MAP, and the mesh's attribute index. Opt-in:
// SPECTRA_MATS=1.
func TestDumpPhysMaterials(t *testing.T) {
	if os.Getenv("SPECTRA_MATS") == "" {
		t.Skip("set SPECTRA_MATS=1")
	}
	mp := envOr("SPECTRA_MAP", "de_ancient")
	home, _ := os.UserHomeDir()
	v, err := openVPK(filepath.Join(home, ".steam/steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/maps/"+mp+".vpk"))
	if err != nil {
		t.Fatal(err)
	}
	defer v.close()
	data, found, err := v.read("maps/" + mp + "/world_physics.vmdl_c")
	if err != nil || !found {
		t.Fatalf("read: %v %v", found, err)
	}
	blocks, err := source2.ParseResource(data)
	if err != nil {
		t.Fatal(err)
	}
	phys, _ := source2.FindBlock(blocks, "PHYS")
	kv, err := source2.Decode(phys)
	if err != nil {
		t.Fatal(err)
	}
	root, _ := kv.Root.(map[string]any)
	parts, _ := root["m_parts"].([]any)
	if len(parts) == 0 {
		t.Fatal("no parts")
	}
	p0, _ := parts[0].(map[string]any)
	shape, _ := p0["m_rnShape"].(map[string]any)
	meshes, _ := shape["m_meshes"].([]any)
	for i, mm := range meshes {
		h, _ := mm.(map[string]any)
		mesh, _ := h["m_Mesh"].(map[string]any)
		mats, _ := mesh["m_Materials"]
		fmt.Printf("MAT mesh %d: m_Materials type %T", i, mats)
		if l, ok := mats.([]byte); ok {
			counts := map[byte]int{}
			for _, b := range l {
				counts[b]++
			}
			fmt.Printf(" len=%d distinct=%d counts=%v", len(l), len(counts), counts)
		}
		if l, ok := mats.([]any); ok {
			fmt.Printf(" len=%d sample=%v", len(l), l[:min(4, len(l))])
		}
		fmt.Println()
		for k := range mesh {
			if k != "m_Vertices" && k != "m_Triangles" && k != "m_Nodes" {
				fmt.Printf("   key %s %T\n", k, mesh[k])
			}
		}
		break
	}
}
