package mappack

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/source2"
)

// TestDumpResource prints the top-level keys of a KV3 resource in a map VPK, and
// the first element of each list. Opt-in: SPECTRA_RES (path inside the VPK, e.g.
// maps/de_anubis.vents), SPECTRA_MAP.
func TestDumpResource(t *testing.T) {
	res := os.Getenv("SPECTRA_RES")
	if res == "" {
		t.Skip("set SPECTRA_RES")
	}
	mp := envOr("SPECTRA_MAP", "de_anubis")
	home, _ := os.UserHomeDir()
	v, err := openVPK(filepath.Join(home, ".steam/steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/maps/"+mp+".vpk"))
	if err != nil {
		t.Fatal(err)
	}
	defer v.close()
	shared, err := openVPK(filepath.Join(home, ".steam/steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/pak01_dir.vpk"))
	if err != nil {
		t.Fatal(err)
	}
	defer shared.close()
	data, found, err := (chainedVPK{v, shared}).read(res + "_c")
	if err != nil || !found {
		t.Fatalf("read %s: %v %v", res, found, err)
	}
	blocks, err := source2.ParseResource(data)
	if err != nil {
		t.Fatal(err)
	}
	for _, b := range blocks {
		fmt.Printf("RES block %s %d\n", b.Type, len(b.Data))
	}
	d, ok := source2.FindBlock(blocks, "DATA")
	if !ok {
		t.Fatal("no DATA")
	}
	kv, err := source2.Decode(d)
	if err != nil {
		t.Fatal(err)
	}
	root, _ := kv.Root.(map[string]any)
	for k, val := range root {
		switch x := val.(type) {
		case []any:
			fmt.Printf("RES %s: list %d", k, len(x))
			if len(x) > 0 {
				s := fmt.Sprint(x[0])
				if len(s) > 400 {
					s = s[:400]
				}
				fmt.Printf(" first=%s", strings.ReplaceAll(s, "\n", " "))
			}
			fmt.Println()
		default:
			s := fmt.Sprint(val)
			if len(s) > 200 {
				s = s[:200]
			}
			fmt.Printf("RES %s = %s\n", k, s)
		}
	}
}

// TestEntityModels prints the entities of a map's default entity resource that
// place a model: class, model, origin, angles and scales. Opt-in: SPECTRA_ENTS=1.
func TestEntityModels(t *testing.T) {
	if os.Getenv("SPECTRA_ENTS") == "" {
		t.Skip("set SPECTRA_ENTS=1")
	}
	mp := envOr("SPECTRA_MAP", "de_anubis")
	home, _ := os.UserHomeDir()
	v, err := openVPK(filepath.Join(home, ".steam/steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/maps/"+mp+".vpk"))
	if err != nil {
		t.Fatal(err)
	}
	defer v.close()
	data, found, err := v.read("maps/" + mp + "/entities/default_ents.vents_c")
	if err != nil || !found {
		t.Fatalf("read: %v %v", found, err)
	}
	blocks, err := source2.ParseResource(data)
	if err != nil {
		t.Fatal(err)
	}
	d, _ := source2.FindBlock(blocks, "DATA")
	kv, err := source2.Decode(d)
	if err != nil {
		t.Fatal(err)
	}
	root, _ := kv.Root.(map[string]any)
	ents, _ := root["m_entityKeyValues"].([]any)
	classes := map[string]int{}
	withModel := 0
	for i, e := range ents {
		em, _ := e.(map[string]any)
		kvd, _ := em["keyValues3Data"].(map[string]any)
		vals, _ := kvd["values"].(map[string]any)
		cls := fmt.Sprint(vals["classname"])
		classes[cls]++
		if _, ok := vals["model"]; ok {
			withModel++
			if withModel <= 3 {
				fmt.Printf("ENT %d %s model=%v origin=%v angles=%v scales=%v keys=%d\n", i, cls, vals["model"], vals["origin"], vals["angles"], vals["scales"], len(vals))
			}
		}
	}
	fmt.Printf("ENTS %s: %d entities, %d with a model\n", mp, len(ents), withModel)
	for c, n := range classes {
		fmt.Printf("ENTCLASS %6d %s\n", n, c)
	}
}

// TestSceneObjects prints the field names and short values of one scene object
// of a world node file, and counts of the models it references. Opt-in:
// SPECTRA_SCENE=<resource path>, SPECTRA_MAP.
func TestSceneObjects(t *testing.T) {
	res := os.Getenv("SPECTRA_SCENE")
	if res == "" {
		t.Skip("set SPECTRA_SCENE")
	}
	mp := envOr("SPECTRA_MAP", "de_cache")
	home, _ := os.UserHomeDir()
	v, err := openVPK(filepath.Join(home, ".steam/steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/maps/"+mp+".vpk"))
	if err != nil {
		t.Fatal(err)
	}
	defer v.close()
	data, found, err := v.read(res + "_c")
	if err != nil || !found {
		t.Fatalf("read: %v %v", found, err)
	}
	blocks, err := source2.ParseResource(data)
	if err != nil {
		t.Fatal(err)
	}
	d, _ := source2.FindBlock(blocks, "DATA")
	kv, err := source2.Decode(d)
	if err != nil {
		t.Fatal(err)
	}
	root, _ := kv.Root.(map[string]any)
	objs, _ := root["m_sceneObjects"].([]any)
	models := map[string]int{}
	for _, o := range objs {
		om, _ := o.(map[string]any)
		models[fmt.Sprint(om["m_renderableModel"])]++
	}
	fmt.Printf("SCENE objects %d, distinct models %d\n", len(objs), len(models))
	if len(objs) > 0 {
		om, _ := objs[0].(map[string]any)
		for k, val := range om {
			s := fmt.Sprint(val)
			if len(s) > 160 {
				s = s[:160]
			}
			fmt.Printf("SCENEFIELD %s = %s\n", k, s)
		}
	}
	var keys []string
	for m := range models {
		keys = append(keys, m)
	}
	sort.Strings(keys)
	for i, m := range keys {
		if i < 3 {
			fmt.Printf("SCENEMODEL %d %s\n", models[m], m)
		}
	}
}

// TestWorldNodeUsage relates a world node file's scene objects and aggregate
// objects to the models in the archive's worldnodes folder. Opt-in: SPECTRA_USE=<node path>.
func TestWorldNodeUsage(t *testing.T) {
	node := os.Getenv("SPECTRA_USE")
	if node == "" {
		t.Skip("set SPECTRA_USE")
	}
	mp := envOr("SPECTRA_MAP", "de_cache")
	home, _ := os.UserHomeDir()
	v, err := openVPK(filepath.Join(home, ".steam/steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/maps/"+mp+".vpk"))
	if err != nil {
		t.Fatal(err)
	}
	defer v.close()
	data, found, err := v.read(node + "_c")
	if err != nil || !found {
		t.Fatalf("read: %v %v", found, err)
	}
	blocks, _ := source2.ParseResource(data)
	d, _ := source2.FindBlock(blocks, "DATA")
	kv, _ := source2.Decode(d)
	root, _ := kv.Root.(map[string]any)
	scene := map[string]int{}
	identity, placed := 0, 0
	objs, _ := root["m_sceneObjects"].([]any)
	for _, o := range objs {
		om, _ := o.(map[string]any)
		scene[fmt.Sprint(om["m_renderableModel"])]++
		if isIdentity(om["m_vTransform"]) {
			identity++
		} else {
			placed++
		}
	}
	agg := map[string]int{}
	aobjs, _ := root["m_aggregateSceneObjects"].([]any)
	var aggFields []string
	for i, o := range aobjs {
		om, _ := o.(map[string]any)
		if i == 0 {
			for k := range om {
				aggFields = append(aggFields, k)
			}
		}
		agg[fmt.Sprint(om["m_renderableModel"])]++
	}
	fmt.Printf("USE scene objects %d: %d identity, %d placed; distinct scene models %d\n", len(objs), identity, placed, len(scene))
	fmt.Printf("USE aggregate objects %d; distinct aggregate models %d; aggregate fields %v\n", len(aobjs), len(agg), aggFields)
	dir := map[string]bool{}
	for name := range v.entries {
		if strings.HasPrefix(name, "maps/"+mp+"/worldnodes/") && strings.HasSuffix(name, ".vmdl_c") {
			dir[strings.TrimSuffix(name, "_c")] = true
		}
	}
	inScene, inAgg, neither := 0, 0, 0
	for m := range dir {
		_, s := scene[m]
		_, a := agg[m]
		switch {
		case s:
			inScene++
		case a:
			inAgg++
		default:
			neither++
		}
	}
	fmt.Printf("USE folder models %d: in scene objects %d, only in aggregates %d, in neither %d\n", len(dir), inScene, inAgg, neither)
	missing := 0
	for m := range scene {
		if !dir[m] {
			missing++
		}
	}
	fmt.Printf("USE scene models absent from the folder: %d\n", missing)
}

// isIdentity reports whether a 3x4 row-major transform is the identity.
func isIdentity(v any) bool {
	rows, ok := v.([]any)
	if !ok || len(rows) != 3 {
		return false
	}
	want := [3][4]float64{{1, 0, 0, 0}, {0, 1, 0, 0}, {0, 0, 1, 0}}
	for i, r := range rows {
		rr, ok := r.([]any)
		if !ok || len(rr) != 4 {
			return false
		}
		for j, e := range rr {
			if entityNumber(e) != want[i][j] {
				return false
			}
		}
	}
	return true
}

// TestAggregateCounts prints, for a world node file, the number of aggregate
// objects, their fragments, distinct draw calls and transforms. Opt-in: SPECTRA_AGG=<node path>.
func TestAggregateCounts(t *testing.T) {
	node := os.Getenv("SPECTRA_AGG")
	if node == "" {
		t.Skip("set SPECTRA_AGG")
	}
	mp := envOr("SPECTRA_MAP", "de_ancient")
	home, _ := os.UserHomeDir()
	v, err := openVPK(filepath.Join(home, ".steam/steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/maps/"+mp+".vpk"))
	if err != nil {
		t.Fatal(err)
	}
	defer v.close()
	data, _, _ := v.read(node + "_c")
	blocks, _ := source2.ParseResource(data)
	d, _ := source2.FindBlock(blocks, "DATA")
	kv, _ := source2.Decode(d)
	root, _ := kv.Root.(map[string]any)
	aobjs, _ := root["m_aggregateSceneObjects"].([]any)
	frags, withT, transforms := 0, 0, 0
	distinct := map[int]bool{}
	for i, o := range aobjs {
		om, _ := o.(map[string]any)
		fm, _ := om["m_aggregateMeshes"].([]any)
		ft, _ := om["m_fragmentTransforms"].([]any)
		frags += len(fm)
		transforms += len(ft)
		for _, f := range fm {
			fmm, _ := f.(map[string]any)
			distinct[kvInt(fmm["m_nDrawCallIndex"])] = true
			if b, _ := fmm["m_bHasTransform"].(bool); b {
				withT++
			}
		}
		if i == 0 {
			fmt.Printf("AGG first object fragments %d, transforms %d, model %v\n", len(fm), len(ft), om["m_renderableModel"])
		}
	}
	fmt.Printf("AGG objects %d, fragments %d, fragments with transform %d, transforms listed %d, distinct draw indices %d\n",
		len(aobjs), frags, withT, transforms, len(distinct))
}

// TestFragmentCoverage compares, for each aggregate object of a world node file,
// the model's triangles with the triangles its fragments keep. Opt-in: SPECTRA_COV=<node>.
func TestFragmentCoverage(t *testing.T) {
	node := os.Getenv("SPECTRA_COV")
	if node == "" {
		t.Skip("set SPECTRA_COV")
	}
	mp := envOr("SPECTRA_MAP", "de_ancient")
	home, _ := os.UserHomeDir()
	v, err := openVPK(filepath.Join(home, ".steam/steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/maps/"+mp+".vpk"))
	if err != nil {
		t.Fatal(err)
	}
	defer v.close()
	shared, _ := openVPK(filepath.Join(home, ".steam/steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/pak01_dir.vpk"))
	defer shared.close()
	cv := chainedVPK{v, shared}
	data, _, _ := v.read(node + "_c")
	blocks, _ := source2.ParseResource(data)
	d, _ := source2.FindBlock(blocks, "DATA")
	kv, _ := source2.Decode(d)
	root, _ := kv.Root.(map[string]any)
	aobjs, _ := root["m_aggregateSceneObjects"].([]any)
	rm := &renderMaterials{index: map[string]uint16{}}
	totalModel, totalKept, lost := 0, 0, 0
	shown := 0
	for _, o := range aobjs {
		om, _ := o.(map[string]any)
		model := modelPath(om["m_renderableModel"])
		m, mats, draws, err := renderModelRaw(cv, model, rm)
		if err != nil {
			continue
		}
		fm, km, _, _, err := aggregateFragments(m, mats, draws, om)
		if err != nil {
			t.Fatal(err)
		}
		kept := 0
		for _, x := range fm {
			kept += len(x.Triangles)
		}
		_ = km
		totalModel += len(m.Triangles)
		totalKept += kept
		if kept < len(m.Triangles) {
			lost++
			if shown < 3 {
				shown++
				fmt.Printf("COV %s: model tris %d, fragments keep %d, draws %d, scene objects in mesh %d\n", model, len(m.Triangles), kept, len(draws), len(draws))
			}
		}
	}
	fmt.Printf("COV %s: model triangles %d, kept by fragments %d, objects losing triangles %d of %d\n", mp, totalModel, totalKept, lost, len(aobjs))
}

// TestDumpCTRL prints the CTRL block's top-level keys and the first embedded mesh's
// fields, for a model in the shared or map archive. Opt-in: SPECTRA_CTRL=<model>.
func TestDumpCTRL(t *testing.T) {
	res := os.Getenv("SPECTRA_CTRL")
	if res == "" {
		t.Skip("set SPECTRA_CTRL")
	}
	mp := envOr("SPECTRA_MAP", "de_ancient")
	home, _ := os.UserHomeDir()
	v, err := openVPK(filepath.Join(home, ".steam/steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/maps/"+mp+".vpk"))
	if err != nil {
		t.Fatal(err)
	}
	defer v.close()
	shared, err := openVPK(filepath.Join(home, ".steam/steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/pak01_dir.vpk"))
	if err != nil {
		t.Fatal(err)
	}
	defer shared.close()
	data, found, err := (chainedVPK{v, shared}).read(res + "_c")
	if err != nil || !found {
		t.Fatalf("read: %v %v", found, err)
	}
	blocks, _ := source2.ParseResource(data)
	c, ok := source2.FindBlock(blocks, "CTRL")
	if !ok {
		t.Fatal("no CTRL")
	}
	kv, err := source2.Decode(c)
	if err != nil {
		t.Fatal(err)
	}
	root, _ := kv.Root.(map[string]any)
	for k, val := range root {
		fmt.Printf("CTRL %s = %T\n", k, val)
	}
	emb, _ := root["embedded_meshes"].([]any)
	fmt.Printf("CTRL embedded %d\n", len(emb))
	for i, e := range emb {
		em, _ := e.(map[string]any)
		fmt.Printf("CTRLNAME %d %v mesh_index %v data_block %v vbib_block %v name2 %v mi %v\n", i, em["name"], em["mesh_index"], em["data_block"], em["vbib_block"], em["m_Name"], em["m_nMeshIndex"])
	}
	if len(emb) > 0 {
		em, _ := emb[0].(map[string]any)
		for k, val := range em {
			s := fmt.Sprint(val)
			if len(s) > 200 {
				s = s[:200]
			}
			fmt.Printf("CTRLEMB %s = %s\n", k, s)
		}
	}
}
