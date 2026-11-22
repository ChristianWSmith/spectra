package encounter_test

import (
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/encounter"
)

// TestOneKillEyeCube tests whether any eye position within a cube around the
// shooter's sampled eye clears the kill whose label contains SPECTRA_ONE. It
// varies x and y as well as z, which the grid search does not. Opt-in.
func TestOneKillEyeCube(t *testing.T) {
	root, data, one := os.Getenv("SPECTRA_ENC"), os.Getenv("SPECTRA_DATA"), os.Getenv("SPECTRA_ONE")
	if root == "" || data == "" || one == "" {
		t.Skip("set SPECTRA_ENC, SPECTRA_DATA, SPECTRA_ONE")
	}
	d := loadSweep(t, root, data)
	for _, k := range d.kills {
		if !strings.Contains(k.label, one) {
			continue
		}
		occ := d.occs[k.mp]
		best := -1.0
		fmt.Printf("ONE %s: %d frames\n", k.label, len(k.frames))
		for _, f := range k.frames {
			clear := false
			for dx := -8.0; dx <= 8 && !clear; dx += 2 {
				for dy := -8.0; dy <= 8 && !clear; dy += 2 {
					for dz := -8.0; dz <= 8 && !clear; dz += 2 {
						eye := [3]float64{f.eye[0] + dx, f.eye[1] + dy, f.eye[2] + dz}
						if encounter.AnyClearBox(eye, f.enemy, encounter.ProductionBox, occ) {
							clear = true
							if best < 0 {
								best = dx*dx + dy*dy + dz*dz
							}
						}
					}
				}
			}
			if clear {
				fmt.Printf("ONE frame eye %.0f %.0f %.0f clears with an eye offset within the cube\n", f.eye[0], f.eye[1], f.eye[2])
				return
			}
		}
		for _, f := range k.frames {
			if f.tick >= 8005 && f.tick <= 8020 {
				fmt.Printf("ONE tick %d eye %.0f %.0f %.0f enemy %.0f %.0f %.0f\n", f.tick, f.eye[0], f.eye[1], f.eye[2], f.enemy.X, f.enemy.Y, f.enemy.Z)
			}
		}
		fmt.Println("ONE no eye position within ±8 units in x, y, z clears it, in any frame")
	}
}
