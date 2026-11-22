package encounter_test

import (
	"database/sql"
	"fmt"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"sync"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/encounter"
	"github.com/ChristianWSmith/spectra/internal/sidecar"
)

// sweepKill is one bullet kill with frames in its window: the shooter's eye and
// the victim's position at each frame, and the map's occluder.
type sweepKill struct {
	mp     string
	frames []sweepFrame
	label  string
}

type sweepFrame struct {
	eye   [3]float64
	enemy encounter.Pos
}

// TestBoxSweep sweeps the enemy box (half-width, top, lateral and forward lean)
// and reports, for each setting: how many unexplained kills it makes clear
// ("captured"), how many kills that are clear under the production box it loses
// ("lost"), and a control: the share of random opposing pairs it calls clear.
// Writes sweep.md to SPECTRA_OVERLAY_OUT. Dev tool, opt-in:
//
//	SPECTRA_ENC, SPECTRA_DATA, SPECTRA_OVERLAY_OUT
func TestBoxSweep(t *testing.T) {
	root, data, out := os.Getenv("SPECTRA_ENC"), os.Getenv("SPECTRA_DATA"), os.Getenv("SPECTRA_OVERLAY_OUT")
	if root == "" || data == "" || out == "" {
		t.Skip("set SPECTRA_ENC, SPECTRA_DATA, SPECTRA_OVERLAY_OUT")
	}
	db, err := sql.Open("sqlite", filepath.Join(root, "spectra.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mrows, _ := db.Query(`SELECT id, map FROM matches ORDER BY id`)
	type mi struct {
		id int64
		mp string
	}
	var ms []mi
	for mrows.Next() {
		var m mi
		_ = mrows.Scan(&m.id, &m.mp)
		ms = append(ms, m)
	}
	mrows.Close()

	occs := map[string]encounter.Occluder{}
	var kills []sweepKill
	var control []sweepKill // random opposing pairs, one frame each
	rng := rand.New(rand.NewSource(11))
	for _, m := range ms {
		if _, ok := occs[m.mp]; !ok {
			occ, err := occFromCache(data, m.mp)
			if err != nil {
				t.Fatal(err)
			}
			occs[m.mp] = occ
		}
		st, err := sidecar.Load(filepath.Join(root, "matches", strconv.FormatInt(m.id, 10)), 0, 0)
		if err != nil {
			t.Fatal(err)
		}
		krows, _ := db.Query(`SELECT tick, attacker, victim, wallbang, through_smoke, weapon FROM events
			WHERE match_id=? AND kind='kill' AND attacker<>'' AND victim<>'' AND attacker<>victim AND round>0`, m.id)
		for krows.Next() {
			var tk, wb, sm int
			var a, v, wp string
			_ = krows.Scan(&tk, &a, &v, &wb, &sm, &wp)
			if wb == 1 || sm == 1 || wp == "HE Grenade" || wp == "Molotov" {
				continue
			}
			ai, _ := strconv.ParseUint(a, 10, 64)
			vi, _ := strconv.ParseUint(v, 10, 64)
			k := sweepKill{mp: m.mp, label: fmt.Sprintf("%s match %d tick %d %s->%s", m.mp, m.id, tk, a, v)}
			for _, f := range st.Frames {
				if f.Tick < tk-64 || f.Tick > tk+4 {
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
				if fa == nil || fv == nil {
					continue
				}
				k.frames = append(k.frames, sweepFrame{
					eye:   shooterEye(fa),
					enemy: encounter.Pos{X: fv.X, Y: fv.Y, Z: fv.Z, Duck: fv.Duck, Side: fv.Side, Yaw: fv.Yaw},
				})
			}
			if len(k.frames) > 0 {
				kills = append(kills, k)
			}
		}
		krows.Close()
		// Control: random opposing pairs in frames, 8 to 50 m apart.
		var opp []struct {
			eye   [3]float64
			enemy encounter.Pos
		}
		for _, f := range st.Frames {
			for _, a := range f.Players {
				for _, b := range f.Players {
					if a.SteamID == b.SteamID || a.Side == "" || b.Side == "" || a.Side == b.Side {
						continue
					}
					d := (a.X-b.X)*(a.X-b.X) + (a.Y-b.Y)*(a.Y-b.Y)
					if d < 200*200 || d > 1250*1250 {
						continue
					}
					opp = append(opp, struct {
						eye   [3]float64
						enemy encounter.Pos
					}{shooterEye(&a), encounter.Pos{X: b.X, Y: b.Y, Z: b.Z, Duck: b.Duck, Side: b.Side, Yaw: b.Yaw}})
				}
			}
		}
		for i := 0; i < 400 && len(opp) > 0; i++ {
			p := opp[rng.Intn(len(opp))]
			control = append(control, sweepKill{mp: m.mp, frames: []sweepFrame{{eye: p.eye, enemy: p.enemy}}})
		}
	}

	// Unexplained: no clear frame under the production box, dense grid (the set
	// the overlays show). Explained-clear: clear under the production box, 8 points.
	dense := func(k sweepKill) bool {
		for _, f := range k.frames {
			if denseFrom(f.eye, f.enemy, occs[k.mp]) {
				return true
			}
		}
		return false
	}
	base := func(k sweepKill) bool {
		for _, f := range k.frames {
			if encounter.AnyClearBox(f.eye, f.enemy, encounter.DefaultBox, occs[k.mp]) {
				return true
			}
		}
		return false
	}
	var unexplained, clearBase []int
	for i, k := range kills {
		if !dense(k) {
			unexplained = append(unexplained, i)
		}
		if base(k) {
			clearBase = append(clearBase, i)
		}
	}
	fmt.Printf("SWEEP kills %d (unexplained %d, clear under production box %d), control pairs %d\n",
		len(kills), len(unexplained), len(clearBase), len(control))
	if os.Getenv("SPECTRA_GRAZE") != "" {
		grazeReport(kills, unexplained, occs)
	}

	type setting struct {
		box encounter.Box
	}
	var settings []setting
	for _, hw := range []float64{16, 20, 24, 28, 32} {
		for _, top := range []float64{8, 12, 16} {
			for _, lat := range []float64{-6, 0, 6} {
				for _, fwd := range []float64{-6, 0, 6} {
					settings = append(settings, setting{encounter.Box{HalfWidth: hw, TopAdd: top, Lat: lat, Fwd: fwd}})
					settings = append(settings, setting{encounter.Box{HalfWidth: hw, TopAdd: top, Lat: lat, Fwd: fwd, Grid: true}})
				}
			}
		}
	}
	type result struct {
		box                      encounter.Box
		captured, lost, controlN int
		clearAll                 int
	}
	results := make([]result, len(settings))
	workers := runtime.NumCPU()
	var wg sync.WaitGroup
	idx := make(chan int)
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for si := range idx {
				b := settings[si].box
				r := result{box: b}
				for _, i := range unexplained {
					if clearWith(kills[i], b, occs[kills[i].mp]) {
						r.captured++
					}
				}
				isBase := map[int]bool{}
				for _, i := range clearBase {
					isBase[i] = true
				}
				for _, i := range clearBase {
					if !clearWith(kills[i], b, occs[kills[i].mp]) {
						r.lost++
					}
				}
				for i := range kills {
					if !isBase[i] && clearWith(kills[i], b, occs[kills[i].mp]) {
						r.clearAll++
					}
				}
				for _, c := range control {
					if clearWith(c, b, occs[c.mp]) {
						r.controlN++
					}
				}
				results[si] = r
			}
		}()
	}
	for si := range settings {
		idx <- si
	}
	close(idx)
	wg.Wait()

	sort.SliceStable(results, func(i, j int) bool {
		if results[i].captured != results[j].captured {
			return results[i].captured > results[j].captured
		}
		return results[i].lost < results[j].lost
	})
	md := fmt.Sprintf("# Box sweep\n\nKills with frames: %d. Unexplained (no clear frame under the production box, dense grid): %d. Kills clear under the production box: %d. Control: %d random opposing pairs 5 to 32 m apart (clear share is a false-positive check).\n\n",
		len(kills), len(unexplained), len(clearBase), len(control))
	md += "| sampler | half-width | top above eye | lateral | forward | unexplained captured (of " + strconv.Itoa(len(unexplained)) + ") | production-clear lost (of " + strconv.Itoa(len(clearBase)) + ") | newly clear (not production-clear) | control clear |\n"
	md += "|---|---|---|---|---|---|---|---|---|\n"
	for _, r := range results {
		sampler := "corners"
		if r.box.Grid {
			sampler = "grid"
		}
		md += fmt.Sprintf("| %s | %.0f | %.0f | %+.0f | %+.0f | %d | %d | %d | %.1f%% |\n",
			sampler, r.box.HalfWidth, r.box.TopAdd, r.box.Lat, r.box.Fwd, r.captured, r.lost, r.clearAll, 100*float64(r.controlN)/float64(max(len(control), 1)))
	}
	if err := os.MkdirAll(out, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(out, "sweep.md"), []byte(md), 0o644); err != nil {
		t.Fatal(err)
	}
	fmt.Println("SWEEP written:", filepath.Join(out, "sweep.md"), "settings", len(settings))
	for i := 0; i < len(results) && i < 8; i++ {
		r := results[i]
		fmt.Printf("SWEEP top: grid %v hw %.0f top %.0f lat %+.0f fwd %+.0f: captured %d, lost %d, newly clear %d, control %d\n",
			r.box.Grid, r.box.HalfWidth, r.box.TopAdd, r.box.Lat, r.box.Fwd, r.captured, r.lost, r.clearAll, r.controlN)
	}
}

// clearWith reports whether any frame of k is clear under box b.
func clearWith(k sweepKill, b encounter.Box, occ encounter.Occluder) bool {
	for _, f := range k.frames {
		if encounter.AnyClearBox(f.eye, f.enemy, b, occ) {
			return true
		}
	}
	return false
}

// denseFrom: the dense 3x3x5 grid from the eye, as in denseClearFrame.
func denseFrom(eye [3]float64, p encounter.Pos, occ encounter.Occluder) bool {
	top := eyeZ2(p) + 8
	for _, dx := range []float64{-16, 0, 16} {
		for _, dy := range []float64{-16, 0, 16} {
			for k := 0; k <= 4; k++ {
				if !occ(eye, [3]float64{p.X + dx, p.Y + dy, p.Z + top*float64(k)/4}) {
					return true
				}
			}
		}
	}
	return false
}

func eyeZ2(p encounter.Pos) float64 {
	if p.Duck {
		return 46
	}
	return 64
}

// shooterEye is the shooter's eye (64 standing, 46 crouching above the origin).
func shooterEye(p *sidecar.FramePlayer) [3]float64 {
	z := 64.0
	if p.Duck {
		z = 46
	}
	return [3]float64{p.X, p.Y, p.Z + z}
}

// grazeReport finds, for each unexplained kill, the smallest move of the shooter's
// eye (in units, 26 directions per radius) that makes a corner of the production
// box clear in any frame. A small move means the blocker only grazes the line.
func grazeReport(kills []sweepKill, unexplained []int, occs map[string]encounter.Occluder) {
	var dirs [][3]float64
	for x := -1.0; x <= 1; x++ {
		for y := -1.0; y <= 1; y++ {
			for z := -1.0; z <= 1; z++ {
				if x == 0 && y == 0 && z == 0 {
					continue
				}
				n := math.Sqrt(x*x + y*y + z*z)
				dirs = append(dirs, [3]float64{x / n, y / n, z / n})
			}
		}
	}
	radii := []float64{1, 2, 4, 8, 16, 32}
	bucket := map[float64]int{}
	var lines []string
	for _, i := range unexplained {
		k := kills[i]
		best := math.Inf(1)
		for _, f := range k.frames {
			for _, r := range radii {
				if r >= best {
					break
				}
				found := false
				for _, d := range dirs {
					o := [3]float64{f.eye[0] + r*d[0], f.eye[1] + r*d[1], f.eye[2] + r*d[2]}
					if encounter.AnyClearBox(o, f.enemy, encounter.DefaultBox, occs[k.mp]) {
						found = true
						break
					}
				}
				if found {
					best = r
					break
				}
			}
		}
		for _, r := range radii {
			if best <= r {
				bucket[r]++
				break
			}
		}
		if math.IsInf(best, 1) {
			bucket[math.Inf(1)]++
		}
		lines = append(lines, fmt.Sprintf("GRAZE %s: min eye move %.0f units", k.label, best))
	}
	for _, l := range lines {
		fmt.Println(l)
	}
	fmt.Printf("GRAZE minimum eye move to clear a corner (unexplained kills): <=1: %d, <=2: %d, <=4: %d, <=8: %d, <=16: %d, <=32: %d, none within 32: %d\n",
		bucket[1], bucket[2], bucket[4], bucket[8], bucket[16], bucket[32], bucket[math.Inf(1)])
}
