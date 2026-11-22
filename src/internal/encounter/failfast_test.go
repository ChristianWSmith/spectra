package encounter_test

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
)

// TestFailFast searches the parameter grid for settings that clear every kill.
// A setting is rejected at the first kill it fails to clear. The kills listed in
// sweep_wide.md (the ones the earlier search could not clear) are tried first, so
// most settings are rejected within a few kills. Writes failfast.md to
// SPECTRA_OVERLAY_OUT. Opt-in with the same environment as TestWideSweep.
func TestFailFast(t *testing.T) {
	root, data, out := os.Getenv("SPECTRA_ENC"), os.Getenv("SPECTRA_DATA"), os.Getenv("SPECTRA_OVERLAY_OUT")
	if root == "" || data == "" || out == "" {
		t.Skip("set SPECTRA_ENC, SPECTRA_DATA, SPECTRA_OVERLAY_OUT")
	}
	md, err := os.ReadFile(filepath.Join(out, "sweep_wide.md"))
	if err != nil {
		t.Fatal(err)
	}
	hard := map[string]bool{}
	for _, l := range strings.Split(string(md), "\n") {
		if strings.HasPrefix(l, "- ") {
			hard[strings.TrimPrefix(l, "- ")] = true
		}
	}
	d := loadSweep(t, root, data)
	var ordered []sweepKill
	for _, k := range d.kills {
		if hard[k.label] {
			ordered = append(ordered, k)
		}
	}
	for _, k := range d.kills {
		if !hard[k.label] {
			ordered = append(ordered, k)
		}
	}
	settings := settingGrid()
	fmt.Printf("FAILFAST kills %d (dropped with no frames: %d), settings %d, hard-first %d\n",
		len(d.kills), d.noFrames, len(settings), len(hard))

	type res struct {
		passed   bool
		failedAt int // index into ordered of the first kill not cleared
		kills    int // kills tried before the first failure (or all, if passed)
	}
	results := make([]res, len(settings))
	var wg sync.WaitGroup
	idx := make(chan int)
	workers := 8
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for si := range idx {
				s := settings[si]
				r := res{passed: true, failedAt: -1}
				for i, k := range ordered {
					r.kills = i + 1
					if !clearKill(k, s, d.occs[k.mp]) {
						r.passed = false
						r.failedAt = i
						break
					}
				}
				results[si] = r
			}
		}()
	}
	for si := range settings {
		idx <- si
	}
	close(idx)
	wg.Wait()

	var passing []int
	firstFail := map[string]int{}
	for si, r := range results {
		if r.passed {
			passing = append(passing, si)
		} else {
			firstFail[ordered[r.failedAt].label]++
		}
	}
	// Least permissive first: fewest random opposing pairs that look clear.
	type cand struct {
		si      int
		control int
	}
	var cands []cand
	for _, si := range passing {
		c := 0
		for _, p := range d.control {
			if clearKill(p, settings[si], d.occs[p.mp]) {
				c++
			}
		}
		cands = append(cands, cand{si, c})
	}
	sort.Slice(cands, func(a, b int) bool { return cands[a].control < cands[b].control })

	var sb strings.Builder
	fmt.Fprintf(&sb, "# Fail-fast search\n\nKills: %d (dropped with no sidecar frames in the window: %d). Settings: %d. Passing every kill: %d.\n\n",
		len(d.kills), d.noFrames, len(settings), len(passing))
	if len(passing) == 0 {
		sb.WriteString("No setting clears every kill. Most common first failure:\n\n")
		type kv struct {
			label string
			n     int
		}
		var top []kv
		for l, n := range firstFail {
			top = append(top, kv{l, n})
		}
		sort.Slice(top, func(a, b int) bool { return top[a].n > top[b].n })
		for i, e := range top {
			if i >= 10 {
				break
			}
			fmt.Fprintf(&sb, "- %s: stops %d settings\n", e.label, e.n)
		}
	} else {
		sb.WriteString("| sampler | half-width | top stand/crouch | mid | lateral | forward | eye shift | random-pair clears |\n|---|---|---|---|---|---|---|---|\n")
		for _, c := range cands {
			s := settings[c.si].box
			sampler := "corners"
			if s.Grid {
				sampler = "grid"
			}
			fmt.Fprintf(&sb, "| %s | %.0f | %.0f/%.0f | %.2f | %+.0f | %+.0f | %+.0f | %d of %d |\n", sampler,
				s.HalfWidth, s.TopStand, s.TopCrouch, s.Frac, s.Lat, s.Fwd, settings[c.si].eyeShift, c.control, len(d.control))
		}
	}
	if err := os.WriteFile(filepath.Join(out, "failfast.md"), []byte(sb.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	fmt.Printf("FAILFAST passing %d of %d settings\n", len(passing), len(settings))
}
