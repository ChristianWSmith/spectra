// Package source2 reads Source 2 resource containers (the *_c files in a CS2
// install) and their binary KV3 data blocks. It is a spike: v5 binary KV3 with
// uncompressed or LZ4 buffers only; zstd and z3 are refused. The layout follows
// ValveResourceFormat (Resource/Resource.cs, Resource/ResourceTypes/BinaryKV3*.cs).
package source2

import (
	"encoding/binary"
	"fmt"
)

// Block is one entry of a resource's block directory.
type Block struct {
	Type string // four ASCII characters as stored on disk, e.g. "DATA"
	Data []byte
}

const knownHeaderVersion = 12

// ParseResource reads the 16-byte header and the block directory, and returns
// every block with its bytes. Offsets are bounds-checked.
func ParseResource(data []byte) ([]Block, error) {
	if len(data) < 16 {
		return nil, fmt.Errorf("source2: resource too short (%d bytes)", len(data))
	}
	if hv := le16(data, 4); hv != knownHeaderVersion {
		return nil, fmt.Errorf("source2: header version %d, want %d (not a resource)", hv, knownHeaderVersion)
	}
	blockOffset := int(le32(data, 8))
	blockCount := int(le32(data, 12))
	dir := 8 + blockOffset
	if dir < 0 || dir+12*blockCount > len(data) {
		return nil, fmt.Errorf("source2: block directory out of range")
	}
	blocks := make([]Block, 0, blockCount)
	for i := 0; i < blockCount; i++ {
		e := dir + 12*i
		typ := string(data[e : e+4])
		off := (e + 4) + int(le32(data, e+4))
		size := int(le32(data, e+8))
		if off < 0 || size < 0 || off+size > len(data) {
			return nil, fmt.Errorf("source2: block %q out of range (off %d size %d file %d)", typ, off, size, len(data))
		}
		blocks = append(blocks, Block{Type: typ, Data: data[off : off+size]})
	}
	return blocks, nil
}

// FindBlock returns the first block of the given type.
func FindBlock(blocks []Block, typ string) ([]byte, bool) {
	for _, b := range blocks {
		if b.Type == typ {
			return b.Data, true
		}
	}
	return nil, false
}

func le16(b []byte, off int) uint16 { return binary.LittleEndian.Uint16(b[off:]) }
func le32(b []byte, off int) uint32 { return binary.LittleEndian.Uint32(b[off:]) }
