package mappack

import (
	"fmt"
	"math/rand"
	"os"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/source2"
)

// TestWorldRadarAgreement checks extracted world collision against the map's
// radar image: walkable floor (up-facing triangles) should project onto drawn
// radar pixels, while random points should mostly miss. Opt-in:
// SPECTRA_RADAR=<map,map,...>. Spike, not a regression gate.
func TestWorldRadarAgreement(t *testing.T) {
	list := os.Getenv("SPECTRA_RADAR")
	if list == "" {
		t.Skip("set SPECTRA_RADAR=de_cache,... to run")
	}
	cs2 := FindCS2("")
	pak := resolvePak(cs2)
	v, err := openVPK(pak)
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
			t.Logf("MAP %s: no overview (%v)", name, err)
			continue
		}
		rdata, found, err := v.read(radarPrefix + name + radarSuffix)
		if err != nil || !found {
			t.Logf("MAP %s: no radar image", name)
			continue
		}
		img, err := decodeVTex(rdata)
		if err != nil {
			t.Logf("MAP %s: radar decode: %v", name, err)
			continue
		}
		w, h := img.Bounds().Dx(), img.Bounds().Dy()
		toPix := func(x, y float64) (int, int, bool) {
			px := int((x - ov.PosX) / ov.Scale)
			py := int((ov.PosY - y) / ov.Scale)
			return px, py, px >= 0 && py >= 0 && px < w && py < h
		}
		opaque := func(px, py int) bool { return img.NRGBAAt(px, py).A > 0 }
		var floor, floorHit, floorIn, rnd, rndHit int
		rng := rand.New(rand.NewSource(3))
		for _, m := range meshes {
			for _, tri := range m.Triangles {
				a, b, c := m.Vertices[tri[0]], m.Vertices[tri[1]], m.Vertices[tri[2]]
				nz := (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0])
				if nz <= 0 {
					continue // only triangles facing up (walkable)
				}
				floor++
				cx := (float64(a[0]) + float64(b[0]) + float64(c[0])) / 3
				cy := (float64(a[1]) + float64(b[1]) + float64(c[1])) / 3
				px, py, in := toPix(cx, cy)
				if in {
					floorIn++
					if opaque(px, py) {
						floorHit++
					}
				}
			}
		}
		// Control: uniform random world points inside the overview's pixel extent.
		for i := 0; i < 20000; i++ {
			x := ov.PosX + rng.Float64()*float64(w)*ov.Scale
			y := ov.PosY - rng.Float64()*float64(h)*ov.Scale
			px, py, in := toPix(x, y)
			rnd++
			if in && opaque(px, py) {
				rndHit++
			}
		}
		// Sensitivity sweep: if the transform is right, agreement peaks at the
		// stated scale and offset.
		best, bestS, bestDX, bestDY := -1.0, 0.0, 0.0, 0.0
		for _, sc := range []float64{0.97, 0.99, 1.0, 1.01, 1.03} {
			for _, dx := range []float64{-40, 0, 40} {
				for _, dy := range []float64{-40, 0, 40} {
					hit, in := 0, 0
					for _, m := range meshes {
						for _, tri := range m.Triangles {
							a, b, c := m.Vertices[tri[0]], m.Vertices[tri[1]], m.Vertices[tri[2]]
							if (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]) <= 0 {
								continue
							}
							cx := (float64(a[0]) + float64(b[0]) + float64(c[0])) / 3
							cy := (float64(a[1]) + float64(b[1]) + float64(c[1])) / 3
							px := int((cx + dx - ov.PosX) / (ov.Scale * sc))
							py := int((ov.PosY - (cy + dy)) / (ov.Scale * sc))
							if px >= 0 && py >= 0 && px < w && py < h {
								in++
								if opaque(px, py) {
									hit++
								}
							}
						}
					}
					if in > 0 && float64(hit)/float64(in) > best {
						best = float64(hit) / float64(in)
						bestS, bestDX, bestDY = sc, dx, dy
					}
				}
			}
		}
		fmt.Printf("SWEEP %s: best agreement %.1f%% at scale x%.2f, offset (%+.0f, %+.0f); stated transform agrees %.1f%%\n",
			name, 100*best, bestS, bestDX, bestDY, 100*float64(floorHit)/float64(max(floorIn, 1)))
		fmt.Printf("RADAR %s: floor triangles %d, in image %d (%.1f%%), on drawn pixels %.1f%%; control random points on drawn pixels %.1f%%; image %dx%d\n",
			name, floor, floorIn, 100*float64(floorIn)/float64(max(floor, 1)),
			100*float64(floorHit)/float64(max(floorIn, 1)), 100*float64(rndHit)/float64(rnd), w, h)
	}
}

func splitComma(s string) []string {
	var out []string
	cur := ""
	for _, c := range s {
		if c == ',' {
			if cur != "" {
				out = append(out, cur)
			}
			cur = ""
			continue
		}
		cur += string(c)
	}
	if cur != "" {
		out = append(out, cur)
	}
	return out
}
