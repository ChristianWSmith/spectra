package main

import (
	"testing"

	"github.com/ChristianWSmith/spectra/internal/mappack"
)

// TestExtractSoundsProgressEmitted runs the SOUND service's extraction
// core against a real local CS2 install (mappack.FindCS2 auto-detects)
// with the shared spectra:asset-progress emitter wired in — the headless
// proof that a service-level run really fires the new emitter along a
// REAL extraction path: events arrive with an honest denominator (the
// canonical sound table, known before the first item — one call per
// canonical name after its variant loop) and the closing call lands
// exactly on it. Skipped when CS2 isn't installed (CI never has it —
// internal/mappack's synthetic TestExtractProgress carries the portable
// extractor coverage). Output is a temp dir; nothing Valve-derived is
// kept.
func TestExtractSoundsProgressEmitted(t *testing.T) {
	cs2Dir := mappack.FindCS2("")
	if cs2Dir == "" {
		t.Skip("no local CS2 install found")
	}
	var seen []AssetProgressEvent
	m := extractSounds(cs2Dir, "", t.TempDir(),
		assetProgress(func(ev AssetProgressEvent) { seen = append(seen, ev) }, assetFamilySounds))
	last := assertAssetProgressRun(t, assetFamilySounds, seen)
	if !m.Extracted || m.Count == 0 {
		t.Fatalf("manifest = %+v, want extracted sounds", m)
	}
	// The denominator must never undercount what the run actually wrote.
	if last.Total < m.Count {
		t.Errorf("denominator total %d < %d extracted sounds", last.Total, m.Count)
	}
}
