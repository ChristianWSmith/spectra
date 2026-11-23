package encounter_test

import (
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"os"
	"path/filepath"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/source2"
)

// TestMapRenderClip renders a whole map's world collision in six orthographic
// views, side by side: left with every mesh (clip-only meshes in orange), right
// without the playerclip/npcclip meshes. Opt-in: SPECTRA_DATA, SPECTRA_OVERLAY_OUT,
// SPECTRA_MAP. Writes <out>/<map>/<view>.png.
func TestMapRenderClip(t *testing.T) {
	data, out, mp := os.Getenv("SPECTRA_DATA"), os.Getenv("SPECTRA_OVERLAY_OUT"), os.Getenv("SPECTRA_MAP")
	if data == "" || out == "" || mp == "" {
		t.Skip("set SPECTRA_DATA, SPECTRA_OVERLAY_OUT, SPECTRA_MAP")
	}
	f, err := os.Open(filepath.Join(data, "worldcol", mp+".worldcol"))
	if err != nil {
		t.Fatal(err)
	}
	meshes, err := source2.ReadMeshes(f)
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	ab, err := os.ReadFile(filepath.Join(out, "attrs", mp+".attrs.json"))
	if err != nil {
		t.Fatal(err)
	}
	var attrs []struct {
		Mesh       int      `json:"mesh"`
		InteractAs []string `json:"interactAs"`
	}
	if err := json.Unmarshal(ab, &attrs); err != nil {
		t.Fatal(err)
	}
	clip := map[int]bool{}
	for _, a := range attrs {
		for _, s := range a.InteractAs {
			if s == "playerclip" || s == "npcclip" {
				clip[a.Mesh] = true
			}
		}
	}
	lo := [3]float64{1e18, 1e18, 1e18}
	hi := [3]float64{-1e18, -1e18, -1e18}
	for _, m := range meshes {
		for _, v := range m.Vertices {
			for i := 0; i < 3; i++ {
				x := float64(v[i])
				if x < lo[i] {
					lo[i] = x
				}
				if x > hi[i] {
					hi[i] = x
				}
			}
		}
	}
	c := [3]float64{(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2}
	half := 0.0
	for i := 0; i < 3; i++ {
		if (hi[i]-lo[i])/2 > half {
			half = (hi[i] - lo[i]) / 2
		}
	}
	half *= 1.02
	cx, cy, cz := c[0], c[1], c[2]
	views := []struct {
		name string
		proj func(p [3]float64) (float64, float64)
	}{
		{"east", func(p [3]float64) (float64, float64) { return p[1] - cy, p[2] - cz }},
		{"west", func(p [3]float64) (float64, float64) { return cy - p[1], p[2] - cz }},
		{"north", func(p [3]float64) (float64, float64) { return cx - p[0], p[2] - cz }},
		{"south", func(p [3]float64) (float64, float64) { return p[0] - cx, p[2] - cz }},
		{"above", func(p [3]float64) (float64, float64) { return p[0] - cx, p[1] - cy }},
		{"below", func(p [3]float64) (float64, float64) { return p[0] - cx, cy - p[1] }},
	}
	const size = 700
	steep := os.Getenv("SPECTRA_CLIP_MODE") == "steep"
	dir := filepath.Join(out, mp+os.Getenv("SPECTRA_RENDER_SUFFIX"))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, vw := range views {
		img := image.NewRGBA(image.Rect(0, 0, 2*size+10, size))
		for y := 0; y < size; y++ {
			for x := 0; x < 2*size+10; x++ {
				img.SetRGBA(x, y, color.RGBA{255, 255, 255, 255})
			}
		}
		for side := 0; side < 2; side++ {
			ox := side * (size + 10)
			pix := func(p [3]float64) (int, int) {
				h, v := vw.proj(p)
				return ox + int((h+half)/(2*half)*size), int((half - v) / (2 * half) * size)
			}
			for i, m := range meshes {
				isClip := clip[i]
				if side == 1 && isClip && !steep {
					continue
				}
				if side == 1 && isClip && steep {
					// Right side, steep mode: only the walkable triangles of clip meshes, in green.
					wm := walkableOnly(m)
					for _, tr := range wm.Triangles {
						a, b, cc := vtx(m, tr[0]), vtx(m, tr[1]), vtx(m, tr[2])
						col := color.RGBA{0, 160, 0, 200}
						edge(img, pix, a, b, col)
						edge(img, pix, b, cc, col)
						edge(img, pix, cc, a, col)
					}
					continue
				}
				col := color.RGBA{90, 90, 255, 90}
				if isClip {
					col = color.RGBA{255, 140, 0, 160}
				}
				for _, tr := range m.Triangles {
					a, b, cc := vtx(m, tr[0]), vtx(m, tr[1]), vtx(m, tr[2])
					edge(img, pix, a, b, col)
					edge(img, pix, b, cc, col)
					edge(img, pix, cc, a, col)
				}
			}
		}
		if err := writePNG(filepath.Join(dir, vw.name+".png"), img); err != nil {
			t.Fatal(err)
		}
	}
	fmt.Printf("MAPRENDER wrote six side-by-side views to %s (steep=%v)\n", dir, steep)
}
