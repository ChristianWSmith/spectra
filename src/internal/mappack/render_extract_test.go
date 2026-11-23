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
}
