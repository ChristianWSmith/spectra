package main

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

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

// TestAssetProgressEmitter pins THE spectra:asset-progress emitter all
// THREE extractor families share (assetProgress / assetProgressFor /
// throttledAssetProgress): the wire payload shape the frontend reads,
// the throttle drop rule (intermediate calls inside the window dropped,
// the closing call never throttled), the per-family label with stage
// "extract", and the nil seams — a service constructed without an app
// handle has no emitter and must never panic.
func TestAssetProgressEmitter(t *testing.T) {
	// The wire contract: the four JSON keys the renderers parse.
	raw, err := json.Marshal(AssetProgressEvent{
		Family: assetFamilyIcons, Stage: "extract", Done: 7, Total: 120,
	})
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"family", "stage", "done", "total"} {
		if _, ok := wire[key]; !ok {
			t.Errorf("AssetProgressEvent JSON missing %q: %s", key, raw)
		}
	}
	if wire["family"] != "icons" || wire["stage"] != "extract" {
		t.Errorf("payload = %s, want family=icons stage=extract", raw)
	}

	// The drop rule, on a window far larger than the test's own runtime
	// so the clock can never race it: the FIRST call always emits
	// (nothing seen yet), an intermediate call inside the window is
	// dropped, the closing call (done == total) is never throttled.
	for _, family := range []string{assetFamilyMapPacks, assetFamilyIcons, assetFamilySounds} {
		var seen []AssetProgressEvent
		cb := throttledAssetProgress(time.Hour, func(ev AssetProgressEvent) { seen = append(seen, ev) }, family)
		cb(1, 3)
		cb(2, 3)
		cb(3, 3)
		want := []AssetProgressEvent{
			{Family: family, Stage: "extract", Done: 1, Total: 3},
			{Family: family, Stage: "extract", Done: 3, Total: 3},
		}
		if !slices.Equal(seen, want) {
			t.Errorf("%s: emitted %+v, want %+v", family, seen, want)
		}
	}

	// An open window (0) drops nothing — the rule is the window itself,
	// not a cap on how many events a run may send.
	var all []AssetProgressEvent
	cb := throttledAssetProgress(0, func(ev AssetProgressEvent) { all = append(all, ev) }, assetFamilySounds)
	for i := 1; i <= 3; i++ {
		cb(i, 3)
	}
	if len(all) != 3 {
		t.Errorf("window=0 emitted %d calls, want 3: %+v", len(all), all)
	}

	// Nil seams: no emitter, no panic (the package's service tests build
	// IconService/SoundService/MapPackService without an app handle).
	if got := assetProgress(nil, assetFamilyIcons); got != nil {
		t.Error("assetProgress(nil emit, …) = non-nil, want nil")
	}
	if got := assetProgressFor(nil, assetFamilyMapPacks); got != nil {
		t.Error("assetProgressFor(nil app, …) = non-nil, want nil (a handle-less service never emits)")
	}
}

// assertAssetProgressRun pins the shape of a COMPLETE extraction run's
// recorded spectra:asset-progress emissions (used by the real-install
// service tests below): the first canonical item and the closing call
// always emit (the throttle withholds neither end of a run), done is
// strictly increasing, the total never moves, and every payload carries
// the run's family with stage "extract".
func assertAssetProgressRun(t *testing.T, family string, seen []AssetProgressEvent) AssetProgressEvent {
	t.Helper()
	if len(seen) < 2 {
		t.Fatalf("%s: %d emitted events, want ≥2 (first item + closing call): %+v", family, len(seen), seen)
	}
	first, last := seen[0], seen[len(seen)-1]
	if first.Done != 1 {
		t.Errorf("first event = %+v, want done 1", first)
	}
	if first.Total <= 1 {
		t.Errorf("first event total = %d, want the run's item count (> 1)", first.Total)
	}
	if last.Done != last.Total {
		t.Errorf("last event = %+v, want the closing call done == total", last)
	}
	if last.Total != first.Total {
		t.Errorf("total changed mid-run: %+v", seen)
	}
	for i, ev := range seen {
		if ev.Family != family || ev.Stage != "extract" {
			t.Errorf("event %d = %+v, want family %q stage \"extract\"", i, ev, family)
			break
		}
		if i > 0 && ev.Done <= seen[i-1].Done {
			t.Errorf("done not strictly increasing: %+v", seen)
			break
		}
	}
	t.Logf("%s: %d emissions, first %+v, last %+v", family, len(seen), first, last)
	return last
}
