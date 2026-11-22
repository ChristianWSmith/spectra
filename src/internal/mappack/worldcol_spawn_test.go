package mappack

import (
	"fmt"
	"os"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/source2"
)

// TestWorldSpawnFloor checks extracted world collision at the overview's spawn
// points: each spawn's XY should lie under an up-facing (walkable) triangle,
// against a control of random points. Opt-in: SPECTRA_RADAR=<maps>.
func TestWorldSpawnFloor(t *testing.T) {
	list := os.Getenv("SPECTRA_RADAR")
	if list == "" {
		t.Skip("set SPECTRA_RADAR=de_cache,... to run")
	}
	cs2 := FindCS2("")
	v, err := openVPK(resolvePak(cs2))
	if err != nil {
		t.Fatal(err)
	}
	defer v.close()
	out := t.TempDir()
	for _, name := range splitComma(list) {
		path, _, err := ExtractWorldCollision(cs2, name, out)
		if err != nil {
			t.Logf("MAP %s: %v", name, err)
			continue
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
		ov, err := readOverview(v, name)
		if err != nil || ov == nil {
			t.Logf("MAP %s: no overview", name)
			continue
		}
		// Up-facing triangles, as 2-D edges for a point-in-triangle test.
		type tri2 struct{ ax, ay, bx, by, cx, cy float64 }
		var floor []tri2
		for _, m := range meshes {
			for _, tr := range m.Triangles {
				a, b, c := m.Vertices[tr[0]], m.Vertices[tr[1]], m.Vertices[tr[2]]
				if (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]) <= 0 {
					continue
				}
				floor = append(floor, tri2{float64(a[0]), float64(a[1]), float64(b[0]), float64(b[1]), float64(c[0]), float64(c[1])})
			}
		}
		under := func(x, y float64) bool {
			for _, t := range floor {
				d1 := (x-t.bx)*(t.ay-t.by) - (t.ax-t.bx)*(y-t.by)
				d2 := (x-t.cx)*(t.by-t.cy) - (t.bx-t.cx)*(y-t.cy)
				d3 := (x-t.ax)*(t.cy-t.ay) - (t.cx-t.ax)*(y-t.ay)
				neg := d1 < 0 || d2 < 0 || d3 < 0
				pos := d1 > 0 || d2 > 0 || d3 > 0
				if !(neg && pos) {
					return true
				}
			}
			return false
		}
		// Spawn fractions are of the radar image; the image is square here.
		w := 1024.0
		spawns := map[string][2]float64{"CT": ov.CTSpawn, "T": ov.TSpawn}
		for side, fr := range spawns {
			if fr == [2]float64{} {
				continue
			}
			x := ov.PosX + fr[0]*w*ov.Scale
			y := ov.PosY - fr[1]*w*ov.Scale
			fmt.Printf("SPAWN %s %s: world (%.0f, %.0f) under floor: %v\n", name, side, x, y, under(x, y))
		}
		hits, n := 0, 0
		for i := 0; i < 2000; i++ {
			x := ov.PosX + float64(i%50)/50*w*ov.Scale
			y := ov.PosY - float64(i/50)/40*w*ov.Scale
			n++
			if under(x, y) {
				hits++
			}
		}
		fmt.Printf("FLOOR %s: control grid, %d/%d points under floor (%.1f%%)\n", name, hits, n, 100*float64(hits)/float64(n))
	}
}
