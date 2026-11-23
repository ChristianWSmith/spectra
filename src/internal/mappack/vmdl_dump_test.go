package mappack

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/source2"
)

// TestDumpVmdl prints the MDAT layout of one render model: its scene object's
// scalar fields, the first draw call and the first meshlet. SPECTRA_VMDL is a
// path inside the map VPK, SPECTRA_MAP the map. Opt-in: SPECTRA_VMDL_DUMP=1.
func TestDumpVmdl(t *testing.T) {
	if os.Getenv("SPECTRA_VMDL_DUMP") == "" {
		t.Skip("set SPECTRA_VMDL_DUMP=1")
	}
	mp := envOr("SPECTRA_MAP", "de_ancient")
	name := os.Getenv("SPECTRA_VMDL")
	home, _ := os.UserHomeDir()
	v, err := openVPK(filepath.Join(home, ".steam/steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/maps/"+mp+".vpk"))
	if err != nil {
		t.Fatal(err)
	}
	defer v.close()
	data, found, err := v.read(name + "_c")
	if err != nil || !found {
		t.Fatalf("read %s: %v %v", name, found, err)
	}
	blocks, err := source2.ParseResource(data)
	if err != nil {
		t.Fatal(err)
	}
	for _, b := range blocks {
		fmt.Printf("BLOCK %s %d bytes\n", b.Type, len(b.Data))
	}
	mdat, ok := source2.FindBlock(blocks, "MDAT")
	if !ok {
		t.Fatal("no MDAT")
	}
	kv, err := source2.Decode(mdat)
	if err != nil {
		t.Fatal(err)
	}
	root, _ := kv.Root.(map[string]any)
	so, _ := root["m_sceneObjects"].([]any)
	if len(so) == 0 {
		t.Fatal("no scene objects")
	}
	obj, _ := so[0].(map[string]any)
	for k, val := range obj {
		if _, isList := val.([]any); !isList {
			fmt.Printf("SCENEOBJ %s = %v\n", k, val)
		}
	}
	if dc, ok := obj["m_drawCalls"].([]any); ok {
		for i, c := range dc {
			d, _ := c.(map[string]any)
			fmt.Printf("DRAW %d vtx=%v base=%v start=%v idx=%v vb=%v ib=%v\n", i, d["m_nVertexCount"], d["m_nBaseVertex"], d["m_nStartIndex"], d["m_nIndexCount"], d["m_vertexBuffers"], d["m_indexBuffer"])
		}
	}
	for _, b := range blocks {
		if b.Type == "MVTX" || b.Type == "MIDX" {
			n := 32
			if len(b.Data) < n {
				n = len(b.Data)
			}
			fmt.Printf("HEAD %s %d bytes: % x\n", b.Type, len(b.Data), b.Data[:n])
		}
	}
	if ml, ok := obj["m_meshlets"].([]any); ok && len(ml) > 0 {
		m0, _ := ml[0].(map[string]any)
		for k, val := range m0 {
			fmt.Printf("MESHLET0 %s = %v\n", k, val)
		}
	}
	for k := range root {
		if _, isList := root[k].([]any); !isList {
			continue
		}
		fmt.Printf("ROOTLIST %s\n", k)
	}
}
