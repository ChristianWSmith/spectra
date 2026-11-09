package mappack

import (
	"encoding/json"
	"fmt"
	"image/png"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestConcurrentExtractions pins the package extraction lock (extractMu
// in extract.go): concurrent runs over ONE synthetic install all succeed
// and leave valid, uncorrupted outputs. The fixture mirrors the app's
// real concurrency — two ExtractMapPacks into the SAME output dir (the
// launch prompt and Settings both extract packs) plus two ExtractIcons
// into the same icons dir (the prompt's accept and Replay's background
// auto-extract race the most in practice).
//
// The progress probes additionally prove the runs are SERIALIZED: each
// pack run sleeps inside its only progress callback, so an unlocked
// implementation would let the active counter reach 2.
func TestConcurrentExtractions(t *testing.T) {
	// Synthetic CS2 install: steam layout + VPK with one radar, its
	// overview, and two equipment icons (the TestExtractMapPacks /
	// TestExtractIconsSynthetic fixtures combined).
	install := t.TempDir()
	csgo := filepath.Join(install, "game", "csgo")
	if err := os.MkdirAll(csgo, 0o755); err != nil {
		t.Fatal(err)
	}
	const w, h = 8, 8
	radar := buildVTex(t, w, h, vtexFormatBGRA8888, bgraPix(w, h), true)
	const akSVG = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><path d="M1 1"/></svg>` + "\n"
	const hsSVG = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><path d="M2 2"/></svg>` + "\n"
	buildVPK(t, csgo, map[string][]byte{
		"panorama/images/overheadmaps/de_fixture_radar_psd.vtex_c": radar,
		"resource/overviews/de_fixture.txt": []byte(`"de_fixture"
{
	"pos_x"		"-100"
	"pos_y"		"200"
	"scale"		"4.0"
	"bombA_x"	"0.5"
	"bombA_y"	"0.6"
	"bombB_x"	"0.2"
	"bombB_y"	"0.3"
	"CTSpawn_x"	"0.1"
	"CTSpawn_y"	"0.2"
	"TSpawn_x"	"0.8"
	"TSpawn_y"	"0.9"
}
`),
		iconPrefix + "ak47" + iconSuffix:            buildVSVG(t, akSVG),
		noticePrefix + "icon_headshot" + iconSuffix: buildVSVG(t, hsSVG),
	})

	packOut := t.TempDir()
	iconOut := t.TempDir()

	// Serialization probe: while a pack run is inside its progress
	// callback the active counter is 1; a second run entering at the
	// same time would push it to 2 (extractMu must prevent that).
	var active, maxActive atomic.Int32
	probe := func(done, total int) {
		n := active.Add(1)
		for {
			old := maxActive.Load()
			if n <= old || maxActive.CompareAndSwap(old, n) {
				break
			}
		}
		time.Sleep(5 * time.Millisecond)
		active.Add(-1)
	}

	start := make(chan struct{})
	var wg sync.WaitGroup
	results := make(chan error, 4)
	runPack := func(i int) {
		defer wg.Done()
		<-start
		maps, errs, err := ExtractMapPacks(install, packOut, WithProgress(probe))
		switch {
		case err != nil:
			results <- fmt.Errorf("pack run %d: %w", i, err)
		case len(errs) > 0:
			results <- fmt.Errorf("pack run %d: unexpected errors %v", i, errs)
		case len(maps) != 1 || maps[0].Map != "de_fixture":
			results <- fmt.Errorf("pack run %d: maps = %v, want the fixture pack", i, maps)
		default:
			results <- nil
		}
	}
	runIcons := func(i int) {
		defer wg.Done()
		<-start
		names, errs, err := ExtractIcons(install, iconOut)
		switch {
		case err != nil:
			results <- fmt.Errorf("icon run %d: %w", i, err)
		// Both fixture icons extracted; every other table entry is
		// absent from the fixture VPK and lands in errs (the
		// TestExtractIconsSynthetic expectation).
		case len(errs) != len(extractTable)-2 || len(names) != 2:
			results <- fmt.Errorf("icon run %d: names=%v errs=%d, want 2 names and %d errors",
				i, names, len(errs), len(extractTable)-2)
		default:
			results <- nil
		}
	}
	for i := 0; i < 2; i++ {
		wg.Add(2)
		go runPack(i)
		go runIcons(i)
	}
	close(start)
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Error(err)
		}
	}
	if m := maxActive.Load(); m > 1 {
		t.Errorf("pack progress callbacks ran concurrently (max %d active) — extractMu is not serializing ExtractMapPacks", m)
	}

	// Outputs are intact after the interleaving: the pack decodes at the
	// expected size, meta.json parses with its transform, and both icon
	// files round-trip their exact payloads.
	f, err := os.Open(filepath.Join(packOut, "de_fixture", "radar.png"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	img, err := png.Decode(f)
	if err != nil {
		t.Fatalf("radar.png does not decode: %v", err)
	}
	if img.Bounds().Dx() != radarUpscale*w || img.Bounds().Dy() != radarUpscale*h {
		t.Errorf("png bounds = %v, want %dx%d", img.Bounds(), radarUpscale*w, radarUpscale*h)
	}
	metaRaw, err := os.ReadFile(filepath.Join(packOut, "de_fixture", "meta.json"))
	if err != nil {
		t.Fatal(err)
	}
	var meta packMeta
	if err := json.Unmarshal(metaRaw, &meta); err != nil {
		t.Fatalf("meta.json corrupt: %v", err)
	}
	if meta.Transform == nil || meta.Transform.Scale != 4 {
		t.Errorf("meta = %+v, want the fixture transform", meta)
	}
	for file, wantSVG := range map[string]string{"ak47.svg": akSVG, "icon_headshot.svg": hsSVG} {
		data, err := os.ReadFile(filepath.Join(iconOut, file))
		if err != nil {
			t.Fatalf("%s missing after concurrent runs: %v", file, err)
		}
		if string(data) != wantSVG {
			t.Errorf("%s = %q, want %q (corrupted by a concurrent run)", file, data, wantSVG)
		}
	}
	if files := IconFiles(iconOut); len(files) != 2 {
		t.Errorf("IconFiles = %v, want exactly the 2 fixture icons", files)
	}
}
