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
	var kills, withBoth, clear, blockedKills, wallbangBlocked, bulletUnflagged, unflaggedClearEarlier, unflaggedClose, unflaggedFar, denseClear, denseStillBlocked int
	blockedByWeapon := map[string]int{}
	for _, m := range ms {
		occ, err := occluderFor(cs2, m.mp, tmp)
		if err != nil {
			t.Fatal(err)
		}
		st, err := sidecar.Load(filepath.Join(root, "matches", strconv.FormatInt(m.id, 10)), 0, 0)
		if err != nil {
			t.Fatal(err)
		}
		krows, _ := db.Query(`SELECT tick, attacker, victim, wallbang, weapon FROM events WHERE match_id=? AND kind='kill' AND attacker<>'' AND victim<>'' AND attacker<>victim AND round>0`, m.id)
		for krows.Next() {
			var tk, wb int
			var a, v, wp string
			_ = krows.Scan(&tk, &a, &v, &wb, &wp)
			kills++
			ai, _ := strconv.ParseUint(a, 10, 64)
			vi, _ := strconv.ParseUint(v, 10, 64)
			// Latest frame in the 16 ticks before the kill where both are present.
			found := false
			var lastOK bool
			var lastClear bool
			anyClearInWindow := false
			var lastDist float64
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
				if encounter.AnyClear(eyeA, encounter.Pos{X: pv.X, Y: pv.Y, Z: pv.Z, Duck: pv.Duck, Side: pv.Side}, occ) {
					anyClearInWindow = true
				}
				lastDist = math.Sqrt((pa.X-pv.X)*(pa.X-pv.X) + (pa.Y-pv.Y)*(pa.Y-pv.Y) + (pa.Z-pv.Z)*(pa.Z-pv.Z))
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
					blockedByWeapon[wp]++
					if wb == 0 && wp != "HE Grenade" && wp != "Molotov" {
						if denseClearInWindow(frames(st, tk), ai, vi, occ) {
							denseClear++
						} else {
							denseStillBlocked++
						}
						bulletUnflagged++
						if anyClearInWindow {
							unflaggedClearEarlier++
						}
						if lastDist < 600 {
							unflaggedClose++
						}
						if lastDist >= 600 {
							unflaggedFar++
						}
					}
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
	fmt.Printf("UNFLAGGED bullet blocks %d: clear in an earlier frame of the window %d; distance under 600 units %d, 600 or more %d\n", bulletUnflagged, unflaggedClearEarlier, unflaggedClose, unflaggedFar)
	fmt.Printf("DENSE grid sample: unflagged bullet blocks cleared %d, still blocked %d\n", denseClear, denseStillBlocked)
	for w, n := range blockedByWeapon {
		fmt.Printf("BLOCKED weapon %q: %d\n", w, n)
	}
	for oi, off := range offsets {
		fmt.Printf("EYE offset %.0f: clear for unflagged last frames %.1f%% (%d)\n", off, 100*float64(offsetClear[oi])/float64(max(offsetTotal, 1)), offsetTotal)
	}
	_ = encounter.Pos{}
}

// frames returns the sidecar frames of a match stream, looked up by tick.
func frames(st sidecar.Stream, tk int) []sidecar.FrameWithPlayers {
	var out []sidecar.FrameWithPlayers
	for _, f := range st.Frames {
		if f.Tick >= tk-16 && f.Tick < tk {
			out = append(out, f)
		}
	}
	return out
}

// denseClearInWindow: is any frame in the window clear to a dense grid of the
// victim's box (3 x 3 x 5 points), from the killer's eye? Diagnostic for
// whether the coarse sample is the limit.
func denseClearInWindow(fs []sidecar.FrameWithPlayers, ai, vi uint64, occ encounter.Occluder) bool {
	for _, f := range fs {
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
		top := 64.0
		if pv.Duck {
			top = 46
		}
		top += 8
		eye := [3]float64{pa.X, pa.Y, pa.Z + 64}
		if pa.Duck {
			eye[2] = pa.Z + 46
		}
		for _, dx := range []float64{-16, 0, 16} {
			for _, dy := range []float64{-16, 0, 16} {
				for k := 0; k <= 4; k++ {
					tgt := [3]float64{pv.X + dx, pv.Y + dy, pv.Z + top*float64(k)/4}
					if !occ(eye, tgt) {
						return true
					}
				}
			}
		}
	}
	return false
}
