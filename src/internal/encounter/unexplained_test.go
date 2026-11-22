package encounter_test

import (
	"database/sql"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/encounter"
	"github.com/ChristianWSmith/spectra/internal/mappack"
	"github.com/ChristianWSmith/spectra/internal/sidecar"
)

// TestUnexplainedKills recounts the blocked bullet kills that no flag explains
// (no wallbang, no smoke, not grenade or fire), and tests them against a wider
// time window (64 ticks before to 4 after) and a dense target grid. Opt-in.
func TestUnexplainedKills(t *testing.T) {
	root := os.Getenv("SPECTRA_ENC")
	if root == "" {
		t.Skip("set SPECTRA_ENC")
	}
	cs2 := mappack.FindCS2("")
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
	tmp := t.TempDir()
	var total, smokeFlag, clearWide, stillBlocked, blockAtShooter, blockAtVictim, blockMiddle int
	var unexplained []string
	for _, m := range ms {
		occ, err := occluderFor(cs2, m.mp, tmp)
		if err != nil {
			t.Fatal(err)
		}
		st, err := sidecar.Load(filepath.Join(root, "matches", strconv.FormatInt(m.id, 10)), 0, 0)
		if err != nil {
			t.Fatal(err)
		}
		krows, _ := db.Query(`SELECT tick, attacker, victim, wallbang, through_smoke, weapon, round FROM events
			WHERE match_id=? AND kind='kill' AND attacker<>'' AND victim<>'' AND attacker<>victim AND round>0`, m.id)
		for krows.Next() {
			var tk, wb, sm, rd int
			var a, v, wp string
			_ = krows.Scan(&tk, &a, &v, &wb, &sm, &wp, &rd)
			if wb == 1 || wp == "HE Grenade" || wp == "Molotov" {
				continue
			}
			ai, _ := strconv.ParseUint(a, 10, 64)
			vi, _ := strconv.ParseUint(v, 10, 64)
			// Any frame in [tk-64, tk+4] with both present, clear to the dense grid?
			anyFrame := false
			clear := false
			for _, f := range st.Frames {
				if f.Tick < tk-64 || f.Tick > tk+4 {
					continue
				}
				var pa, pv *sidecar.FramePlayer
				for i := range f.Players {
					if f.Players[i].SteamID == ai {
						pa = &f.Players[i]
					}
					if f.Players[i].SteamID == vi {
						pv = &f.Players[i]
					}
				}
				if pa == nil || pv == nil {
					continue
				}
				anyFrame = true
				if denseClearFrame(pa, pv, occ) {
					clear = true
					break
				}
			}
			if !anyFrame {
				continue // no frames: cannot judge, not counted
			}
			// Only count kills blocked at every frame that had both present.
			total++
			if sm == 1 {
				smokeFlag++
			}
			if clear {
				clearWide++
				continue
			}
			stillBlocked++
			if sm == 0 {
				// Where is the block? Test the first and last 80 units of the sight line
				// at the latest frame with both present.
				var lastA, lastV *sidecar.FramePlayer
				for _, f := range st.Frames {
					if f.Tick < tk-64 || f.Tick >= tk {
						continue
					}
					var pa, pv *sidecar.FramePlayer
					for i := range f.Players {
						if f.Players[i].SteamID == ai {
							pa = &f.Players[i]
						}
						if f.Players[i].SteamID == vi {
							pv = &f.Players[i]
						}
					}
					if pa != nil && pv != nil {
						lastA, lastV = pa, pv
					}
				}
				if lastA != nil {
					ea := [3]float64{lastA.X, lastA.Y, lastA.Z + 64}
					ev := [3]float64{lastV.X, lastV.Y, lastV.Z + 64}
					dx, dy, dz := ev[0]-ea[0], ev[1]-ea[1], ev[2]-ea[2]
					n := math.Sqrt(dx*dx + dy*dy + dz*dz)
					if n > 200 {
						near := [3]float64{ea[0] + dx/n*80, ea[1] + dy/n*80, ea[2] + dz/n*80}
						far := [3]float64{ev[0] - dx/n*80, ev[1] - dy/n*80, ev[2] - dz/n*80}
						if occ(ea, near) {
							blockAtShooter++
						}
						if occ(far, ev) {
							blockAtVictim++
						}
						if !occ(ea, near) && !occ(far, ev) {
							blockMiddle++
						}
					}
				}
				unexplained = append(unexplained, fmt.Sprintf("%s match %d round %d tick %d %s->%s %s", m.mp, m.id, rd, tk, a, v, wp))
			}
		}
		krows.Close()
	}
	fmt.Printf("UNEXPLAINED candidates (bullet, unflagged wallbang): %d kills with frames; through smoke %d; cleared in window [-64,+4] dense %d; still blocked %d\n",
		total, smokeFlag, clearWide, stillBlocked)
	fmt.Printf("BLOCK location (unflagged, no smoke): first 80 units from shooter %d, last 80 units at victim %d, middle only %d\n", blockAtShooter, blockAtVictim, blockMiddle)
	for _, u := range unexplained {
		fmt.Println("UNEXPLAINED", u)
	}
	_ = encounter.Pos{}
}

// denseClearFrame: is the enemy's dense grid (3 x 3 x 5) reachable from the
// shooter's eye at this frame?
func denseClearFrame(pa, pv *sidecar.FramePlayer, occ encounter.Occluder) bool {
	eye := [3]float64{pa.X, pa.Y, pa.Z + 64}
	if pa.Duck {
		eye[2] = pa.Z + 46
	}
	top := 64.0
	if pv.Duck {
		top = 46
	}
	top += 8
	for _, dx := range []float64{-16, 0, 16} {
		for _, dy := range []float64{-16, 0, 16} {
			for k := 0; k <= 4; k++ {
				if !occ(eye, [3]float64{pv.X + dx, pv.Y + dy, pv.Z + top*float64(k)/4}) {
					return true
				}
			}
		}
	}
	return false
}
