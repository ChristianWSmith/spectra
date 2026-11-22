package encounter_test

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/encounter"
	"github.com/ChristianWSmith/spectra/internal/mappack"
	"github.com/ChristianWSmith/spectra/internal/sidecar"
)

// TestKillLineOfSight validates the occluder and eye heights: a kill is a fight,
// so the killer should have a clear line to the victim just before the kill.
// Opt-in: SPECTRA_ENC.
func TestKillLineOfSight(t *testing.T) {
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
	offsets := []float64{0, 32, 46, 64, 72}
	offsetClear := make([]int, len(offsets))
	offsetTotal := 0
	var kills, withBoth, clear, blockedKills, wallbangBlocked int
	for _, m := range ms {
		occ, err := occluderFor(cs2, m.mp, tmp)
		if err != nil {
			t.Fatal(err)
		}
		st, err := sidecar.Load(filepath.Join(root, "matches", strconv.FormatInt(m.id, 10)), 0, 0)
		if err != nil {
			t.Fatal(err)
		}
		krows, _ := db.Query(`SELECT tick, attacker, victim, wallbang FROM events WHERE match_id=? AND kind='kill' AND attacker<>'' AND victim<>'' AND attacker<>victim AND round>0`, m.id)
		for krows.Next() {
			var tk, wb int
			var a, v string
			_ = krows.Scan(&tk, &a, &v, &wb)
			kills++
			ai, _ := strconv.ParseUint(a, 10, 64)
			vi, _ := strconv.ParseUint(v, 10, 64)
			// Latest frame in the 16 ticks before the kill where both are present.
			found := false
			var lastOK bool
			var lastClear bool
			for _, f := range st.Frames {
				if f.Tick < tk-16 || f.Tick >= tk {
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
				found = true
				eyeA := [3]float64{pa.X, pa.Y, pa.Z + 64}
				eyeV := [3]float64{pv.X, pv.Y, pv.Z + 64}
				if pa.Duck {
					eyeA[2] = pa.Z + 46
				}
				if pv.Duck {
					eyeV[2] = pv.Z + 46
				}
				lastOK = true
				lastClear = encounter.AnyClear(eyeA, encounter.Pos{X: pv.X, Y: pv.Y, Z: pv.Z, Duck: pv.Duck, Side: pv.Side}, occ)
				if wb == 0 {
					for oi, off := range offsets {
						ea := [3]float64{pa.X, pa.Y, pa.Z + off}
						ev := [3]float64{pv.X, pv.Y, pv.Z + off}
						if !occ(ea, ev) {
							offsetClear[oi]++
						}
					}
					offsetTotal++
				}
			}
			if found {
				withBoth++
			}
			if lastOK {
				if lastClear {
					clear++
				} else {
					blockedKills++
					if wb == 1 {
						wallbangBlocked++
					}
				}
			}
		}
		krows.Close()
	}
	fmt.Printf("KILLS: %d kills, %d with both players sampled in the 16 ticks before; last sampled frame: clear %d, blocked %d (%.1f%% clear)\n",
		kills, withBoth, clear, blockedKills, 100*float64(clear)/float64(max(clear+blockedKills, 1)))
	fmt.Printf("KILLS blocked by world mesh: %d, of which flagged wallbang: %d; unflagged blocked: %d\n", blockedKills, wallbangBlocked, blockedKills-wallbangBlocked)
	for oi, off := range offsets {
		fmt.Printf("EYE offset %.0f: clear for unflagged last frames %.1f%% (%d)\n", off, 100*float64(offsetClear[oi])/float64(max(offsetTotal, 1)), offsetTotal)
	}
	_ = encounter.Pos{}
}
