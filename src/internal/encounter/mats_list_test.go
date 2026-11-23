package encounter_test

import (
	"fmt"
	"os"
	"sort"
	"strings"
	"testing"
)

// TestListMaterials prints every material of each map's render sidecar with its
// triangle count, flagging names that could be see-through. Opt-in: SPECTRA_MATS_DIR.
func TestListMaterials(t *testing.T) {
	dir := os.Getenv("SPECTRA_MATS_DIR")
	if dir == "" {
		t.Skip("set SPECTRA_MATS_DIR")
	}
	flags := []string{"smoke", "dust", "fog", "glass", "window", "foliage", "leaf", "tree", "bush", "fence", "grate", "grill", "mesh", "net", "cloth", "curtain", "flame", "fire", "water", "particle", "sprite", "card", "decal", "alpha", "effects", "tools", "sky", "nodraw", "vine", "hedge", "plant", "grass", "chain", "rope", "wire", "screen", "tint"}
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
		type row struct {
			name string
			n    int
		}
		var rows []row
		for i, n := range table {
			rows = append(rows, row{n, count[i]})
		}
		sort.Slice(rows, func(i, j int) bool { return rows[i].n < rows[j].n })
		flagged := 0
		for _, r := range rows {
			low := strings.ToLower(r.name)
			var hit []string
			for _, f := range flags {
				if strings.Contains(low, f) {
					hit = append(hit, f)
				}
			}
			if len(hit) > 0 {
				flagged++
				fmt.Printf("MAT %s %8d %s [%s]\n", m, r.n, r.name, strings.Join(hit, ","))
			}
		}
		fmt.Printf("MATSUM %s: %d materials, %d flagged\n", m, len(table), flagged)
	}
}
