package main

import (
	"path/filepath"
	"sync"

	"github.com/ChristianWSmith/spectra/internal/data"
	"github.com/ChristianWSmith/spectra/internal/encounter"
)

// windowOccluderFor returns the sight-line geometry provider for the parse
// (library.Options.WindowOccluder). It keeps one map's geometry in memory: a
// large map's hierarchy is big, and imports are one match at a time.
func windowOccluderFor() func(mapName string) (encounter.Occluder, error) {
	var mu sync.Mutex
	var lastMap string
	var last encounter.Occluder
	return func(mapName string) (encounter.Occluder, error) {
		mu.Lock()
		defer mu.Unlock()
		if last != nil && lastMap == mapName {
			return last, nil
		}
		occ, err := encounter.LoadRenderOccluder(filepath.Join(data.RenderGeometryDir(), mapName+".render"))
		if err != nil {
			return nil, err
		}
		lastMap, last = mapName, occ
		return occ, nil
	}
}
