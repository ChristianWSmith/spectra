package mappack

import (
	"image/png"
	"os"
	"path/filepath"
	"strings"
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

// TestExtractRealCS2Icons extracts the equipment-icon set from a real
// local CS2 install (FindCS2 auto-detects) into a temp dir and checks
// the contract the frontend keys on: the canonical names the replay
// stream emits are present, and every written file is a CRC-verified,
// well-formed SVG. Skipped when CS2 isn't installed (CI never has it —
// the synthetic fixtures carry the portable coverage). Nothing
// Valve-derived is kept: output is a temp dir.
func TestExtractRealCS2Icons(t *testing.T) {
	cs2Dir := FindCS2("")
	if cs2Dir == "" {
		t.Skip("no local CS2 install found")
	}
	out := t.TempDir()

	names, errs, err := ExtractIcons(cs2Dir, out)
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	// A per-name error means the table points at a file the game update
	// moved/renamed (or the decoder regressed) — surface it.
	if len(errs) > 0 {
		t.Errorf("per-icon errors: %v", errs)
	}
	if len(names) != len(iconTable) {
		t.Errorf("extracted %d icons, want %d (the whole table)", len(names), len(iconTable))
	}

	// Manifest keys other agents are coding against.
	files := IconFiles(out)
	for _, key := range []string{"AK-47", "Smoke Grenade", "C4", "Kevlar + Helmet"} {
		if files[key] == "" {
			t.Errorf("manifest key %q missing (have %d keys)", key, len(files))
		}
	}
	// Every file: non-empty, re-verifiable through the decoder (CRC +
	// SVG shape), and named as the route's whitelist expects.
	for name, file := range files {
		raw, err := os.ReadFile(filepath.Join(out, file))
		if err != nil {
			t.Errorf("%s: %v", file, err)
			continue
		}
		if len(raw) == 0 {
			t.Errorf("%s: empty file", file)
			continue
		}
		if !ValidIconFileBase(file) {
			t.Errorf("%s: fails the route whitelist", file)
		}
		body := string(raw)
		if !strings.HasPrefix(body, "<?xml") && !strings.HasPrefix(body, "<svg") {
			t.Errorf("%s: does not start like an SVG (%.20q)", file, body)
		}
		if !strings.Contains(body, "</svg>") {
			t.Errorf("%s: no </svg> terminator", file)
		}
		// The extraction-time decode already verified each on-disk CRC
		// (errs==0 above); this round trip re-checks the SVG text itself
		// survives the container encode/decode.
		if _, err := decodeVSVG(buildVSVG(t, body)); err != nil {
			t.Errorf("%s: round trip: %v", name, err)
		}
	}
}
