package mappack

import (
	"path/filepath"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/source2"
)

// TestPropHullLocalClip: regression for the hull clip in local space. Every
// convex hull of the de_anubis props must be reached from just outside its
// bounds to its own centroid. Skips when the install is absent.
func TestPropHullLocalClip(t *testing.T) {
	if FindCS2("") == "" {
		t.Skip("no CS2 install")
	}
	v, err := openVPK(filepath.Join(FindCS2(""), "maps", "de_anubis.vpk"))
	if err != nil {
		t.Fatal(err)
	}
	defer v.close()
	props, _ := LoadProps(v, "de_anubis")
	inside, total := 0, 0
	for _, p := range props {
		s, err := LoadShape(v, p.Model)
		if err != nil || len(s.Hulls) == 0 {
			continue
		}
		for _, h := range s.Hulls {
			total++
			if source2.SegmentHitsHull(h, source2.Vec3{h.Min[0] - 1, h.Min[1] - 1, h.Min[2] - 1}, h.Centroid) {
				inside++
			}
		}
	}
	if total == 0 {
		t.Fatal("no hulls checked: the entity lump or prop models did not load")
	}
	if inside != total {
		t.Errorf("hull clip misses the centroid for %d of %d hulls", total-inside, total)
	}
}
