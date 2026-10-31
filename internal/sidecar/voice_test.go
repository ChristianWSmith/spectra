package sidecar

import (
	"bytes"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/extract"
)

// voiceStream is a synthetic 3-player chunk stream with deterministic
// payloads (byte i of chunk n = xuid*10 + n) so read-back slices prove
// byte-accurate offsets.
func voiceStream() []extract.VoiceChunk {
	xuids := []uint64{76561198000000001, 76561198000000002, 76561198000000003}
	var chunks []extract.VoiceChunk
	for n := 0; n < 30; n++ {
		x := xuids[n%len(xuids)]
		payload := bytes.Repeat([]byte{byte(x*10 + uint64(n))}, 3+n%5)
		chunks = append(chunks, extract.VoiceChunk{
			Tick:    1000 + n*3,
			XUID:    x,
			Payload: payload,
			Caster:  n == 7, // exactly one caster chunk
			Section: uint32(n / len(xuids)),
		})
	}
	return chunks
}

func TestVoiceWriterRoundtrip(t *testing.T) {
	dir := t.TempDir()
	w, err := NewVoiceWriter(dir)
	if err != nil {
		t.Fatalf("NewVoiceWriter: %v", err)
	}
	chunks := voiceStream()
	for _, c := range chunks {
		if err := w.Add(c); err != nil {
			t.Fatalf("Add(tick=%d xuid=%d): %v", c.Tick, c.XUID, err)
		}
	}
	meta, rows, err := w.Close()
	if err != nil {
		t.Fatalf("Close: %v", err)
	}

	wantBytes := 0
	for _, c := range chunks {
		wantBytes += len(c.Payload)
	}
	if meta.Chunks != len(chunks) || meta.Players != 3 || meta.Casters != 1 || meta.Bytes != wantBytes {
		t.Errorf("meta = %+v, want {Chunks:%d Players:3 Casters:1 Bytes:%d}",
			meta, len(chunks), wantBytes)
	}
	if len(rows) != len(chunks) {
		t.Fatalf("rows = %d, want %d", len(rows), len(chunks))
	}

	// Rows are in capture order with per-player offsets; SteamIDs decimal.
	offOf := map[string]int64{}
	for i, r := range rows {
		c := chunks[i]
		wantSteam := strconv.FormatUint(c.XUID, 10)
		if r.SteamID != wantSteam {
			t.Errorf("rows[%d].SteamID = %s, want %s", i, r.SteamID, wantSteam)
		}
		if r.Tick != c.Tick {
			t.Errorf("rows[%d].Tick = %d, want %d", i, r.Tick, c.Tick)
		}
		if r.Caster != c.Caster {
			t.Errorf("rows[%d].Caster = %v, want %v", i, r.Caster, c.Caster)
		}
		if r.Section != c.Section {
			t.Errorf("rows[%d].Section = %d, want %d", i, r.Section, c.Section)
		}
		if r.Round != 0 {
			t.Errorf("rows[%d].Round = %d, want 0 (store assigns)", i, r.Round)
		}
		if r.Off != offOf[r.SteamID] {
			t.Errorf("rows[%d].Off = %d, want %d (player %s append offset)", i, r.Off, offOf[r.SteamID], r.SteamID)
		}
		if r.Len != int64(len(c.Payload)) {
			t.Errorf("rows[%d].Len = %d, want %d", i, r.Len, len(c.Payload))
		}
		offOf[r.SteamID] = r.Off + r.Len

		// Byte-accurate read-back: Off..Off+Len slices the player file to
		// exactly this chunk's payload.
		path := filepath.Join(dir, VoiceDirName, r.SteamID+".opus")
		raw, err := os.ReadFile(path) //nolint:gosec // test-controlled temp path
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		got := raw[r.Off : r.Off+r.Len]
		if !bytes.Equal(got, c.Payload) {
			t.Errorf("rows[%d] payload mismatch: got %d bytes %x, want %x", i, len(got), got[:min(8, len(got))], c.Payload[:min(8, len(c.Payload))])
		}
	}

	// Per-player files exist and their sizes equal the player's total bytes.
	for xuid, final := range offOf {
		fi, err := os.Stat(filepath.Join(dir, VoiceDirName, xuid+".opus"))
		if err != nil {
			t.Fatalf("stat player file %s: %v", xuid, err)
		}
		if fi.Size() != final {
			t.Errorf("player %s file size = %d, want %d", xuid, fi.Size(), final)
		}
	}

	// Close is single-shot (positions.Writer.Close convention).
	if _, _, err := w.Close(); err == nil {
		t.Error("second Close: err = nil, want already-closed error")
	}
}

func TestVoiceWriterTruncatesOnRewrite(t *testing.T) {
	dir := t.TempDir()
	w, err := NewVoiceWriter(dir)
	if err != nil {
		t.Fatalf("NewVoiceWriter: %v", err)
	}
	big := bytes.Repeat([]byte{0xAA}, 64)
	for i := 0; i < 5; i++ {
		if err := w.Add(extract.VoiceChunk{Tick: i, XUID: 42, Payload: big}); err != nil {
			t.Fatalf("Add: %v", err)
		}
	}
	if _, _, err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	path := filepath.Join(dir, VoiceDirName, "42.opus")
	if fi, err := os.Stat(path); err != nil || fi.Size() != 320 {
		t.Fatalf("pre-rewrite size = %v %v, want 320", fi, err)
	}

	// Rewrite: NewVoiceWriter + os.Create must truncate the stale file.
	w2, err := NewVoiceWriter(dir)
	if err != nil {
		t.Fatalf("NewVoiceWriter (rewrite): %v", err)
	}
	if err := w2.Add(extract.VoiceChunk{Tick: 99, XUID: 42, Payload: []byte{1, 2, 3}}); err != nil {
		t.Fatalf("Add (rewrite): %v", err)
	}
	meta, rows, err := w2.Close()
	if err != nil {
		t.Fatalf("Close (rewrite): %v", err)
	}
	if meta.Chunks != 1 || meta.Bytes != 3 {
		t.Errorf("rewrite meta = %+v, want {Chunks:1 Bytes:3}", meta)
	}
	raw, err := os.ReadFile(path) //nolint:gosec // test-controlled temp path
	if err != nil {
		t.Fatalf("read rewritten file: %v", err)
	}
	if !bytes.Equal(raw, []byte{1, 2, 3}) {
		t.Errorf("rewritten file = %x, want 010203", raw)
	}
	if rows[0].Off != 0 || rows[0].Len != 3 {
		t.Errorf("rewrite row = %+v, want Off=0 Len=3", rows[0])
	}
}

func TestVoiceWriterAddAfterClose(t *testing.T) {
	w, err := NewVoiceWriter(t.TempDir())
	if err != nil {
		t.Fatalf("NewVoiceWriter: %v", err)
	}
	if _, _, err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := w.Add(extract.VoiceChunk{XUID: 1, Payload: []byte{0}}); err == nil {
		t.Error("Add after Close: err = nil, want error")
	}
}
