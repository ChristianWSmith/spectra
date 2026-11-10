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
// q16 stream (HTTP asset-server route).
type Reader struct {
	dir     string
	meta    Meta
	blocks  []idxEntry
	binSize int64

	// state stream (state.go) — zero/absent = fail soft via ErrNoState.
	stateBlocks []idxEntry
	stateSize   int64
	hasState    bool
}

// Open reads meta.json, positions.idx and stats positions.bin. Missing
// files yield ErrNoSidecar; present-but-corrupt files yield other errors.
// The state stream is optional: it is loaded only when its files exist (a
// match without them keeps HasState=false, no error).
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
	r := &Reader{dir: dir, meta: meta, blocks: blocks, binSize: binInfo.Size()}
	if err := r.openState(); err != nil {
		return nil, err
	}
	return r, nil
}

// openState loads the optional state stream (see Open). Absence of either
// file (or both) means no stream — fail soft, not corrupt.
func (r *Reader) openState() error {
	stateIdx, err := os.ReadFile(filepath.Join(r.dir, StateIdxName))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil // no stream — absent
		}
		return fmt.Errorf("sidecar: read %s: %w", StateIdxName, err)
	}
	stateBlocks, err := parseIdxEntries(stateIdx)
	if err != nil {
		return err
	}
	stateInfo, err := os.Stat(filepath.Join(r.dir, StateBinName))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil // torn pair — absent beats serving half a stream
		}
		return fmt.Errorf("sidecar: stat %s: %w", StateBinName, err)
	}
	r.stateBlocks = stateBlocks
	r.stateSize = stateInfo.Size()
	r.hasState = true
	return nil
}

// HasState reports whether the match carries the state stream (a match
// without it returns false; capability for the /state route).
func (r *Reader) HasState() bool { return r.hasState }

// Meta returns the sidecar header read at Open.
func (r *Reader) Meta() Meta { return r.meta }

// ReadRange returns the decompressed raw stream of whole frames
// [fromFrame, toFrame). fromFrame clamps to [0, Frames]; toFrame <=
// fromFrame or toFrame > Frames means Frames (i.e. "through the end"), so
// ReadRange(0, 0) is the whole match. Only the zstd blocks intersecting
// the range are read and decompressed. The result is the q16 stream —
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

// ReadStateRange returns the decompressed state records (raw bytes —
// DecodeStateRecords decodes them) whose frame lies in [fromFrame,
// toFrame). Unlike the positions range, `to <= from` (or beyond the
// record maximum) means "through the end" and fromFrame clamps to >= 0;
// whole zstd blocks intersecting the range are returned, records inside
// them are filtered by frame — blocks are independently decodable (every
// record carries its absolute frame), so no baseline from outside the
// range is ever needed. ErrNoState when the match has no state stream.
func (r *Reader) ReadStateRange(fromFrame, toFrame int) ([]byte, error) {
	if !r.hasState {
		return nil, ErrNoState
	}
	if fromFrame < 0 {
		fromFrame = 0
	}
	unbounded := toFrame <= fromFrame // 0,0 (or inverted) = whole stream

	f, err := os.Open(filepath.Join(r.dir, StateBinName))
	if err != nil {
		return nil, fmt.Errorf("sidecar: open %s: %w", StateBinName, err)
	}
	defer func() { _ = f.Close() }()
	dec, err := zstd.NewReader(nil)
	if err != nil {
		return nil, fmt.Errorf("sidecar: zstd reader: %w", err)
	}
	defer dec.Close()

	var out []byte
	for i, b := range r.stateBlocks {
		start := int(b.firstFrame)
		if !unbounded && start >= toFrame {
			break // blocks are ordered by firstFrame
		}
		// Block i covers frames [firstFrame_i, firstFrame_{i+1}); skip
		// blocks entirely below fromFrame.
		next := int(^uint(0) >> 1) // math.MaxInt without the import
		if i+1 < len(r.stateBlocks) {
			next = int(r.stateBlocks[i+1].firstFrame)
		}
		if next <= fromFrame {
			continue
		}
		end := r.stateSize
		if i+1 < len(r.stateBlocks) {
			end = int64(r.stateBlocks[i+1].byteOffset)
		}
		size := end - int64(b.byteOffset)
		if size < 0 || int64(b.byteOffset)+size > r.stateSize {
			return nil, errCorrupt("state index offset outside file")
		}
		if size == 0 {
			continue
		}
		raw := make([]byte, size)
		if _, err := f.ReadAt(raw, int64(b.byteOffset)); err != nil {
			return nil, fmt.Errorf("sidecar: read state block: %w", err)
		}
		data, err := dec.DecodeAll(raw, nil)
		if err != nil {
			return nil, fmt.Errorf("sidecar: decompress state block at frame %d: %w", start, err)
		}
		off, walked, prev := 0, 0, -1
		for off < len(data) {
			rec, n, err := decodeStateRecordAt(data, off)
			if err != nil {
				return nil, err
			}
			if rec.Frame < prev {
				return nil, errCorrupt("state frames not monotonic")
			}
			prev = rec.Frame
			if rec.Frame >= fromFrame && (unbounded || rec.Frame < toFrame) {
				out = append(out, data[off:n]...)
			}
			off = n
			walked++
		}
		if walked != int(b.frameCount) {
			return nil, fmt.Errorf("sidecar: state block at frame %d holds %d records, index says %d",
				start, walked, b.frameCount)
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
