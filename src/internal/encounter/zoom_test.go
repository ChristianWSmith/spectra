package encounter_test

import (
	"fmt"
	"image"
	"image/color"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/encounter"
	"github.com/ChristianWSmith/spectra/internal/source2"
)

// TestZoomRender draws six orthographic views centred on the blocking triangles
// of one kill's frame. Triangles near the blocker are thin blue edges, the
// blocking triangles are red, rays are green when clear and red when blocked.
// Selects the kill by SPECTRA_ONE, frame by SPECTRA_TICK, mesh by SPECTRA_MESH.
// Writes zoom-*.png to SPECTRA_OVERLAY_OUT. Opt-in.
func TestZoomRender(t *testing.T) {
	root, data, out, one := os.Getenv("SPECTRA_ENC"), os.Getenv("SPECTRA_DATA"), os.Getenv("SPECTRA_OVERLAY_OUT"), os.Getenv("SPECTRA_ONE")
	if root == "" || data == "" || out == "" || one == "" {
		t.Skip("set SPECTRA_ENC, SPECTRA_DATA, SPECTRA_OVERLAY_OUT, SPECTRA_ONE")
	}
	tick, _ := strconv.Atoi(os.Getenv("SPECTRA_TICK"))
	mi, _ := strconv.Atoi(os.Getenv("SPECTRA_MESH"))
	d := loadSweep(t, root, data)
	for _, k := range d.kills {
		if !strings.Contains(k.label, one) {
			continue
		}
		var f *sweepFrame
		for i := range k.frames {
			if k.frames[i].tick == tick {
				f = &k.frames[i]
			}
		}
		if f == nil {
			t.Fatalf("no frame at tick %d", tick)
		}
		fh, err := os.Open(filepath.Join(data, "worldcol", k.mp+".worldcol"))
		if err != nil {
			t.Fatal(err)
		}
		meshes, err := source2.ReadMeshes(fh)
		fh.Close()
		if err != nil {
			t.Fatal(err)
		}
		m := meshes[mi]
		eye := [3]float64{f.eye[0], f.eye[1], f.eye[2]}
		targets := encounter.TargetsBox(f.enemy, encounter.ProductionBox)

		// Blocking triangles for every target line, and where they are hit.
		blockers := map[int]bool{}
		var hitPts [][3]float64
		clearTo := make([]bool, len(targets))
		for ti, tg := range targets {
			dir := sub3(tg, eye)
			for i, tr := range m.Triangles {
				v0, v1, v2 := vtx(m, tr[0]), vtx(m, tr[1]), vtx(m, tr[2])
				tt, _, _, ok := segTri(eye, dir, v0, v1, v2)
				if ok {
					blockers[i] = true
					hitPts = append(hitPts, [3]float64{eye[0] + tt*dir[0], eye[1] + tt*dir[1], eye[2] + tt*dir[2]})
				}
			}
			clearTo[ti] = true
			for i := range blockers {
				_ = i
				clearTo[ti] = false
				break
			}
		}
		// Centre: the mean of the blocking hit points, or the eye if none.
		center := eye
		if len(hitPts) > 0 {
			var c [3]float64
			for _, p := range hitPts {
				c = add(c, p)
			}
			center = scale(c, 1/float64(len(hitPts)))
		}
		const half = 220.0
		const size = 800
		cx, cy, cz := center[0], center[1], center[2]
		near := func(p [3]float64) bool {
			return absf(p[0]-cx) < half+100 && absf(p[1]-cy) < half+100 && absf(p[2]-cz) < half+100
		}
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
		for _, vw := range views {
			img := image.NewRGBA(image.Rect(0, 0, size, size))
			for y := 0; y < size; y++ {
				for x := 0; x < size; x++ {
					img.SetRGBA(x, y, color.RGBA{255, 255, 255, 255})
				}
			}
			pix := func(p [3]float64) (int, int) {
				h, v := vw.proj(p)
				return int((h + half) / (2 * half) * size), int((half - v) / (2 * half) * size)
			}
			// Nearby triangles: thin blue edges.
			for i, tr := range m.Triangles {
				if blockers[i] {
					continue
				}
				v0, v1, v2 := vtx(m, tr[0]), vtx(m, tr[1]), vtx(m, tr[2])
				if !near(v0) && !near(v1) && !near(v2) {
					continue
				}
				edge(img, pix, v0, v1, color.RGBA{120, 120, 230, 160})
				edge(img, pix, v1, v2, color.RGBA{120, 120, 230, 160})
				edge(img, pix, v2, v0, color.RGBA{120, 120, 230, 160})
			}
			// Blocking triangles: thick red edges.
			for i := range blockers {
				tr := m.Triangles[i]
				v0, v1, v2 := vtx(m, tr[0]), vtx(m, tr[1]), vtx(m, tr[2])
				for _, o := range []int{0, 1} {
					red := color.RGBA{255, 0, 0, 255}
					edgeOff(img, pix, v0, v1, o, red)
					edgeOff(img, pix, v1, v2, o, red)
					edgeOff(img, pix, v2, v0, o, red)
				}
			}
			// Rays: green when clear, red when blocked.
			ex, ey := pix(eye)
			for ti, tg := range targets {
				col := color.RGBA{255, 40, 40, 255}
				if clearTo[ti] {
					col = color.RGBA{0, 200, 0, 255}
				}
				tx, ty := pix(tg)
				line(img, ex, ey, tx, ty, col)
			}
			for _, p := range hitPts {
				x, y := pix(p)
				dot(img, x, y, 2, color.RGBA{255, 0, 0, 255})
			}
			dot(img, ex, ey, 5, color.RGBA{255, 255, 0, 255})
			vx, vy := pix([3]float64{f.enemy.X, f.enemy.Y, f.enemy.Z})
			dot(img, vx, vy, 5, color.RGBA{255, 0, 255, 255})
			name := filepath.Join(out, fmt.Sprintf("zoom-%s-%d-%s.png", k.mp, tick, vw.name))
			if err := writePNG(name, img); err != nil {
				t.Fatal(err)
			}
		}
		fmt.Printf("ZOOM wrote six views for %s tick %d, centre %.0f %.0f %.0f, %d blocking triangles\n", k.label, tick, cx, cy, cz, len(blockers))
		return
	}
}

func sub3(a, b [3]float64) [3]float64 { return [3]float64{a[0] - b[0], a[1] - b[1], a[2] - b[2]} }
func add(a, b [3]float64) [3]float64  { return [3]float64{a[0] + b[0], a[1] + b[1], a[2] + b[2]} }
func scale(a [3]float64, s float64) [3]float64 {
	return [3]float64{a[0] * s, a[1] * s, a[2] * s}
}
func absf(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}

// edge draws a projected edge.
func edge(img *image.RGBA, pix func([3]float64) (int, int), a, b [3]float64, c color.RGBA) {
	x0, y0 := pix(a)
	x1, y1 := pix(b)
	line(img, x0, y0, x1, y1, c)
}

// edgeOff draws an edge offset by o pixels in y, for a thicker line.
func edgeOff(img *image.RGBA, pix func([3]float64) (int, int), a, b [3]float64, o int, c color.RGBA) {
	x0, y0 := pix(a)
	x1, y1 := pix(b)
	line(img, x0, y0+o, x1, y1+o, c)
}
