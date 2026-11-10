// Package sidecar persists the per-match tactical position stream outside
// SQLite: a quantized per-frame player sample written during
// extraction, block-compressed so ranges can be fetched and decompressed
// server-side without the frontend ever owning a zstd decoder.
//
// # Raw stream layout (encoding "q16")
//
// positions.bin decompresses to a concatenation of frames, each:
//
//	tick   int32  little-endian (demo ingame tick)
//	mask   uint16 little-endian, bit i set = slot i has a payload
//	for each set bit in ascending slot order:
//		x      int16 little-endian, world units quantized at 1.0 (clamped ±32767)
//		y      int16 little-endian, same quantization
//		z      int16 little-endian, same quantization
//		yaw    uint8, (deg+180)/360*256 wrapped to 0..255 (deg in -180..180)
//		flags  uint8, bit0 = airborne, bit1 = ducking,
//		       bits2-3 = side (0 unknown, 1 t, 2 ct)
//
// The yaw byte is the player's real view yaw; the flags byte carries
// airborne/ducking plus the per-frame side (bits 2-3).
//
// The slot table (steamID per slot, first-seen order) lives in meta.json;
// slots are assigned at the first frame that carries players and later
// unknown SteamIDs are skipped with a log line (never a parse failure).
// The quantization is 1.0 u int16 — 8 B/player, ~9.1 MB raw / ~2.5 MB zstd
// for the golden demo.
//
// # Files
//
//	positions.bin  concatenated independent zstd frames (one per ≤256-frame
//	               block — EncodeAll, so each block decompresses alone)
//	positions.idx  fixed 16-byte entries per block: firstFrame uint32,
//	               byteOffset uint64, frameCount uint16, pad uint16
//	meta.json      Meta (encoding, tick rate, sample rate, counts,
//	               slot table + its teammate colors, plus the state
//	               stream's weaponNames when present — see state.go)
//
// A second, independent stream (state.bin/state.idx) carries sparse
// per-change player state — see state.go for its layout, rationale and
// measurement. Voice is a third, per-player payload pair under voice/ —
// <steamid>.opus plus its fixed-record chunk index <steamid>.idx — see
// voice.go (writer + record layout) and voicereader.go (reader).
package sidecar

import (
	"encoding/binary"
	"fmt"
	"math"
	"math/bits"
	"time"

	"github.com/ChristianWSmith/spectra/internal/extract"
)

// Format constants recorded in meta.json.
const (
	// SampleRate is frames per second: samples are 1:1 with demo frames
	// (full 64 Hz).
	SampleRate = 64
	// Encoding names the quantization scheme of the raw stream.
	Encoding = "q16"
	// BlockFrames is the maximum number of frames per zstd block.
	BlockFrames = 256
	// maxSlots is the alive-mask width (uint16) — the hard slot-table cap.
	maxSlots = 16
	// coordClamp bounds world coordinates into the int16 grid.
	coordClamp = 32767
	// side bits in the flags byte: 0 unknown, 1 t, 2 ct (sideMask is the
	// value mask; shift by sideShift at use).
	sideShift       = 2
	sideMask        = 3
	flagSideUnknown = 0
	flagSideT       = 1
	flagSideCT      = 2
)

// Sidecar file names inside a match directory.
const (
	BinName  = "positions.bin"
	IdxName  = "positions.idx"
	MetaName = "meta.json"

	// idxEntrySize is the fixed width of one positions.idx entry.
	idxEntrySize = 16
)

// Player is one slot-table identity (kept as a typed JSON entry shape for
// consumers of meta.json; Meta.Players stores the compact uint64 list).
type Player struct {
	SteamID uint64 `json:"steamId"`
}

// Meta is meta.json: the sidecar's self-describing header. It is the
// source of truth for frame count and the slot table; matches.position_*
// mirror it.
type Meta struct {
	TickRate   float64   `json:"tickRate"`
	SampleRate int       `json:"sampleRate"` // 64
	Frames     int       `json:"frames"`
	Encoding   string    `json:"encoding"` // "q16"
	Players    []uint64  `json:"players"`  // slot table, first-seen order
	CreatedAt  time.Time `json:"createdAt"`

	// State stream (state.go): WeaponNames is written iff the stream
	// exists — its presence IS the capability marker (absent = no state
	// stream — a parse with no State sink — and readers fail soft,
	// exactly like a missing sidecar). The state record's
	// weapon/inventory bytes are indices into WeaponNames (interned
	// first-seen order, [0] = "Unknown").
	WeaponNames []string `json:"weaponNames,omitempty"`

	// PlayerColors parallels Players BY SLOT INDEX: the raw
	// m_iCompTeammateColor of each slot-table player (CS2.md "Player
	// scoreboard/radar colors": 0 blue, 1 green, 2 yellow, 3 orange,
	// 4 purple, -1 none/GOTV), delivered by extract's RosterSink at the
	// end of the parse. Absent (nil) in sidecars written before the
	// field or in parses that carried no roster — consumers report "no
	// color" for a missing or short entry, never a guessed one.
	PlayerColors []int `json:"playerColors,omitempty"`
}

// Slot returns the slot-table index for steamID, or -1 when the player is
// not in the table (the helper Writer uses to resolve frames).
func (m Meta) Slot(steamID uint64) int {
	for i, id := range m.Players {
		if id == steamID {
			return i
		}
	}
	return -1
}

// ColorAt returns the raw m_iCompTeammateColor recorded for a slot (CS2.md
// "Player scoreboard/radar colors": 0 blue … 4 purple, -1 none) and
// whether the sidecar carries a color row for it at all — a sidecar
// written before PlayerColors reports ok=false, so callers render "no
// color" instead of reading an absent entry as 0 (blue).
func (m Meta) ColorAt(slot int) (int, bool) {
	if slot < 0 || slot >= len(m.PlayerColors) {
		return 0, false
	}
	return m.PlayerColors[slot], true
}

// idxEntry mirrors one 16-byte positions.idx record.
type idxEntry struct {
	firstFrame uint32
	byteOffset uint64
	frameCount uint16
}

// appendIdxEntry appends the little-endian encoding of e to b.
func appendIdxEntry(b []byte, e idxEntry) []byte {
	var raw [idxEntrySize]byte
	binary.LittleEndian.PutUint32(raw[0:4], e.firstFrame)
	binary.LittleEndian.PutUint64(raw[4:12], e.byteOffset)
	binary.LittleEndian.PutUint16(raw[12:14], e.frameCount)
	// raw[14:16] pad stays zero.
	return append(b, raw[:]...)
}

// parseIdxEntries decodes a whole positions.idx payload.
func parseIdxEntries(b []byte) ([]idxEntry, error) {
	if len(b)%idxEntrySize != 0 {
		return nil, fmt.Errorf("sidecar: index length %d is not a multiple of %d", len(b), idxEntrySize)
	}
	out := make([]idxEntry, 0, len(b)/idxEntrySize)
	for off := 0; off < len(b); off += idxEntrySize {
		out = append(out, idxEntry{
			firstFrame: binary.LittleEndian.Uint32(b[off : off+4]),
			byteOffset: binary.LittleEndian.Uint64(b[off+4 : off+12]),
			frameCount: binary.LittleEndian.Uint16(b[off+12 : off+14]),
		})
	}
	return out, nil
}

// errCorrupt builds a sidecar integrity error (truncated/misaligned data).
func errCorrupt(msg string) error { return fmt.Errorf("sidecar: corrupt data: %s", msg) }

// quantCoord truncates a world coordinate onto the int16 @1.0 u grid,
// clamped to ±32767 (the M2-T1 spike's encoding).
func quantCoord(v float32) uint16 {
	c := float64(v)
	if c > coordClamp {
		c = coordClamp
	}
	if c < -coordClamp {
		c = -coordClamp
	}
	return uint16(int16(c))
}

// quantYaw maps a direction in degrees onto 0..255 (spike encoding),
// wrapping any input (real yaw is 0..360; the decode contract is
// -180..180).
func quantYaw(deg float32) byte {
	y := math.Mod(float64(deg)+180.0, 360.0)
	if y < 0 {
		y += 360.0
	}
	return byte(y / 360.0 * 256.0)
}

// sideFlagBits maps a models side string onto the flags-byte side bits.
func sideFlagBits(side string) byte {
	switch side {
	case "t":
		return flagSideT << sideShift
	case "ct":
		return flagSideCT << sideShift
	default:
		return flagSideUnknown << sideShift
	}
}

// sideFlagString maps decoded flags-byte side bits back to the models side
// vocabulary ("" for unknown).
func sideFlagString(flags byte) string {
	switch (flags >> sideShift) & sideMask {
	case flagSideT:
		return "t"
	case flagSideCT:
		return "ct"
	default:
		return ""
	}
}

// encodeFrame appends one frame to dst. bySlot is indexed by slot; only
// slots present in mask are read, in ascending slot order (the on-wire
// order). dst must already be empty of this frame's bytes.
func encodeFrame(dst []byte, tick int32, mask uint16, bySlot *[maxSlots]extract.PositionPlayer) []byte {
	var fh [6]byte
	binary.LittleEndian.PutUint32(fh[0:4], uint32(tick))
	binary.LittleEndian.PutUint16(fh[4:6], mask)
	dst = append(dst, fh[:]...)
	for slot := 0; slot < maxSlots; slot++ {
		if mask&(1<<uint(slot)) == 0 {
			continue
		}
		p := &bySlot[slot]
		var pb [8]byte
		binary.LittleEndian.PutUint16(pb[0:2], quantCoord(p.X))
		binary.LittleEndian.PutUint16(pb[2:4], quantCoord(p.Y))
		binary.LittleEndian.PutUint16(pb[4:6], quantCoord(p.Z))
		pb[6] = quantYaw(p.Yaw)
		var flags byte
		if p.Air {
			flags |= 1
		}
		if p.Duck {
			flags |= 2
		}
		flags |= sideFlagBits(p.Side)
		pb[7] = flags
		dst = append(dst, pb[:]...)
	}
	return dst
}

// frameLen returns the encoded length of the frame starting at off in data
// (or an error when truncated).
func frameLen(data []byte, off int) (int, error) {
	if off+6 > len(data) {
		return 0, errCorrupt("truncated frame header")
	}
	mask := binary.LittleEndian.Uint16(data[off+4 : off+6])
	n := 6 + bits.OnesCount16(mask)*8
	if off+n > len(data) {
		return 0, errCorrupt("truncated frame payload")
	}
	return n, nil
}
