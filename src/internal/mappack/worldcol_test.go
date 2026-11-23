package mappack

import (
	"math/rand"
	"os"
	"path/filepath"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/source2"
)

// TestExtractWorldCollisionRoundTrip extracts de_cache's world collision from
// the local install, reads the cache back, and checks that the reloaded
// meshes give the same visibility answers as the freshly decoded ones.
func TestExtractWorldCollisionRoundTrip(t *testing.T) {
	cs2 := FindCS2("")
	if cs2 == "" {
		t.Skip("no CS2 install")
	}
	out := t.TempDir()
	path, n, err := ExtractWorldCollision(cs2, "de_cache", out)
	if err != nil {
		t.Fatalf("ExtractWorldCollision: %v", err)
	}
	if n != 11 {
		t.Fatalf("meshes = %d, want 11", n)
	}
	if st, err := os.Stat(path); err == nil {
		t.Logf("cache size %d bytes", st.Size())
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	loaded, err := source2.ReadMeshes(f)
	if err != nil {
		t.Fatalf("ReadMeshes: %v", err)
	}
	if len(loaded) != n {
		t.Fatalf("reloaded %d meshes, want %d", len(loaded), n)
	}
	fresh := freshDeCacheMeshes(t, cs2)
	rng := rand.New(rand.NewSource(7))
	lo, hi := fresh[0].Min, fresh[0].Max
	for _, m := range fresh {
		for k := 0; k < 3; k++ {
			lo[k] = min32(lo[k], m.Min[k])
			hi[k] = max32(hi[k], m.Max[k])
		}
	}
	point := func() source2.Vec3 {
		var p source2.Vec3
		for k := 0; k < 3; k++ {
			p[k] = lo[k] + float32(rng.Float64())*(hi[k]-lo[k])
		}
		return p
	}
	mismatch := 0
	for i := 0; i < 300; i++ {
		seg := source2.Segment{A: point(), B: point()}
		for j := range fresh {
			if fresh[j].Blocked(seg) != loaded[j].Blocked(seg) {
				mismatch++
			}
		}
	}
	if mismatch != 0 {
		t.Errorf("reloaded cache disagrees with fresh decode on %d queries", mismatch)
	}
}

func freshDeCacheMeshes(t *testing.T, cs2 string) []source2.Mesh {
	t.Helper()
	v, err := openVPK(filepath.Join(cs2, "maps", "de_cache.vpk"))
	if err != nil {
		t.Fatal(err)
	}
	defer v.close()
	data, _, err := v.read("maps/de_cache/world_physics.vmdl_c")
	if err != nil {
		t.Fatal(err)
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
	return meshes
}
