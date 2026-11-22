package mappack

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestExtractWorldCollisionAllMaps runs the extractor over every map VPK in
// the local install (spike: checks the manifest lookup generalizes). Opt-in:
// set SPECTRA_WORLDCOL_ALL=1, since it writes ~64 MB per map to a temp dir.
func TestExtractWorldCollisionAllMaps(t *testing.T) {
	if os.Getenv("SPECTRA_WORLDCOL_ALL") == "" {
		t.Skip("set SPECTRA_WORLDCOL_ALL=1 to run")
	}
	cs2 := FindCS2("")
	if cs2 == "" {
		t.Skip("no CS2 install")
	}
	entries, err := os.ReadDir(filepath.Join(cs2, "maps"))
	if err != nil {
		t.Fatal(err)
	}
	out := t.TempDir()
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".vpk") || strings.Contains(name, "_vanity") || strings.Contains(name, "_retake") {
			continue
		}
		mapName := strings.TrimSuffix(name, ".vpk")
		start := time.Now()
		_, n, err := ExtractWorldCollision(cs2, mapName, out)
		if err != nil {
			t.Logf("MAP %s: %v", mapName, err)
			continue
		}
		t.Logf("MAP %s: %d meshes in %s", mapName, n, time.Since(start).Round(time.Millisecond))
	}
}
