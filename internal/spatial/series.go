// Package spatial computes the M5 §2.4 sidecar-derived time series that
// need no map-pack region polygons: teammate spacing and team spread over
// time buckets. (Pattern detectors and region occupancy are descoped by
// the M5 status note — they need per-map region polygons Spectra does not
// capture; this package ships the recomputable series only.)
//
// The series is computed on read from the position sidecar: the
// whole stream is decoded once (same pattern as the presence heatmap) and
// every frame contributes at most one sample to its tick bucket. Values
// are world-unit distances in the horizontal (x,y) plane; buckets without
// a valid frame sample are -1 (team dead / warmup gaps / unknown sides).
package spatial

import (
	"fmt"
	"math"
	"path/filepath"

	"github.com/ChristianWSmith/spectra/internal/sidecar"
)

// Kind names the two v1 series.
const (
	// KindSpacing is the average distance between alive teammates: per
	// frame, for each team with ≥2 alive players, the mean pairwise (x,y)
	// distance among that team's alive players; the frame's value is the
	// mean across the teams that had a valid sample. Frames where no team
	// has ≥2 alive players contribute no sample.
	KindSpacing = "spacing"
	// KindSpread is the team spread: per frame, the mean pairwise (x,y)
	// distance across ALL alive players regardless of team. Frames with
	// fewer than 2 alive players contribute no sample.
	KindSpread = "spread"
)

// DefaultBuckets is the series resolution when the caller passes ≤ 0
// (120 buckets ≈ one per 1.25 s on a ~2:30 match).
const DefaultBuckets = 120

// Series is one recomputable sidecar series: Values has length Buckets
// over [FromTick, ToTick]; -1 marks a bucket with no valid sample.
type Series struct {
	Kind     string
	Buckets  int
	FromTick int
	ToTick   int
	Values   []float64
}

// Compute decodes the sidecar in dir (match sidecar root) and computes
// the requested kind series. sides maps SteamID → final side ("ct"/"t");
// players absent from it are excluded from both metrics (team attribution
// requires a known side — same final-side model as the heatmap filters).
// durationTicks ≤ 0 falls back to the largest frame tick; buckets ≤ 0
// means DefaultBuckets. Warmup frames are kept: their values are valid
// positions.
func Compute(dir, kind string, buckets, durationTicks int, sides map[uint64]string) (Series, error) {
	if kind != KindSpacing && kind != KindSpread {
		return Series{}, fmt.Errorf("spatial: unknown series kind %q", kind)
	}
	if buckets <= 0 {
		buckets = DefaultBuckets
	}
	rd, err := sidecar.Open(filepath.Clean(dir))
	if err != nil {
		return Series{}, fmt.Errorf("spatial: %w", err)
	}
	raw, err := rd.ReadRange(0, 0)
	if err != nil {
		return Series{}, fmt.Errorf("spatial: read stream: %w", err)
	}
	frames, err := sidecar.DecodeFrames(raw, rd.Meta().Players)
	if err != nil {
		return Series{}, fmt.Errorf("spatial: decode frames: %w", err)
	}
	if durationTicks <= 0 {
		for _, fr := range frames {
			if fr.Tick > durationTicks {
				durationTicks = fr.Tick
			}
		}
	}

	sums := make([]float64, buckets)
	counts := make([]int, buckets)
	for _, fr := range frames {
		v, ok := frameMetric(fr, kind, sides)
		if !ok {
			continue
		}
		b := fr.Tick * buckets / durationTicks
		if b < 0 {
			b = 0
		}
		if b >= buckets {
			b = buckets - 1
		}
		sums[b] += v
		counts[b]++
	}

	values := make([]float64, buckets)
	for i := range values {
		if counts[i] == 0 {
			values[i] = -1
		} else {
			values[i] = sums[i] / float64(counts[i])
		}
	}
	return Series{
		Kind: kind, Buckets: buckets,
		FromTick: 0, ToTick: durationTicks,
		Values: values,
	}, nil
}

// frameMetric computes one frame's sample. ok=false means "no sample"
// (fewer than the metric's minimum of attributed alive players).
func frameMetric(fr sidecar.FrameWithPlayers, kind string, sides map[uint64]string) (float64, bool) {
	// Attributed alive players only (presence in the sidecar frame =
	// alive + connected pawn).
	bySide := map[string][]sidecar.FramePlayer{}
	var all []sidecar.FramePlayer
	for _, p := range fr.Players {
		side, ok := sides[p.SteamID]
		if !ok || (side != "ct" && side != "t") {
			continue
		}
		bySide[side] = append(bySide[side], p)
		all = append(all, p)
	}
	switch kind {
	case KindSpacing:
		var sum float64
		var teams int
		for _, ps := range bySide {
			if len(ps) < 2 {
				continue
			}
			sum += meanPairwise(ps)
			teams++
		}
		if teams == 0 {
			return 0, false
		}
		return sum / float64(teams), true
	case KindSpread:
		if len(all) < 2 {
			return 0, false
		}
		return meanPairwise(all), true
	}
	return 0, false
}

// meanPairwise returns the mean (x,y) Euclidean distance over all
// unordered pairs (n≤1 → 0).
func meanPairwise(ps []sidecar.FramePlayer) float64 {
	var sum float64
	var pairs int
	for i := 0; i < len(ps); i++ {
		for j := i + 1; j < len(ps); j++ {
			dx := ps[i].X - ps[j].X
			dy := ps[i].Y - ps[j].Y
			sum += math.Hypot(dx, dy)
			pairs++
		}
	}
	if pairs == 0 {
		return 0
	}
	return sum / float64(pairs)
}
