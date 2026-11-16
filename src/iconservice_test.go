package main

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/mappack"
)

// TestBuildIconManifest pins the served manifest contract: fresh dir
// listing, canonical-name keys → /api/icons URLs, the SPLIT map half
// (map name → its logo, never folded into count/icons), strays ignored,
// and the empty-dir fallback shape the frontend normalizes.
func TestBuildIconManifest(t *testing.T) {
	dir := t.TempDir()
	write := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("ak47.svg", `<svg xmlns="http://www.w3.org/2000/svg"/>`)
	write("smokegrenade.svg", `<svg xmlns="http://www.w3.org/2000/svg"/>`)
	write("map_icon_de_mirage.svg", `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"/>`)
	write("flair0.svg", `<svg/>`) // real VPK file, but not in the canonical table
	write("notes.txt", "stray")

	m := buildIconManifest(dir)
	// Count stays the EQUIPMENT + notice size (Settings' "Equipment
	// icons" row reads it): the map logo rides its own half.
	if !m.Extracted || m.Count != 2 || len(m.Icons) != 2 {
		t.Fatalf("manifest = %+v", m)
	}
	if m.Icons["AK-47"] != "/api/icons/ak47.svg" {
		t.Errorf(`manifest["AK-47"] = %q`, m.Icons["AK-47"])
	}
	if m.Icons["Smoke Grenade"] != "/api/icons/smokegrenade.svg" {
		t.Errorf(`manifest["Smoke Grenade"] = %q`, m.Icons["Smoke Grenade"])
	}
	if _, dup := m.Icons["de_mirage"]; dup {
		t.Error("a map icon must never land in icons (it would ride every Replay preload)")
	}
	if m.Maps["de_mirage"] != "/api/icons/map_icon_de_mirage.svg" {
		t.Errorf(`manifest.Maps["de_mirage"] = %q, want the map logo URL`, m.Maps["de_mirage"])
	}
	if m.MapCount != 1 {
		t.Errorf("MapCount = %d, want 1", m.MapCount)
	}

	// JSON field names are the wire contract other agents code against.
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"extracted", "count", "icons", "maps", "mapCount"} {
		if _, ok := wire[key]; !ok {
			t.Errorf("manifest JSON missing %q: %s", key, raw)
		}
	}
	if _, ok := wire["note"]; ok {
		t.Errorf("note must be omitempty (absent when empty): %s", raw)
	}

	// A map-free dir omits BOTH map keys (omitempty) — a flat manifest
	// with count === icons size and no maps half to normalize.
	onlyStatic := filepath.Join(dir, "only-static")
	if err := os.Mkdir(onlyStatic, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(onlyStatic, "c4.svg"), []byte(`<svg/>`), 0o644); err != nil {
		t.Fatal(err)
	}
	staticRaw, err := json.Marshal(buildIconManifest(onlyStatic))
	if err != nil {
		t.Fatal(err)
	}
	var staticWire map[string]any
	if err := json.Unmarshal(staticRaw, &staticWire); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"maps", "mapCount"} {
		if _, ok := staticWire[key]; ok {
			t.Errorf("%q must be omitempty (absent with no map icons): %s", key, staticRaw)
		}
	}

	// Empty dir → the fail-soft shape: extracted=false, empty maps.
	empty := buildIconManifest(filepath.Join(dir, "nope"))
	if empty.Extracted || empty.Count != 0 || empty.Icons == nil || len(empty.Icons) != 0 ||
		empty.Maps != nil || empty.MapCount != 0 {
		t.Errorf("empty manifest = %+v", empty)
	}
}

// TestServeIconFile exercises the /api/icons/<file>.svg whitelist: valid
// names serve with the SVG content type, every traversal/case/extension
// variant 404s (mirror of the map-pack route's rejection style). The map
// logos ride the SAME whitelist — their namespaced stem is why they pass.
func TestServeIconFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "c4.svg"), []byte(`<svg/>`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "map_icon_de_mirage.svg"), []byte(`<svg/>`), 0o644); err != nil {
		t.Fatal(err)
	}
	get := func(name string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		serveIconFile(rec, httptest.NewRequest("GET", "/api/icons/"+name, nil), dir, name)
		return rec
	}

	for _, name := range []string{"c4.svg", "map_icon_de_mirage.svg"} {
		rec := get(name)
		if rec.Code != 200 {
			t.Errorf("valid icon %q status = %d, want 200", name, rec.Code)
		}
		if ct := rec.Header().Get("Content-Type"); ct != "image/svg+xml" {
			t.Errorf("%q Content-Type = %q, want image/svg+xml", name, ct)
		}
	}

	for _, name := range []string{
		"missing.svg", "../c4.svg", "sub/c4.svg", "/etc/passwd",
		"C4.svg", "c4.png", "c4", "", "manifest.json", "..",
		"map_icon_de_mirage.png", "map_icon_../de_mirage.svg", "Map_Icon_De_Mirage.svg",
	} {
		if code := get(name).Code; code != 404 {
			t.Errorf("%q served with %d, want 404", name, code)
		}
	}
}

// TestHandleIconsMethodRejection: the route only answers GET (the
// manifest branch is reached only after the method check).
func TestHandleIconsMethodRejection(t *testing.T) {
	rec := httptest.NewRecorder()
	handleIcons(rec, httptest.NewRequest("POST", "/api/icons/manifest.json", nil), "manifest.json")
	if rec.Code != 404 {
		t.Errorf("POST status = %d, want 404", rec.Code)
	}
}

// TestHandleIconsManifestRoute: GET /api/icons/manifest.json answers
// 200 with JSON carrying the three contract keys (content comes from the
// real icons dir, so assertions are shape-only).
func TestHandleIconsManifestRoute(t *testing.T) {
	rec := httptest.NewRecorder()
	handleIcons(rec, httptest.NewRequest("GET", "/api/icons/manifest.json", nil), "manifest.json")
	if rec.Code != 200 {
		t.Fatalf("manifest status = %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	var wire map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &wire); err != nil {
		t.Fatalf("manifest body: %v", err)
	}
	for _, key := range []string{"extracted", "count", "icons"} {
		if _, ok := wire[key]; !ok {
			t.Errorf("served manifest missing %q: %s", key, rec.Body.String())
		}
	}
}

// TestExtractIconsNoInstall: a cs2Dir without a VPK yields
// extracted=false plus a human-readable note — a fallback state, never a
// failure (the frontend keeps rendering text labels). Detection fails
// BEFORE extraction starts, so the progress callback must never fire:
// no run means no percentage is invented for the bar.
func TestExtractIconsNoInstall(t *testing.T) {
	var progressCalls int
	m := extractIcons(filepath.Join(t.TempDir(), "no-cs2"), "", t.TempDir(),
		func(done, total int) { progressCalls++ })
	if progressCalls != 0 {
		t.Errorf("progress fired %d times before extraction could start, want 0", progressCalls)
	}
	if m.Extracted || m.Count != 0 {
		t.Errorf("manifest = %+v, want nothing extracted", m)
	}
	if !strings.Contains(m.Note, "pak01_dir.vpk") {
		t.Errorf("note = %q, want the missing-VPK explanation", m.Note)
	}
	if len(m.Icons) != 0 {
		t.Errorf("icons = %v, want empty", m.Icons)
	}
}

// TestExtractIconsProgressEmitted runs the ICON service's extraction
// core against a real local CS2 install (mappack.FindCS2 auto-detects)
// with the shared spectra:asset-progress emitter wired in — the headless
// proof that a service-level run really fires the new emitter along a
// REAL extraction path: events arrive with an honest denominator (the
// canonical icon table, known before the first item) and the closing
// call lands exactly on it. Skipped when CS2 isn't installed (CI never
// has it — internal/mappack's synthetic TestExtractProgress carries the
// portable extractor coverage). Output is a temp dir; nothing
// Valve-derived is kept.
func TestExtractIconsProgressEmitted(t *testing.T) {
	cs2Dir := mappack.FindCS2("")
	if cs2Dir == "" {
		t.Skip("no local CS2 install found")
	}
	var seen []AssetProgressEvent
	m := extractIcons(cs2Dir, "", t.TempDir(),
		assetProgress(func(ev AssetProgressEvent) { seen = append(seen, ev) }, assetFamilyIcons))
	last := assertAssetProgressRun(t, assetFamilyIcons, seen)
	if !m.Extracted || m.Count == 0 {
		t.Fatalf("manifest = %+v, want extracted icons", m)
	}
	// The denominator must never undercount what the run actually wrote.
	if last.Total < m.Count {
		t.Errorf("denominator total %d < %d extracted icons", last.Total, m.Count)
	}
}
