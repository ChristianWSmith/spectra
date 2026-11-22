package source2

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"io"
)

// worldColMagic identifies the binary world-collision cache ("SWC1").
const worldColMagic = 0x31435753

// WriteMeshes serializes meshes to the world-collision cache format:
// magic u32, mesh count u32, then per mesh: min and max (6 f32), vertex count,
// triangle count, node count (u32 each), vertices (3 f32), triangles (3 i32),
// nodes (type u8, pad 3, child u32, triangle offset u32, min and max 6 f32).
// Little-endian throughout.
func WriteMeshes(w io.Writer, meshes []Mesh) error {
	bw := bufio.NewWriterSize(w, 1<<20)
	put := func(v any) error { return binary.Write(bw, binary.LittleEndian, v) }
	if err := put(uint32(worldColMagic)); err != nil {
		return err
	}
	if err := put(uint32(len(meshes))); err != nil {
		return err
	}
	for _, m := range meshes {
		if err := put([6]float32{m.Min[0], m.Min[1], m.Min[2], m.Max[0], m.Max[1], m.Max[2]}); err != nil {
			return err
		}
		if err := put([3]uint32{uint32(len(m.Vertices)), uint32(len(m.Triangles)), uint32(len(m.Nodes))}); err != nil {
			return err
		}
		if err := put(m.Vertices); err != nil {
			return err
		}
		if err := put(m.Triangles); err != nil {
			return err
		}
		for _, n := range m.Nodes {
			rec := struct {
				Type     uint8
				Pad      [3]uint8
				ChildOff uint32
				TriOff   uint32
				Min, Max Vec3
			}{Type: n.Type, ChildOff: n.ChildOffset, TriOff: n.TriangleOffset, Min: n.Min, Max: n.Max}
			if err := put(&rec); err != nil {
				return err
			}
		}
	}
	return bw.Flush()
}

// ReadMeshes loads a cache written by WriteMeshes.
func ReadMeshes(r io.Reader) ([]Mesh, error) {
	br := bufio.NewReaderSize(r, 1<<20)
	get := func(v any) error { return binary.Read(br, binary.LittleEndian, v) }
	var magic, count uint32
	if err := get(&magic); err != nil {
		return nil, err
	}
	if magic != worldColMagic {
		return nil, fmt.Errorf("worldcol: bad magic %#x", magic)
	}
	if err := get(&count); err != nil {
		return nil, err
	}
	meshes := make([]Mesh, count)
	for i := range meshes {
		var bounds [6]float32
		var sizes [3]uint32
		if err := get(&bounds); err != nil {
			return nil, err
		}
		if err := get(&sizes); err != nil {
			return nil, err
		}
		m := &meshes[i]
		m.Min = Vec3{bounds[0], bounds[1], bounds[2]}
		m.Max = Vec3{bounds[3], bounds[4], bounds[5]}
		m.Vertices = make([]Vec3, sizes[0])
		if err := get(m.Vertices); err != nil {
			return nil, err
		}
		m.Triangles = make([]Triangle, sizes[1])
		if err := get(m.Triangles); err != nil {
			return nil, err
		}
		m.Nodes = make([]Node, sizes[2])
		for k := range m.Nodes {
			var rec struct {
				Type     uint8
				Pad      [3]uint8
				ChildOff uint32
				TriOff   uint32
				Min, Max Vec3
			}
			if err := get(&rec); err != nil {
				return nil, err
			}
			m.Nodes[k] = Node{Min: rec.Min, Max: rec.Max, Type: rec.Type, ChildOffset: rec.ChildOff, TriangleOffset: rec.TriOff}
		}
	}
	return meshes, nil
}
