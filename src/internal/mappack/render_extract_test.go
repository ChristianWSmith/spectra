package mappack

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/source2"
)

// TestExtractRenderGeometry extracts a map's render geometry and prints its size
// and bounds, to compare with the collision mesh. Opt-in: SPECTRA_RENDER_EXTRACT
// (output directory), SPECTRA_MAP.
func TestExtractRenderGeometry(t *testing.T) {
	out := os.Getenv("SPECTRA_RENDER_EXTRACT")
	if out == "" {
		t.Skip("set SPECTRA_RENDER_EXTRACT")
	}
	home, _ := os.UserHomeDir()
	cs2 := filepath.Join(home, ".steam/steam/steamapps/common/Counter-Strike Global Offensive/game/csgo")
	mp := envOr("SPECTRA_MAP", "de_ancient")
	start := time.Now()
	path, models, err := ExtractRenderGeometry(cs2, mp, out)
	if err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	meshes, err := source2.ReadMeshes(f)
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	tris, verts := 0, 0
	var lo, hi source2.Vec3
	for i, m := range meshes {
		tris += len(m.Triangles)
		verts += len(m.Vertices)
		for k := 0; k < 3; k++ {
			if i == 0 || m.Min[k] < lo[k] {
				lo[k] = m.Min[k]
			}
			if i == 0 || m.Max[k] > hi[k] {
				hi[k] = m.Max[k]
			}
		}
	}
	fmt.Printf("RENDER %s: %d models, %d meshes, %d vertices, %d triangles, bounds %v..%v, %v\n",
		mp, models, len(meshes), verts, tris, lo, hi, time.Since(start).Round(time.Second))
	wlo, whi, err := worldNodeBounds(cs2, mp)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Printf("RENDERBOUNDS %s: world resource %v..%v; render within %.0f units of it\n", mp, wlo, whi, maxBoundsGap(lo, hi, wlo, whi))
}

// worldNodeBounds reads the world resource's stored bounds (its first world
// node), to check the render geometry's extent against the map's own record.
func worldNodeBounds(cs2, mp string) ([3]float64, [3]float64, error) {
	v, err := openVPK(filepath.Join(cs2, "maps", mp+".vpk"))
	if err != nil {
		return [3]float64{}, [3]float64{}, err
	}
	defer v.close()
	data, found, err := v.read("maps/" + mp + "/world.vwrld_c")
	if err != nil || !found {
		return [3]float64{}, [3]float64{}, fmt.Errorf("world.vwrld: %v %v", found, err)
	}
	blocks, err := source2.ParseResource(data)
	if err != nil {
		return [3]float64{}, [3]float64{}, err
	}
	d, _ := source2.FindBlock(blocks, "DATA")
	kv, err := source2.Decode(d)
	if err != nil {
		return [3]float64{}, [3]float64{}, err
	}
	root, _ := kv.Root.(map[string]any)
	nodes, _ := root["m_worldNodes"].([]any)
	if len(nodes) == 0 {
		return [3]float64{}, [3]float64{}, fmt.Errorf("no world nodes")
	}
	// The union of every world node's bounds.
	lo := [3]float64{1e18, 1e18, 1e18}
	hi := [3]float64{-1e18, -1e18, -1e18}
	for _, n := range nodes {
		nm, _ := n.(map[string]any)
		a := vec3Of(nm["m_vMinBounds"], [3]float64{})
		b := vec3Of(nm["m_vMaxBounds"], [3]float64{})
		for k := 0; k < 3; k++ {
			if a[k] < lo[k] {
				lo[k] = a[k]
			}
			if b[k] > hi[k] {
				hi[k] = b[k]
			}
		}
	}
	fmt.Printf("RENDERNODES %s: %d world nodes\n", mp, len(nodes))
	return lo, hi, nil
}

// maxBoundsGap is the largest distance by which the render extent exceeds the
// stored world bounds on any side (0 when it lies within them).
func maxBoundsGap(lo, hi source2.Vec3, wlo, whi [3]float64) float64 {
	gap := 0.0
	for k := 0; k < 3; k++ {
		if d := wlo[k] - float64(lo[k]); d > gap {
			gap = d
		}
		if d := float64(hi[k]) - whi[k]; d > gap {
			gap = d
		}
	}
	return gap
}
