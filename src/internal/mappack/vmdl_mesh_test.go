package mappack

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/source2"
)

// TestDumpVmdlMesh decodes the embedded meshes of one render model from its
// CTRL block (buffers in MVTX and MIDX) and prints the layout and sanity checks.
// Opt-in: SPECTRA_VMDL_MESH=1, SPECTRA_MAP, SPECTRA_VMDL.
func TestDumpVmdlMesh(t *testing.T) {
	if os.Getenv("SPECTRA_VMDL_MESH") == "" {
		t.Skip("set SPECTRA_VMDL_MESH=1")
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
		t.Fatalf("read: %v %v", found, err)
	}
	blocks, err := source2.ParseResource(data)
	if err != nil {
		t.Fatal(err)
	}
	ctrlB, ok := source2.FindBlock(blocks, "CTRL")
	if !ok {
		t.Fatal("no CTRL")
	}
	kv, err := source2.Decode(ctrlB)
	if err != nil {
		t.Fatal(err)
	}
	root, _ := kv.Root.(map[string]any)
	emb, _ := root["embedded_meshes"].([]any)
	fmt.Println("EMBEDDED", len(emb))
	for mi, e := range emb {
		em, _ := e.(map[string]any)
		fmt.Printf("EMB %d keys:", mi)
		for k := range em {
			fmt.Printf(" %s", k)
		}
		fmt.Println()
		vbs, _ := em["m_vertexBuffers"].([]any)
		ibs, _ := em["m_indexBuffers"].([]any)
		for bi, b := range vbs {
			bm, _ := b.(map[string]any)
			fmt.Printf("EMB %d VB %d: %v\n", mi, bi, bm)
		}
		for bi, b := range ibs {
			bm, _ := b.(map[string]any)
			fmt.Printf("EMB %d IB %d: %v\n", mi, bi, bm)
		}
		if mi == 0 {
			vb0, _ := vbs[0].(map[string]any)
			ib0, _ := ibs[0].(map[string]any)
			vcount := toInt(vb0["m_nElementCount"])
			vsize := toInt(vb0["m_nElementSizeInBytes"])
			vblock := toInt(vb0["m_nBlockIndex"])
			icount := toInt(ib0["m_nElementCount"])
			isize := toInt(ib0["m_nElementSizeInBytes"])
			iblock := toInt(ib0["m_nBlockIndex"])
			vraw, err := source2.DecodeVertexBuffer(vcount, vsize, blocks[vblock].Data)
			if err != nil {
				t.Fatalf("vertex decode: %v", err)
			}
			iraw, err := source2.DecodeIndexBuffer(icount, isize, blocks[iblock].Data)
			if err != nil {
				t.Fatalf("index decode: %v", err)
			}
			maxIdx := 0
			for i := 0; i+1 < len(iraw); i += isize {
				v := int(iraw[i]) | int(iraw[i+1])<<8
				if v > maxIdx {
					maxIdx = v
				}
			}
			fmt.Printf("DECODE vertices %d stride %d -> %d bytes; indices %d x%d -> %d bytes; max index %d (vertex count %d)\n",
				vcount, vsize, len(vraw), icount, isize, len(iraw), maxIdx, vcount)
			var lo, hi [3]float32
			for i := 0; i < 3; i++ {
				lo[i], hi[i] = 1e30, -1e30
			}
			for vi := 0; vi < vcount; vi++ {
				for c := 0; c < 3; c++ {
					f := leF32(vraw[vi*vsize+c*4:])
					if f < lo[c] {
						lo[c] = f
					}
					if f > hi[c] {
						hi[c] = f
					}
				}
			}
			fmt.Printf("DECODE position bbox min %v max %v\n", lo, hi)
			for vi := 0; vi < 3; vi++ {
				fmt.Printf("DECODE vertex %d: %.1f %.1f %.1f\n", vi, leF32(vraw[vi*vsize:]), leF32(vraw[vi*vsize+4:]), leF32(vraw[vi*vsize+8:]))
			}
			break
		}
	}
}

func leF32(b []byte) float32 {
	u := uint32(b[0]) | uint32(b[1])<<8 | uint32(b[2])<<16 | uint32(b[3])<<24
	return math.Float32frombits(u)
}

func toInt(v any) int {
	switch x := v.(type) {
	case int64:
		return int(x)
	case uint64:
		return int(x)
	case int32:
		return int(x)
	case uint32:
		return int(x)
	case int:
		return x
	}
	return -1
}
