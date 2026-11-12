package main

import (
	"encoding/json"
	"path/filepath"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/data"
	"github.com/ChristianWSmith/spectra/internal/extract"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/sidecar"
)

// TestHeatmapProgressEmitter pins THE spectra:heatmap-progress emitter
// GetHeatmap's presence path shares (heatmapProgress / heatmapProgressFor /
// throttledHeatmapProgress): the wire payload shape the frontend reads,
// the throttle drop rule with its two never-throttled exemptions (closing
// determinate call, stage change), and the nil seams — a service
// constructed without an app handle has no emitter and must never panic.
// The window is injected so the test can never race the real clock (the
// mirror of TestAssetProgressEmitter in mappackservice_test.go).
func TestHeatmapProgressEmitter(t *testing.T) {
	// The wire contract: the three JSON keys the renderer parses.
	raw, err := json.Marshal(HeatmapProgressEvent{Stage: heatmapStageLoad, Done: 7, Total: 120})
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"stage", "done", "total"} {
		if _, ok := wire[key]; !ok {
			t.Errorf("HeatmapProgressEvent JSON missing %q: %s", key, raw)
		}
	}
	if wire["stage"] != "load" {
		t.Errorf("payload = %s, want stage=load", raw)
	}

	// The drop rule, on a window far larger than the test's own runtime:
	// the FIRST call always emits (nothing seen yet), an intermediate call
	// inside the window on the SAME stage is dropped, the closing call
	// (done == total) is never throttled, and a STAGE change is never
	// throttled — the chip must switch phases immediately.
	var seen []HeatmapProgressEvent
	cb := throttledHeatmapProgress(time.Hour, func(ev HeatmapProgressEvent) { seen = append(seen, ev) })
	cb(heatmapStageLoad, 0, 3)
	cb(heatmapStageLoad, 1, 3)   // dropped: intermediate, same stage
	cb(heatmapStageLoad, 3, 3)   // closing determinate call — always
	cb(heatmapStageRaster, 0, 0) // stage change — always
	cb(heatmapStageRaster, 0, 0) // dropped: intermediate, same (indeterminate) stage
	want := []HeatmapProgressEvent{
		{Stage: heatmapStageLoad, Done: 0, Total: 3},
		{Stage: heatmapStageLoad, Done: 3, Total: 3},
		{Stage: heatmapStageRaster, Done: 0, Total: 0},
	}
	if !slices.Equal(seen, want) {
		t.Errorf("emitted %+v, want %+v", seen, want)
	}

	// An open window (0) drops nothing — the rule is the window itself,
	// not a cap on how many events a run may send.
	var all []HeatmapProgressEvent
	open := throttledHeatmapProgress(0, func(ev HeatmapProgressEvent) { all = append(all, ev) })
	for i := 0; i <= 3; i++ {
		open(heatmapStageLoad, i, 3)
	}
	if len(all) != 4 {
		t.Errorf("window=0 emitted %d calls, want 4: %+v", len(all), all)
	}

	// Nil seams: no emitter, no panic (the package's service tests build
	// AnalyticsService without an app handle).
	if got := heatmapProgress(nil); got != nil {
		t.Error("heatmapProgress(nil emit, …) = non-nil, want nil")
	}
	if got := heatmapProgressFor(nil); got != nil {
		t.Error("heatmapProgressFor(nil app, …) = non-nil, want nil (a handle-less service never emits)")
	}
}

// TestHeatmapPresenceProgressDenominators pins the honest numbers of the
// end-to-end presence path: every "load" event carries the sidecar's real
// frame count as its total (meta.Frames for a whole-match read), done
// starts at 0 before the first byte and lands exactly on the total (frames
// fully read AND decoded), and the run ends by handing the indeterminate
// 0/0 "raster" stage to the renderer — never a fabricated fraction.
func TestHeatmapPresenceProgressDenominators(t *testing.T) {
	useTempXDG(t)
	st, id := seedHeatmapMatch(t, nil)
	as := &AnalyticsService{st: st}

	// 100 frames @ tick = frame index (mirrors
	// TestHeatmapPresenceBandFilter's sidecar seeding): a single zstd
	// block, so the load phase reports 0 → 100 in two honest steps.
	dir := filepath.Join(data.MatchesDir(), strconv.FormatInt(id, 10))
	w, err := sidecar.NewWriter(dir, 64)
	if err != nil {
		t.Fatalf("NewWriter: %v", err)
	}
	for i := 0; i < 100; i++ {
		players := []extract.PositionPlayer{
			{SteamID: 100, X: 0, Y: 0, Z: 0},
			{SteamID: 200, X: 100, Y: 0, Z: 200},
		}
		if err := w.AddFrame(int32(i), players); err != nil {
			t.Fatalf("AddFrame %d: %v", i, err)
		}
	}
	if _, err := w.Close(64); err != nil {
		t.Fatalf("Close sidecar: %v", err)
	}

	// The rounds projection + side resolver GetHeatmap would build (the
	// test drives heatmapPresence directly so progress lands in a
	// recorder instead of an app handle).
	roundInfos, err := st.GetRoundInfos(id)
	if err != nil {
		t.Fatalf("GetRoundInfos: %v", err)
	}
	roundSpans := make([]models.Round, len(roundInfos))
	for i, r := range roundInfos {
		roundSpans[i] = models.Round{Number: r.Number, StartTick: r.StartTick, EndTick: r.EndTick}
	}
	sideAt := func(string, int) string { return "" }

	var seen []HeatmapProgressEvent
	progress := func(stage string, done, total int) {
		seen = append(seen, HeatmapProgressEvent{Stage: stage, Done: done, Total: total})
	}
	g, err := as.heatmapPresence(id, HeatmapFilter{RoundFrom: -1, RoundTo: -1}, roundSpans, sideAt, progress)
	if err != nil {
		t.Fatalf("heatmapPresence: %v", err)
	}
	if g.Samples != 200 {
		t.Errorf("presence samples = %d, want 200 (2 players × 100 frames) — progress must not disturb the raster", g.Samples)
	}

	want := []HeatmapProgressEvent{
		{Stage: heatmapStageLoad, Done: 0, Total: 100},
		{Stage: heatmapStageLoad, Done: 100, Total: 100},
		{Stage: heatmapStageRaster, Done: 0, Total: 0},
	}
	if !slices.Equal(seen, want) {
		t.Fatalf("progress = %+v, want %+v", seen, want)
	}
	for _, ev := range seen {
		if ev.Stage == heatmapStageLoad && ev.Total != 100 {
			t.Errorf("load event total = %d, want the stream's 100 frames (sidecar meta)", ev.Total)
		}
	}
}
