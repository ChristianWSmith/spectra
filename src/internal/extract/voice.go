package extract

import "fmt"

// VoiceChunk is one CSVCMsg_VoiceData capture unit. Payload is exactly one
// raw Opus packet (no TOC/length wrapper, 10 ms mono frame); Tick is
// GameState().IngameTick() at handler
// time (the message's own tick field is 0 in SourceTV demos); Section is the
// per-sender chunk counter used to detect rare gaps. XUID is the sender's
// SteamID64 (0 when absent).
type VoiceChunk struct {
	Tick    int
	XUID    uint64
	Payload []byte
	Caster  bool
	Section uint32
}

// VoiceSink receives one call per captured voice chunk. Implementations
// must consume Payload synchronously (the slice is only valid for the call
// — same contract as PositionSink). An error returned from Add aborts the
// parse.
type VoiceSink interface {
	Add(c VoiceChunk) error
}

// voiceGate buffers the voice chunks captured during ONE frame while
// extract.Parse's sanitization gate may still be closed (owner ruling,
// 2026-11-12: no data before the first counted round's start tick). The
// gate signal — the first counted round exists — only becomes known at
// events.RoundStart, which demoinfocs dispatches at the END of the frame,
// after the frame's net messages, so a chunk cannot be delivered (or
// refused) at handler time.
//
// INVARIANT (pinned by TestVoiceGate and the golden-parse pins): no chunk
// with tick < the first counted round's startTick ever reaches the sink;
// chunks AT startTick ARE kept — they arrive in the boundary frame, whose
// frameEnd already sees the gate open.
//
// The buffer is frame-scoped: frameEnd must run once per FrameDone (Parse
// also runs it once after ParseToEnd for late end-of-demo messages), and it
// either flushes every buffered chunk to the sink (gate open) or discards
// them (gate closed) — at most one frame of chunks is ever held in memory.
type voiceGate struct {
	pending []VoiceChunk
}

// add buffers one chunk (net-message handler time).
func (g *voiceGate) add(c VoiceChunk) {
	g.pending = append(g.pending, c)
}

// frameEnd flushes the frame's buffered chunks to sink when the gate is
// open, discards them when it is closed, and clears the buffer either way.
// A sink error is returned wrapped exactly like Parse's other sink errors
// (the caller cancels the parse).
func (g *voiceGate) frameEnd(open bool, sink VoiceSink) error {
	if open {
		for _, c := range g.pending {
			if err := sink.Add(c); err != nil {
				g.pending = g.pending[:0]
				return fmt.Errorf("extract: voice sink: %w", err)
			}
		}
	}
	g.pending = g.pending[:0]
	return nil
}
