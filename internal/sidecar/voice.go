package sidecar

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"github.com/ChristianWSmith/spectra/internal/extract"
	"github.com/ChristianWSmith/spectra/internal/models"
)

// VoiceDirName is the per-match voice subdirectory inside a match dir.
const VoiceDirName = "voice"

// VoiceMeta is the summary returned by VoiceWriter.Close.
type VoiceMeta struct {
	Chunks  int
	Players int
	Casters int
	Bytes   int
}

// voiceFile is one open per-player payload file plus its append offset.
type voiceFile struct {
	f   *os.File
	off int64
}

// VoiceWriter appends Opus payloads to a match's voice/<xuid>.opus files
// and accumulates the chunk-index rows the store persists as voice_chunks.
// Deliberate design: there is NO chunks.idx
// file — the database IS the index (voice_chunks rows carry per-player
// Off/Len); one fewer file to keep consistent with the DB, and rows are
// written in a single transaction at import end anyway.
// It implements extract.VoiceSink. One VoiceWriter owns one match
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
// and records its index row (Off/Len against that player's file, in
// insertion order). Payload is only read here.
func (w *VoiceWriter) Add(c extract.VoiceChunk) error {
	if w.closed {
		return errors.New("sidecar: add voice chunk after close")
	}
	vf, ok := w.files[c.XUID]
	if !ok {
		f, err := os.Create(filepath.Join(w.dir, strconv.FormatUint(c.XUID, 10)+".opus"))
		if err != nil {
			return fmt.Errorf("sidecar: create voice file for %d: %w", c.XUID, err)
		}
		vf = &voiceFile{f: f}
		w.files[c.XUID] = vf
	}
	n, err := vf.f.Write(c.Payload)
	if err != nil {
		return fmt.Errorf("sidecar: write voice chunk: %w", err)
	}
	w.rows = append(w.rows, models.VoiceIndexRow{
		Tick:    c.Tick,
		SteamID: strconv.FormatUint(c.XUID, 10),
		Off:     vf.off,
		Len:     int64(n),
		Caster:  c.Caster,
		Section: c.Section,
	})
	vf.off += int64(n)
	return nil
}

// Close closes every per-player file and returns the summary plus the
// index rows in capture order (steam IDs as decimal strings; Round stays 0
// — the store assigns rounds from the match's round tick ranges at insert
// time). Single-shot like positions.Writer.Close: a second call errors.
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
	for id, vf := range w.files {
		if err := vf.f.Close(); err != nil {
			return meta, nil, fmt.Errorf("sidecar: close voice file %d: %w", id, err)
		}
	}
	return meta, w.rows, nil
}
