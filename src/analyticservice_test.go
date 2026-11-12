package main

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"slices"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/data"
	"github.com/ChristianWSmith/spectra/internal/extract"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/sidecar"
	"github.com/ChristianWSmith/spectra/internal/store"
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

// TestRecomputeRunnerLifecycle pins the background-recompute state
// machine: submit returns without running anything (the compute is on a
// goroutine), a duplicate submit for an in-flight match is refused, a
// second match queues BEHIND the single compute slot (serialization —
// RebuildCareer must never interleave two Computes), states report
// running/queued while in flight and drain afterwards, and each run
// announces analysis-progress (stage analyze, indeterminate 0/0) before
// analysis-done carries the outcome — "" on success, the failure text
// otherwise.
func TestRecomputeRunnerLifecycle(t *testing.T) {
	type recEv struct {
		name    string
		payload any
	}
	var mu sync.Mutex
	var seen []recEv
	emit := func(name string, payload any) {
		mu.Lock()
		defer mu.Unlock()
		seen = append(seen, recEv{name, payload})
	}
	events := func() []recEv {
		mu.Lock()
		defer mu.Unlock()
		return slices.Clone(seen)
	}
	rc := &recomputeRunner{}
	waitFor := func(what string, cond func() bool) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for !cond() {
			if time.Now().After(deadline) {
				s := rc.states()
				t.Fatalf("timed out waiting for %s (states %+v)", what, s)
			}
			time.Sleep(2 * time.Millisecond)
		}
	}

	started := make(chan struct{})
	release := make(chan struct{})
	ranSecond := make(chan bool, 1)

	if !rc.submit(7, emit, func() error { close(started); <-release; return nil }) {
		t.Fatal("first submit was deduped")
	}
	<-started // run 7 holds the slot and is inside compute()

	// Dedupe: a second submit for the in-flight match never starts a run.
	if rc.submit(7, emit, func() error { t.Error("duplicate run started"); return nil }) {
		t.Error("submit accepted while match 7 is already running")
	}

	// A different match queues behind the slot.
	if !rc.submit(8, emit, func() error { ranSecond <- true; return errors.New("boom") }) {
		t.Fatal("second submit was deduped")
	}
	waitFor("match 7 running and match 8 queued", func() bool {
		s := rc.states()
		return slices.Equal(s.Running, []int64{7}) && slices.Equal(s.Queued, []int64{8})
	})
	if got := len(events()); got != 1 {
		t.Fatalf("%d events while run 2 waits for the slot, want 1 (match 8 must not have started)", got)
	}

	close(release)
	waitFor("both runs drained", func() bool {
		s := rc.states()
		return len(s.Running) == 0 && len(s.Queued) == 0
	})
	<-ranSecond // draining implies match 8's compute ran (and only once — see the deduped submit)

	got := events()
	want := []recEv{
		{name: eventAnalysisProgress, payload: AnalysisProgressEvent{MatchID: 7, Stage: models.StageAnalyze, Done: 0, Total: 0}},
		{name: eventAnalysisDone, payload: AnalysisDoneEvent{MatchID: 7, Error: ""}},
		{name: eventAnalysisProgress, payload: AnalysisProgressEvent{MatchID: 8, Stage: models.StageAnalyze, Done: 0, Total: 0}},
		{name: eventAnalysisDone, payload: AnalysisDoneEvent{MatchID: 8, Error: "boom"}},
	}
	if !slices.EqualFunc(got, want, func(a, b recEv) bool {
		return a.name == b.name && a.payload == b.payload
	}) {
		t.Errorf("events =\n%+v\nwant\n%+v", got, want)
	}
}

// TestRecomputeAnalysisSubmitsInBackground pins the service-level
// contract: RecomputeAnalysis returns as soon as the run is QUEUED (only
// the config read is synchronous — the compute itself fails for this
// nonexistent match, and that failure must NOT come back through the
// call), the queued run is visible through RecomputeStates, a duplicate
// submit while it is in flight is a no-op, and the run drains once the
// slot frees.
func TestRecomputeAnalysisSubmitsInBackground(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	as := &AnalyticsService{st: st}

	// Hold the compute slot so the queued state is observable
	// deterministically (the background goroutine blocks on it).
	as.rc.slot.Lock()
	if err := as.RecomputeAnalysis(4242); err != nil {
		as.rc.slot.Unlock()
		t.Fatalf("submission: %v (only a config read may fail here)", err)
	}
	s := as.RecomputeStates()
	if !slices.Equal(s.Queued, []int64{4242}) || len(s.Running) != 0 {
		as.rc.slot.Unlock()
		t.Fatalf("states after submit = %+v, want queued=[4242] running=[]", s)
	}
	// Duplicate submit while in flight: still one queued run, no error.
	if err := as.RecomputeAnalysis(4242); err != nil {
		as.rc.slot.Unlock()
		t.Fatalf("duplicate submission: %v", err)
	}
	if s := as.RecomputeStates(); !slices.Equal(s.Queued, []int64{4242}) {
		as.rc.slot.Unlock()
		t.Fatalf("states after duplicate submit = %+v, want the single queued run kept", s)
	}
	as.rc.slot.Unlock()

	// The background run fails (match 4242 does not exist — the error
	// rides spectra:analysis-done, not the call) and the state drains.
	deadline := time.Now().Add(5 * time.Second)
	for {
		s := as.RecomputeStates()
		if len(s.Queued) == 0 && len(s.Running) == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("background recompute never drained: %+v", s)
		}
		time.Sleep(5 * time.Millisecond)
	}
}
