package encounter_test

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/encounter"
	"github.com/ChristianWSmith/spectra/internal/source2"
)

// TestOccluderAblation takes the kills listed in sweep_wide.md (the ones no
// setting clears) and, for each, removes one world mesh at a time. A mesh is a
// clearing mesh when the kill has a clear line from some frame and target with
// that mesh removed and every other mesh kept. Writes ablation.md to
// SPECTRA_OVERLAY_OUT. Opt-in: SPECTRA_ENC, SPECTRA_DATA, SPECTRA_OVERLAY_OUT.
func TestOccluderAblation(t *testing.T) {
	root, data, out := os.Getenv("SPECTRA_ENC"), os.Getenv("SPECTRA_DATA"), os.Getenv("SPECTRA_OVERLAY_OUT")
	if root == "" || data == "" || out == "" {
		t.Skip("set SPECTRA_ENC, SPECTRA_DATA, SPECTRA_OVERLAY_OUT")
	}
	md, err := os.ReadFile(filepath.Join(out, "sweep_wide.md"))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{}
	for _, l := range strings.Split(string(md), "\n") {
		if strings.HasPrefix(l, "- ") {
			want[strings.TrimPrefix(l, "- ")] = true
		}
	}
	d := loadSweep(t, root, data)
	meshCache := map[string][]source2.Mesh{}
	meshesFor := func(mp string) []source2.Mesh {
		if m, ok := meshCache[mp]; ok {
			return m
		}
		f, err := os.Open(filepath.Join(data, "worldcol", mp+".worldcol"))
		if err != nil {
			t.Fatal(err)
		}
		m, err := source2.ReadMeshes(f)
		f.Close()
		if err != nil {
			t.Fatal(err)
		}
		meshCache[mp] = m
		return m
	}

	// blockedBy returns the meshes (other than skip) that hit the segment.
	hits := func(meshes []source2.Mesh, a, b [3]float64, skip int) bool {
		s := source2.Segment{A: f32(a), B: f32(b)}
		for mi := range meshes {
			if mi == skip {
				continue
			}
			if _, ok := meshes[mi].FirstHit(s); ok {
				return true
			}
		}
		return false
	}
	clearsWithout := func(k sweepKill, meshes []source2.Mesh, skip int) bool {
		for _, f := range k.frames {
			for _, tg := range encounter.TargetsBox(f.enemy, encounter.ProductionBox) {
				if !hits(meshes, f.eye, tg, skip) {
					return true
				}
			}
		}
		return false
	}

	single := map[string]int{}
	var sb strings.Builder
	fmt.Fprintf(&sb, "# Occluder ablation\n\nKills tested: the %d that no setting clears in sweep_wide.md.\n\n", len(want))
	n := 0
	for _, k := range d.kills {
		if !want[k.label] {
			continue
		}
		n++
		meshes := meshesFor(k.mp)
		cands := map[int]bool{}
		for _, f := range k.frames {
			for _, tg := range encounter.TargetsBox(f.enemy, encounter.ProductionBox) {
				s := source2.Segment{A: f32(f.eye), B: f32(tg)}
				for mi := range meshes {
					if _, ok := meshes[mi].FirstHit(s); ok {
						cands[mi] = true
					}
				}
			}
		}
		var ids []int
		for mi := range cands {
			ids = append(ids, mi)
		}
		sort.Ints(ids)
		var clearers []int
		for _, mi := range ids {
			if clearsWithout(k, meshes, mi) {
				clearers = append(clearers, mi)
				single[fmt.Sprintf("%s/%d", k.mp, mi)]++
			}
		}
		if len(clearers) == 0 {
			fmt.Fprintf(&sb, "- %s: %d candidate meshes; removing any one does not clear it\n", k.label, len(ids))
			continue
		}
		var parts []string
		for _, mi := range clearers {
			parts = append(parts, fmt.Sprintf("mesh %d (%d tris)", mi, len(meshes[mi].Triangles)))
		}
		fmt.Fprintf(&sb, "- %s: removing %s clears it\n", k.label, strings.Join(parts, ", "))
	}
	sb.WriteString("\n## Meshes that clear the most kills alone\n\n| map and mesh | triangles | bounding box min | bounding box max | kills cleared alone |\n|---|---|---|---|---|\n")
	var keys []string
	for key := range single {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(a, b int) bool { return single[keys[a]] > single[keys[b]] })
	for _, key := range keys {
		var mp string
		var mi int
		fmt.Sscanf(strings.Replace(key, "/", " ", 1), "%s %d", &mp, &mi)
		m := meshesFor(mp)[mi]
		fmt.Fprintf(&sb, "| %s mesh %d | %d | %.0f | %.0f | %d |\n", mp, mi, len(m.Triangles), m.Min, m.Max, single[key])
	}
	if err := os.WriteFile(filepath.Join(out, "ablation.md"), []byte(sb.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	fmt.Printf("ABLATION tested %d kills; meshes that clear at least one alone: %d\n", n, len(keys))
}

// TestDenseGapCheck tests the narrow-gap hypothesis for the kills in sweep_wide.md:
// a gap in a solid-looking mesh is missed by sparse sample points but hit by a
// dense field. Every frame's eye reaches a 2-unit-spaced grid across the enemy's
// body (9 x 9 x 10 points, first 10 frames). Opt-in with the same environment as TestOccluderAblation.
func TestDenseGapCheck(t *testing.T) {
	root, data, out := os.Getenv("SPECTRA_ENC"), os.Getenv("SPECTRA_DATA"), os.Getenv("SPECTRA_OVERLAY_OUT")
	if root == "" || data == "" || out == "" {
		t.Skip("set SPECTRA_ENC, SPECTRA_DATA, SPECTRA_OVERLAY_OUT")
	}
	md, err := os.ReadFile(filepath.Join(out, "sweep_wide.md"))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{}
	for _, l := range strings.Split(string(md), "\n") {
		if strings.HasPrefix(l, "- ") {
			want[strings.TrimPrefix(l, "- ")] = true
		}
	}
	one := os.Getenv("SPECTRA_ONE") // optional: only kills whose label contains this
	d := loadSweep(t, root, data)
	cache := map[string][]source2.Mesh{}
	n, clearDense := 0, 0
	var lines []string
	for _, k := range d.kills {
		if !want[k.label] || (one != "" && !strings.Contains(k.label, one)) {
			continue
		}
		n++
		meshes, ok := cache[k.mp]
		if !ok {
			f, err := os.Open(filepath.Join(data, "worldcol", k.mp+".worldcol"))
			if err != nil {
				t.Fatal(err)
			}
			meshes, err = source2.ReadMeshes(f)
			f.Close()
			if err != nil {
				t.Fatal(err)
			}
			cache[k.mp] = meshes
		}
		clear := false
	outer:
		for fi, f := range k.frames {
			if fi >= 10 {
				break
			}
			for dx := -16.0; dx <= 16; dx += 4 {
				for dy := -16.0; dy <= 16; dy += 4 {
					for z := 0.0; z <= 72; z += 8 {
						tg := [3]float64{f.enemy.X + dx, f.enemy.Y + dy, f.enemy.Z + z}
						if !hitsAny(meshes, f.eye, tg, -1) {
							clear = true
							break outer
						}
					}
				}
			}
		}
		if clear {
			clearDense++
		}
		fmt.Printf("DENSEPROG %d/%d clear=%v %s\n", n, len(want), clear, k.label)
		lines = append(lines, fmt.Sprintf("- %s: %v", k.label, map[bool]string{true: "dense field finds a clear line", false: "still blocked"}[clear]))
	}
	md2 := fmt.Sprintf("# Dense gap check\n\nKills tested: %d. Dense field (4-unit spacing across the body, 9 x 9 x 10 points per frame, first 10 frames) finds a clear line for %d of them.\n\n%s\n",
		n, clearDense, strings.Join(lines, "\n"))
	if err := os.WriteFile(filepath.Join(out, "dense_gap.md"), []byte(md2), 0o644); err != nil {
		t.Fatal(err)
	}
	fmt.Printf("DENSE tested %d kills; dense field clears %d\n", n, clearDense)
}

// hitsAny reports whether any mesh (other than skip) blocks the segment a to b.
func hitsAny(meshes []source2.Mesh, a, b [3]float64, skip int) bool {
	s := source2.Segment{A: f32(a), B: f32(b)}
	for mi := range meshes {
		if mi == skip {
			continue
		}
		if _, ok := meshes[mi].FirstHit(s); ok {
			return true
		}
	}
	return false
}
