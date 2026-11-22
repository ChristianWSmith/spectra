package encounter_test

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/encounter"
	"github.com/ChristianWSmith/spectra/internal/sidecar"
	"github.com/ChristianWSmith/spectra/internal/source2"
)

// TestKillOverlay renders one kill's sight line over the map (dev tool, opt-in).
// Two images: plan view (over the radar) and side view (x-z). Green lines are
// clear, red lines are blocked; a blocked line's first blocking triangle is red.
//
//	SPECTRA_ENC=<dir with spectra.db and matches/>   (the match library)
//	SPECTRA_DATA=<dir with maps/ and worldcol/>       (the extracted assets)
//	SPECTRA_OVERLAY_MATCH=<match id> SPECTRA_OVERLAY_TICK=<kill tick>
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
	if err := os.MkdirAll(out, 0o755); err != nil {
		t.Fatal(err)
	}
	ex, err := renderKill(db, root, data, out, mid, tk, os.Getenv("SPECTRA_OVERLAY_ATTACKER"), os.Getenv("SPECTRA_OVERLAY_VICTIM"))
	if err != nil {
		t.Fatal(err)
	}
	fmt.Println(ex.Line())
}

// killExplain is the measured story of one kill's sight line.
type killExplain struct {
	Match                       int64
	Tick, Frame                 int
	Map, Killer, Victim         string
	Weapon                      string
	DistanceM                   float64
	Headshot                    bool
	Wallbang, Smoke, Penetrated int
	AnyClear                    bool
	BlockedMesh                 int
	BlockFrac                   []float64 // per target: fraction of the sight line at the first block (-1 when clear)
	ClearEarlier                int       // ticks before the kill with a clear dense line (0 = none in the window)
}

func (k killExplain) Line() string {
	cl := "no"
	if k.AnyClear {
		cl = "yes"
	}
	lo, hi := 2.0, -1.0
	for _, f := range k.BlockFrac {
		if f < 0 {
			continue
		}
		if f < lo {
			lo = f
		}
		if f > hi {
			hi = f
		}
	}
	where := "n/a"
	if hi >= 0 {
		switch {
		case hi < 0.2:
			where = "at the shooter"
		case lo > 0.8:
			where = "at the victim"
		case lo > 0.2 && hi < 0.8:
			where = "mid-line"
		default:
			where = "spread along the line"
		}
	}
	return fmt.Sprintf("match %d tick %d (frame %d) %s: %s -> %s, %s, %.1f m, headshot %v, wallbang %d, smoke %d, penetrated %d; any target clear: %s; block %s (mesh %d); clear earlier in window: %d ticks",
		k.Match, k.Tick, k.Frame, k.Map, k.Killer, k.Victim, k.Weapon, k.DistanceM, k.Headshot, k.Wallbang, k.Smoke, k.Penetrated, cl, where, k.BlockedMesh, k.ClearEarlier)
}

// renderKill draws one kill's two overlay images into out and returns the
// measured story. Errors when the kill or its frames are missing.
func renderKill(db *sql.DB, root, data, out string, mid int64, tk int, killer, victimID string) (killExplain, error) {
	var ex killExplain
	ex.Match, ex.Tick = mid, tk
	var attacker, victim string
	var wallbang, smoke, pen int
	var weapon string
	var dist float64
	var headshot int
	var raw string
	err := db.QueryRow(`SELECT m.map, e.attacker, e.victim, e.wallbang, e.through_smoke, e.weapon, e.distance, e.raw_json
		FROM events e JOIN matches m ON m.id = e.match_id
		WHERE e.match_id = ? AND e.tick = ? AND e.kind = 'kill' AND e.attacker <> '' AND e.victim <> ''
		  AND (? = '' OR e.attacker = ?) AND (? = '' OR e.victim = ?) LIMIT 1`, mid, tk, killer, killer, victimID, victimID).
		Scan(&ex.Map, &attacker, &victim, &wallbang, &smoke, &weapon, &dist, &raw)
	if err != nil {
		return ex, fmt.Errorf("no kill at tick %d in match %d: %w", tk, mid, err)
	}
	var payload struct {
		Penetrated int  `json:"penetrated"`
		Headshot   bool `json:"headshot"`
	}
	_ = json.Unmarshal([]byte(raw), &payload)
	pen, headshot = payload.Penetrated, 0
	if payload.Headshot {
		headshot = 1
	}
	ex.Wallbang, ex.Smoke, ex.Penetrated, ex.Weapon, ex.DistanceM, ex.Headshot = wallbang, smoke, pen, weapon, dist, headshot == 1
	ex.Killer, ex.Victim = namesFor(db, mid, attacker), namesFor(db, mid, victim)
	ai, _ := strconv.ParseUint(attacker, 10, 64)
	vi, _ := strconv.ParseUint(victim, 10, 64)
	st, err := sidecar.Load(filepath.Join(root, "matches", strconv.FormatInt(mid, 10)), 0, 0)
	if err != nil {
		return ex, err
	}
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
		return ex, fmt.Errorf("no frame with both players in the window")
	}
	ex.Frame = ft
	f, err := os.Open(filepath.Join(data, "worldcol", ex.Map+".worldcol"))
	if err != nil {
		return ex, err
	}
	meshes, err := source2.ReadMeshes(f)
	f.Close()
	if err != nil {
		return ex, err
	}
	ea := [3]float64{pa.X, pa.Y, pa.Z + 64}
	targets := encounter.Targets(encounter.Pos{X: pv.X, Y: pv.Y, Z: pv.Z, Duck: pv.Duck})
	type seg struct {
		to      [3]float64
		blocked bool
		hitMesh int
		hitTri  int
		frac    float64
	}
	var segs []seg
	ex.BlockedMesh = -1
	for _, tg := range targets {
		s := source2.Segment{A: f32(ea), B: f32(tg)}
		sg := seg{to: tg, hitMesh: -1, hitTri: -1, frac: -1}
		for mi := range meshes {
			if ti, ok := meshes[mi].FirstHit(s); ok {
				sg.blocked, sg.hitMesh, sg.hitTri = true, mi, ti
				tr := meshes[mi].Triangles[ti]
				cx := (float64(meshes[mi].Vertices[tr[0]][0]) + float64(meshes[mi].Vertices[tr[1]][0]) + float64(meshes[mi].Vertices[tr[2]][0])) / 3
				cy := (float64(meshes[mi].Vertices[tr[0]][1]) + float64(meshes[mi].Vertices[tr[1]][1]) + float64(meshes[mi].Vertices[tr[2]][1])) / 3
				cz := (float64(meshes[mi].Vertices[tr[0]][2]) + float64(meshes[mi].Vertices[tr[1]][2]) + float64(meshes[mi].Vertices[tr[2]][2])) / 3
				dx, dy, dz := tg[0]-ea[0], tg[1]-ea[1], tg[2]-ea[2]
				l2 := dx*dx + dy*dy + dz*dz
				if l2 > 0 {
					sg.frac = ((cx-ea[0])*dx + (cy-ea[1])*dy + (cz-ea[2])*dz) / l2
				}
				if ex.BlockedMesh < 0 {
					ex.BlockedMesh = mi
				}
				break
			}
		}
		if !sg.blocked {
			ex.AnyClear = true
		}
		ex.BlockFrac = append(ex.BlockFrac, sg.frac)
		segs = append(segs, sg)
	}
	// Clear earlier: how many ticks before the kill had a clear dense line.
	for _, fr := range st.Frames {
		if fr.Tick < tk-192 || fr.Tick >= tk {
			continue
		}
		var fa, fv *sidecar.FramePlayer
		for i := range fr.Players {
			if fr.Players[i].SteamID == ai {
				fa = &fr.Players[i]
			}
			if fr.Players[i].SteamID == vi {
				fv = &fr.Players[i]
			}
		}
		if fa == nil || fv == nil {
			continue
		}
		if denseLine(fa, fv, occFor(meshes)) {
			ex.ClearEarlier = tk - fr.Tick
		}
	}

	// Six orthographic views, centred on the midpoint of the two eyes: the four
	// sides (looking along +x, -x, +y, -y), above (looking down) and below
	// (looking up). Each view draws the world triangles in the window, the eight
	// target rays (green clear, red blocked, the first blocking triangle red), the
	// killer (yellow) and the victim (magenta).
	cx := (ea[0] + float64(pv.X)) / 2
	cy := (ea[1] + float64(pv.Y)) / 2
	cz := (ea[2] + float64(pv.Z)) / 2
	const half = 1000.0
	views := []struct {
		name string
		proj func(p [3]float64) (h, v float64)
	}{
		{"east", func(p [3]float64) (float64, float64) { return p[1] - cy, p[2] - cz }},  // looking +x: horizontal y
		{"west", func(p [3]float64) (float64, float64) { return cy - p[1], p[2] - cz }},  // looking -x
		{"north", func(p [3]float64) (float64, float64) { return cx - p[0], p[2] - cz }}, // looking +y: horizontal -x
		{"south", func(p [3]float64) (float64, float64) { return p[0] - cx, p[2] - cz }}, // looking -y
		{"above", func(p [3]float64) (float64, float64) { return p[0] - cx, p[1] - cy }}, // looking down
		{"below", func(p [3]float64) (float64, float64) { return p[0] - cx, cy - p[1] }}, // looking up
	}
	const size = 800
	for _, vw := range views {
		img := image.NewRGBA(image.Rect(0, 0, size, size))
		pix := func(p [3]float64) (int, int) {
			h, v := vw.proj(p)
			return int((h + half) / (2 * half) * size), int((half - v) / (2 * half) * size)
		}
		inWindow := func(p [3]float64) bool {
			h, v := vw.proj(p)
			return h > -half-200 && h < half+200 && v > -half-200 && v < half+200
		}
		for _, m := range meshes {
			for _, tr := range m.Triangles {
				a, b, c := tri3(m, tr)
				if !inWindow(a) && !inWindow(b) && !inWindow(c) {
					continue
				}
				edgeProj(img, pix, a, b, color.RGBA{90, 90, 255, 60})
				edgeProj(img, pix, b, c, color.RGBA{90, 90, 255, 60})
				edgeProj(img, pix, c, a, color.RGBA{90, 90, 255, 60})
			}
		}
		for _, sg := range segs {
			col := color.RGBA{0, 220, 0, 255}
			if sg.blocked {
				col = color.RGBA{255, 40, 40, 255}
				a, b, c := tri3(meshes[sg.hitMesh], meshes[sg.hitMesh].Triangles[sg.hitTri])
				for _, v := range [][3]float64{a, b, c} {
					x, y := pix(v)
					dot(img, x, y, 3, color.RGBA{255, 0, 0, 255})
				}
			}
			x0, y0 := pix(ea)
			x1, y1 := pix(sg.to)
			line(img, x0, y0, x1, y1, col)
		}
		kx, ky := pix(ea)
		dot(img, kx, ky, 5, color.RGBA{255, 255, 0, 255})
		vx, vy := pix([3]float64{float64(pv.X), float64(pv.Y), float64(pv.Z)})
		dot(img, vx, vy, 5, color.RGBA{255, 0, 255, 255})
		if err := writePNG(filepath.Join(out, fmt.Sprintf("kill-%d-%d-%s.png", mid, tk, vw.name)), img); err != nil {
			return ex, err
		}
	}
	return ex, nil
}

// occFor returns the segment-blocked query over a mesh set.
func occFor(meshes []source2.Mesh) encounter.Occluder {
	return func(a, b [3]float64) bool {
		seg := source2.Segment{A: f32(a), B: f32(b)}
		for i := range meshes {
			if meshes[i].Blocked(seg) {
				return true
			}
		}
		return false
	}
}

// denseLine reports whether any dense target point is reachable from the shooter's eye.
func denseLine(pa, pv *sidecar.FramePlayer, occ encounter.Occluder) bool {
	return denseClearFrame(pa, pv, occ)
}

// namesFor returns a player's name in match mid, or the steam id.
func namesFor(db *sql.DB, mid int64, sid string) string {
	var n string
	if err := db.QueryRow(`SELECT name FROM players WHERE match_id = ? AND steam_id = ?`, mid, sid).Scan(&n); err != nil || n == "" {
		return sid
	}
	return n
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

// tri3 returns a triangle's three vertices in world space.
func tri3(m source2.Mesh, tr source2.Triangle) ([3]float64, [3]float64, [3]float64) {
	v := func(i int32) [3]float64 {
		p := m.Vertices[i]
		return [3]float64{float64(p[0]), float64(p[1]), float64(p[2])}
	}
	return v(tr[0]), v(tr[1]), v(tr[2])
}

// edgeProj draws the projected edge between two world points.
func edgeProj(img *image.RGBA, pix func([3]float64) (int, int), a, b [3]float64, c color.RGBA) {
	x0, y0 := pix(a)
	x1, y1 := pix(b)
	line(img, x0, y0, x1, y1, c)
}
