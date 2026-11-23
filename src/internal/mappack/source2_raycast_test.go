package mappack

import (
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/source2"
)

// TestSource2SpikeRaycast validates the kd-tree visibility query against a
// brute-force reference on the real de_cache world collision, then times the
// tree query on random sight lines. Skips when the install is absent.
func TestSource2SpikeRaycast(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip()
	}
	vpkPath := filepath.Join(home, ".steam/steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/maps/de_cache.vpk")
	if _, err := os.Stat(vpkPath); err != nil {
		t.Skip("CS2 map VPK not installed")
	}
	v, err := openVPK(vpkPath)
	if err != nil {
		t.Fatal(err)
	}
	defer v.close()
	data, found, err := v.read("maps/de_cache/world_physics.vmdl_c")
	if err != nil || !found {
		t.Fatalf("read: found=%v err=%v", found, err)
	}
	blocks, err := source2.ParseResource(data)
	if err != nil {
		t.Fatal(err)
	}
	phys, _ := source2.FindBlock(blocks, "PHYS")
	kv, err := source2.Decode(phys)
	if err != nil {
		t.Fatal(err)
	}
	meshes, err := source2.PhysicsMeshes(kv)
	if err != nil {
		t.Fatal(err)
	}
	var lo, hi = meshes[0].Min, meshes[0].Max
	for _, m := range meshes {
		for k := 0; k < 3; k++ {
			lo[k] = min32(lo[k], m.Min[k])
			hi[k] = max32(hi[k], m.Max[k])
		}
	}
	rng := rand.New(rand.NewSource(1))
	point := func() source2.Vec3 {
		var p source2.Vec3
		for k := 0; k < 3; k++ {
			p[k] = lo[k] + float32(rng.Float64())*(hi[k]-lo[k])
		}
		return p
	}
	// Validation: tree and brute force must agree on every mesh.
	const checks = 150
	disagree, blockedCount := 0, 0
	for i := 0; i < checks; i++ {
		a := point()
		b := point()
		seg := source2.Segment{A: a, B: b}
		for _, m := range meshes {
			tree := m.Blocked(seg)
			ref := m.BruteBlocked(seg)
			if tree != ref {
				disagree++
			}
			if ref {
				blockedCount++
			}
		}
	}
	fmt.Printf("raycast validation: %d segments x %d meshes, tree/brute disagreements %d, brute-blocked mesh hits %d\n",
		checks, len(meshes), disagree, blockedCount)
	if disagree != 0 {
		t.Errorf("kd-tree disagrees with brute force on %d mesh queries", disagree)
	}

	// Timing: whole-world visibility (blocked by any mesh) on random segments.
	const trials = 20000
	segs := make([]source2.Segment, trials)
	for i := range segs {
		segs[i] = source2.Segment{A: point(), B: point()}
	}
	start := time.Now()
	blocked := 0
	for _, s := range segs {
		for _, m := range meshes {
			if m.Blocked(s) {
				blocked++
				break
			}
		}
	}
	elapsed := time.Since(start)
	var open []source2.Segment
	for _, s := range segs {
		hit := false
		for _, m := range meshes {
			if m.Blocked(s) {
				hit = true
				break
			}
		}
		if !hit {
			open = append(open, s)
		}
	}
	start = time.Now()
	for _, s := range open {
		for _, m := range meshes {
			_ = m.Blocked(s)
		}
	}
	oe := time.Since(start)
	fmt.Printf("raycast unblocked timing: %d unblocked segments in %s (%.0f per second, all meshes walked)\n",
		len(open), oe, float64(len(open))/oe.Seconds())
	fmt.Printf("raycast timing: %d segments in %s (%.0f per second, world-wide), %d blocked\n",
		trials, elapsed, float64(trials)/elapsed.Seconds(), blocked)
}

func min32(a, b float32) float32 {
	if a < b {
		return a
	}
	return b
}

func max32(a, b float32) float32 {
	if a > b {
		return a
	}
	return b
}
