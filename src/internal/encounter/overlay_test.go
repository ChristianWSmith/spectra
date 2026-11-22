package encounter_test

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/encounter"
	"github.com/ChristianWSmith/spectra/internal/sidecar"
	"github.com/ChristianWSmith/spectra/internal/source2"
)

// TestKillOverlay renders one kill's sight line over the map, for eyeballing the
// blocking geometry. Two images: plan view (over the radar) and side view (x-z).
// Green lines are clear, red lines are blocked; a blocked line's first blocking
// triangle is filled in red. Dev tool, opt-in:
//
//	SPECTRA_ENC=<dir with spectra.db and matches/>  (the match library)
//	SPECTRA_DATA=<dir with maps/ and worldcol/>      (the extracted assets)
//	SPECTRA_OVERLAY_MATCH=<match id>  SPECTRA_OVERLAY_TICK=<kill tick>
//	SPECTRA_OVERLAY_OUT=<output dir>
func TestKillOverlay(t *testing.T) {
	root, data := os.Getenv("SPECTRA_ENC"), os.Getenv("SPECTRA_DATA")
	midStr, tickStr, out := os.Getenv("SPECTRA_OVERLAY_MATCH"), os.Getenv("SPECTRA_OVERLAY_TICK"), os.Getenv("SPECTRA_OVERLAY_OUT")
	if root == "" || data == "" || midStr == "" || tickStr == "" || out == "" {
		t.Skip("set SPECTRA_ENC, SPECTRA_DATA, SPECTRA_OVERLAY_MATCH, SPECTRA_OVERLAY_TICK, SPECTRA_OVERLAY_OUT")
	}
	mid, _ := strconv.ParseInt(midStr, 10, 64)
	tk, _ := strconv.Atoi(tickStr)
	db, err := sql.Open("sqlite", filepath.Join(root, "spectra.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var mapName, attacker, victim string
	var wallbang, smoke int
	err = db.QueryRow(`SELECT m.map, e.attacker, e.victim, e.wallbang, e.through_smoke FROM events e JOIN matches m ON m.id = e.match_id
		WHERE e.match_id = ? AND e.tick = ? AND e.kind = 'kill' AND e.attacker <> '' AND e.victim <> '' LIMIT 1`, mid, tk).
		Scan(&mapName, &attacker, &victim, &wallbang, &smoke)
	if err != nil {
		t.Fatalf("no kill at tick %d in match %d: %v", tk, mid, err)
	}
	ai, _ := strconv.ParseUint(attacker, 10, 64)
	vi, _ := strconv.ParseUint(victim, 10, 64)
	st, err := sidecar.Load(filepath.Join(root, "matches", strconv.FormatInt(mid, 10)), 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	// Latest frame in the 16 ticks before the kill with both present.
	var pa, pv *sidecar.FramePlayer
	var ft int
	for _, f := range st.Frames {
		if f.Tick < tk-16 || f.Tick >= tk {
			continue
		}
		var fa, fv *sidecar.FramePlayer
		for i := range f.Players {
			if f.Players[i].SteamID == ai {
				fa = &f.Players[i]
			}
			if f.Players[i].SteamID == vi {
				fv = &f.Players[i]
			}
		}
		if fa != nil && fv != nil {
			pa, pv, ft = fa, fv, f.Tick
		}
	}
	if pa == nil {
		t.Fatal("no frame with both players in the window")
	}
	// World meshes and the overview transform.
	f, err := os.Open(filepath.Join(data, "worldcol", mapName+".worldcol"))
	if err != nil {
		t.Fatal(err)
	}
	meshes, err := source2.ReadMeshes(f)
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	ea := [3]float64{pa.X, pa.Y, pa.Z + 64}
	targets := encounter.Targets(encounter.Pos{X: pv.X, Y: pv.Y, Z: pv.Z, Duck: pv.Duck})
	type seg struct {
		to      [3]float64
		blocked bool
		hitMesh int
		hitTri  int
	}
	var segs []seg
	anyClear := false
	for _, tg := range targets {
		s := source2.Segment{A: f32(ea), B: f32(tg)}
		sg := seg{to: tg, hitMesh: -1, hitTri: -1}
		for mi := range meshes {
			if ti, ok := meshes[mi].FirstHit(s); ok {
				sg.blocked, sg.hitMesh, sg.hitTri = true, mi, ti
				break
			}
		}
		if !sg.blocked {
			anyClear = true
		}
		segs = append(segs, sg)
	}
	fmt.Printf("OVERLAY %s match %d tick %d (frame %d): killer %s, victim %s, wallbang %d, smoke %d; any target clear: %v\n",
		mapName, mid, tk, ft, attacker, victim, wallbang, smoke, anyClear)

	// Overview transform from the map pack's meta.json (pixel = (x-pos_x)/scale).
	raw, err := os.ReadFile(filepath.Join(data, "maps", mapName, "meta.json"))
	if err != nil {
		t.Fatal(err)
	}
	var meta struct {
		Transform struct {
			PosX, PosY, Scale float64
		} `json:"transform"`
	}
	if err := json.Unmarshal(raw, &meta); err != nil {
		t.Fatal(err)
	}
	tf := meta.Transform
	rf, err := os.Open(filepath.Join(data, "maps", mapName, "radar.png"))
	if err != nil {
		t.Fatal(err)
	}
	radar, err := png.Decode(rf)
	rf.Close()
	if err != nil {
		t.Fatal(err)
	}
	plan := image.NewRGBA(radar.Bounds())
	draw.Draw(plan, plan.Bounds(), radar, image.Point{}, draw.Src)
	toPix := func(x, y float64) (int, int) {
		return int((x - tf.PosX) / tf.Scale), int((tf.PosY - y) / tf.Scale)
	}
	// Plan view: every world triangle edge, faint.
	for _, m := range meshes {
		for _, tr := range m.Triangles {
			a, b, c := m.Vertices[tr[0]], m.Vertices[tr[1]], m.Vertices[tr[2]]
			edgePlan(plan, toPix, a, b, color.RGBA{90, 90, 255, 40})
			edgePlan(plan, toPix, b, c, color.RGBA{90, 90, 255, 40})
			edgePlan(plan, toPix, c, a, color.RGBA{90, 90, 255, 40})
		}
	}
	// Blocking triangles in red, sight lines in green (clear) or red (blocked).
	for _, sg := range segs {
		col := color.RGBA{0, 220, 0, 255}
		if sg.blocked {
			col = color.RGBA{255, 40, 40, 255}
			tr := meshes[sg.hitMesh].Triangles[sg.hitTri]
			for _, v := range []source2.Vec3{meshes[sg.hitMesh].Vertices[tr[0]], meshes[sg.hitMesh].Vertices[tr[1]], meshes[sg.hitMesh].Vertices[tr[2]]} {
				x, y := toPix(float64(v[0]), float64(v[1]))
				dot(plan, x, y, 3, color.RGBA{255, 0, 0, 255})
			}
		}
		lineOn(plan, toPix, ea, sg.to, col)
	}
	kx, ky := toPix(ea[0], ea[1])
	dot(plan, kx, ky, 5, color.RGBA{255, 255, 0, 255})
	vx, vy := toPix(pv.X, pv.Y)
	dot(plan, vx, vy, 5, color.RGBA{255, 0, 255, 255})
	if err := writePNG(filepath.Join(out, fmt.Sprintf("kill-%d-%d-plan.png", mid, tk)), plan); err != nil {
		t.Fatal(err)
	}

	// Side view: x horizontal, z vertical, the sight lines against the geometry.
	side := image.NewRGBA(image.Rect(0, 0, 1000, 600))
	xmin, xmax := pv.X-1500, pv.X+1500
	zmin, zmax := -200.0, 1200.0
	sx := func(x float64) int { return int((x - xmin) / (xmax - xmin) * 1000) }
	sz := func(z float64) int { return int((zmax - z) / (zmax - zmin) * 600) }
	for _, m := range meshes {
		for _, tr := range m.Triangles {
			a, b, c := m.Vertices[tr[0]], m.Vertices[tr[1]], m.Vertices[tr[2]]
			if float64(maxf(a[0], b[0], c[0])) < xmin || float64(minf(a[0], b[0], c[0])) > xmax {
				continue
			}
			edgeSide(side, sx, sz, a, b, color.RGBA{90, 90, 255, 60})
			edgeSide(side, sx, sz, b, c, color.RGBA{90, 90, 255, 60})
			edgeSide(side, sx, sz, c, a, color.RGBA{90, 90, 255, 60})
		}
	}
	for _, sg := range segs {
		col := color.RGBA{0, 220, 0, 255}
		if sg.blocked {
			col = color.RGBA{255, 40, 40, 255}
		}
		lineSide(side, sx, sz, ea, sg.to, col)
	}
	dot(side, sx(ea[0]), sz(ea[2]), 5, color.RGBA{255, 255, 0, 255})
	dot(side, sx(pv.X), sz(pv.Z), 5, color.RGBA{255, 0, 255, 255})
	if err := writePNG(filepath.Join(out, fmt.Sprintf("kill-%d-%d-side.png", mid, tk)), side); err != nil {
		t.Fatal(err)
	}
}

func f32(a [3]float64) source2.Vec3 {
	return source2.Vec3{float32(a[0]), float32(a[1]), float32(a[2])}
}

func edgePlan(img *image.RGBA, toPix func(x, y float64) (int, int), a, b source2.Vec3, c color.RGBA) {
	x0, y0 := toPix(float64(a[0]), float64(a[1]))
	x1, y1 := toPix(float64(b[0]), float64(b[1]))
	line(img, x0, y0, x1, y1, c)
}

func edgeSide(img *image.RGBA, sx func(float64) int, sz func(float64) int, a, b source2.Vec3, c color.RGBA) {
	line(img, sx(float64(a[0])), sz(float64(a[2])), sx(float64(b[0])), sz(float64(b[2])), c)
}

func lineOn(img *image.RGBA, toPix func(x, y float64) (int, int), a [3]float64, b [3]float64, c color.RGBA) {
	x0, y0 := toPix(a[0], a[1])
	x1, y1 := toPix(b[0], b[1])
	line(img, x0, y0, x1, y1, c)
}

func lineSide(img *image.RGBA, sx func(float64) int, sz func(float64) int, a, b [3]float64, c color.RGBA) {
	line(img, sx(a[0]), sz(a[2]), sx(b[0]), sz(b[2]), c)
}

// line draws a Bresenham line, skipping pixels outside the image.
func line(img *image.RGBA, x0, y0, x1, y1 int, c color.RGBA) {
	dx, dy := abs(x1-x0), -abs(y1-y0)
	sx, sy := sign(x0, x1), sign(y0, y1)
	err := dx + dy
	for {
		if image.Pt(x0, y0).In(img.Bounds()) {
			img.SetRGBA(x0, y0, blend(img.RGBAAt(x0, y0), c))
		}
		if x0 == x1 && y0 == y1 {
			return
		}
		e2 := 2 * err
		if e2 >= dy {
			err += dy
			x0 += sx
		}
		if e2 <= dx {
			err += dx
			y0 += sy
		}
	}
}

func dot(img *image.RGBA, x, y, r int, c color.RGBA) {
	for dy := -r; dy <= r; dy++ {
		for dx := -r; dx <= r; dx++ {
			if image.Pt(x+dx, y+dy).In(img.Bounds()) {
				img.SetRGBA(x+dx, y+dy, c)
			}
		}
	}
}

func blend(dst, src color.RGBA) color.RGBA {
	a := float64(src.A) / 255
	return color.RGBA{
		R: uint8(float64(dst.R)*(1-a) + float64(src.R)*a),
		G: uint8(float64(dst.G)*(1-a) + float64(src.G)*a),
		B: uint8(float64(dst.B)*(1-a) + float64(src.B)*a),
		A: 255,
	}
}

func writePNG(path string, img image.Image) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return png.Encode(f, img)
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

func sign(a, b int) int {
	if a < b {
		return 1
	}
	return -1
}

func maxf(a ...float32) float32 {
	m := a[0]
	for _, v := range a {
		if v > m {
			m = v
		}
	}
	return m
}

func minf(a ...float32) float32 {
	m := a[0]
	for _, v := range a {
		if v < m {
			m = v
		}
	}
	return m
}

