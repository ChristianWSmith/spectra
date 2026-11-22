package encounter_test

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/encounter"
	"github.com/ChristianWSmith/spectra/internal/sidecar"
	"github.com/ChristianWSmith/spectra/internal/source2"
)

// TestKillOverlayBatch renders every unexplained kill (the criteria of
// TestUnexplainedKills: bullet, no wallbang, no smoke, not grenade or fire; blocked
// in every frame of [-64,+4] ticks under the dense grid) and writes an
// explanations.md beside the images. Dev tool, opt-in: SPECTRA_ENC, SPECTRA_DATA,
// SPECTRA_OVERLAY_OUT.
func TestKillOverlayBatch(t *testing.T) {
	root, data, out := os.Getenv("SPECTRA_ENC"), os.Getenv("SPECTRA_DATA"), os.Getenv("SPECTRA_OVERLAY_OUT")
	if root == "" || data == "" || out == "" {
		t.Skip("set SPECTRA_ENC, SPECTRA_DATA, SPECTRA_OVERLAY_OUT")
	}
	if err := os.MkdirAll(out, 0o755); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", filepath.Join(root, "spectra.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	type kill struct {
		mid  int64
		mp   string
		tk   int
		a, v string
	}
	var kills []kill
	mrows, _ := db.Query(`SELECT id, map FROM matches ORDER BY id`)
	var ms []kill
	for mrows.Next() {
		var k kill
		_ = mrows.Scan(&k.mid, &k.mp)
		ms = append(ms, k)
	}
	mrows.Close()
	for _, m := range ms {
		occ, err := occFromCache(data, m.mp)
		if err != nil {
			t.Fatal(err)
		}
		st, err := sidecar.Load(filepath.Join(root, "matches", strconv.FormatInt(m.mid, 10)), 0, 0)
		if err != nil {
			t.Fatal(err)
		}
		krows, _ := db.Query(`SELECT tick, attacker, victim, wallbang, through_smoke, weapon FROM events
			WHERE match_id=? AND kind='kill' AND attacker<>'' AND victim<>'' AND attacker<>victim AND round>0`, m.mid)
		for krows.Next() {
			var tk, wb, sm int
			var a, v, wp string
			_ = krows.Scan(&tk, &a, &v, &wb, &sm, &wp)
			if wb == 1 || sm == 1 || wp == "HE Grenade" || wp == "Molotov" {
				continue
			}
			ai, _ := strconv.ParseUint(a, 10, 64)
			vi, _ := strconv.ParseUint(v, 10, 64)
			anyFrame, clear := false, false
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
				}
			}
			if anyFrame && !clear {
				kills = append(kills, kill{mid: m.mid, mp: m.mp, tk: tk, a: a, v: v})
			}
		}
		krows.Close()
	}
	var md strings.Builder
	md.WriteString("# Unexplained kills: overlays and explanations\n\n")
	md.WriteString("Each entry: six orthographic views centred on the two players (east, west, north, south = the four sides; above, below). Green = clear ray, red = blocked, red triangles = the first blocking triangle per blocked target. Yellow = killer, magenta = victim.\n")
	md.WriteString("red = blocked, red triangles = the first blocking triangle per blocked target.\n\n")
	n := 0
	for _, k := range kills {
		ex, err := renderKill(db, root, data, out, k.mid, k.tk, k.a, k.v)
		if err != nil {
			fmt.Fprintf(&md, "- match %d tick %d: could not render (%v)\n", k.mid, k.tk, err)
			continue
		}
		n++
		fmt.Fprintf(&md, "## %d. %s, match %d, tick %d\n\n", n, ex.Map, k.mid, k.tk)
		fmt.Fprintf(&md, "- Files: `kill-%d-%d-{east,west,north,south,above,below}.png`\n", k.mid, k.tk)
		fmt.Fprintf(&md, "- Kill: %s killed %s with %s at %.1f m (headshot %v). Wallbang %d, smoke %d, penetrated %d.\n",
			ex.Killer, ex.Victim, ex.Weapon, ex.DistanceM, ex.Headshot, ex.Wallbang, ex.Smoke, ex.Penetrated)
		fmt.Fprintf(&md, "- Sight line at the last sampled frame (%d): any of the 8 target points clear = %v.\n", ex.Frame, ex.AnyClear)
		fmt.Fprintf(&md, "- First blocking triangle lies at fraction %v of the line (0 = shooter, 1 = victim); mesh %d.\n", fracsText(ex.BlockFrac), ex.BlockedMesh)
		if ex.ClearEarlier > 0 {
			fmt.Fprintf(&md, "- A dense line was clear %d ticks before the kill.\n", ex.ClearEarlier)
		} else {
			fmt.Fprintf(&md, "- No dense line was clear in the 192 ticks before the kill.\n")
		}
		fmt.Fprintf(&md, "- Measured position: %s.\n\n", ex.Line())
	}
	if err := os.WriteFile(filepath.Join(out, "explanations.md"), []byte(md.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	fmt.Printf("BATCH rendered %d of %d kills into %s\n", n, len(kills), out)
}

func fracsText(f []float64) string {
	var parts []string
	for _, v := range f {
		if v < 0 {
			parts = append(parts, "n/a")
		} else {
			parts = append(parts, fmt.Sprintf("%.2f", v))
		}
	}
	return "[" + strings.Join(parts, ", ") + "]"
}

// occFromCache returns the world-collision occluder for a map from the data dir.
func occFromCache(data, mapName string) (encounter.Occluder, error) {
	f, err := os.Open(filepath.Join(data, "worldcol", mapName+".worldcol"))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	meshes, err := source2.ReadMeshes(f)
	if err != nil {
		return nil, err
	}
	return occFor(meshes), nil
}
