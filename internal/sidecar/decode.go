package sidecar

import (
	"encoding/binary"
	"math/bits"
)

// FramePlayer is one player's sample inside a decoded frame.
type FramePlayer struct {
	SteamID uint64
	Slot    int
	X, Y, Z float64
	Yaw     float64 // degrees, -180..180
	Air     bool
	Duck    bool
}

// FrameWithPlayers is one decoded q16-v1 frame (stream layout).
type FrameWithPlayers struct {
	Tick    int
	Players []FramePlayer
}

// DecodeFrames walks a decompressed q16-v1 stream (the raw bytes a
// Reader.ReadRange returns) and decodes every frame. slotTable is the
// meta.json slot table (SteamID per slot, first-seen order); slots absent
// from it are skipped, mirroring Writer.AddFrame. Truncated/misaligned
// data yields an error (partial output is not returned).
func DecodeFrames(b []byte, slotTable []uint64) ([]FrameWithPlayers, error) {
	var out []FrameWithPlayers
	off := 0
	for off < len(b) {
		if off+6 > len(b) {
			return nil, errCorrupt("truncated frame header")
		}
		tick := int(binary.LittleEndian.Uint32(b[off : off+4]))
		mask := binary.LittleEndian.Uint16(b[off+4 : off+6])
		off += 6
		n := bits.OnesCount16(mask)
		if off+n*8 > len(b) {
			return nil, errCorrupt("truncated frame payload")
		}
		f := FrameWithPlayers{Tick: tick}
		for slot := 0; slot < maxSlots; slot++ {
			if mask&(1<<uint(slot)) == 0 {
				continue
			}
			p := b[off : off+8]
			off += 8
			if slot >= len(slotTable) {
				continue // unknown slot — skip like the writer does
			}
			f.Players = append(f.Players, FramePlayer{
				SteamID: slotTable[slot],
				Slot:    slot,
				X:       float64(int16(binary.LittleEndian.Uint16(p[0:2]))),
				Y:       float64(int16(binary.LittleEndian.Uint16(p[2:4]))),
				Z:       float64(int16(binary.LittleEndian.Uint16(p[4:6]))),
				Yaw:     float64(p[6])/256*360 - 180,
				Air:     p[7]&1 != 0,
				Duck:    p[7]&2 != 0,
			})
		}
		out = append(out, f)
	}
	return out, nil
}
