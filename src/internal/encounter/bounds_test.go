package encounter_test

import (
	"fmt"
	"os"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/source2"
)

// TestBoundsCompare prints the bounds of a map's collision file and its render
// file, and how many render triangles lie below the collision floor. Opt-in:
// SPECTRA_DATA, SPECTRA_MAP, SPECTRA_RENDER_FILE.
func TestBoundsCompare(t *testing.T) {
	data, mp, file := os.Getenv("SPECTRA_DATA"), os.Getenv("SPECTRA_MAP"), os.Getenv("SPECTRA_RENDER_FILE")
	if data == "" || mp == "" || file == "" {
		t.Skip("set SPECTRA_DATA, SPECTRA_MAP, SPECTRA_RENDER_FILE")
	}
	cf, err := os.Open(fmt.Sprintf("%s/worldcol/%s.worldcol", data, mp))
	if err != nil {
		t.Fatal(err)
	}
	cm, err := source2.ReadMeshes(cf)
	cf.Close()
	if err != nil {
		t.Fatal(err)
	}
	rf, err := os.Open(file)
	if err != nil {
		t.Fatal(err)
	}
	rm, err := source2.ReadMeshes(rf)
	rf.Close()
	if err != nil {
		t.Fatal(err)
	}
	show := func(name string, ms []source2.Mesh) (lo, hi [3]float32) {
		for i, m := range ms {
			for _, v := range m.Vertices {
				for k := 0; k < 3; k++ {
					if i == 0 && v == m.Vertices[0] || v[k] < lo[k] {
						lo[k] = v[k]
					}
					if i == 0 && v == m.Vertices[0] || v[k] > hi[k] {
						hi[k] = v[k]
					}
				}
			}
		}
		fmt.Printf("BOUNDS %s %s: %v..%v (%d meshes)\n", mp, name, lo, hi, len(ms))
		return
	}
	_, chi := show("collision", cm)
	_, _ = show("render", rm)
	_ = chi
	// Render meshes that reach below the collision floor (collision min z).
	clo, _ := show("collision-min", cm)
	below := 0
	for _, m := range rm {
		if m.Max[2] < clo[2]-50 {
			below++
		}
	}
	fmt.Printf("BOUNDS %s: render meshes wholly below the collision floor by 50 units: %d\n", mp, below)
}
