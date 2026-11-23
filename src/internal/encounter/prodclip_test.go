package encounter_test

import (
	"fmt"
	"os"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/encounter"
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
}
