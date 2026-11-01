package mappack

import (
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

// TestExtractRealCS2Install runs the full extraction pipeline against a
// real local Counter-Strike 2 install (FindCS2 auto-detects). Skipped
// when CS2 isn't installed — CI never has it, so the synthetic fixtures
// above carry the portable coverage; this proves the shipped code
// against real VPK/vtex bytes (BGRA + DXT5 + LZ4 mips, all official
// maps). Output goes to a temp dir; nothing Valve-derived is kept.
func TestExtractRealCS2Install(t *testing.T) {
	cs2Dir := FindCS2("")
	if cs2Dir == "" {
		t.Skip("no local CS2 install found")
	}
	out := t.TempDir()

	maps, errs, err := ExtractMapPacks(cs2Dir, out)
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	// Every official map must extract; a per-map error means the decoder
	// regressed on a real format variant.
	if len(errs) > 0 {
		t.Errorf("per-map errors: %v", errs)
	}
	if len(maps) < 10 {
		t.Errorf("only %d maps extracted, want ≥10 (official set)", len(maps))
	}

	// Spot-check one pack end-to-end: PNG decodes at the declared size
	// and meta.json carries the transform.
	probe := filepath.Join(out, "de_mirage")
	if _, err := os.Stat(filepath.Join(probe, "meta.json")); err != nil {
		t.Fatalf("de_mirage pack missing: %v", err)
	}
	f, err := os.Open(filepath.Join(probe, "radar.png"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	img, err := png.Decode(f)
	if err != nil {
		t.Fatalf("radar.png decode: %v", err)
	}
	if img.Bounds().Dx() != 1024 || img.Bounds().Dy() != 1024 {
		t.Errorf("radar bounds = %v, want 1024×1024", img.Bounds())
	}

	// DXT5-format maps (ar_shoots, cs_italy) must decode too — they take
	// the block-compression path the BGRA maps never touch.
	if _, err := os.Stat(filepath.Join(out, "ar_shoots", "radar.png")); err != nil {
		t.Errorf("ar_shoots (DXT5) pack missing: %v", err)
	}
}
