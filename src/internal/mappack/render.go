package mappack

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"

	"github.com/ChristianWSmith/spectra/internal/source2"
)

// dxgiR32G32B32Float is the DXGI format of a float32 x3 position.
const dxgiR32G32B32Float = 6

// ExtractRenderGeometry reads a map's render geometry (the worldnodes render
// models, which hold the textured world) from the local CS2 install and writes
// it to outDir/<map>.render in the worldcol mesh format, with positions in map
// space. cs2Dir is the install's game/csgo directory (the one holding maps/).
func ExtractRenderGeometry(cs2Dir, mapName, outDir string) (string, int, error) {
	if !supportedMaps[mapName] {
		return "", 0, fmt.Errorf("render: %s is not a supported map", mapName)
	}
	v, err := openVPK(filepath.Join(cs2Dir, "maps", mapName+".vpk"))
	if err != nil {
		return "", 0, fmt.Errorf("render: %w", err)
	}
	defer v.close()
	mapData, found, err := v.read("maps/" + mapName + ".vmap_c")
	if err != nil || !found {
		return "", 0, fmt.Errorf("render: map resource: found=%v err=%v", found, err)
	}
	blocks, err := source2.ParseResource(mapData)
	if err != nil {
		return "", 0, fmt.Errorf("render: %w", err)
	}
	red2, ok := source2.FindBlock(blocks, "RED2")
	if !ok {
		return "", 0, fmt.Errorf("render: %s has no manifest block", mapName)
	}
	manifest, err := source2.Decode(red2)
	if err != nil {
		return "", 0, fmt.Errorf("render: manifest: %w", err)
	}
	root, _ := manifest.Root.(map[string]any)
	children, _ := root["m_ChildResourceList"].([]any)
	var all []source2.Mesh
	var allMats [][]uint16
	rm := &renderMaterials{index: map[string]uint16{}}
	models := 0
	for _, c := range children {
		name, _ := c.(string)
		if !strings.Contains(name, "/worldnodes/") || !strings.HasSuffix(name, ".vmdl") {
			continue
		}
		// Skybox models are the distant backdrop, outside the playable map.
		if strings.Contains(name, "skybox") {
			continue
		}
		models++
		ms, mats, err := renderModelMeshes(v, strings.TrimSuffix(name, "_c"), rm)
		if err != nil {
			return "", 0, fmt.Errorf("render: %s: %w", name, err)
		}
		all = append(all, ms...)
		allMats = append(allMats, mats...)
	}
	if len(all) == 0 {
		return "", 0, fmt.Errorf("render: %s has no render meshes", mapName)
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return "", 0, err
	}
	out := filepath.Join(outDir, mapName+".render")
	tmp := out + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return "", 0, err
	}
	if err := source2.WriteMeshes(f, all); err != nil {
		f.Close()
		os.Remove(tmp)
		return "", 0, err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return "", 0, err
	}
	if err := os.Rename(tmp, out); err != nil {
		return "", 0, err
	}
	if err := writeMaterials(out+".mats", rm.table, allMats); err != nil {
		return "", 0, err
	}
	return out, models, nil
}

// drawCall is one range of a render model's index buffer, with its material.
type drawCall struct {
	start, count, base int
	material           string
}

// renderMaterials is the table of material names and each triangle's material.
type renderMaterials struct {
	table []string
	index map[string]uint16
}

func (rm *renderMaterials) id(name string) uint16 {
	if i, ok := rm.index[name]; ok {
		return i
	}
	rm.table = append(rm.table, name)
	rm.index[name] = uint16(len(rm.table) - 1)
	return rm.index[name]
}

// renderModelMeshes decodes the embedded meshes of one render model, with each
// triangle's material id, from the model's CTRL and MDAT blocks.
func renderModelMeshes(v *vpk, name string, rm *renderMaterials) ([]source2.Mesh, [][]uint16, error) {
	data, found, err := v.read(name + "_c")
	if err != nil || !found {
		return nil, nil, fmt.Errorf("read: found=%v err=%v", found, err)
	}
	blocks, err := source2.ParseResource(data)
	if err != nil {
		return nil, nil, err
	}
	ctrlB, ok := source2.FindBlock(blocks, "CTRL")
	if !ok {
		return nil, nil, errors.New("no CTRL block")
	}
	kv, err := source2.Decode(ctrlB)
	if err != nil {
		return nil, nil, err
	}
	root, _ := kv.Root.(map[string]any)
	emb, _ := root["embedded_meshes"].([]any)
	draws, err := modelDrawCalls(blocks)
	if err != nil {
		return nil, nil, err
	}
	if len(draws) != len(emb) {
		return nil, nil, fmt.Errorf("%d scene objects for %d embedded meshes", len(draws), len(emb))
	}
	var out []source2.Mesh
	var mats [][]uint16
	for mi, e := range emb {
		em, _ := e.(map[string]any)
		m, tm, err := embeddedMesh(blocks, em, draws[mi], rm)
		if err != nil {
			return nil, nil, err
		}
		out = append(out, m)
		mats = append(mats, tm)
	}
	return out, mats, nil
}

// modelDrawCalls reads each scene object's draw calls from the MDAT block.
func modelDrawCalls(blocks []source2.Block) ([][]drawCall, error) {
	mdat, ok := source2.FindBlock(blocks, "MDAT")
	if !ok {
		return nil, errors.New("no MDAT block")
	}
	kv, err := source2.Decode(mdat)
	if err != nil {
		return nil, err
	}
	root, _ := kv.Root.(map[string]any)
	objs, _ := root["m_sceneObjects"].([]any)
	var out [][]drawCall
	for _, o := range objs {
		om, _ := o.(map[string]any)
		dcs, _ := om["m_drawCalls"].([]any)
		var list []drawCall
		for _, d := range dcs {
			dm, _ := d.(map[string]any)
			list = append(list, drawCall{
				start:    kvInt(dm["m_nStartIndex"]),
				count:    kvInt(dm["m_nIndexCount"]),
				base:     kvInt(dm["m_nBaseVertex"]),
				material: fmt.Sprint(dm["m_material"]),
			})
		}
		out = append(out, list)
	}
	return out, nil
}

func embeddedMesh(blocks []source2.Block, em map[string]any, draws []drawCall, rm *renderMaterials) (source2.Mesh, []uint16, error) {
	var out source2.Mesh
	vbs, _ := em["m_vertexBuffers"].([]any)
	ibs, _ := em["m_indexBuffers"].([]any)
	if len(vbs) == 0 || len(ibs) == 0 {
		return out, nil, errors.New("embedded mesh without vertex or index buffers")
	}
	// The position buffer is the first vertex buffer with a POSITION field.
	var posBuf map[string]any
	var posOff int
	for _, b := range vbs {
		bm, _ := b.(map[string]any)
		fields, _ := bm["m_inputLayoutFields"].([]any)
		for _, f := range fields {
			fm, _ := f.(map[string]any)
			if fmt.Sprint(fm["m_pSemanticName"]) == "POSITION" && kvInt(fm["m_nSlot"]) == 0 {
				if kvInt(fm["m_Format"]) != dxgiR32G32B32Float {
					return out, nil, fmt.Errorf("POSITION format %d not supported", kvInt(fm["m_Format"]))
				}
				posBuf, posOff = bm, kvInt(fm["m_nOffset"])
			}
		}
		if posBuf != nil {
			break
		}
	}
	if posBuf == nil {
		return out, nil, errors.New("no POSITION buffer")
	}
	vraw, err := decodeBuffer(blocks, posBuf, true)
	if err != nil {
		return out, nil, fmt.Errorf("vertices: %w", err)
	}
	vsize := kvInt(posBuf["m_nElementSizeInBytes"])
	vcount := kvInt(posBuf["m_nElementCount"])
	out.Vertices = make([]source2.Vec3, vcount)
	for i := 0; i < vcount; i++ {
		o := i*vsize + posOff
		out.Vertices[i] = source2.Vec3{f32le(vraw[o:]), f32le(vraw[o+4:]), f32le(vraw[o+8:])}
	}
	ib, _ := ibs[0].(map[string]any)
	iraw, err := decodeBuffer(blocks, ib, false)
	if err != nil {
		return out, nil, fmt.Errorf("indices: %w", err)
	}
	isize := kvInt(ib["m_nElementSizeInBytes"])
	icount := kvInt(ib["m_nElementCount"])
	if icount%3 != 0 {
		return out, nil, errors.New("index count not a multiple of 3")
	}
	out.Triangles = make([]source2.Triangle, icount/3)
	tmat := make([]uint16, icount/3)
	// Each triangle takes the material of the draw call covering its first index,
	// and that draw call's base vertex.
	for _, d := range draws {
		for t := d.start / 3; t < (d.start+d.count)/3 && t < len(tmat); t++ {
			tmat[t] = rm.id(d.material)
		}
	}
	for t := range out.Triangles {
		base := 0
		for _, d := range draws {
			if t >= d.start/3 && t < (d.start+d.count)/3 {
				base = d.base
				break
			}
		}
		for k := 0; k < 3; k++ {
			o := (t*3 + k) * isize
			var idx uint32
			if isize == 2 {
				idx = uint32(iraw[o]) | uint32(iraw[o+1])<<8
			} else {
				idx = uint32(iraw[o]) | uint32(iraw[o+1])<<8 | uint32(iraw[o+2])<<16 | uint32(iraw[o+3])<<24
			}
			idx += uint32(base)
			if int(idx) >= vcount {
				return out, nil, fmt.Errorf("index %d outside %d vertices", idx, vcount)
			}
			out.Triangles[t][k] = int32(idx)
		}
	}
	out.Min, out.Max = bounds(out.Vertices)
	return out, tmat, nil
}

// decodeBuffer returns a buffer's raw bytes: decompressed when it is meshopt
// coded, the stored bytes otherwise. ZSTD-coded buffers are not supported yet.
func decodeBuffer(blocks []source2.Block, b map[string]any, vertex bool) ([]byte, error) {
	count := kvInt(b["m_nElementCount"])
	size := kvInt(b["m_nElementSizeInBytes"])
	bi := kvInt(b["m_nBlockIndex"])
	if bi < 0 || bi >= len(blocks) {
		return nil, fmt.Errorf("block index %d out of range", bi)
	}
	raw := blocks[bi].Data
	if b["m_bCompressedZSTD"] == true {
		return nil, errors.New("ZSTD-coded buffer not supported")
	}
	if b["m_bMeshoptCompressed"] != true {
		return raw, nil
	}
	if vertex {
		return source2.DecodeVertexBuffer(count, size, raw)
	}
	return source2.DecodeIndexBuffer(count, size, raw)
}

func kvInt(v any) int {
	switch x := v.(type) {
	case int64:
		return int(x)
	case uint64:
		return int(x)
	case int32:
		return int(x)
	case uint32:
		return int(x)
	case int:
		return x
	}
	return -1
}

func f32le(b []byte) float32 {
	u := uint32(b[0]) | uint32(b[1])<<8 | uint32(b[2])<<16 | uint32(b[3])<<24
	return float32frombits(u)
}

func bounds(vs []source2.Vec3) (source2.Vec3, source2.Vec3) {
	var lo, hi source2.Vec3
	if len(vs) == 0 {
		return lo, hi
	}
	lo, hi = vs[0], vs[0]
	for _, v := range vs[1:] {
		for i := 0; i < 3; i++ {
			if v[i] < lo[i] {
				lo[i] = v[i]
			}
			if v[i] > hi[i] {
				hi[i] = v[i]
			}
		}
	}
	return lo, hi
}

func float32frombits(u uint32) float32 { return math.Float32frombits(u) }

// writeMaterials writes the material sidecar: the name table, then each mesh's
// triangle material ids. Layout (little-endian): uint32 table count, then per name
// uint32 length and bytes; uint32 mesh count, then per mesh uint32 triangle count
// and uint16 ids.
func writeMaterials(path string, table []string, mats [][]uint16) error {
	tmp := path + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	w := bufio.NewWriterSize(f, 1<<20)
	put := func(v any) error { return binary.Write(w, binary.LittleEndian, v) }
	err = put(uint32(len(table)))
	for _, n := range table {
		if err == nil {
			err = put(uint32(len(n)))
		}
		if err == nil {
			_, err = w.WriteString(n)
		}
	}
	if err == nil {
		err = put(uint32(len(mats)))
	}
	for _, m := range mats {
		if err == nil {
			err = put(uint32(len(m)))
		}
		if err == nil {
			err = put(m)
		}
	}
	if err == nil {
		err = w.Flush()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}
