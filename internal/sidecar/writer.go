package sidecar

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/klauspost/compress/zstd"

	"github.com/ChristianWSmith/spectra/internal/extract"
)

// Writer appends sampled frames to a match's positions.bin in ≤256-frame
// zstd blocks, then writes positions.idx and meta.json on Close. It
// implements extract.PositionSink. One Writer owns one match directory.
type Writer struct {
	dir      string
	bin      *os.File
	enc      *zstd.Encoder
	tickRate float64

	buf        []byte // current block's raw frames
	comp       []byte // scratch for EncodeAll output
	blockFirst int    // first frame index of the current block
	frames     int
	offset     int64 // bytes written to positions.bin so far
	idx        []idxEntry

	slots       []uint64
	slotOf      map[uint64]int
	slotsLocked bool // slot table assigned by the first non-empty frame
	skipped     map[uint64]bool

	// st is the sparse player-state stream (state.go); its files are
	// created lazily by the first AddState — a parse without a State
	// sink ships no state.bin/idx at all.
	st stateStream

	created time.Time
	closed  bool
}

// NewWriter creates dir if needed and truncates any previous
// positions.bin/positions.idx (reprocessing replaces the sidecar in
// place). tickRate is the fallback recorded in meta.json when Close is
// called with tickRate <= 0.
func NewWriter(dir string, tickRate float64) (*Writer, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("sidecar: create directory: %w", err)
	}
	bin, err := os.Create(filepath.Join(dir, BinName))
	if err != nil {
		return nil, fmt.Errorf("sidecar: create %s: %w", BinName, err)
	}
	// Truncate a stale index too — it is only rewritten at Close, and a
	// half-written sidecar must never keep old index bytes.
	if idx, err := os.Create(filepath.Join(dir, IdxName)); err != nil {
		_ = bin.Close()
		return nil, fmt.Errorf("sidecar: create %s: %w", IdxName, err)
	} else if err := idx.Close(); err != nil {
		_ = bin.Close()
		return nil, fmt.Errorf("sidecar: close %s: %w", IdxName, err)
	}
	enc, err := zstd.NewWriter(nil)
	if err != nil {
		_ = bin.Close()
		return nil, fmt.Errorf("sidecar: zstd writer: %w", err)
	}
	// Remove any stale state files: reprocessing replaces the sidecar in
	// place, and the state stream is recreated lazily (a reprocess whose
	// parse fails before AddState must not keep the old state.bin).
	_ = os.Remove(filepath.Join(dir, StateBinName))
	_ = os.Remove(filepath.Join(dir, StateIdxName))
	return &Writer{
		dir:      dir,
		bin:      bin,
		enc:      enc,
		tickRate: tickRate,
		buf:      make([]byte, 0, BlockFrames*96),
		slotOf:   make(map[uint64]int),
		skipped:  make(map[uint64]bool),
		st: stateStream{
			dir:     dir,
			enc:     enc,
			intern:  map[string]uint8{unknownWeaponName: 0},
			names:   []string{unknownWeaponName},
			skipped: make(map[uint64]bool),
		},
		created: time.Now().UTC(),
	}, nil
}

// AddFrame encodes one frame (extract.PositionSink). The slot table is
// assigned at the first frame that carries players, in first-seen SteamID
// order; SteamIDs that appear later are skipped with a log line instead of
// failing the parse (a slot is never retroactively renumbered — the index
// must stay stable for readers). Flushes a zstd block every BlockFrames
// frames. players must not be retained by the caller side — it is only
// read here.
func (w *Writer) AddFrame(tick int32, players []extract.PositionPlayer) error {
	if w.closed {
		return errors.New("sidecar: add frame after close")
	}
	if !w.slotsLocked && len(players) > 0 {
		for _, p := range players {
			if len(w.slots) >= maxSlots {
				w.logSkip(p.SteamID, "slot table full")
				continue
			}
			w.slotOf[p.SteamID] = len(w.slots)
			w.slots = append(w.slots, p.SteamID)
		}
		w.slotsLocked = true
	}
	var mask uint16
	var bySlot [maxSlots]extract.PositionPlayer
	for _, p := range players {
		slot, ok := w.slotOf[p.SteamID]
		if !ok {
			w.logSkip(p.SteamID, "not in first-frame slot table")
			continue
		}
		if mask&(1<<uint(slot)) != 0 {
			// Duplicate SteamID in one frame (bots share SteamID 0):
			// the first sighting wins the slot.
			continue
		}
		mask |= 1 << uint(slot)
		bySlot[slot] = p
	}
	w.buf = encodeFrame(w.buf, tick, mask, &bySlot)
	w.frames++
	if w.frames-w.blockFirst >= BlockFrames {
		if err := w.flushBlock(); err != nil {
			return err
		}
	}
	return nil
}

// logSkip records an unusable SteamID once per Writer.
func (w *Writer) logSkip(steamID uint64, why string) {
	if w.skipped[steamID] {
		return
	}
	w.skipped[steamID] = true
	slog.Warn("sidecar: player skipped from position stream", "steamId", steamID, "reason", why)
}

// flushBlock compresses the buffered frames and appends them to
// positions.bin, recording the block's index entry.
func (w *Writer) flushBlock() error {
	if len(w.buf) == 0 {
		return nil
	}
	w.comp = w.enc.EncodeAll(w.buf, w.comp[:0])
	n, err := w.bin.Write(w.comp)
	w.offset += int64(n)
	if err != nil {
		return fmt.Errorf("sidecar: write block: %w", err)
	}
	w.idx = append(w.idx, idxEntry{
		firstFrame: uint32(w.blockFirst),
		byteOffset: uint64(w.offset - int64(n)),
		frameCount: uint16(w.frames - w.blockFirst),
	})
	w.buf = w.buf[:0]
	w.blockFirst = w.frames
	return nil
}

// Close flushes the final partial block, writes positions.idx and
// meta.json, and returns the recorded metadata. tickRate is the demo's
// tick rate (values <= 0 fall back to the rate given to NewWriter). Close
// is single-shot: a second call returns an error.
func (w *Writer) Close(tickRate float64) (Meta, error) {
	var meta Meta
	if w.closed {
		return meta, errors.New("sidecar: writer already closed")
	}
	w.closed = true
	if err := w.flushBlock(); err != nil {
		return meta, err
	}
	// State stream: flush its final block before the shared encoder
	// closes, then close state.bin (close is a no-op when the stream was
	// never used — no state files ship).
	if err := w.st.close(); err != nil {
		return meta, err
	}
	if err := w.bin.Close(); err != nil {
		return meta, fmt.Errorf("sidecar: close %s: %w", BinName, err)
	}
	if w.st.bin != nil {
		if err := w.st.bin.Close(); err != nil {
			return meta, fmt.Errorf("sidecar: close %s: %w", StateBinName, err)
		}
	}
	if err := w.enc.Close(); err != nil {
		return meta, fmt.Errorf("sidecar: close encoder: %w", err)
	}

	var idxRaw []byte
	for _, e := range w.idx {
		idxRaw = appendIdxEntry(idxRaw, e)
	}
	if err := os.WriteFile(filepath.Join(w.dir, IdxName), idxRaw, 0o644); err != nil {
		return meta, fmt.Errorf("sidecar: write %s: %w", IdxName, err)
	}

	tr := tickRate
	if tr <= 0 {
		tr = w.tickRate
	}
	meta = Meta{
		FormatVersion: FormatVersion,
		TickRate:      tr,
		SampleRate:    SampleRate,
		Frames:        w.frames,
		Encoding:      Encoding,
		Players:       w.slots,
		CreatedAt:     w.created,
	}
	// State stream capability (absent fields = no stream, which is how
	// pre-stream imports read): version + the interned weapon-name table
	// records live against.
	if w.st.bin != nil {
		meta.StateFormatVersion = StateFormatVersion
		meta.WeaponNames = w.st.names
	}
	raw, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return Meta{}, fmt.Errorf("sidecar: marshal meta: %w", err)
	}
	if err := os.WriteFile(filepath.Join(w.dir, MetaName), append(raw, '\n'), 0o644); err != nil {
		return Meta{}, fmt.Errorf("sidecar: write %s: %w", MetaName, err)
	}
	return meta, nil
}
