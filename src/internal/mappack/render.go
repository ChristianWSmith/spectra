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
	mv, err := openVPK(filepath.Join(cs2Dir, "maps", mapName+".vpk"))
	if err != nil {
		return "", 0, fmt.Errorf("render: %w", err)
	}
	defer mv.close()
	// Shared content (props under models/) lives in the common archive.
	shared, err := openVPK(filepath.Join(cs2Dir, "pak01_dir.vpk"))
	if err != nil {
		return "", 0, fmt.Errorf("render: shared content: %w", err)
	}
	defer shared.close()
	v := chainedVPK{mv, shared}
	mapData, found, err := mv.read("maps/" + mapName + ".vmap_c")
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
	rm := &renderMaterials{index: map[string]uint16{}}
	// The world resource names the world nodes; each node file places its models.
	nodes, err := worldNodePaths(mv, mapName)
	if err != nil {
		return "", 0, fmt.Errorf("render: %w", err)
	}
	all, allMats, wst, err := worldNodeGeometry(v, mapName, nodes, rm)
	if err != nil {
		return "", 0, fmt.Errorf("render: %w", err)
	}
	models := wst.SceneObjects + wst.Aggregates
	pm, pmats, _, err := placedMeshes(v, mapName, children, rm)
	if err != nil {
		return "", 0, fmt.Errorf("render: %w", err)
	}
	all = append(all, pm...)
	allMats = append(allMats, pmats...)
	all, allMats = dropSkipMaterials(all, allMats, rm.table)
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
	vbuf, ibuf         int // vertex and index buffer handles (hBuffer)
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
func renderModelMeshes(v resourceReader, name string, rm *renderMaterials) ([]source2.Mesh, [][]uint16, error) {
	ms, mats, _, err := renderModelParts(v, name, rm)
	return ms, mats, err
}

// renderModelParts is renderModelMeshes with each embedded mesh's draw calls.
func renderModelParts(v resourceReader, name string, rm *renderMaterials) ([]source2.Mesh, [][]uint16, [][]drawCall, error) {
	data, found, err := v.read(name + "_c")
	if err != nil || !found {
		return nil, nil, nil, fmt.Errorf("read: found=%v err=%v", found, err)
	}
	blocks, err := source2.ParseResource(data)
	if err != nil {
		return nil, nil, nil, err
	}
	ctrlB, ok := source2.FindBlock(blocks, "CTRL")
	if !ok {
		return nil, nil, nil, errors.New("no CTRL block")
	}
	kv, err := source2.Decode(ctrlB)
	if err != nil {
		return nil, nil, nil, err
	}
	root, _ := kv.Root.(map[string]any)
	emb, _ := root["embedded_meshes"].([]any)
	// A model with several embedded meshes holds its levels of detail. The
	// highest detail (lowest mesh index) is the one that is drawn up close, so it
	// is the one kept.
	keep := lowestLOD(emb)
	var out []source2.Mesh
	var mats [][]uint16
	var draws [][]drawCall
	for _, mi := range keep {
		em, _ := emb[mi].(map[string]any)
		block := kvInt(em["m_nDataBlock"])
		if _, classic := em["data_block"]; classic {
			block = kvInt(em["data_block"])
		}
		dc, err := drawCallsOfBlock(blocks, block)
		if err != nil {
			return nil, nil, nil, err
		}
		m, tm, err := embeddedMesh(blocks, em, dc, rm)
		if err != nil {
			return nil, nil, nil, err
		}
		out = append(out, m)
		mats = append(mats, tm)
		draws = append(draws, dc)
	}
	return out, mats, draws, nil
}

// lowestLOD returns the indices of the embedded meshes to keep: all of them when
// there is one, else the ones with the lowest mesh index.
func lowestLOD(emb []any) []int {
	if len(emb) <= 1 {
		var out []int
		for i := range emb {
			out = append(out, i)
		}
		return out
	}
	idx := func(e any) int {
		em, _ := e.(map[string]any)
		if _, ok := em["m_nMeshIndex"]; ok {
			return kvInt(em["m_nMeshIndex"])
		}
		return kvInt(em["mesh_index"])
	}
	lowest := idx(emb[0])
	for _, e := range emb[1:] {
		if x := idx(e); x < lowest {
			lowest = x
		}
	}
	var out []int
	for i, e := range emb {
		if idx(e) == lowest {
			out = append(out, i)
		}
	}
	return out
}

// drawCallsOfBlock returns the draw calls of one MDAT block, flattened over its
// scene objects.
func drawCallsOfBlock(blocks []source2.Block, block int) ([]drawCall, error) {
	if block < 0 || block >= len(blocks) || blocks[block].Type != "MDAT" {
		return nil, fmt.Errorf("data block %d is not an MDAT block", block)
	}
	kv, err := source2.Decode(blocks[block].Data)
	if err != nil {
		return nil, err
	}
	root, _ := kv.Root.(map[string]any)
	objs, _ := root["m_sceneObjects"].([]any)
	var out []drawCall
	for _, o := range objs {
		om, _ := o.(map[string]any)
		out = append(out, drawCallsOf(om)...)
	}
	return out, nil
}

// drawCallsOf reads one scene object's draw calls.
func drawCallsOf(om map[string]any) []drawCall {
	dcs, _ := om["m_drawCalls"].([]any)
	var list []drawCall
	for _, d := range dcs {
		dm, _ := d.(map[string]any)
		vbuf, ibuf := 0, 0
		if vbs, ok := dm["m_vertexBuffers"].([]any); ok && len(vbs) > 0 {
			vb, _ := vbs[0].(map[string]any)
			vbuf = kvInt(vb["m_hBuffer"])
		}
		if ib, ok := dm["m_indexBuffer"].(map[string]any); ok {
			ibuf = kvInt(ib["m_hBuffer"])
		}
		list = append(list, drawCall{
			start:    kvInt(dm["m_nStartIndex"]),
			count:    kvInt(dm["m_nIndexCount"]),
			base:     kvInt(dm["m_nBaseVertex"]),
			material: fmt.Sprint(dm["m_material"]),
			vbuf:     vbuf,
			ibuf:     ibuf,
		})
	}
	return list
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
			vbuf, ibuf := 0, 0
			if vbs, ok := dm["m_vertexBuffers"].([]any); ok && len(vbs) > 0 {
				vb, _ := vbs[0].(map[string]any)
				vbuf = kvInt(vb["m_hBuffer"])
			}
			if ib, ok := dm["m_indexBuffer"].(map[string]any); ok {
				ibuf = kvInt(ib["m_hBuffer"])
			}
			list = append(list, drawCall{
				start:    kvInt(dm["m_nStartIndex"]),
				count:    kvInt(dm["m_nIndexCount"]),
				base:     kvInt(dm["m_nBaseVertex"]),
				material: fmt.Sprint(dm["m_material"]),
				vbuf:     vbuf,
				ibuf:     ibuf,
			})
		}
		out = append(out, list)
	}
	return out, nil
}

func embeddedMesh(blocks []source2.Block, em map[string]any, draws []drawCall, rm *renderMaterials) (source2.Mesh, []uint16, error) {
	if _, classic := em["vbib_block"]; classic {
		return classicEmbeddedMesh(blocks, em, draws, rm)
	}
	vbs, _ := em["m_vertexBuffers"].([]any)
	ibs, _ := em["m_indexBuffers"].([]any)
	if len(vbs) == 0 || len(ibs) == 0 {
		return source2.Mesh{}, nil, errors.New("embedded mesh without vertex or index buffers")
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
					return source2.Mesh{}, nil, fmt.Errorf("POSITION format %d not supported", kvInt(fm["m_Format"]))
				}
				posBuf, posOff = bm, kvInt(fm["m_nOffset"])
			}
		}
		if posBuf != nil {
			break
		}
	}
	if posBuf == nil {
		return source2.Mesh{}, nil, errors.New("no POSITION buffer")
	}
	vraw, err := decodeBuffer(blocks, posBuf, true)
	if err != nil {
		return source2.Mesh{}, nil, fmt.Errorf("vertices: %w", err)
	}
	ib, _ := ibs[0].(map[string]any)
	iraw, err := decodeBuffer(blocks, ib, false)
	if err != nil {
		return source2.Mesh{}, nil, fmt.Errorf("indices: %w", err)
	}
	return buildMesh(vraw, kvInt(posBuf["m_nElementSizeInBytes"]), posOff, kvInt(posBuf["m_nElementCount"]),
		iraw, kvInt(ib["m_nElementSizeInBytes"]), kvInt(ib["m_nElementCount"]), draws, rm)
}

// classicEmbeddedMesh reads a mesh of the older format: its buffers are in the
// VBIB (or MBUF) block its vbib_block names.
func classicEmbeddedMesh(blocks []source2.Block, em map[string]any, draws []drawCall, rm *renderMaterials) (source2.Mesh, []uint16, error) {
	bi := kvInt(em["vbib_block"])
	if bi < 0 || bi >= len(blocks) {
		return source2.Mesh{}, nil, fmt.Errorf("vbib block %d out of range", bi)
	}
	verts, idxs, err := source2.ParseVBIB(blocks[bi].Data)
	if err != nil {
		return source2.Mesh{}, nil, err
	}
	if len(verts) == 0 || len(idxs) == 0 {
		return source2.Mesh{}, nil, errors.New("classic mesh without vertex or index buffers")
	}
	// Draw calls must all use the buffers this reader takes: vertex 0 and index 0.
	for _, d := range draws {
		if d.vbuf != 0 || d.ibuf != 0 {
			return source2.Mesh{}, nil, fmt.Errorf("draw call uses buffer %d/%d; only 0/0 is supported", d.vbuf, d.ibuf)
		}
	}
	var pos *source2.VBIBAttr
	var posOff int
	for k := range verts[0].Attrs {
		a := verts[0].Attrs[k]
		if a.Name == "POSITION" && a.Slot == 0 {
			if a.Format != dxgiR32G32B32Float {
				return source2.Mesh{}, nil, fmt.Errorf("POSITION format %d not supported", a.Format)
			}
			pos = &verts[0].Attrs[k]
			posOff = int(a.Offset)
		}
	}
	if pos == nil {
		return source2.Mesh{}, nil, errors.New("classic vertex buffer without POSITION")
	}
	ib := idxs[0]
	return buildMesh(verts[0].Data, verts[0].ElemSize, posOff, verts[0].Count, ib.Data, ib.ElemSize, ib.Count, draws, rm)
}

// buildMesh assembles a mesh from decoded vertex positions and index triples, and
// tags each triangle with its draw call's material, applying the base vertex.
func buildMesh(vraw []byte, vsize, posOff, vcount int, iraw []byte, isize, icount int, draws []drawCall, rm *renderMaterials) (source2.Mesh, []uint16, error) {
	var out source2.Mesh
	out.Vertices = make([]source2.Vec3, vcount)
	for i := 0; i < vcount; i++ {
		o := i*vsize + posOff
		out.Vertices[i] = source2.Vec3{f32le(vraw[o:]), f32le(vraw[o+4:]), f32le(vraw[o+8:])}
	}
	if icount%3 != 0 {
		return out, nil, errors.New("index count not a multiple of 3")
	}
	out.Triangles = make([]source2.Triangle, icount/3)
	tmat := make([]uint16, icount/3)
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

// worldNodePaths returns the world node files a map's world resource names: each
// prefix (backslashes, no extension) becomes <prefix>.vwnod.
func worldNodePaths(mv *vpk, mapName string) ([]string, error) {
	data, found, err := mv.read("maps/" + mapName + "/world.vwrld_c")
	if err != nil || !found {
		return nil, fmt.Errorf("world.vwrld: found=%v err=%v", found, err)
	}
	blocks, err := source2.ParseResource(data)
	if err != nil {
		return nil, err
	}
	d, ok := source2.FindBlock(blocks, "DATA")
	if !ok {
		return nil, errors.New("world.vwrld: no DATA")
	}
	kv, err := source2.Decode(d)
	if err != nil {
		return nil, err
	}
	root, _ := kv.Root.(map[string]any)
	nodes, _ := root["m_worldNodes"].([]any)
	var out []string
	for _, n := range nodes {
		nm, _ := n.(map[string]any)
		prefix := strings.ReplaceAll(fmt.Sprint(nm["m_worldNodePrefix"]), "\\", "/")
		if prefix == "" {
			continue
		}
		out = append(out, prefix+".vwnod")
	}
	if len(out) == 0 {
		return nil, errors.New("world.vwrld names no world nodes")
	}
	return out, nil
}

// dropSkipMaterials removes the triangles whose material is left out of the
// render geometry, and their material ids with them.
func dropSkipMaterials(ms []source2.Mesh, mats [][]uint16, table []string) ([]source2.Mesh, [][]uint16) {
	skip := make([]bool, len(table))
	for i, n := range table {
		skip[i] = skipMaterial(n)
	}
	for i := range ms {
		var keep []source2.Triangle
		var keepMats []uint16
		for t, tr := range ms[i].Triangles {
			if !skip[mats[i][t]] {
				keep = append(keep, tr)
				keepMats = append(keepMats, mats[i][t])
			}
		}
		ms[i].Triangles = keep
		mats[i] = keepMats
	}
	return ms, mats
}
