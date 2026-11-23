package encounter_test

import (
	"fmt"
	"os"
	"sort"
	"strings"
	"testing"
)

// TestBorderlineMaterials counts triangles of borderline material groups per map
// in the production render sidecars. Opt-in: SPECTRA_MATS_DIR.
func TestBorderlineMaterials(t *testing.T) {
	dir := os.Getenv("SPECTRA_MATS_DIR")
	if dir == "" {
		t.Skip("set SPECTRA_MATS_DIR")
	}
	groups := []struct {
		name string
		keys []string
	}{
		{"foliage", []string{"foliage", "plant", "leaf", "bush", "flower", "palm", "weeds", "sumac", "vine", "bark", "roots"}},
		{"grass", []string{"grass"}},
		{"decal", []string{"decal"}},
		{"cloth", []string{"cloth", "curtain", "rug", "tablecloth", "banner", "awning_fabric"}},
		{"wire-rope", []string{"wire", "rope", "chain"}},
		{"grate-fence-mesh", []string{"grate", "grill", "fence", "mesh", "net_"}},
		{"tools", []string{"tools/"}},
		{"fire-flame", []string{"fire", "flame"}},
		{"sky", []string{"sky"}},
	}
	maps := []string{"de_ancient", "de_anubis", "de_cache", "de_dust2", "de_inferno", "de_mirage", "de_nuke"}
	for _, m := range maps {
		table, mats, err := readMaterials(dir + "/" + m + ".render.mats")
		if err != nil {
			t.Fatal(err)
		}
		count := make([]int, len(table))
		for _, ms := range mats {
			for _, id := range ms {
				count[id]++
			}
		}
		var parts []string
		for _, g := range groups {
			total := 0
			var names []string
			for i, n := range table {
				low := strings.ToLower(n)
				for _, k := range g.keys {
					if strings.Contains(low, k) {
						total += count[i]
						names = append(names, n)
						break
					}
				}
			}
			if total > 0 {
				sort.Strings(names)
				parts = append(parts, fmt.Sprintf("%s=%d", g.name, total))
			}
		}
		fmt.Printf("BORDER %s: %s\n", m, strings.Join(parts, " "))
	}
}
