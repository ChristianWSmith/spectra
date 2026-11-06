package main

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestBuildIconManifest pins the served manifest contract: fresh dir
// listing, canonical-name keys → /api/icons URLs, strays ignored, and
// the empty-dir fallback shape the frontend normalizes.
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
	write("flair0.svg", `<svg/>`) // real VPK file, but not in the canonical table
	write("notes.txt", "stray")

	m := buildIconManifest(dir)
	if !m.Extracted || m.Count != 2 || len(m.Icons) != 2 {
		t.Fatalf("manifest = %+v", m)
	}
	if m.Icons["AK-47"] != "/api/icons/ak47.svg" {
		t.Errorf(`manifest["AK-47"] = %q`, m.Icons["AK-47"])
	}
	if m.Icons["Smoke Grenade"] != "/api/icons/smokegrenade.svg" {
		t.Errorf(`manifest["Smoke Grenade"] = %q`, m.Icons["Smoke Grenade"])
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
	for _, key := range []string{"extracted", "count", "icons"} {
		if _, ok := wire[key]; !ok {
			t.Errorf("manifest JSON missing %q: %s", key, raw)
		}
	}
	if _, ok := wire["note"]; ok {
		t.Errorf("note must be omitempty (absent when empty): %s", raw)
	}

	// Empty dir → the fail-soft shape: extracted=false, empty maps.
	empty := buildIconManifest(filepath.Join(dir, "nope"))
	if empty.Extracted || empty.Count != 0 || empty.Icons == nil || len(empty.Icons) != 0 {
		t.Errorf("empty manifest = %+v", empty)
	}
}

// TestServeIconFile exercises the /api/icons/<file>.svg whitelist: valid
// names serve with the SVG content type, every traversal/case/extension
// variant 404s (mirror of the map-pack route's rejection style).
func TestServeIconFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "c4.svg"), []byte(`<svg/>`), 0o644); err != nil {
		t.Fatal(err)
	}
	get := func(name string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		serveIconFile(rec, httptest.NewRequest("GET", "/api/icons/"+name, nil), dir, name)
		return rec
	}

	rec := get("c4.svg")
	if rec.Code != 200 {
		t.Fatalf("valid icon status = %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "image/svg+xml" {
		t.Errorf("Content-Type = %q, want image/svg+xml", ct)
	}

	for _, name := range []string{
		"missing.svg", "../c4.svg", "sub/c4.svg", "/etc/passwd",
		"C4.svg", "c4.png", "c4", "", "manifest.json", "..",
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
// failure (the frontend keeps rendering text labels).
func TestExtractIconsNoInstall(t *testing.T) {
	m := extractIcons(filepath.Join(t.TempDir(), "no-cs2"), "", t.TempDir())
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
