package encounter_test

import (
	"database/sql"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/sidecar"
)

// TestEventDistanceUnits compares the kill event's distance field with the
// distance between the two sampled positions just before the kill, to find the unit.
func TestEventDistanceUnits(t *testing.T) {
	root := os.Getenv("SPECTRA_ENC")
	if root == "" {
		t.Skip()
	}
	db, _ := sql.Open("sqlite", filepath.Join(root, "spectra.db"))
	defer db.Close()
	rows, _ := db.Query(`SELECT match_id, tick, attacker, victim, distance FROM events WHERE kind='kill' AND attacker<>'' AND victim<>'' AND attacker<>victim AND round>0 AND match_id=1 LIMIT 60`)
	st, _ := sidecar.Load(filepath.Join(root, "matches", "1"), 0, 0)
	var ratios []float64
	for rows.Next() {
		var mid int64
		var tk int
		var a, v string
		var d float64
		_ = rows.Scan(&mid, &tk, &a, &v, &d)
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
		pd := math.Sqrt((pa.X-pv.X)*(pa.X-pv.X) + (pa.Y-pv.Y)*(pa.Y-pv.Y) + (pa.Z-pv.Z)*(pa.Z-pv.Z))
		if d > 0 {
			ratios = append(ratios, pd/d)
		}
		if len(ratios) <= 8 {
			fmt.Printf("UNITS event %.2f  position distance %.1f  ratio %.2f\n", d, pd, pd/d)
		}
	}
	var sum float64
	for _, r := range ratios {
		sum += r
	}
	if len(ratios) > 0 {
		fmt.Printf("UNITS median-ish mean ratio %.2f over %d kills\n", sum/float64(len(ratios)), len(ratios))
	}
}
