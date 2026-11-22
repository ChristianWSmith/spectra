package encounter_test

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/ChristianWSmith/spectra/internal/encounter"
	"github.com/ChristianWSmith/spectra/internal/mappack"
	"github.com/ChristianWSmith/spectra/internal/sidecar"
	"github.com/ChristianWSmith/spectra/internal/source2"
)

// TestEncounterSpike runs the shot-seeded encounter builder on a scratch
// library (SPECTRA_ENC=<dir containing spectra.db and matches/>). It reports
// seeds, skips and the share of tick rows the windows cover. Opt-in.
func TestEncounterSpike(t *testing.T) {
	root := os.Getenv("SPECTRA_ENC")
	if root == "" {
		t.Skip("set SPECTRA_ENC to a library data dir")
	}
	cs2 := mappack.FindCS2("")
	db, err := sql.Open("sqlite", filepath.Join(root, "spectra.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mrows, err := db.Query(`SELECT id, map FROM matches ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	type matchInfo struct {
		id int64
		mp string
	}
	var matches []matchInfo
	for mrows.Next() {
		var m matchInfo
		if err := mrows.Scan(&m.id, &m.mp); err != nil {
			t.Fatal(err)
		}
		matches = append(matches, m)
	}
	mrows.Close()
	out := t.TempDir()
	var totalRows, coveredRows, totalSeeds, totalShots, totalEnc int
	for _, m := range matches {
		occ, err := occluderFor(cs2, m.mp, out)
		if err != nil {
			t.Logf("MATCH %d (%s): %v", m.id, m.mp, err)
			continue
		}
		stream, err := sidecar.Load(filepath.Join(root, "matches", strconv.FormatInt(m.id, 10)), 0, 0)
		if err != nil {
			t.Logf("MATCH %d: sidecar: %v", m.id, err)
			continue
		}
		frames := make([]encounter.Frame, 0, len(stream.Frames))
		for _, f := range stream.Frames {
			ef := encounter.Frame{Tick: f.Tick, Players: make(map[uint64]encounter.Pos, len(f.Players))}
			for _, p := range f.Players {
				ef.Players[p.SteamID] = encounter.Pos{X: p.X, Y: p.Y, Z: p.Z, Duck: p.Duck, Side: p.Side}
			}
			frames = append(frames, ef)
		}
		sort.Slice(frames, func(i, j int) bool { return frames[i].Tick < frames[j].Tick })

		rounds := map[int]encounter.Range{}
		rr, err := db.Query(`SELECT number, start_tick, end_tick FROM rounds WHERE match_id = ?`, m.id)
		if err != nil {
			t.Fatal(err)
		}
		for rr.Next() {
			var n, s, e int
			if err := rr.Scan(&n, &s, &e); err != nil {
				t.Fatal(err)
			}
			rounds[n] = encounter.Range{Start: s, End: e}
		}
		rr.Close()

		var shots []encounter.Shot
		sr, err := db.Query(`SELECT round, tick, attacker FROM events WHERE match_id = ? AND kind = 'weapon_fire' AND round > 0 AND attacker <> ''`, m.id)
		if err != nil {
			t.Fatal(err)
		}
		for sr.Next() {
			var r, tk int
			var a string
			if err := sr.Scan(&r, &tk, &a); err != nil {
				t.Fatal(err)
			}
			id, err := strconv.ParseUint(a, 10, 64)
			if err != nil {
				continue
			}
			shots = append(shots, encounter.Shot{Round: r, Tick: tk, Shooter: id})
		}
		sr.Close()

		// Diagnostic: shots with any living enemy present in the frame (no LOS test).
		withEnemy := 0
		for _, sh := range shots {
			i := -1
			for k := range frames {
				if frames[k].Tick >= sh.Tick {
					i = k
					break
				}
			}
			if i < 0 {
				continue
			}
			sp, ok := frames[i].Players[sh.Shooter]
			if !ok {
				continue
			}
			for id, p := range frames[i].Players {
				if id != sh.Shooter && p.Side != "" && p.Side != sp.Side {
					withEnemy++
					break
				}
			}
		}
		fmt.Printf("DIAG %d: shots %d, shots with a living enemy in frame %d\n", m.id, len(shots), withEnemy)
		encs, st := encounter.Build(frames, shots, rounds, occ, 0)
		totalShots += st.Shots
		totalSeeds += st.Seeds
		totalEnc += len(encs)

		// Coverage: per (player, round), merge the windows the player is in
		// (as shooter or enemy), then count that player's tick rows inside.
		type key struct {
			p uint64
			r int
		}
		ivs := map[key][][2]int{}
		for _, e := range encs {
			ivs[key{e.Shooter, e.Round}] = append(ivs[key{e.Shooter, e.Round}], [2]int{e.Start, e.End})
			ivs[key{e.Enemy, e.Round}] = append(ivs[key{e.Enemy, e.Round}], [2]int{e.Start, e.End})
		}
		var matchCovered int
		for k, list := range ivs {
			sort.Slice(list, func(i, j int) bool { return list[i][0] < list[j][0] })
			var merged [][2]int
			for _, iv := range list {
				if n := len(merged); n > 0 && iv[0] <= merged[n-1][1] {
					if iv[1] > merged[n-1][1] {
						merged[n-1][1] = iv[1]
					}
				} else {
					merged = append(merged, iv)
				}
			}
			for _, iv := range merged {
				var c int
				err := db.QueryRow(`SELECT COUNT(*) FROM player_ticks WHERE match_id = ? AND steam_id = ? AND round = ? AND tick BETWEEN ? AND ?`,
					m.id, strconv.FormatUint(k.p, 10), k.r, iv[0], iv[1]).Scan(&c)
				if err != nil {
					t.Fatal(err)
				}
				matchCovered += c
			}
		}
		var matchRows int
		if err := db.QueryRow(`SELECT COUNT(*) FROM player_ticks WHERE match_id = ?`, m.id).Scan(&matchRows); err != nil {
			t.Fatal(err)
		}
		totalRows += matchRows
		coveredRows += matchCovered
		fmt.Printf("MATCH %d (%s): shots %d, seeds %d, skipped covered %d, no line of sight %d, encounters %d, covered rows %.1f%%\n",
			m.id, m.mp, st.Shots, st.Seeds, st.SkippedCovered, st.NoLineOfSight, len(encs), 100*float64(matchCovered)/float64(max(matchRows, 1)))
	}
	fmt.Printf("ENCOUNTERS total: shots %d, seeds %d, encounters %d, covered tick rows %.1f%% (%d of %d)\n",
		totalShots, totalSeeds, totalEnc, 100*float64(coveredRows)/float64(max(totalRows, 1)), coveredRows, totalRows)
}

// occluderFor builds a segment-blocked query over the map's world collision.
func occluderFor(cs2, mapName, tmp string) (encounter.Occluder, error) {
	path, _, err := mappack.ExtractWorldCollision(cs2, mapName, tmp)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	meshes, err := source2.ReadMeshes(f)
	if err != nil {
		return nil, err
	}
	world := func(a, b [3]float64) bool {
		seg := source2.Segment{
			A: source2.Vec3{float32(a[0]), float32(a[1]), float32(a[2])},
			B: source2.Vec3{float32(b[0]), float32(b[1]), float32(b[2])},
		}
		for i := range meshes {
			if meshes[i].Blocked(seg) {
				return true
			}
		}
		return false
	}
	return world, nil
}
