package encounter_test

import (
	"database/sql"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/mappack"
	"github.com/ChristianWSmith/spectra/internal/sidecar"
)

// TestDoorProximity: are the unexplained blocked kills' sight lines close to door
// (or other interactable) entities? Opt-in: SPECTRA_ENC.
func TestDoorProximity(t *testing.T) {
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
	classCount := map[string]int{}
	var unexplainedN, unexplainedNear, clearN, clearNear int
	for _, m := range ms {
		occ, err := occluderFor(cs2, m.mp, tmp)
		if err != nil {
			t.Fatal(err)
		}
		ents, err := mappack.EntityOrigins(cs2, m.mp)
		if err != nil {
			t.Fatal(err)
		}
		var doors [][3]float64
		for _, e := range ents {
			classCount[e.Class]++
			if strings.Contains(e.Class, "door") || strings.Contains(e.Class, "breakable") {
				doors = append(doors, e.Origin)
			}
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
			var pa, pv *sidecar.FramePlayer
			for _, f := range st.Frames {
				if f.Tick < tk-64 || f.Tick >= tk {
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
					pa, pv = fa, fv
				}
			}
			if pa == nil {
				continue
			}
			ea := [3]float64{pa.X, pa.Y, pa.Z + 64}
			ev := [3]float64{pv.X, pv.Y, pv.Z + 64}
			near := nearestToSegment(doors, ea, ev) < 150
			if occ(ea, ev) && !denseClearFrame(pa, pv, occ) {
				unexplainedN++
				if near {
					unexplainedNear++
				}
			} else {
				clearN++
				if near {
					clearNear++
				}
			}
		}
		krows.Close()
	}
	fmt.Printf("DOORS: unexplained blocks %d, within 150 units of a door-like entity: %d; clear kills %d, within 150: %d\n",
		unexplainedN, unexplainedNear, clearN, clearNear)
	for c, n := range classCount {
		if strings.Contains(c, "door") || strings.Contains(c, "breakable") || strings.Contains(c, "button") {
			fmt.Printf("CLASS %s %d\n", c, n)
		}
	}
}

// nearestToSegment is the distance from the closest point to segment a-b.
func nearestToSegment(pts [][3]float64, a, b [3]float64) float64 {
	best := math.Inf(1)
	ab := [3]float64{b[0] - a[0], b[1] - a[1], b[2] - a[2]}
	l2 := ab[0]*ab[0] + ab[1]*ab[1] + ab[2]*ab[2]
	for _, p := range pts {
		ap := [3]float64{p[0] - a[0], p[1] - a[1], p[2] - a[2]}
		t := 0.0
		if l2 > 0 {
			t = (ap[0]*ab[0] + ap[1]*ab[1] + ap[2]*ab[2]) / l2
		}
		t = math.Max(0, math.Min(1, t))
		c := [3]float64{a[0] + ab[0]*t, a[1] + ab[1]*t, a[2] + ab[2]*t}
		d := math.Sqrt((p[0]-c[0])*(p[0]-c[0]) + (p[1]-c[1])*(p[1]-c[1]) + (p[2]-c[2])*(p[2]-c[2]))
		best = math.Min(best, d)
	}
	return best
}
