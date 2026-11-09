package main

import (
	"encoding/json"
	"io/fs"
	"testing"
)

// TestBundledMapMeta pins the extraction wiring for the bundled meta
// copies: the pack-name whitelist keeps every lookup inside the embedded
// maps/ tree, and every map pack the embedded frontend/dist actually
// ships resolves through bundledMapMeta to its meta.json — the bytes
// WithBundledMeta feeds to mappack.preserveElevation (the canonical
// home of the hand-authored elevation_regions).
//
// A stub dist (make test / make vet on a fresh clone — index.html only,
// no maps) skips the embed half; the no-bundle fallback those builds
// exercise is pinned by internal/mappack's tests.
func TestBundledMapMeta(t *testing.T) {
	// Nothing outside the pack-dir name shape may reach the embed FS.
	for _, name := range []string{"", "..", "de/mirage", "De_nuke", "x\\y", "de_nuke/../.."} {
		if got := bundledMapMeta(name); got != nil {
			t.Errorf("bundledMapMeta(%q) = %q, want nil (pack-name whitelist)", name, got)
		}
	}

	if _, err := fs.Stat(assets, "frontend/dist/maps"); err != nil {
		t.Skipf("embedded dist carries no maps (stub build?): %v", err)
	}
	// de_nuke is the canonical bundled pack (README.md, the drift test in
	// frontend/src/lib/nuke-elevation.test.js).
	got := bundledMapMeta("de_nuke")
	if len(got) == 0 {
		t.Fatal("bundledMapMeta(\"de_nuke\") = nil, want the embedded meta.json")
	}
	var meta struct {
		ElevationRegions []map[string]any `json:"elevation_regions"`
	}
	if err := json.Unmarshal(got, &meta); err != nil {
		t.Fatalf("bundled de_nuke meta.json: %v", err)
	}
	if len(meta.ElevationRegions) == 0 {
		t.Error("bundled de_nuke meta.json carries no elevation_regions — the canonical home is empty")
	}

	// Every other bundled pack resolves the same way (one meta.json per
	// pack dir; README.md is a plain file and is skipped).
	entries, err := fs.ReadDir(assets, "frontend/dist/maps")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if b := bundledMapMeta(e.Name()); len(b) == 0 {
			t.Errorf("bundledMapMeta(%q) = nil, want the embedded meta.json", e.Name())
		}
	}
}
