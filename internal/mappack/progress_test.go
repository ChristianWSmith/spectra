package mappack

import (
	"os"
	"path/filepath"
	"testing"
)

// TestExtractProgress pins WithProgress (extractConfig.progress) — the OPTIONAL
// trailing option all three extractors share: exactly one call per
// completed item, done strictly increasing from 1 up to the run's item
// count (the shape of extract.ParseOptions.Progress; see
// internal/extract/agg_test.go TestProgressCallback). Items that fail
// (a texture absent from the VPK, an undecodable resource) still count
// as completed, so the final call always reports the full total. The
// option is optional: every extractor test above runs without it.
func TestExtractProgress(t *testing.T) {
	type call struct{ done, total int }

	assertProgress := func(t *testing.T, family string, calls []call, total int) {
		t.Helper()
		if len(calls) != total {
			t.Fatalf("%s: %d progress calls, want %d: %v", family, len(calls), total, calls)
		}
		for i, c := range calls {
			if c.done != i+1 || c.total != total {
				t.Errorf("%s: call %d = %+v, want {done:%d total:%d}", family, i, c, i+1, total)
			}
			if i > 0 && c.done <= calls[i-1].done {
				t.Errorf("%s: done not increasing: %v", family, calls)
			}
		}
	}

	// Map packs: three radars, no overviews (each is a plain pack).
	t.Run("map packs", func(t *testing.T) {
		install := t.TempDir()
		csgo := filepath.Join(install, "game", "csgo")
		if err := os.MkdirAll(csgo, 0o755); err != nil {
			t.Fatal(err)
		}
		const w, h = 8, 8
		radar := buildVTex(t, w, h, vtexFormatBGRA8888, bgraPix(w, h), true)
		files := map[string][]byte{}
		for _, m := range []string{"de_alpha", "de_bravo", "de_charlie"} {
			files["panorama/images/overheadmaps/"+m+"_radar_psd.vtex_c"] = radar
		}
		buildVPK(t, csgo, files)

		var calls []call
		_, errs, err := ExtractMapPacks(install, t.TempDir(),
			WithProgress(func(done, total int) { calls = append(calls, call{done, total}) }))
		if err != nil {
			t.Fatal(err)
		}
		if len(errs) > 0 {
			t.Fatalf("unexpected errors: %v", errs)
		}
		assertProgress(t, "map packs", calls, 3)
	})

	// Icons: one equipment icon present, the rest absent. The total is
	// every canonical icon the run attempts — absent ones land in errs
	// but still complete, so done still reaches the total.
	t.Run("icons", func(t *testing.T) {
		install := t.TempDir()
		csgo := filepath.Join(install, "game", "csgo")
		if err := os.MkdirAll(csgo, 0o755); err != nil {
			t.Fatal(err)
		}
		const svg = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><path d="M1 1"/></svg>` + "\n"
		buildVPK(t, csgo, map[string][]byte{
			iconPrefix + "ak47" + iconSuffix: buildVSVG(t, svg),
		})

		var calls []call
		_, _, err := ExtractIcons(install, t.TempDir(),
			WithProgress(func(done, total int) { calls = append(calls, call{done, total}) }))
		if err != nil {
			t.Fatal(err)
		}
		assertProgress(t, "icons", calls, len(extractTableNames))
	})

	// Sounds: one single-variant canonical sound present (the Galil),
	// the whole table still attempted — same total rule as icons.
	t.Run("sounds", func(t *testing.T) {
		install := t.TempDir()
		csgo := filepath.Join(install, "game", "csgo")
		if err := os.MkdirAll(csgo, 0o755); err != nil {
			t.Fatal(err)
		}
		buildVPK(t, csgo, map[string][]byte{
			soundTable["Galil AR"][0]: buildVSndV4(t, 44100, 0 /*PCM16*/, 1, 4, make([]byte, 8)),
		})

		var calls []call
		_, _, err := ExtractSounds(install, t.TempDir(),
			WithProgress(func(done, total int) { calls = append(calls, call{done, total}) }))
		if err != nil {
			t.Fatal(err)
		}
		assertProgress(t, "sounds", calls, len(soundTableNames))
	})
}
