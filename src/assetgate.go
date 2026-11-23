package main

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/ChristianWSmith/spectra/internal/data"
	"github.com/ChristianWSmith/spectra/internal/mappack"
)

// assetsReady reports whether the CS2-derived assets the app needs are in the
// data dir: radar map packs, equipment icons, sounds, and the world-collision
// cache for every supported map. The app no longer runs without them, so import
// is refused until they exist. missing lists what is absent.
func assetsReady() (ok bool, missing []string) {
	for _, d := range []struct {
		name, dir string
	}{
		{"map packs", data.MapsDir()},
		{"icons", data.IconsDir()},
		{"sounds", data.SoundsDir()},
	} {
		if !nonEmptyDir(d.dir) {
			missing = append(missing, d.name)
		}
	}
	for _, m := range mappack.SupportedRenderMaps() {
		p := filepath.Join(data.RenderGeometryDir(), m+".render")
		if _, err := os.Stat(p); err != nil {
			missing = append(missing, fmt.Sprintf("render geometry (%s)", m))
		}
	}
	return len(missing) == 0, missing
}

func nonEmptyDir(dir string) bool {
	entries, err := os.ReadDir(dir)
	return err == nil && len(entries) > 0
}
