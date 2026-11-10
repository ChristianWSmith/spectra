package sidecar

import (
	"encoding/binary"
	"errors"
	"math"
	"os"
	"path/filepath"
	"testing"

	"github.com/klauspost/compress/zstd"

	"github.com/ChristianWSmith/spectra/internal/extract"
)

const (
	slotA = uint64(76561198000000001)
	slotB = uint64(76561198000000002)
)

// syntheticState derives frame i's players from a deterministic pattern:
// moving integer coordinates (they survive int16 quantization exactly),
// yaw sweeping the full circle (including the 0..360 raw range), a side
// cycling ct/t/unknown, alternating flags, and a mask that cycles
// through both-alive / A-only / B-only / both-dead.
func syntheticState(i int) (tick int32, players []extract.PositionPlayer) {
	tick = int32(1000 + i*2)
	sides := [...]string{"ct", "t", ""}
	mk := func(id uint64, i int, air, duck bool) extract.PositionPlayer {
		return extract.PositionPlayer{
			SteamID: id,
			X:       float32(i%2000 - 1000),
			Y:       float32(i % 100),
			Z:       float32(-(i % 50)),
			Yaw:     float32((i*13)%360 - 180),
			Air:     air,
			Duck:    duck,
			Side:    sides[i%3],
		}
	}
	switch i % 5 {
	case 0, 1:
		players = append(players, mk(slotA, i, i%2 == 0, i%3 == 0), mk(slotB, i+7, i%4 == 0, i%7 == 0))
	case 2:
		players = append(players, mk(slotA, i, i%2 == 0, i%3 == 0))
	case 3:
		players = append(players, mk(slotB, i+7, i%4 == 0, i%7 == 0))
	case 4:
		// both dead: empty frame
	}
	return tick, players
}

// playerPayload is one decoded slot's quantized state.
type playerPayload struct {
	x, y, z float32
	yaw     byte
	flags   byte
}

// decodedFrame is one frame parsed back out of the raw stream.
type decodedFrame struct {
	tick   int32
	mask   uint16
	bySlot map[int]playerPayload // ascending slot order
}

// decodeStream parses a whole raw stream into frames (independent of the
// writer's internals — it only trusts the documented layout).
func decodeStream(t *testing.T, data []byte) []decodedFrame {
	t.Helper()
	var out []decodedFrame
	off := 0
	for off < len(data) {
		tick, mask, err := decodeFrameHeader(data, off)
		if err != nil {
			t.Fatalf("frame header at %d: %v", off, err)
		}
		off += 6
		f := decodedFrame{tick: tick, mask: mask, bySlot: map[int]playerPayload{}}
		for slot := 0; slot < 16; slot++ {
			if mask&(1<<uint(slot)) == 0 {
				continue
			}
			if off+8 > len(data) {
				t.Fatalf("truncated payload at %d", off)
			}
			f.bySlot[slot] = playerPayload{
				x:     float32(int16(binary.LittleEndian.Uint16(data[off : off+2]))),
				y:     float32(int16(binary.LittleEndian.Uint16(data[off+2 : off+4]))),
				z:     float32(int16(binary.LittleEndian.Uint16(data[off+4 : off+6]))),
				yaw:   data[off+6],
				flags: data[off+7],
			}
			off += 8
		}
		out = append(out, f)
	}
	if off != len(data) {
		t.Fatalf("stream walked to %d of %d bytes", off, len(data))
	}
	return out
}

// writeSynthetic writes n frames through a Writer and closes it at 64 Hz.
func writeSynthetic(t *testing.T, dir string, n int) Meta {
	t.Helper()
	w, err := NewWriter(dir, 0)
	if err != nil {
		t.Fatalf("NewWriter: %v", err)
	}
	for i := 0; i < n; i++ {
		tick, players := syntheticState(i)
		if err := w.AddFrame(tick, players); err != nil {
			t.Fatalf("AddFrame %d: %v", i, err)
		}
	}
	meta, err := w.Close(64)
	if err != nil {
		t.Fatalf("Close: %v", err)
	}
	return meta
}

// assertFrames checks every decoded frame against the synthetic source:
// slots resolve to the right SteamIDs, integer coordinates survive
// quantization, mask bits track aliveness, and yaw/flags re-encode to the
// same bytes.
func assertFrames(t *testing.T, got []decodedFrame, from int) {
	t.Helper()
	for j, f := range got {
		i := from + j
		tick, players := syntheticState(i)
		if f.tick != tick {
			t.Errorf("frame %d tick = %d, want %d", i, f.tick, tick)
		}
		wantMask := uint16(0)
		for _, p := range players {
			slot := 0
			if p.SteamID == slotB {
				slot = 1
			}
			wantMask |= 1 << uint(slot)
		}
		if f.mask != wantMask {
			t.Errorf("frame %d mask = %#b, want %#b", i, f.mask, wantMask)
			continue
		}
		for _, p := range players {
			slot := 0
			if p.SteamID == slotB {
				slot = 1
			}
			got, ok := f.bySlot[slot]
			if !ok {
				t.Fatalf("frame %d slot %d missing", i, slot)
			}
			if got.x != p.X || got.y != p.Y || got.z != p.Z {
				t.Errorf("frame %d slot %d pos = (%v,%v,%v), want (%v,%v,%v)",
					i, slot, got.x, got.y, got.z, p.X, p.Y, p.Z)
			}
			if wantYaw := quantYaw(p.Yaw); got.yaw != wantYaw {
				t.Errorf("frame %d slot %d yaw byte = %d, want %d (deg %v)",
					i, slot, got.yaw, wantYaw, p.Yaw)
			}
			var wantFlags byte
			if p.Air {
				wantFlags |= 1
			}
			if p.Duck {
				wantFlags |= 2
			}
			wantFlags |= sideFlagBits(p.Side)
			if got.flags != wantFlags {
				t.Errorf("frame %d slot %d flags = %#b, want %#b", i, slot, got.flags, wantFlags)
			}
			if s := sideFlagString(got.flags); s != p.Side {
				t.Errorf("frame %d slot %d side = %q, want %q", i, slot, s, p.Side)
			}
		}
	}
}

func TestWriteReadRoundtripFull(t *testing.T) {
	dir := t.TempDir()
	meta := writeSynthetic(t, dir, 1000)

	if meta.SampleRate != SampleRate ||
		meta.Encoding != Encoding || meta.Frames != 1000 || meta.TickRate != 64 {
		t.Errorf("Close meta mismatch: %+v", meta)
	}
	if meta.CreatedAt.IsZero() {
		t.Error("CreatedAt is zero")
	}
	if len(meta.Players) != 2 || meta.Players[0] != slotA || meta.Players[1] != slotB {
		t.Fatalf("slot table = %v, want [%d %d] (first-seen order)", meta.Players, slotA, slotB)
	}
	if meta.Slot(slotB) != 1 || meta.Slot(slotA) != 0 || meta.Slot(42) != -1 {
		t.Errorf("Slot lookups wrong: %d %d %d", meta.Slot(slotA), meta.Slot(slotB), meta.Slot(42))
	}

	r, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if r.Meta().Frames != 1000 || r.Meta().TickRate != 64 {
		t.Errorf("Reader meta = %+v", r.Meta())
	}
	raw, err := r.ReadRange(0, 0)
	if err != nil {
		t.Fatalf("ReadRange(0,0): %v", err)
	}
	frames := decodeStream(t, raw)
	if len(frames) != 1000 {
		t.Fatalf("frames = %d, want 1000", len(frames))
	}
	assertFrames(t, frames, 0)
}

func TestReadRangeSingleFrame(t *testing.T) {
	dir := t.TempDir()
	writeSynthetic(t, dir, 1000)
	r, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	raw, err := r.ReadRange(500, 501)
	if err != nil {
		t.Fatalf("ReadRange: %v", err)
	}
	frames := decodeStream(t, raw)
	if len(frames) != 1 {
		t.Fatalf("frames = %d, want 1", len(frames))
	}
	assertFrames(t, frames, 500)
}

func TestReadRangeSpansBlockBoundary(t *testing.T) {
	dir := t.TempDir()
	writeSynthetic(t, dir, 1000)
	r, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	// Block boundary sits between frames 255 and 256.
	from, to := 250, 262
	raw, err := r.ReadRange(from, to)
	if err != nil {
		t.Fatalf("ReadRange: %v", err)
	}
	frames := decodeStream(t, raw)
	if len(frames) != to-from {
		t.Fatalf("frames = %d, want %d", len(frames), to-from)
	}
	assertFrames(t, frames, from)
}

func TestReadRangeClamps(t *testing.T) {
	dir := t.TempDir()
	writeSynthetic(t, dir, 1000)
	r, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	count := func(from, to int) int {
		t.Helper()
		raw, err := r.ReadRange(from, to)
		if err != nil {
			t.Fatalf("ReadRange(%d,%d): %v", from, to, err)
		}
		return len(decodeStream(t, raw))
	}

	// from clamps to 0; to <= from means "through the end".
	if n := count(-10, 0); n != 1000 {
		t.Errorf("ReadRange(-10,0) frames = %d, want 1000", n)
	}
	// to beyond the end clamps to frames.
	if n := count(0, 999999); n != 1000 {
		t.Errorf("ReadRange(0,999999) frames = %d, want 1000", n)
	}
	// from beyond the end → empty.
	if n := count(1000, 2000); n != 0 {
		t.Errorf("ReadRange(1000,2000) frames = %d, want 0", n)
	}
	if n := count(5000, 9999); n != 0 {
		t.Errorf("ReadRange(5000,9999) frames = %d, want 0", n)
	}
	// to < from → whole stream from `from`.
	if n := count(5, 3); n != 995 {
		t.Errorf("ReadRange(5,3) frames = %d, want 995", n)
	}
}

func TestIdxMath(t *testing.T) {
	dir := t.TempDir()
	writeSynthetic(t, dir, 1000)

	idxRaw, err := os.ReadFile(filepath.Join(dir, IdxName))
	if err != nil {
		t.Fatalf("read idx: %v", err)
	}
	entries, err := parseIdxEntries(idxRaw)
	if err != nil {
		t.Fatalf("parse idx: %v", err)
	}
	want := []idxEntry{
		{firstFrame: 0, frameCount: 256},
		{firstFrame: 256, frameCount: 256},
		{firstFrame: 512, frameCount: 256},
		{firstFrame: 768, frameCount: 232},
	}
	if len(entries) != len(want) {
		t.Fatalf("idx entries = %d, want %d", len(entries), len(want))
	}
	binInfo, err := os.Stat(filepath.Join(dir, BinName))
	if err != nil {
		t.Fatalf("stat bin: %v", err)
	}
	var prevEnd uint64 // end offset of the previous block (0 for i==0)
	for i, e := range entries {
		if e.firstFrame != want[i].firstFrame || e.frameCount != want[i].frameCount {
			t.Errorf("entry %d = %+v, want %+v", i, e, want[i])
		}
		if i > 0 {
			// Blocks are concatenated: each offset starts where the
			// previous one ended, so offsets strictly increase.
			if e.byteOffset != prevEnd {
				t.Errorf("entry %d offset %d, want contiguous %d", i, e.byteOffset, prevEnd)
			}
			if e.byteOffset <= entries[i-1].byteOffset {
				t.Errorf("entry %d offset %d not beyond previous %d", i, e.byteOffset, entries[i-1].byteOffset)
			}
		}
		// Every entry must point at an independent zstd frame magic.
		f, err := os.Open(filepath.Join(dir, BinName))
		if err != nil {
			t.Fatalf("open bin: %v", err)
		}
		magic := make([]byte, 4)
		_, err = f.ReadAt(magic, int64(e.byteOffset))
		_ = f.Close()
		if err != nil {
			t.Fatalf("read magic at entry %d: %v", i, err)
		}
		if binary.LittleEndian.Uint32(magic) != 0xFD2FB528 {
			t.Errorf("entry %d offset %d: magic = %x, want zstd frame", i, e.byteOffset, magic)
		}
		if i+1 < len(entries) {
			prevEnd = entries[i+1].byteOffset
		} else {
			prevEnd = uint64(binInfo.Size())
		}
	}
	if prevEnd != uint64(binInfo.Size()) {
		t.Errorf("last block end = %d, want bin size %d", prevEnd, binInfo.Size())
	}
}

func TestOpenMissingSidecar(t *testing.T) {
	t.Run("missing dir", func(t *testing.T) {
		if _, err := Open(filepath.Join(t.TempDir(), "nope")); !errors.Is(err, ErrNoSidecar) {
			t.Errorf("Open(missing dir) err = %v, want ErrNoSidecar", err)
		}
	})
	t.Run("empty dir", func(t *testing.T) {
		if _, err := Open(t.TempDir()); !errors.Is(err, ErrNoSidecar) {
			t.Errorf("Open(empty dir) err = %v, want ErrNoSidecar", err)
		}
	})
	t.Run("meta without idx", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, MetaName), []byte("{}"), 0o644); err != nil {
			t.Fatalf("write meta: %v", err)
		}
		if _, err := Open(dir); !errors.Is(err, ErrNoSidecar) {
			t.Errorf("Open(meta only) err = %v, want ErrNoSidecar", err)
		}
	})
}

func TestUnknownSteamIDSkippedNotFatal(t *testing.T) {
	dir := t.TempDir()
	w, err := NewWriter(dir, 0)
	if err != nil {
		t.Fatalf("NewWriter: %v", err)
	}
	latecomer := uint64(76561198000000003)
	if err := w.AddFrame(100, []extract.PositionPlayer{
		{SteamID: slotA, X: 1, Y: 2, Z: 3},
		{SteamID: slotB, X: 4, Y: 5, Z: 6},
	}); err != nil {
		t.Fatalf("AddFrame #1: %v", err)
	}
	if err := w.AddFrame(102, []extract.PositionPlayer{
		{SteamID: slotA, X: 7, Y: 8, Z: 9},
		{SteamID: latecomer, X: 10, Y: 11, Z: 12}, // never got a slot
	}); err != nil {
		t.Fatalf("AddFrame #2 (unknown id must not fail): %v", err)
	}
	meta, err := w.Close(64)
	if err != nil {
		t.Fatalf("Close: %v", err)
	}
	if len(meta.Players) != 2 || meta.Players[0] != slotA || meta.Players[1] != slotB {
		t.Fatalf("slot table = %v, want [A B] frozen at first frame", meta.Players)
	}

	r, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	raw, err := r.ReadRange(0, 0)
	if err != nil {
		t.Fatalf("ReadRange: %v", err)
	}
	frames := decodeStream(t, raw)
	if len(frames) != 2 {
		t.Fatalf("frames = %d, want 2", len(frames))
	}
	if frames[0].mask != 0b11 {
		t.Errorf("frame 0 mask = %#b, want 0b11", frames[0].mask)
	}
	// The latecomer was dropped: only slot A survives.
	if frames[1].mask != 0b01 {
		t.Errorf("frame 1 mask = %#b, want 0b01", frames[1].mask)
	}
	if frames[1].bySlot[0].x != 7 {
		t.Errorf("frame 1 slot 0 x = %v, want 7", frames[1].bySlot[0].x)
	}
}

func TestAddFrameAfterCloseFails(t *testing.T) {
	dir := t.TempDir()
	w, err := NewWriter(dir, 0)
	if err != nil {
		t.Fatalf("NewWriter: %v", err)
	}
	if _, err := w.Close(64); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := w.AddFrame(1, nil); err == nil {
		t.Error("AddFrame after Close: want error, got nil")
	}
	if _, err := w.Close(64); err == nil {
		t.Error("second Close: want error, got nil")
	}
}

func TestEmptySidecarRoundtrip(t *testing.T) {
	dir := t.TempDir()
	w, err := NewWriter(dir, 0)
	if err != nil {
		t.Fatalf("NewWriter: %v", err)
	}
	meta, err := w.Close(0)
	if err != nil {
		t.Fatalf("Close: %v", err)
	}
	if meta.Frames != 0 || meta.TickRate != 0 || len(meta.Players) != 0 {
		t.Errorf("empty meta = %+v", meta)
	}
	r, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	raw, err := r.ReadRange(0, 0)
	if err != nil {
		t.Fatalf("ReadRange: %v", err)
	}
	if len(raw) != 0 {
		t.Errorf("empty sidecar returned %d bytes", len(raw))
	}
}

// TestBlockIndependentDecode proves each positions.bin block is a
// standalone zstd frame (the Range-serving path decompresses blocks
// in isolation).
func TestBlockIndependentDecode(t *testing.T) {
	dir := t.TempDir()
	writeSynthetic(t, dir, 1000)

	idxRaw, err := os.ReadFile(filepath.Join(dir, IdxName))
	if err != nil {
		t.Fatalf("read idx: %v", err)
	}
	entries, err := parseIdxEntries(idxRaw)
	if err != nil {
		t.Fatalf("parse idx: %v", err)
	}
	bin, err := os.ReadFile(filepath.Join(dir, BinName))
	if err != nil {
		t.Fatalf("read bin: %v", err)
	}
	dec, err := zstd.NewReader(nil)
	if err != nil {
		t.Fatalf("zstd reader: %v", err)
	}
	defer dec.Close()

	total := 0
	for i, e := range entries {
		end := len(bin)
		if i+1 < len(entries) {
			end = int(entries[i+1].byteOffset)
		}
		data, err := dec.DecodeAll(bin[e.byteOffset:end], nil)
		if err != nil {
			t.Fatalf("DecodeAll block %d: %v", i, err)
		}
		off, walked := 0, 0
		for off < len(data) {
			n, err := frameLen(data, off)
			if err != nil {
				t.Fatalf("block %d frame %d: %v", i, walked, err)
			}
			off += n
			walked++
		}
		if walked != int(e.frameCount) {
			t.Errorf("block %d frames = %d, want %d", i, walked, e.frameCount)
		}
		total += walked
	}
	if total != 1000 {
		t.Errorf("total frames across blocks = %d, want 1000", total)
	}
}

// TestQuantYawWrap: yaw encodes modulo 360 (real yaw is 0..360; the decode
// contract is -180..180) — wrapping beats clamping, so the full circle
// stays distinct.
func TestQuantYawWrap(t *testing.T) {
	if quantYaw(270) != quantYaw(-90) {
		t.Errorf("quantYaw(270)=%d != quantYaw(-90)=%d (must wrap)", quantYaw(270), quantYaw(-90))
	}
	if quantYaw(359) == quantYaw(179) {
		t.Error("359° and 179° must encode differently")
	}
	for _, deg := range []float32{-180, -90, 0, 45, 90, 179, 180, 270, 359.9} {
		got := float64(quantYaw(deg))/256*360 - 180
		want := float64(deg)
		if want > 180 {
			want -= 360
		}
		delta := math.Abs(got - want)
		if delta > 180 {
			delta = 360 - delta // circular distance (±180 are the same angle)
		}
		if delta > 360.0/256+0.001 {
			t.Errorf("quantYaw(%v) decoded to %v, want ~%v", deg, got, want)
		}
	}
}
