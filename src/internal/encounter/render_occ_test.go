package encounter_test

import (
	"fmt"
	"os"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/encounter"
	"github.com/ChristianWSmith/spectra/internal/source2"
)

// occFromRenderFile is an occluder over a render-geometry mesh file. Each mesh
// gets a bounding-volume hierarchy, so a ray visits only the boxes it crosses.
func occFromRenderFile(path string) (encounter.Occluder, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	meshes, err := source2.ReadMeshes(f)
	f.Close()
	if err != nil {
		return nil, err
	}
	bvhs := make([]*source2.BVH, len(meshes))
	for i := range meshes {
		bvhs[i] = source2.BuildBVH(&meshes[i])
	}
	return func(a, b [3]float64) bool {
		seg := source2.Segment{A: f32(a), B: f32(b)}
		for _, t := range bvhs {
			if t.Blocked(seg) {
				return true
			}
		}
		return false
	}, nil
}

// segBoxOverlap is a slab test: does the segment a..b touch the box lo..hi.
func segBoxOverlap(a, b, lo, hi [3]float64) bool {
	t0, t1 := 0.0, 1.0
	for k := 0; k < 3; k++ {
		d := b[k] - a[k]
		if d == 0 {
			if a[k] < lo[k] || a[k] > hi[k] {
				return false
			}
			continue
		}
		ta := (lo[k] - a[k]) / d
		tb := (hi[k] - a[k]) / d
		if ta > tb {
			ta, tb = tb, ta
		}
		if ta > t0 {
			t0 = ta
		}
		if tb < t1 {
			t1 = tb
		}
		if t0 > t1 {
			return false
		}
	}
	return true
}

// TestRenderProduction scores the production box on one map's kills, against the
// render geometry (SPECTRA_RENDER_FILE). Lists the kills it does not clear.
// Opt-in: SPECTRA_ENC, SPECTRA_DATA, SPECTRA_MAP, SPECTRA_RENDER_FILE.
func TestRenderProduction(t *testing.T) {
	root, data, mp, file := os.Getenv("SPECTRA_ENC"), os.Getenv("SPECTRA_DATA"), os.Getenv("SPECTRA_MAP"), os.Getenv("SPECTRA_RENDER_FILE")
	if root == "" || data == "" || mp == "" || file == "" {
		t.Skip("set SPECTRA_ENC, SPECTRA_DATA, SPECTRA_MAP, SPECTRA_RENDER_FILE")
	}
	occ, err := occFromRenderFile(file)
	if err != nil {
		t.Fatal(err)
	}
	d := loadSweep(t, root, data)
	clear, total := 0, 0
	for _, k := range d.kills {
		if k.mp != mp {
			continue
		}
		total++
		ok := false
		for _, f := range k.frames {
			if encounter.AnyClearBox(f.eye, f.enemy, encounter.ProductionBox, occ) {
				ok = true
				break
			}
		}
		if ok {
			clear++
		} else {
			fmt.Printf("RENDERPROD blocked: %s\n", k.label)
		}
	}
	fmt.Printf("RENDERPROD %s: production box on render geometry clears %d of %d kills\n", mp, clear, total)
}
