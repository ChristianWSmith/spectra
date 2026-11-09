package mappack

import (
	"encoding/json"
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

	// Spot-check one pack end-to-end: PNG decodes at the upscaled size,
	// meta.json still declares the LOGICAL 1024×1024 (world mapping) and
	// carries the transform.
	probe := filepath.Join(out, "de_mirage")
	metaRaw, err := os.ReadFile(filepath.Join(probe, "meta.json"))
	if err != nil {
		t.Fatalf("de_mirage pack missing: %v", err)
	}
	var meta packMeta
	if err := json.Unmarshal(metaRaw, &meta); err != nil {
		t.Fatalf("de_mirage meta.json: %v", err)
	}
	if meta.Radar == nil || meta.Radar.Width != 1024 || meta.Radar.Height != 1024 {
		t.Errorf("meta.radar = %+v, want logical 1024×1024", meta.Radar)
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
	// The radar file is upscaled ×2 (2048) while meta.radar stays at the
	// logical 1024×1024 — asserted above against meta.json.
	if img.Bounds().Dx() != 2048 || img.Bounds().Dy() != 2048 {
		t.Errorf("radar bounds = %v, want 2048×2048 (2× the 1024 source)", img.Bounds())
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
	// Both families extract: the equipment table AND the death-notice
	// glyphs (extractTable = the merged set ExtractIcons walks).
	if len(names) != len(extractTable) {
		t.Errorf("extracted %d icons, want %d (the whole table)", len(names), len(extractTable))
	}

	// Manifest keys other agents are coding against (incl. the renderer's
	// kill-feed indicators — every file verified present + decodable on a
	// real install 2026-11-07).
	files := IconFiles(out)
	for _, key := range []string{
		"AK-47", "Smoke Grenade", "C4", "Kevlar + Helmet",
		"headshot", "blind_kill", "noscope", "throughsmoke", "wallbang",
		"airborne", "suicide", "explosion",
	} {
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
