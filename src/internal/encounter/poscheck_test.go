package encounter_test

import (
	"database/sql"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/sidecar"
)

// TestPositionAgreement compares the recorded victim position on damage events
// with the sidecar's sampled position for the same player at the same tick.
// Opt-in: SPECTRA_ENC.
func TestPositionAgreement(t *testing.T) {
	root := os.Getenv("SPECTRA_ENC")
	if root == "" {
		t.Skip("set SPECTRA_ENC")
	}
	db, err := sql.Open("sqlite", filepath.Join(root, "spectra.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mrows, _ := db.Query(`SELECT id FROM matches ORDER BY id`)
	var ids []int64
	for mrows.Next() {
		var id int64
		_ = mrows.Scan(&id)
		ids = append(ids, id)
	}
	mrows.Close()
	var dx, dy, dz []float64
	var dduck, dstand []float64
	for _, mid := range ids {
		st, err := sidecar.Load(filepath.Join(root, "matches", strconv.FormatInt(mid, 10)), 0, 0)
		if err != nil {
			t.Fatal(err)
		}
		byTick := map[int]map[uint64]sidecar.FramePlayer{}
		for _, f := range st.Frames {
			m := map[uint64]sidecar.FramePlayer{}
			for _, p := range f.Players {
				m[p.SteamID] = p
			}
			byTick[f.Tick] = m
		}
		rows, _ := db.Query(`SELECT tick, victim, pos_x, pos_y, pos_z FROM events
			WHERE match_id=? AND kind='damage' AND victim<>'' AND pos_x IS NOT NULL`, mid)
		for rows.Next() {
			var tk int
			var v string
			var x, y, z float64
			_ = rows.Scan(&tk, &v, &x, &y, &z)
			vid, _ := strconv.ParseUint(v, 10, 64)
			m, ok := byTick[tk]
			if !ok {
				continue
			}
			p, ok := m[vid]
			if !ok {
				continue
			}
			dx = append(dx, x-p.X)
			dy = append(dy, y-p.Y)
			dz = append(dz, z-p.Z)
			if p.Duck {
				dduck = append(dduck, z-p.Z)
			} else {
				dstand = append(dstand, z-p.Z)
			}
		}
		rows.Close()
	}
	stat := func(name string, v []float64) {
		if len(v) == 0 {
			fmt.Printf("POS %s: none\n", name)
			return
		}
		sort.Float64s(v)
		var s, sq float64
		for _, x := range v {
			s += x
			sq += x * x
		}
		n := float64(len(v))
		mean := s / n
		fmt.Printf("POS %s: n=%d mean %.2f sd %.2f median %.2f p5 %.2f p95 %.2f\n", name, len(v), mean, math.Sqrt(sq/n-mean*mean), v[len(v)/2], v[len(v)/20], v[len(v)*19/20])
	}
	stat("x diff (event - sidecar)", dx)
	stat("y diff", dy)
	stat("z diff", dz)
	stat("z diff, victim standing", dstand)
	stat("z diff, victim crouching", dduck)
}
