package sidecar

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"

	"github.com/ChristianWSmith/spectra/internal/extract"
	"github.com/ChristianWSmith/spectra/internal/models"
)

// VoiceDirName is the per-match voice subdirectory inside a match dir.
const VoiceDirName = "voice"

// Voice file names inside <matchDir>/voice: one Opus payload per player
// plus that player's fixed-record chunk index, written together at Close.
const (
	voicePayloadExt = ".opus"
	voiceIdxExt     = ".idx"
)

// voiceIdxRecordSize is the fixed width of one <steamid>.idx record,
// little-endian:
//
//	tick     int32   demo tick
//	off      uint32  byte offset inside <steamid>.opus
//	section  uint32  capture section
//	len      uint16  payload bytes
//	flags    uint8   bit0 = caster
//	reserved uint8   0
//
// One file per player, sorted by tick (sort.SliceStable at Close — ties
// keep capture order), no compression: fixed 16-byte records, so a window
// read binary-searches the file on disk and pulls only that window's
// records (see VoiceReader.Chunks). The round number is NOT
// stored (its only reader was a metrics groupBy whose source is gone);
// compute it at read time with store.RoundForTick if ever needed.
const voiceIdxRecordSize = 16

// voiceIdxFlagCaster is bit0 of a record's flags byte.
const voiceIdxFlagCaster = 1

// maxVoicePayloadBytes caps one player's .opus file: off is uint32 in the
// index record, so a payload at 4 GiB could no longer be addressed.
const maxVoicePayloadBytes = 1 << 32

// maxVoiceIdxLen is the largest len a record can hold (uint16 on disk) —
// an Opus packet is ≤1275 bytes, so this only ever trips on corruption.
const maxVoiceIdxLen = int64(1<<16 - 1)

// appendVoiceIdxRecord appends the little-endian encoding of one row to b.
// Off/Len are validated against the record limits by Close before this runs.
func appendVoiceIdxRecord(b []byte, r models.VoiceIndexRow) []byte {
	var raw [voiceIdxRecordSize]byte
	binary.LittleEndian.PutUint32(raw[0:4], uint32(r.Tick))
	binary.LittleEndian.PutUint32(raw[4:8], uint32(r.Off))
	binary.LittleEndian.PutUint32(raw[8:12], r.Section)
	binary.LittleEndian.PutUint16(raw[12:14], uint16(r.Len))
	if r.Caster {
		raw[14] = voiceIdxFlagCaster
	}
	// raw[15] reserved stays zero.
	return append(b, raw[:]...)
}

// VoiceMeta is the summary returned by VoiceWriter.Close.
type VoiceMeta struct {
	Chunks  int
	Players int
	Casters int
	Bytes   int
}

// voiceFile is one open per-player payload file: a buffered writer (the
// chunks are ~10 ms frames of tens-to-hundreds of bytes — one unbuffered
// Write each would be ~105k tiny syscalls per match), its append offset
// and the cached decimal SteamID stem the rows and file names share
// (strconv.FormatUint once per player, not once per chunk).
type voiceFile struct {
	f     *os.File
	bw    *bufio.Writer
	off   int64
	steam string
}

// VoiceWriter appends Opus payloads to a match's voice/<xuid>.opus files
// and accumulates the chunk-index rows, which Close serializes to one
// <xuid>.idx per player (see voiceIdxRecordSize — the index lives in the
// sidecar, never in SQLite; the store only keeps the voice_presence
// header). It implements extract.VoiceSink. One VoiceWriter owns one match
// directory; NewVoiceWriter creates <dir>/voice and every per-player file
// is created with os.Create, so a rewrite truncates stale bytes (the
// library also wipes the voice dir before constructing a writer).
type VoiceWriter struct {
	dir    string
	files  map[uint64]*voiceFile
	rows   []models.VoiceIndexRow
	closed bool
}

// NewVoiceWriter creates <dir>/voice (layout).
func NewVoiceWriter(dir string) (*VoiceWriter, error) {
	voiceDir := filepath.Join(dir, VoiceDirName)
	if err := os.MkdirAll(voiceDir, 0o755); err != nil {
		return nil, fmt.Errorf("sidecar: create voice directory: %w", err)
	}
	return &VoiceWriter{
		dir:   voiceDir,
		files: make(map[uint64]*voiceFile),
	}, nil
}

// Add appends one chunk's payload to voice/<xuid>.opus (extract.VoiceSink)
// and records its index row (Off/Len against that player's file, in capture
// order — Close serializes them tick-sorted). Payload is only read here.
// The payload write is buffered (the per-player file flushes at Close) and
// the decimal SteamID is formatted once per player, not once per chunk.
func (w *VoiceWriter) Add(c extract.VoiceChunk) error {
	if w.closed {
		return errors.New("sidecar: add voice chunk after close")
	}
	vf, ok := w.files[c.XUID]
	if !ok {
		steamID := strconv.FormatUint(c.XUID, 10) // formatted ONCE per player
		f, err := os.Create(filepath.Join(w.dir, steamID+voicePayloadExt))
		if err != nil {
			return fmt.Errorf("sidecar: create voice file for %d: %w", c.XUID, err)
		}
		vf = &voiceFile{f: f, bw: bufio.NewWriter(f), steam: steamID}
		w.files[c.XUID] = vf
	}
	n, err := vf.bw.Write(c.Payload)
	if err != nil {
		return fmt.Errorf("sidecar: write voice chunk: %w", err)
	}
	w.rows = append(w.rows, models.VoiceIndexRow{
		Tick:    c.Tick,
		SteamID: vf.steam,
		Off:     vf.off,
		Len:     int64(n),
		Caster:  c.Caster,
		Section: c.Section,
	})
	vf.off += int64(n)
	return nil
}

// Close flushes and closes every per-player payload file, then writes one
// <steamid>.idx per player — the rows sorted by tick (sort.SliceStable:
// ties keep capture order) — and returns the summary plus the index rows
// in capture order (steam IDs as decimal strings). Single-shot like
// positions.Writer.Close: a second call errors.
func (w *VoiceWriter) Close() (VoiceMeta, []models.VoiceIndexRow, error) {
	var meta VoiceMeta
	if w.closed {
		return meta, nil, errors.New("sidecar: voice writer already closed")
	}
	w.closed = true
	meta.Chunks = len(w.rows)
	meta.Players = len(w.files)
	for _, r := range w.rows {
		meta.Bytes += int(r.Len)
		if r.Caster {
			meta.Casters++
		}
	}
	// Payload files first: flush the buffered chunks, then their final
	// sizes are the bound every record's uint32 off must stay inside, and
	// the size the reader validates against.
	byPlayer := make(map[string][]models.VoiceIndexRow, len(w.files))
	for id, vf := range w.files {
		if err := vf.bw.Flush(); err != nil {
			return meta, nil, fmt.Errorf("sidecar: flush voice file %d: %w", id, err)
		}
		if vf.off > maxVoicePayloadBytes {
			return meta, nil, fmt.Errorf("sidecar: voice payload %d is %d bytes, over the %d byte index limit",
				id, vf.off, maxVoicePayloadBytes)
		}
		if err := vf.f.Close(); err != nil {
			return meta, nil, fmt.Errorf("sidecar: close voice file %d: %w", id, err)
		}
	}
	for _, r := range w.rows {
		if r.Len < 0 || r.Len > maxVoiceIdxLen {
			return meta, nil, fmt.Errorf("sidecar: voice chunk for %s is %d bytes, over the %d byte record limit",
				r.SteamID, r.Len, maxVoiceIdxLen)
		}
		byPlayer[r.SteamID] = append(byPlayer[r.SteamID], r)
	}
	for steamID, rows := range byPlayer {
		sort.SliceStable(rows, func(i, j int) bool { return rows[i].Tick < rows[j].Tick })
		buf := make([]byte, 0, len(rows)*voiceIdxRecordSize)
		for _, r := range rows {
			buf = appendVoiceIdxRecord(buf, r)
		}
		// In-place write, exactly like positions.idx: os.WriteFile
		// truncates, so a rewrite never keeps stale records.
		if err := os.WriteFile(filepath.Join(w.dir, steamID+voiceIdxExt), buf, 0o644); err != nil {
			return meta, nil, fmt.Errorf("sidecar: write voice index %s: %w", steamID, err)
		}
	}
	return meta, w.rows, nil
}
