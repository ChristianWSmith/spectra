package extract

import (
	"errors"
	"strings"
	"testing"
)

// recordingVoice is a VoiceSink that keeps every delivered chunk's tick.
type recordingVoice struct {
	ticks []int
	err   error
}

func (s *recordingVoice) Add(c VoiceChunk) error {
	if s.err != nil {
		return s.err
	}
	s.ticks = append(s.ticks, c.Tick)
	return nil
}

// TestVoiceGate pins the pre-first-counted-round voice sanitization seam
// (owner ruling, 2026-11-12): the gate is only known at FrameDone, so
// chunks are buffered per frame and then flushed (gate open) or discarded
// (gate closed). INVARIANT: no chunk with tick < the first counted round's
// startTick ever reaches the sink; chunks AT startTick ARE kept — they sit
// in the boundary frame, whose frameEnd sees the gate open.
func TestVoiceGate(t *testing.T) {
	t.Run("closed frame discards its chunks", func(t *testing.T) {
		var g voiceGate
		sink := &recordingVoice{}
		g.add(VoiceChunk{Tick: 100})
		g.add(VoiceChunk{Tick: 150})
		if err := g.frameEnd(false, sink); err != nil {
			t.Fatalf("frameEnd: %v", err)
		}
		if len(sink.ticks) != 0 {
			t.Errorf("delivered ticks %v, want none (gate closed)", sink.ticks)
		}
	})

	t.Run("boundary frame flushes chunks captured while the gate was closed", func(t *testing.T) {
		// The exact boundary scenario: the frame's net messages arrive
		// BEFORE events.RoundStart dispatches, so they are buffered while
		// the gate is closed; the FrameDone after RoundStart sees the gate
		// open and must flush them — chunks AT startTick are kept.
		var g voiceGate
		sink := &recordingVoice{}
		g.add(VoiceChunk{Tick: 2919}) // == first counted round startTick
		g.add(VoiceChunk{Tick: 2919})
		if err := g.frameEnd(true, sink); err != nil {
			t.Fatalf("frameEnd: %v", err)
		}
		if len(sink.ticks) != 2 || sink.ticks[0] != 2919 || sink.ticks[1] != 2919 {
			t.Errorf("delivered ticks %v, want both chunks at 2919 (boundary flush)", sink.ticks)
		}
	})

	t.Run("buffer is frame-scoped", func(t *testing.T) {
		var g voiceGate
		sink := &recordingVoice{}
		g.add(VoiceChunk{Tick: 1})
		if err := g.frameEnd(true, sink); err != nil {
			t.Fatalf("frameEnd #1: %v", err)
		}
		// A second frameEnd with nothing added must deliver nothing: one
		// frame of chunks at most is ever held or re-delivered.
		if err := g.frameEnd(true, sink); err != nil {
			t.Fatalf("frameEnd #2: %v", err)
		}
		if len(sink.ticks) != 1 {
			t.Errorf("delivered ticks %v, want exactly the one buffered chunk", sink.ticks)
		}
	})

	t.Run("pre-boundary frames never deliver", func(t *testing.T) {
		// Two full frames below the boundary, then the boundary frame.
		var g voiceGate
		sink := &recordingVoice{}
		for frame := 0; frame < 3; frame++ {
			g.add(VoiceChunk{Tick: frame})
			if err := g.frameEnd(false, sink); err != nil { // gate closed
				t.Fatalf("frameEnd(%d): %v", frame, err)
			}
		}
		g.add(VoiceChunk{Tick: 3}) // boundary frame, gate opens at FrameDone
		if err := g.frameEnd(true, sink); err != nil {
			t.Fatalf("boundary frameEnd: %v", err)
		}
		if len(sink.ticks) != 1 || sink.ticks[0] != 3 {
			t.Errorf("delivered ticks %v, want only the boundary-frame chunk [3]", sink.ticks)
		}
	})

	t.Run("sink error is wrapped and the buffer is cleared", func(t *testing.T) {
		var g voiceGate
		sink := &recordingVoice{err: errors.New("boom")}
		g.add(VoiceChunk{Tick: 1})
		err := g.frameEnd(true, sink)
		if err == nil || !strings.Contains(err.Error(), "extract: voice sink: boom") {
			t.Fatalf("error = %v, want wrapped 'extract: voice sink: boom'", err)
		}
		if len(g.pending) != 0 {
			t.Errorf("pending = %d chunks after an error, want 0 (cleared)", len(g.pending))
		}
	})
}
