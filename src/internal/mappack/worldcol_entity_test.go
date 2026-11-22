package mappack

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/source2"
)

// TestEntityPhysicsProbe: spike for props and entities. For one map, count the
// entity models that carry a PHYS block and decode their meshes. Opt-in:
// SPECTRA_ENTITY=<map>.
func TestEntityPhysicsProbe(t *testing.T) {
	name := os.Getenv("SPECTRA_ENTITY")
	if name == "" {
		t.Skip("set SPECTRA_ENTITY=de_anubis")
	}
	v, err := openVPK(filepath.Join(FindCS2(""), "maps", name+".vpk"))
	if err != nil {
		t.Fatal(err)
	}
	defer v.close()
	var withPhys, meshes, tris, failed, total, hulls int
	for _, n := range v.names("maps/"+name+"/entities/", "_c") {
		if !strings.HasSuffix(n, ".vmdl_c") {
			continue
		}
		total++
		data, _, _ := v.read(n)
		bs, err := source2.ParseResource(data)
		if err != nil {
			failed++
			continue
		}
		phys, ok := source2.FindBlock(bs, "PHYS")
		if !ok {
			continue
		}
		withPhys++
		kv, err := source2.Decode(phys)
		if err != nil {
			failed++
			fmt.Println("ENTITY decode", n, err)
			continue
		}
		if root, ok := kv.Root.(map[string]any); ok {
			for _, pv := range root["m_parts"].([]any) {
				shape, _ := pv.(map[string]any)["m_rnShape"].(map[string]any)
				if hs, ok := shape["m_hulls"].([]any); ok {
					hulls += len(hs)
				}
			}
		}
		ms, err := source2.PhysicsMeshes(kv)
		if err != nil {
			failed++
			continue
		}
		meshes += len(ms)
		for _, m := range ms {
			tris += len(m.Triangles)
		}
	}
	fmt.Printf("ENTITY %s: %d entity models, %d with PHYS, %d convex hulls, %d meshes, %d triangles, %d failed\n",
		name, total, withPhys, hulls, meshes, tris, failed)
}
