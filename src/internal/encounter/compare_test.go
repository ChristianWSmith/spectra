package encounter_test

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"sort"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/encounter"
	"github.com/ChristianWSmith/spectra/internal/source2"
)

// readMaterials reads the render material sidecar: the name table and each
// mesh's triangle material ids.
func readMaterials(path string) ([]string, [][]uint16, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 1<<20)
	var n uint32
	if err := binary.Read(r, binary.LittleEndian, &n); err != nil {
		return nil, nil, err
	}
	table := make([]string, n)
	for i := range table {
		var l uint32
		if err := binary.Read(r, binary.LittleEndian, &l); err != nil {
			return nil, nil, err
		}
		b := make([]byte, l)
		if _, err := io.ReadFull(r, b); err != nil {
			return nil, nil, err
		}
		table[i] = string(b)
	}
	var m uint32
	if err := binary.Read(r, binary.LittleEndian, &m); err != nil {
		return nil, nil, err
	}
	mats := make([][]uint16, m)
	for i := range mats {
		var t uint32
		if err := binary.Read(r, binary.LittleEndian, &t); err != nil {
			return nil, nil, err
		}
		mats[i] = make([]uint16, t)
		if err := binary.Read(r, binary.LittleEndian, mats[i]); err != nil {
			return nil, nil, err
		}
	}
	return table, mats, nil
}

// TestRenderVsCollision compares, kill by kill, whether the production box clears
// the kill against the render geometry and against the collision geometry, and
// lists the kills that only one of them clears. For kills only the render
// geometry blocks, it counts the materials of the triangles blocking the lines.
// Opt-in: SPECTRA_ENC, SPECTRA_DATA, SPECTRA_MAP, SPECTRA_RENDER_FILE (the
// .render file; its .mats sidecar is read alongside).
func TestRenderVsCollision(t *testing.T) {
	root, data, mp, file := os.Getenv("SPECTRA_ENC"), os.Getenv("SPECTRA_DATA"), os.Getenv("SPECTRA_MAP"), os.Getenv("SPECTRA_RENDER_FILE")
	if root == "" || data == "" || mp == "" || file == "" {
		t.Skip("set SPECTRA_ENC, SPECTRA_DATA, SPECTRA_MAP, SPECTRA_RENDER_FILE")
	}
	table, mats, err := readMaterials(file + ".mats")
	if err != nil {
		t.Fatal(err)
	}
	rf, err := os.Open(file)
	if err != nil {
		t.Fatal(err)
	}
	rmeshes, err := source2.ReadMeshes(rf)
	rf.Close()
	if err != nil {
		t.Fatal(err)
	}
	if len(mats) != len(rmeshes) {
		t.Fatalf("material sidecar has %d meshes, render file %d", len(mats), len(rmeshes))
	}
	bvhs := make([]*source2.BVH, len(rmeshes))
	for i := range rmeshes {
		bvhs[i] = source2.BuildBVH(&rmeshes[i])
	}
	// renderBlocked returns the material of a triangle blocking a..b, if any.
	renderBlocked := func(a, b [3]float64) (string, bool) {
		seg := source2.Segment{A: f32(a), B: f32(b)}
		for i, t := range bvhs {
			if ti, ok := t.BlockedBy(seg); ok {
				return table[mats[i][ti]], true
			}
		}
		return "", false
	}
	renderOcc := func(a, b [3]float64) bool {
		_, ok := renderBlocked(a, b)
		return ok
	}
	cf, err := os.Open(fmt.Sprintf("%s/worldcol/%s.worldcol", data, mp))
	if err != nil {
		t.Fatal(err)
	}
	cmeshes, err := source2.ReadMeshes(cf)
	cf.Close()
	if err != nil {
		t.Fatal(err)
	}
	collOcc := occFor(cmeshes)

	d := loadSweep(t, root, data)
	var ronly, conly, both, neither int
	conlyMats := map[string]int{}
	var conlyKills []string
	for _, k := range d.kills {
		if k.mp != mp {
			continue
		}
		rc, cc := clearKill(k, setting{encounter.ProductionBox, 0}, renderOcc), clearKill(k, setting{encounter.ProductionBox, 0}, collOcc)
		switch {
		case rc && cc:
			both++
		case rc:
			ronly++
			fmt.Printf("CMP render-only clear: %s\n", k.label)
		case cc:
			conly++
			// Materials of the first hit on each target, in the first frame.
			f := k.frames[0]
			var names []string
			for _, tg := range encounter.TargetsBox(f.enemy, encounter.ProductionBox) {
				if m, ok := renderBlocked(f.eye, tg); ok {
					names = append(names, m)
					conlyMats[m]++
				}
			}
			conlyKills = append(conlyKills, fmt.Sprintf("%s  render blockers: %v", k.label, names))
		default:
			neither++
		}
	}
	fmt.Printf("CMP %s: both clear %d, render-only clear %d, collision-only clear %d, neither %d\n", mp, both, ronly, conly, neither)
	for _, l := range conlyKills {
		fmt.Printf("CMP collision-only clear: %s\n", l)
	}
	type kv struct {
		m string
		n int
	}
	var top []kv
	for m, n := range conlyMats {
		top = append(top, kv{m, n})
	}
	sort.Slice(top, func(i, j int) bool { return top[i].n > top[j].n })
	for i, e := range top {
		if i >= 20 {
			break
		}
		fmt.Printf("CMPMAT %6d  %s\n", e.n, e.m)
	}
}
