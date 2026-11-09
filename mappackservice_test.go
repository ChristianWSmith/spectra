package main

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	"github.com/adrg/xdg"
	"github.com/wailsapp/wails/v3/pkg/services/kvstore"
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

// TestMapPackStatusIsPresenceOnly pins the launch-prompt contract on the
// Go side: MapPackStatus carries only presence signals (found/path/
// manual/maps) — NO promptState field. The gate is presence-driven in
// the frontend (any missing asset family re-opens the prompt every
// launch), so a durable suppression value has nowhere to live: even a
// stale mappack_prompt_state pref left in a dev kvstore is simply
// ignored.
func TestMapPackStatusIsPresenceOnly(t *testing.T) {
	kvs := kvstore.New()
	if err := kvs.Set("mappack_prompt_state", "declined"); err != nil {
		t.Fatal(err)
	}
	s := &MapPackService{kvs: kvs}

	// Point the data dir at a temp dir so MapsDir() lists that instead
	// of the developer's real extraction output.
	prevDataHome := xdg.DataHome
	xdg.DataHome = t.TempDir()
	t.Cleanup(func() { xdg.DataHome = prevDataHome })

	raw, err := json.Marshal(s.GetMapPackStatus())
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"found", "path", "manual", "maps"} {
		if _, ok := got[key]; !ok {
			t.Errorf("MapPackStatus JSON missing %q: %s", key, raw)
		}
	}
	if _, ok := got["promptState"]; ok {
		t.Errorf("MapPackStatus must not carry promptState (presence-driven gate): %s", raw)
	}
}

// TestSetCS2DirPersistsOnlyThePath pins the repurposed folder-persist
// method: SetCS2Dir validates and stores the manual CS2 dir — and never
// writes the retired prompt-suppression key (the old SetMapPackPromptState
// wrote "declined"/"done" under it; nothing may bring that back).
func TestSetCS2DirPersistsOnlyThePath(t *testing.T) {
	kvs := kvstore.New()
	s := &MapPackService{kvs: kvs}

	// Cancelled pick (empty path): a no-op, nothing written.
	if err := s.SetCS2Dir(""); err != nil {
		t.Fatalf("SetCS2Dir(\"\") = %v, want nil", err)
	}
	if v := kvs.Get(prefsMapPackCS2PathKey); v != nil {
		t.Errorf("empty path wrote %s = %v", prefsMapPackCS2PathKey, v)
	}

	// A folder without a pak is rejected and stores nothing.
	if err := s.SetCS2Dir(t.TempDir()); err == nil {
		t.Fatal("SetCS2Dir(non-install) = nil, want a validation error")
	}
	if v := kvs.Get(prefsMapPackCS2PathKey); v != nil {
		t.Errorf("invalid path wrote %s = %v", prefsMapPackCS2PathKey, v)
	}

	// A valid install persists under the CS2-path key only.
	install := t.TempDir()
	if err := os.WriteFile(filepath.Join(install, "pak01_dir.vpk"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := s.SetCS2Dir(install); err != nil {
		t.Fatalf("SetCS2Dir(valid) = %v", err)
	}
	if got := kvs.Get(prefsMapPackCS2PathKey); got != install {
		t.Errorf("%s = %v, want %q", prefsMapPackCS2PathKey, got, install)
	}
	if got := kvs.Get("mappack_prompt_state"); got != nil {
		t.Errorf("retired prompt-suppression pref was written: %v", got)
	}
}
