package encounter_test

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/encounter"
	"github.com/ChristianWSmith/spectra/internal/source2"
)

// TestTriangleCheck lists every triangle of one mesh that the eye-to-target lines
// of one frame pass through, with where on the triangle each line crosses it.
// Selects the kill by SPECTRA_ONE, the frame by SPECTRA_TICK, the mesh by
// SPECTRA_MESH (default 0). Opt-in.
func TestTriangleCheck(t *testing.T) {
	root, data, one := os.Getenv("SPECTRA_ENC"), os.Getenv("SPECTRA_DATA"), os.Getenv("SPECTRA_ONE")
	if root == "" || data == "" || one == "" {
		t.Skip("set SPECTRA_ENC, SPECTRA_DATA, SPECTRA_ONE")
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
		fmt.Printf("TRI %s tick %d mesh %d (%d tris), eye %.1f %.1f %.1f\n", k.label, tick, mi, len(m.Triangles), f.eye[0], f.eye[1], f.eye[2])
		eye := [3]float64{f.eye[0], f.eye[1], f.eye[2]}
		for ti, tg := range encounter.TargetsBox(f.enemy, encounter.ProductionBox) {
			dir := [3]float64{tg[0] - eye[0], tg[1] - eye[1], tg[2] - eye[2]}
			hits := 0
			for i, tr := range m.Triangles {
				v0, v1, v2 := vtx(m, tr[0]), vtx(m, tr[1]), vtx(m, tr[2])
				tt, u, v, ok := segTri(eye, dir, v0, v1, v2)
				if !ok {
					continue
				}
				hits++
				w := 1 - u - v
				n := cross(sub(v1, v0), sub(v2, v0))
				nl := math.Sqrt(vdot(n, n))
				cosv := vdot(n, dir) / (nl * math.Sqrt(vdot(dir, dir)))
				hit := [3]float64{eye[0] + tt*dir[0], eye[1] + tt*dir[1], eye[2] + tt*dir[2]}
				fmt.Printf("TRI target %d: tri %d at %.2f of the line, point %.0f %.0f %.0f, barycentric %.2f %.2f %.2f, normal cos to line %.2f, area %.0f\n",
					ti, i, tt, hit[0], hit[1], hit[2], w, u, v, cosv, nl/2)
			}
			if hits == 0 {
				fmt.Printf("TRI target %d: clear\n", ti)
			}
		}
		return
	}
}

func vtx(m source2.Mesh, i int32) [3]float64 {
	p := m.Vertices[i]
	return [3]float64{float64(p[0]), float64(p[1]), float64(p[2])}
}
func sub(a, b [3]float64) [3]float64 { return [3]float64{a[0] - b[0], a[1] - b[1], a[2] - b[2]} }
func vdot(a, b [3]float64) float64   { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2] }
func cross(a, b [3]float64) [3]float64 {
	return [3]float64{a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]}
}

// segTri is Möller–Trumbore for the segment eye + t*dir, t in [0,1].
// Returns t, and the barycentric u, v of the hit.
func segTri(o, d, v0, v1, v2 [3]float64) (float64, float64, float64, bool) {
	const eps = 1e-9
	e1, e2 := sub(v1, v0), sub(v2, v0)
	p := cross(d, e2)
	det := vdot(e1, p)
	if math.Abs(det) < eps {
		return 0, 0, 0, false
	}
	inv := 1 / det
	s := sub(o, v0)
	u := vdot(s, p) * inv
	if u < 0 || u > 1 {
		return 0, 0, 0, false
	}
	q := cross(s, e1)
	v := vdot(d, q) * inv
	if v < 0 || u+v > 1 {
		return 0, 0, 0, false
	}
	tt := vdot(e2, q) * inv
	if tt < 0 || tt > 1 {
		return 0, 0, 0, false
	}
	return tt, u, v, true
}
