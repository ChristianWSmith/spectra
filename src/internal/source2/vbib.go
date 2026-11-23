package source2

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"

	"github.com/klauspost/compress/zstd"
)

// VBIBAttr is one vertex attribute of a classic vertex buffer.
type VBIBAttr struct {
	Name   string
	Index  int
	Format uint32
	Offset uint32
	Slot   int
}

// VBIBBuffer is one classic vertex or index buffer, decoded to raw elements.
type VBIBBuffer struct {
	Count, ElemSize int
	Attrs           []VBIBAttr
	Data            []byte
}

// ParseVBIB reads a classic VBIB or MBUF block: the vertex buffers, then the index
// buffers. Each on-disk buffer is decompressed (zstd, meshoptimizer, or raw).
// Layout after Read in the VRF reference (VBIB.cs, ReadOnDiskBufferData).
func ParseVBIB(data []byte) (verts, idxs []VBIBBuffer, err error) {
	if len(data) < 16 {
		return nil, nil, fmt.Errorf("vbib: block too short")
	}
	vo := int(binary.LittleEndian.Uint32(data[0:]))
	vc := int(binary.LittleEndian.Uint32(data[4:]))
	io_ := int(binary.LittleEndian.Uint32(data[8:]))
	ic := int(binary.LittleEndian.Uint32(data[12:]))
	for i := 0; i < vc; i++ {
		b, err := readOnDiskBuffer(data, vo+i*24, true)
		if err != nil {
			return nil, nil, err
		}
		verts = append(verts, b)
	}
	for i := 0; i < ic; i++ {
		b, err := readOnDiskBuffer(data, 8+io_+i*24, false)
		if err != nil {
			return nil, nil, err
		}
		idxs = append(idxs, b)
	}
	return verts, idxs, nil
}

// readOnDiskBuffer reads one 24-byte buffer record at pos (offsets inside it are
// relative to the fields that hold them).
func readOnDiskBuffer(data []byte, pos int, isVertex bool) (VBIBBuffer, error) {
	var b VBIBBuffer
	if pos < 0 || pos+24 > len(data) {
		return b, fmt.Errorf("vbib: buffer record at %d outside the block", pos)
	}
	u32 := func(p int) uint32 { return binary.LittleEndian.Uint32(data[p:]) }
	count := u32(pos)
	size := u32(pos + 4)
	b.Count = int(count)
	b.ElemSize = int(size & 0x3FFFFFF)
	isMeshopt := size&0x4000000 == 0
	isZstd := size&0x8000000 != 0
	refA := pos + 8
	attrOff := int(u32(refA))
	attrCount := int(u32(refA + 4))
	refB := pos + 16
	dataOff := int(u32(refB))
	totalSize := int(int32(u32(refB + 4)))
	for i := 0; i < attrCount; i++ {
		p := refA + attrOff + i*56
		if p < 0 || p+56 > len(data) {
			return b, fmt.Errorf("vbib: attribute outside the block")
		}
		name := data[p : p+32]
		if k := bytes.IndexByte(name, 0); k >= 0 {
			name = name[:k]
		}
		b.Attrs = append(b.Attrs, VBIBAttr{
			Name:   string(bytes.ToUpper(name)),
			Index:  int(int32(u32(p + 32))),
			Format: u32(p + 36),
			Offset: u32(p + 40),
			Slot:   int(int32(u32(p + 44))),
		})
	}
	start := refB + dataOff
	if start < 0 || totalSize < 0 || start+totalSize > len(data) {
		return b, fmt.Errorf("vbib: buffer data outside the block")
	}
	raw := data[start : start+totalSize]
	decompressed := b.Count * b.ElemSize
	if decompressed > totalSize {
		out, err := decompressClassic(raw, decompressed, b.Count, b.ElemSize, isVertex, isZstd, isMeshopt)
		if err != nil {
			return b, err
		}
		b.Data = out
	} else {
		b.Data = append([]byte(nil), raw...)
	}
	return b, nil
}

func decompressClassic(raw []byte, decompressed, count, elemSize int, isVertex, isZstd, isMeshopt bool) ([]byte, error) {
	src := raw
	if isZstd {
		zd, err := zstd.NewReader(bytes.NewReader(nil))
		if err != nil {
			return nil, err
		}
		defer zd.Close()
		out, err := zd.DecodeAll(raw, make([]byte, 0, decompressed))
		if err != nil {
			return nil, fmt.Errorf("vbib: zstd: %w", err)
		}
		src = out
	}
	if !isMeshopt {
		if len(src) != decompressed {
			return nil, fmt.Errorf("vbib: decompressed %d bytes, want %d", len(src), decompressed)
		}
		return append([]byte(nil), src...), nil
	}
	if isVertex {
		return DecodeVertexBuffer(count, elemSize, src)
	}
	return DecodeIndexBuffer(count, elemSize, src)
}

var _ = io.EOF
