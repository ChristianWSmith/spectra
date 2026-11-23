package encounter_test

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/encounter"
	"github.com/ChristianWSmith/spectra/internal/source2"
)

// TestProductionNoClip scores the production box, with and without the
// player/NPC clip meshes (SPECTRA_NO_CLIP), on every kill. Lists kills it does not
// clear. Opt-in with the same environment as TestWideSweep.
func TestProductionNoClip(t *testing.T) {
	root, data := os.Getenv("SPECTRA_ENC"), os.Getenv("SPECTRA_DATA")
	if root == "" || data == "" {
		t.Skip("set SPECTRA_ENC, SPECTRA_DATA")
	}
	d := loadSweep(t, root, data)
	clear, total := 0, 0
	for _, k := range d.kills {
		total++
		ok := false
		for _, f := range k.frames {
			if encounter.AnyClearBox(f.eye, f.enemy, encounter.ProductionBox, d.occs[k.mp]) {
				ok = true
				break
			}
		}
		if ok {
			clear++
		} else {
			fmt.Printf("PRODNC blocked: %s\n", k.label)
		}
	}
	fmt.Printf("PRODNC production box clears %d of %d kills (noClip=%v)\n", clear, total, os.Getenv("SPECTRA_NO_CLIP") != "")
	// Control: random opposing pairs. Removing solid geometry would make these
	// look clear; a sane filter leaves most of them blocked.
	cc := 0
	perMap := map[string][2]int{}
	for _, c := range d.control {
		pm := perMap[c.mp]
		pm[1]++
		for _, f := range c.frames {
			if encounter.AnyClearBox(f.eye, f.enemy, encounter.ProductionBox, d.occs[c.mp]) {
				cc++
				pm[0]++
				break
			}
		}
		perMap[c.mp] = pm
	}
	for mp, pm := range perMap {
		fmt.Printf("PRODNC control %s: %d of %d clear (noClip=%v)\n", mp, pm[0], pm[1], os.Getenv("SPECTRA_NO_CLIP") != "")
	}
	fmt.Printf("PRODNC control: %d of %d random opposing pairs look clear (noClip=%v)\n", cc, len(d.control), os.Getenv("SPECTRA_NO_CLIP") != "")
}

// TestClipShare reports, per map, how many triangles the clip-only filter removes.
func TestClipShare(t *testing.T) {
	data := os.Getenv("SPECTRA_DATA")
	out := os.Getenv("SPECTRA_OVERLAY_OUT")
	if data == "" || out == "" {
		t.Skip("set SPECTRA_DATA, SPECTRA_OVERLAY_OUT")
	}
	for _, mp := range []string{"de_ancient", "de_anubis", "de_cache", "de_dust2", "de_inferno", "de_mirage", "de_nuke"} {
		f, err := os.Open(filepath.Join(data, "worldcol", mp+".worldcol"))
		if err != nil {
			t.Fatal(err)
		}
		meshes, err := source2.ReadMeshes(f)
		f.Close()
		if err != nil {
			t.Fatal(err)
		}
		ab, err := os.ReadFile(filepath.Join(out, "attrs", mp+".attrs.json"))
		if err != nil {
			t.Fatal(err)
		}
		var attrs []struct {
			Mesh       int      `json:"mesh"`
			InteractAs []string `json:"interactAs"`
		}
		if err := json.Unmarshal(ab, &attrs); err != nil {
			t.Fatal(err)
		}
		clip := map[int]bool{}
		for _, a := range attrs {
			for _, s := range a.InteractAs {
				if s == "playerclip" || s == "npcclip" {
					clip[a.Mesh] = true
				}
			}
		}
		total, removed := 0, 0
		for i, m := range meshes {
			total += len(m.Triangles)
			if clip[i] {
				removed += len(m.Triangles)
			}
		}
		fmt.Printf("CLIPSHARE %s: %d of %d triangles removed (%.1f%%), %d of %d meshes\n", mp, removed, total,
			100*float64(removed)/float64(total), len(clip), len(meshes))
	}
}
