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
	"strings"
	"sync"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/encounter"
	"github.com/ChristianWSmith/spectra/internal/sidecar"
)

// sweepFrame is one frame in a kill's window: the shooter's eye at production
// height, and the enemy's sampled position.
type sweepFrame struct {
	tick  int
	eye   [3]float64
	enemy encounter.Pos
}

// sweepKill is a kill with frames in its window (the ground truth: the server
// recorded it, so the shooter had a line to the victim at some point).
type sweepKill struct {
	mp     string
	label  string
	frames []sweepFrame
}

type sweepData struct {
	noFrames int // kills dropped because no sidecar frame in their window
	kills    []sweepKill
	control  []sweepKill // random opposing pairs; not known blocked or clear
	occs     map[string]encounter.Occluder
}

// loadSweep reads every kill (excluding wallbang, smoke, HE and molotov, which
// need no line of sight) with the frames in [tick-64, tick+4], and a sample of
// random opposing pairs 5 to 32 m apart as a permissiveness reference.
func loadSweep(t *testing.T, root, data string) sweepData {
	db, err := sql.Open("sqlite", filepath.Join(root, "spectra.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	type mi struct {
		id int64
		mp string
	}
	mrows, _ := db.Query(`SELECT id, map FROM matches ORDER BY id`)
	var ms []mi
	for mrows.Next() {
		var m mi
		_ = mrows.Scan(&m.id, &m.mp)
		ms = append(ms, m)
	}
	mrows.Close()

	d := sweepData{occs: map[string]encounter.Occluder{}}
	rng := rand.New(rand.NewSource(11))
	for _, m := range ms {
		if _, ok := d.occs[m.mp]; !ok {
			occ, err := occFromCache(data, m.mp)
			if err != nil {
				t.Fatal(err)
			}
			d.occs[m.mp] = occ
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
					tick:  f.Tick,
					eye:   eyeOf(fa, 64, 46),
					enemy: encounter.Pos{X: fv.X, Y: fv.Y, Z: fv.Z, Duck: fv.Duck, Side: fv.Side, Yaw: fv.Yaw},
				})
			}
			if len(k.frames) > 0 {
				d.kills = append(d.kills, k)
			} else {
				d.noFrames++
			}
		}
		krows.Close()
		var opp []sweepFrame
		for _, f := range st.Frames {
			for _, a := range f.Players {
				for _, b := range f.Players {
					if a.SteamID == b.SteamID || a.Side == "" || b.Side == "" || a.Side == b.Side {
						continue
					}
					dd := (a.X-b.X)*(a.X-b.X) + (a.Y-b.Y)*(a.Y-b.Y)
					if dd < 200*200 || dd > 1250*1250 {
						continue
					}
					opp = append(opp, sweepFrame{eye: eyeOf(&a, 64, 46),
						enemy: encounter.Pos{X: b.X, Y: b.Y, Z: b.Z, Duck: b.Duck, Side: b.Side, Yaw: b.Yaw}})
				}
			}
		}
		for i := 0; i < 400 && len(opp) > 0; i++ {
			p := opp[rng.Intn(len(opp))]
			d.control = append(d.control, sweepKill{mp: m.mp, frames: []sweepFrame{p}})
		}
	}
	return d
}

// eyeOf is the eye of a player: origin plus the standing or crouching height.
func eyeOf(p *sidecar.FramePlayer, stand, crouch float64) [3]float64 {
	z := stand
	if p.Duck {
		z = crouch
	}
	return [3]float64{p.X, p.Y, p.Z + z}
}

// setting is one point in the search: a box and a shift of the shooter's eye.
type setting struct {
	box      encounter.Box
	eyeShift float64
}

// clearKill reports whether any frame of k is clear under s.
func clearKill(k sweepKill, s setting, occ encounter.Occluder) bool {
	for _, f := range k.frames {
		eye := [3]float64{f.eye[0], f.eye[1], f.eye[2] + s.eyeShift}
		if encounter.AnyClearBox(eye, f.enemy, s.box, occ) {
			return true
		}
	}
	return false
}

// settingGrid is the full search space. A random sample is taken instead when
// SPECTRA_WIDE_N is set. The production setting is always included.
func settingGrid() []setting {
	var all []setting
	for _, hw := range []float64{0, 8, 12, 16, 20, 24, 28, 32, 36} {
		for _, shift := range []float64{-8, 0, 8, 16} {
			for _, frac := range []float64{0.25, 0.5, 0.75} {
				for _, lat := range []float64{-8, -4, 0, 4, 8} {
					for _, fwd := range []float64{-8, -4, 0, 4, 8} {
						for _, grid := range []bool{false, true} {
							for _, eyeShift := range []float64{-8, -4, 0, 4, 8} {
								all = append(all, setting{encounter.Box{
									HalfWidth: hw, TopStand: 72 + shift, TopCrouch: 54 + shift,
									Frac: frac, Lat: lat, Fwd: fwd, Grid: grid,
								}, eyeShift})
							}
						}
					}
				}
			}
		}
	}
	if n, err := strconv.Atoi(os.Getenv("SPECTRA_WIDE_N")); err == nil && n > 0 && n < len(all) {
		rng := rand.New(rand.NewSource(5))
		rng.Shuffle(len(all), func(i, j int) { all[i], all[j] = all[j], all[i] })
		all = all[:n]
	}
	prod := setting{encounter.ProductionBox, 0}
	for _, s := range all {
		if s == prod {
			return all
		}
	}
	return append(all, prod)
}

// TestWideSweep searches the full parameter space for the setting that clears the
// most kills. Every kill is a true line of sight (the server recorded it), so
// recall on kills is the objective. Random opposing pairs are reported only as a
// permissiveness reference: they are not known to be blocked.
// Writes sweep_wide.csv and sweep_wide.md to SPECTRA_OVERLAY_OUT. Opt-in:
//
//	SPECTRA_ENC, SPECTRA_DATA, SPECTRA_OVERLAY_OUT, optional SPECTRA_WIDE_N
func TestWideSweep(t *testing.T) {
	root, data, out := os.Getenv("SPECTRA_ENC"), os.Getenv("SPECTRA_DATA"), os.Getenv("SPECTRA_OVERLAY_OUT")
	if root == "" || data == "" || out == "" {
		t.Skip("set SPECTRA_ENC, SPECTRA_DATA, SPECTRA_OVERLAY_OUT")
	}
	d := loadSweep(t, root, data)
	settings := settingGrid()
	fmt.Printf("WIDE kills %d, control pairs %d, settings %d\n", len(d.kills), len(d.control), len(settings))

	type res struct {
		clear   []bool
		recall  int
		control int
	}
	results := make([]res, len(settings))
	var wg sync.WaitGroup
	idx := make(chan int)
	for w := 0; w < runtime.NumCPU(); w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for si := range idx {
				s := settings[si]
				r := res{clear: make([]bool, len(d.kills))}
				for i, k := range d.kills {
					if clearKill(k, s, d.occs[k.mp]) {
						r.clear[i] = true
						r.recall++
					}
				}
				for _, c := range d.control {
					if clearKill(c, s, d.occs[c.mp]) {
						r.control++
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

	prodIdx := len(settings) - 1
	best := 0
	for i := range results {
		if results[i].recall > results[best].recall {
			best = i
		}
	}
	// Kills no setting clears.
	never := make([]bool, len(d.kills))
	for i := range never {
		never[i] = true
		for _, r := range results {
			if r.clear[i] {
				never[i] = false
				break
			}
		}
	}
	nNever := 0
	for _, n := range never {
		if n {
			nNever++
		}
	}
	nBest := 0
	for _, r := range results {
		if r.recall == results[best].recall {
			nBest++
		}
	}

	if err := os.MkdirAll(out, 0o755); err != nil {
		t.Fatal(err)
	}
	var csv strings.Builder
	csv.WriteString("sampler,half_width,top_stand,top_crouch,frac,lat,fwd,eye_shift,kills_clear,kills_total,control_clear,control_total\n")
	order := make([]int, len(settings))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool {
		ra, rb := results[order[a]], results[order[b]]
		if ra.recall != rb.recall {
			return ra.recall > rb.recall
		}
		return ra.control < rb.control
	})
	for _, i := range order {
		s, r := settings[i], results[i]
		sampler := "corners"
		if s.box.Grid {
			sampler = "grid"
		}
		fmt.Fprintf(&csv, "%s,%.0f,%.0f,%.0f,%.2f,%+.0f,%+.0f,%+.0f,%d,%d,%d,%d\n", sampler, s.box.HalfWidth,
			s.box.TopStand, s.box.TopCrouch, s.box.Frac, s.box.Lat, s.box.Fwd, s.eyeShift,
			r.recall, len(d.kills), r.control, len(d.control))
	}
	if err := os.WriteFile(filepath.Join(out, "sweep_wide.csv"), []byte(csv.String()), 0o644); err != nil {
		t.Fatal(err)
	}

	var md strings.Builder
	fmt.Fprintf(&md, "# Wide sweep\n\nKills (ground truth, the server recorded each): %d. Settings searched: %d.\n\n", len(d.kills), len(settings))
	fmt.Fprintf(&md, "Production box (%s): clears %d of %d.\n\n", "16 half-width, top 72/54, mid 0.5, corners, eye 64/46", results[prodIdx].recall, len(d.kills))
	fmt.Fprintf(&md, "Best: %d of %d (%d settings tie). Kills that no setting clears: %d.\n\n", results[best].recall, len(d.kills), nBest, nNever)
	md.WriteString("Top 25 settings (sorted by kills clear, then random-pair clears):\n\n")
	md.WriteString("| sampler | half-width | top stand/crouch | mid frac | lateral | forward | eye shift | kills clear | random-pair clears |\n|---|---|---|---|---|---|---|---|---|\n")
	for n, i := range order {
		if n >= 25 {
			break
		}
		s, r := settings[i], results[i]
		sampler := "corners"
		if s.box.Grid {
			sampler = "grid"
		}
		fmt.Fprintf(&md, "| %s | %.0f | %.0f/%.0f | %.2f | %+.0f | %+.0f | %+.0f | %d | %d of %d |\n", sampler, s.box.HalfWidth,
			s.box.TopStand, s.box.TopCrouch, s.box.Frac, s.box.Lat, s.box.Fwd, s.eyeShift, r.recall, r.control, len(d.control))
	}
	md.WriteString("\nKills no setting clears:\n\n")
	for i, n := range never {
		if n {
			fmt.Fprintf(&md, "- %s\n", d.kills[i].label)
		}
	}
	if err := os.WriteFile(filepath.Join(out, "sweep_wide.md"), []byte(md.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	fmt.Printf("WIDE production clears %d of %d; best %d (%d ties); never clear under any setting: %d\n",
		results[prodIdx].recall, len(d.kills), results[best].recall, nBest, nNever)
	fmt.Println("WIDE written:", filepath.Join(out, "sweep_wide.md"))
}

// TestGrazeNeverClear finds, for each kill no setting clears, the smallest move of
// the shooter's eye (26 directions per radius) that clears a corner of the
// production box. Opt-in with the same environment as TestWideSweep.
func TestGrazeNeverClear(t *testing.T) {
	root, data := os.Getenv("SPECTRA_ENC"), os.Getenv("SPECTRA_DATA")
	if root == "" || data == "" {
		t.Skip("set SPECTRA_ENC, SPECTRA_DATA")
	}
	d := loadSweep(t, root, data)
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
	for _, k := range d.kills {
		best := math.Inf(1)
		for _, f := range k.frames {
			for _, r := range radii {
				if r >= best {
					break
				}
				found := false
				for _, dd := range dirs {
					o := [3]float64{f.eye[0] + r*dd[0], f.eye[1] + r*dd[1], f.eye[2] + r*dd[2]}
					if encounter.AnyClearBox(o, f.enemy, encounter.ProductionBox, d.occs[k.mp]) {
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
		fmt.Printf("GRAZE %s: min eye move %.0f units (Inf = none within 32)\n", k.label, best)
	}
}
