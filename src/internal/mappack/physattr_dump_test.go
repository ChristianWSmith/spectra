package mappack

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/source2"
)

// TestDumpPhysAttributes prints the PHYS block's keys for de_ancient's world
// physics model, to see whether parts carry collision attributes. Opt-in via
// SPECTRA_DUMP_PHYS=1.
func TestDumpPhysAttributes(t *testing.T) {
	if os.Getenv("SPECTRA_DUMP_PHYS") == "" {
		t.Skip("set SPECTRA_DUMP_PHYS=1")
	}
	home, _ := os.UserHomeDir()
	vpkPath := filepath.Join(home, ".steam/steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/maps/"+envOr("SPECTRA_DUMP_MAP", "de_ancient")+".vpk")
	v, err := openVPK(vpkPath)
	if err != nil {
		t.Fatal(err)
	}
	defer v.close()
	data, found, err := v.read("maps/" + envOr("SPECTRA_DUMP_MAP", "de_ancient") + "/world_physics.vmdl_c")
	if err != nil || !found {
		t.Fatalf("read: found=%v err=%v", found, err)
	}
	blocks, err := source2.ParseResource(data)
	if err != nil {
		t.Fatal(err)
	}
	phys, ok := source2.FindBlock(blocks, "PHYS")
	if !ok {
		t.Fatal("no PHYS")
	}
	kv, err := source2.Decode(phys)
	if err != nil {
		t.Fatal(err)
	}
	root, _ := kv.Root.(map[string]any)
	if root == nil {
		t.Fatalf("root is %T", kv.Root)
	}
	for k := range root {
		fmt.Println("PHYS root key:", k)
	}
	parts, _ := root["m_parts"].([]any)
	fmt.Println("parts:", len(parts))
	if len(parts) > 0 {
		if p0, ok := parts[0].(map[string]any); ok {
			for k, val := range p0 {
				fmt.Printf("part[0] key %s: %T\n", k, val)
			}
		}
	}
	if len(parts) > 0 {
		if p0, ok := parts[0].(map[string]any); ok {
			fmt.Println("part[0] m_nCollisionAttributeIndex:", p0["m_nCollisionAttributeIndex"])
		}
	}
	if len(parts) > 0 {
		if p0, ok := parts[0].(map[string]any); ok {
			if shape, ok := p0["m_rnShape"].(map[string]any); ok {
				for k, val := range shape {
					fmt.Printf("SHAPE key %s: %T\n", k, val)
				}
				if meshes, ok := shape["m_meshes"].([]any); ok && len(meshes) > 0 {
					if m0, ok := meshes[0].(map[string]any); ok {
						for k, val := range m0 {
							fmt.Printf("MESH0 key %s: %T len=%d\n", k, val, lenOf(val))
						}
					}
				}
			}
		}
	}
	attrs0, _ := root["m_collisionAttributes"].([]any)
	var exp []meshAttr
	if len(parts) > 0 {
		if p0, ok := parts[0].(map[string]any); ok {
			if shape, ok := p0["m_rnShape"].(map[string]any); ok {
				meshes, _ := shape["m_meshes"].([]any)
				for i, mm := range meshes {
					m, _ := mm.(map[string]any)
					ai, _ := m["m_nCollisionAttributeIndex"].(uint64)
					mesh, _ := m["m_Mesh"].(map[string]any)
					tris, _ := mesh["m_Triangles"].([]any)
					groupStr := "?"
					interactAs := "?"
					if int(ai) < len(attrs0) {
						a, _ := attrs0[ai].(map[string]any)
						groupStr = fmt.Sprint(a["m_CollisionGroupString"])
						interactAs = fmt.Sprint(a["m_InteractAsStrings"])
					}
					fmt.Printf("MESHATTR %d attr=%d group=%s interactAs=%s tris=%d\n", i, ai, groupStr, interactAs, len(tris))
					if a, ok := attrs0Entry(attrs0, ai); ok {
						exp = append(exp, meshAttr{Mesh: i, Attr: int(ai), Group: fmt.Sprint(a["m_CollisionGroupString"]), InteractAs: stringList(a["m_InteractAsStrings"])})
					}
				}
			}
		}
	}
	if out := os.Getenv("SPECTRA_DUMP_OUT"); out != "" {
		b, _ := json.MarshalIndent(exp, "", " ")
		if err := os.WriteFile(filepath.Join(out, envOr("SPECTRA_DUMP_MAP", "de_ancient")+".attrs.json"), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	attrs, _ := root["m_collisionAttributes"].([]any)
	for i, a := range attrs {
		m, _ := a.(map[string]any)
		fmt.Printf("ATTR %d group=%v interactAs=%v interactExclude=%v interactWith=%v interactWithExclude=%v\n", i,
			m["m_CollisionGroupString"], m["m_InteractAsStrings"], m["m_InteractExcludeStrings"], m["m_InteractWithStrings"], m["m_InteractWithExcludeStrings"])
	}
	for k, val := range root {
		if k == "m_parts" || k == "m_collisionAttributes" {
			continue
		}
		switch x := val.(type) {
		case []any:
			fmt.Printf("root %s: list of %d\n", k, len(x))
			for i, e := range x {
				if i >= 4 {
					break
				}
				fmt.Printf("  %s[%d] = %v\n", k, i, e)
			}
		}
	}
}

func lenOf(v any) int {
	switch x := v.(type) {
	case []any:
		return len(x)
	case []byte:
		return len(x)
	}
	return -1
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

// meshAttr is one PHYS mesh's collision attribute, exported for the encounter
// experiments: which meshes interact with player and NPC clips.
type meshAttr struct {
	Mesh       int      `json:"mesh"`
	Attr       int      `json:"attr"`
	Group      string   `json:"group"`
	InteractAs []string `json:"interactAs"`
}

func attrs0Entry(attrs []any, i uint64) (map[string]any, bool) {
	if int(i) >= len(attrs) {
		return nil, false
	}
	a, ok := attrs[i].(map[string]any)
	return a, ok
}

func stringList(v any) []string {
	var out []string
	if l, ok := v.([]any); ok {
		for _, e := range l {
			out = append(out, fmt.Sprint(e))
		}
	}
	return out
}
