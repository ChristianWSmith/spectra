package sidecar

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/klauspost/compress/zstd"
)

// ErrNoSidecar reports that a match directory does not hold a sidecar
// (missing directory or files) — callers treat it as "no replay data",
// not as a failure (HasSidecar=false is not an error).
var ErrNoSidecar = errors.New("sidecar: not present")

// Reader serves meta lookups and decompressed frame ranges from a match's
// sidecar. The frontend never decodes zstd: ranges come back as the raw
// q16-v1 stream (HTTP asset-server route).
type Reader struct {
	dir     string
	meta    Meta
	blocks  []idxEntry
	binSize int64
}

// Open reads meta.json, positions.idx and stats positions.bin. Missing
// files yield ErrNoSidecar; present-but-corrupt files yield other errors.
func Open(dir string) (*Reader, error) {
	metaRaw, err := os.ReadFile(filepath.Join(dir, MetaName))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, ErrNoSidecar
		}
		return nil, fmt.Errorf("sidecar: read %s: %w", MetaName, err)
	}
	var meta Meta
	if err := json.Unmarshal(metaRaw, &meta); err != nil {
		return nil, fmt.Errorf("sidecar: parse %s: %w", MetaName, err)
	}
	idxRaw, err := os.ReadFile(filepath.Join(dir, IdxName))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, ErrNoSidecar
		}
		return nil, fmt.Errorf("sidecar: read %s: %w", IdxName, err)
	}
	blocks, err := parseIdxEntries(idxRaw)
	if err != nil {
		return nil, err
	}
	binInfo, err := os.Stat(filepath.Join(dir, BinName))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, ErrNoSidecar
		}
		return nil, fmt.Errorf("sidecar: stat %s: %w", BinName, err)
	}
	return &Reader{dir: dir, meta: meta, blocks: blocks, binSize: binInfo.Size()}, nil
}

// Meta returns the sidecar header read at Open.
func (r *Reader) Meta() Meta { return r.meta }

// ReadRange returns the decompressed raw stream of whole frames
// [fromFrame, toFrame). fromFrame clamps to [0, Frames]; toFrame <=
// fromFrame or toFrame > Frames means Frames (i.e. "through the end"), so
// ReadRange(0, 0) is the whole match. Only the zstd blocks intersecting
// the range are read and decompressed. The result is the q16-v1 stream —
// see the package doc for the frame layout.
func (r *Reader) ReadRange(fromFrame, toFrame int) ([]byte, error) {
	frames := r.meta.Frames
	if fromFrame < 0 {
		fromFrame = 0
	}
	if fromFrame > frames {
		fromFrame = frames
	}
	if toFrame <= fromFrame || toFrame > frames {
		toFrame = frames
	}
	if fromFrame >= toFrame || len(r.blocks) == 0 {
		return []byte{}, nil
	}

	f, err := os.Open(filepath.Join(r.dir, BinName))
	if err != nil {
		return nil, fmt.Errorf("sidecar: open %s: %w", BinName, err)
	}
	defer func() { _ = f.Close() }()
	dec, err := zstd.NewReader(nil)
	if err != nil {
		return nil, fmt.Errorf("sidecar: zstd reader: %w", err)
	}
	defer dec.Close()

	var out []byte
	for i, b := range r.blocks {
		blockStart := int(b.firstFrame)
		blockEnd := blockStart + int(b.frameCount)
		if blockStart >= toFrame || blockEnd <= fromFrame {
			continue
		}
		end := r.binSize
		if i+1 < len(r.blocks) {
			end = int64(r.blocks[i+1].byteOffset)
		}
		size := end - int64(b.byteOffset)
		if size < 0 || int64(b.byteOffset)+size > r.binSize {
			return nil, errCorrupt("index offset outside file")
		}
		if size == 0 {
			continue
		}
		raw := make([]byte, size)
		if _, err := f.ReadAt(raw, int64(b.byteOffset)); err != nil {
			return nil, fmt.Errorf("sidecar: read block: %w", err)
		}
		data, err := dec.DecodeAll(raw, nil)
		if err != nil {
			return nil, fmt.Errorf("sidecar: decompress block at frame %d: %w", blockStart, err)
		}
		off, walked := 0, 0
		for off < len(data) {
			n, err := frameLen(data, off)
			if err != nil {
				return nil, err
			}
			global := blockStart + walked
			if global >= fromFrame && global < toFrame {
				out = append(out, data[off:off+n]...)
			}
			off += n
			walked++
		}
		if walked != int(b.frameCount) {
			return nil, fmt.Errorf("sidecar: block at frame %d holds %d frames, index says %d",
				blockStart, walked, b.frameCount)
		}
	}
	return out, nil
}

// decodeFrameHeader exposes one frame's tick + mask for tests and callers
// walking a ReadRange result (payload follows the 6-byte header, 8 bytes
// per set bit in ascending slot order).
func decodeFrameHeader(data []byte, off int) (tick int32, mask uint16, err error) {
	if off+6 > len(data) {
		return 0, 0, errCorrupt("truncated frame header")
	}
	tick = int32(binary.LittleEndian.Uint32(data[off : off+4]))
	mask = binary.LittleEndian.Uint16(data[off+4 : off+6])
	return tick, mask, nil
}
