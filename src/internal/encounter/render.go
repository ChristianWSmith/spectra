package encounter

import (
	"fmt"
	"os"

	"github.com/ChristianWSmith/spectra/internal/source2"
)

// LoadRenderOccluder reads a map's render-geometry cache (written by the asset
// extraction, materials already filtered) and returns the segment-blocked query
// over it. Each mesh gets a bounding-volume hierarchy, so a ray visits only the
// boxes it crosses.
func LoadRenderOccluder(path string) (Occluder, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("render geometry %s: %w (extract the CS2 assets)", path, err)
	}
	defer f.Close()
	meshes, err := source2.ReadMeshes(f)
	if err != nil {
		return nil, fmt.Errorf("render geometry %s: %w", path, err)
	}
	trees := make([]*source2.BVH, len(meshes))
	for i := range meshes {
		trees[i] = source2.BuildBVH(&meshes[i])
	}
	return func(a, b [3]float64) bool {
		seg := source2.Segment{
			A: source2.Vec3{float32(a[0]), float32(a[1]), float32(a[2])},
			B: source2.Vec3{float32(b[0]), float32(b[1]), float32(b[2])},
		}
		for _, t := range trees {
			if t.Blocked(seg) {
				return true
			}
		}
		return false
	}, nil
}
