package sidecar

import (
	"fmt"
	"path/filepath"
)

// Stream is a decoded sidecar: the header read at Open plus every frame in
// the requested range.
type Stream struct {
	Meta   Meta
	Frames []FrameWithPlayers
}

// Load opens the sidecar in dir and returns the header plus every decoded
// frame in [fromFrame, toFrame) — the Open → walk → DecodeFrames boilerplate
// every whole-stream consumer repeats (the presence heatmap in the root
// services, internal/spatial's series). 0, 0 means the whole match. The
// error names the failing stage (open/read/decode); a missing sidecar is
// ErrNoSidecar either way (errors.Is works through the wrap).
//
// It is LoadProgress without a callback; callers that want honest
// progress read the sibling's doc instead.
//
// Callers that only need meta or RAW bytes (the replay asset route, the
// provenance panel) keep using Open + ReadRange directly — decoding is
// pointless for them.
func Load(dir string, fromFrame, toFrame int) (Stream, error) {
	return LoadProgress(dir, fromFrame, toFrame, nil)
}

// LoadProgress is Load with an honest progress callback. progress is
// called once with (0, total) before the first block is read, then after
// every DECODED block with the running count of frames read AND decoded
// so far; total is the clamped range size — meta.Frames for a whole-match
// (0, 0) read. done therefore only ever counts complete frames out of a
// total known before the first byte is touched: a real denominator, never
// an estimate (progress frames the loading ladder's "honest progress"
// step; the caller decides the throttle and the wire payload).
//
// Decoding happens per block inside the shared walk (visitRangeStream —
// blocks hold whole frames, so a per-visit decode is frame-exact), which
// is what lets progress advance without re-opening positions.bin or the
// decompressor. The result is byte-identical to Load's, and a nil
// callback IS Load.
func LoadProgress(dir string, fromFrame, toFrame int, progress func(done, totalFrames int)) (Stream, error) {
	rd, err := Open(filepath.Clean(dir))
	if err != nil {
		return Stream{}, fmt.Errorf("open: %w", err)
	}
	meta := rd.Meta()
	lo, hi := rd.frameRange(fromFrame, toFrame)
	total := hi - lo
	if progress != nil {
		progress(0, total)
	}
	var frames []FrameWithPlayers
	var decodeErr error // marks the failing stage for Load's error wording
	err = rd.visitRangeStream(fromFrame, toFrame, func(delivered int, data []byte) error {
		fs, derr := DecodeFrames(data, meta.Players)
		if derr != nil {
			decodeErr = derr
			return derr
		}
		frames = append(frames, fs...)
		if progress != nil {
			progress(delivered, total)
		}
		return nil
	})
	if err != nil {
		if decodeErr != nil {
			return Stream{}, fmt.Errorf("decode frames: %w", decodeErr)
		}
		return Stream{}, fmt.Errorf("read stream: %w", err)
	}
	return Stream{Meta: meta, Frames: frames}, nil
}
