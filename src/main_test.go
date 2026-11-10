package main

import "testing"

// TestValidPackFile pins the /api/mappack file whitelist: meta.json and
// the extractor's radar image spellings pass; every path-segment or
// non-radar attempt fails (the whitelist is what keeps a crafted URL
// inside the pack dir — dropping it for the multi-floor layer images
// must not reopen ".." or an arbitrary filename).
func TestValidPackFile(t *testing.T) {
	valid := []string{
		"meta.json",
		"radar.png",
		"radar_lower.png",
		"radar_upper_r.png",
		"radar2.png",
	}
	for _, f := range valid {
		if !validPackFile(f) {
			t.Errorf("validPackFile(%q) = false, want true", f)
		}
	}
	invalid := []string{
		"",
		"..",
		"../evil.png",
		"..png",
		"radar..png",      // '.' not in the [0-9a-z_] set
		"radar_../x.png",  // contains '/'
		"radar/x.png",     // contains '/'
		"Radar.png",       // uppercase
		"radar.PNG",       // wrong case suffix
		"other.png",       // not a radar image
		"meta.json.bak",   // suffix spoof
		"meta.json/x",     // path segment
		"radar_upper.Png", // case
		"radar_a-b.png",   // '-' not allowed
	}
	for _, f := range invalid {
		if validPackFile(f) {
			t.Errorf("validPackFile(%q) = true, want false", f)
		}
	}
}

// TestValidPackName pins the map-dir whitelist (lowercase/digits/_,
// bounded length) — the pair to validPackFile.
func TestValidPackName(t *testing.T) {
	valid := []string{"de_mirage", "de_nuke", "ar_baggage", "0"}
	for _, s := range valid {
		if !validPackName(s) {
			t.Errorf("validPackName(%q) = false, want true", s)
		}
	}
	invalid := []string{"", "..", "de/mirage", "de Mirage", "De_mirage", "x\\y"}
	for _, s := range invalid {
		if validPackName(s) {
			t.Errorf("validPackName(%q) = true, want false", s)
		}
	}
}
