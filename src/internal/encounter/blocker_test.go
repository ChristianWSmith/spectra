package encounter_test

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/encounter"
	"github.com/ChristianWSmith/spectra/internal/mappack"
	"github.com/ChristianWSmith/spectra/internal/sidecar"
	"github.com/ChristianWSmith/spectra/internal/source2"
)

// TestBlockerMeshes: for the unflagged bullet kills blocked in every frame of
// the window, which world mesh blocks the sight line (first hit, per map)?
func TestBlockerMeshes(t *testing.T) {
	root := os.Getenv("SPECTRA_ENC")
	if root == "" {
		t.Skip()
	}
	cs2 := mappack.FindCS2("")
	db, _ := sql.Open("sqlite", filepath.Join(root, "spectra.db"))
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
	counts := map[string]map[int]int{}
	for _, m := range ms {
		path, _, err := mappack.ExtractWorldCollision(cs2, m.mp, tmp)
		if err != nil {
			t.Fatal(err)
		}
		f, _ := os.Open(path)
		meshes, err := source2.ReadMeshes(f)
		f.Close()
		if err != nil {
			t.Fatal(err)
		}
		for i, mm := range meshes {
			fmt.Printf("MESHINFO %s mesh %d: %d triangles, bounds %v..%v\n", m.mp, i, len(mm.Triangles), mm.Min, mm.Max)
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
			var fa, fv *sidecar.FramePlayer
			var lastA, lastV *sidecar.FramePlayer
			anyFrame := false
			clearAny := false
			for _, f := range st.Frames {
				if f.Tick < tk-64 || f.Tick >= tk {
					continue
				}
				fa, fv = nil, nil
				for i := range f.Players {
					if f.Players[i].SteamID == ai {
						fa = &f.Players[i]
					}
					if f.Players[i].SteamID == vi {
						fv = &f.Players[i]
					}
				}
				if fa != nil && fv != nil {
					anyFrame = true
					lastA, lastV = fa, fv
					if encounter.AnyClear([3]float64{fa.X, fa.Y, fa.Z + 64}, encounter.Pos{X: fv.X, Y: fv.Y, Z: fv.Z, Duck: fv.Duck}, func(a, b [3]float64) bool {
						return false
					}) {
						clearAny = true
					}
				}
			}
			_ = clearAny
			if !anyFrame || lastA == nil {
				continue
			}
			ea := [3]float64{lastA.X, lastA.Y, lastA.Z + 64}
			ev := [3]float64{lastV.X, lastV.Y, lastV.Z + 64}
			// first blocking mesh on the last-frame sight line, if any
			seg := source2.Segment{A: source2.Vec3{float32(ea[0]), float32(ea[1]), float32(ea[2])}, B: source2.Vec3{float32(ev[0]), float32(ev[1]), float32(ev[2])}}
			hit := -1
			for i := range meshes {
				if meshes[i].Blocked(seg) {
					hit = i
					break
				}
			}
			if hit < 0 {
				continue
			}
			if counts[m.mp] == nil {
				counts[m.mp] = map[int]int{}
			}
			counts[m.mp][hit]++
		}
		krows.Close()
	}
	var keys []string
	for k := range counts {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		var idx []int
		for i := range counts[k] {
			idx = append(idx, i)
		}
		sort.Ints(idx)
		for _, i := range idx {
			fmt.Printf("BLOCKER %s mesh %d: %d kills\n", k, i, counts[k][i])
		}
	}
}
