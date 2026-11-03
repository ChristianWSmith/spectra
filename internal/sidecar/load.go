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
// frame in [fromFrame, toFrame) — the Open → ReadRange → DecodeFrames
// boilerplate every whole-stream consumer repeats (the presence heatmap in
// the root services, internal/spatial's series). 0, 0 means the whole
// match. The error names the failing stage (open/read/decode); a missing
// sidecar is ErrNoSidecar either way (errors.Is works through the wrap).
//
// Callers that only need meta or RAW bytes (the replay asset route, the
// provenance panel) keep using Open + ReadRange directly — decoding is
// pointless for them.
func Load(dir string, fromFrame, toFrame int) (Stream, error) {
	rd, err := Open(filepath.Clean(dir))
	if err != nil {
		return Stream{}, fmt.Errorf("open: %w", err)
	}
	raw, err := rd.ReadRange(fromFrame, toFrame)
	if err != nil {
		return Stream{}, fmt.Errorf("read stream: %w", err)
	}
	frames, err := DecodeFrames(raw, rd.meta.Players)
	if err != nil {
		return Stream{}, fmt.Errorf("decode frames: %w", err)
	}
	return Stream{Meta: rd.meta, Frames: frames}, nil
}
