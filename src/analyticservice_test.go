package main

import (
	"encoding/json"
	"errors"
	"fmt"
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
	// deterministically (the background goroutine blocks on it). gate()
	// resolves the runner's lock on first use (shared or private).
	slot := as.rc.gate()
	slot.Lock()
	if err := as.RecomputeAnalysis(4242); err != nil {
		slot.Unlock()
		t.Fatalf("submission: %v (only a config read may fail here)", err)
	}
	s := as.RecomputeStates()
	if !slices.Equal(s.Queued, []int64{4242}) || len(s.Running) != 0 {
		slot.Unlock()
		t.Fatalf("states after submit = %+v, want queued=[4242] running=[]", s)
	}
	// Duplicate submit while in flight: still one queued run, no error.
	if err := as.RecomputeAnalysis(4242); err != nil {
		slot.Unlock()
		t.Fatalf("duplicate submission: %v", err)
	}
	if s := as.RecomputeStates(); !slices.Equal(s.Queued, []int64{4242}) {
		slot.Unlock()
		t.Fatalf("states after duplicate submit = %+v, want the single queued run kept", s)
	}
	slot.Unlock()

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

// TestSetConfigBumpsOnlyOnChange pins the no-bump-on-identical contract:
// a save whose four values equal the stored row returns the stored row
// untouched (same rule_version — the observable of "no write, no bump"),
// a caller-supplied RuleVersion is ignored in BOTH paths, and each single
// field changing bumps by exactly one. Validation still runs first, so a
// rejected save never bumps.
func TestSetConfigBumpsOnlyOnChange(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	as := &AnalyticsService{st: st}

	cur, err := as.GetConfig() // seeds the defaults (rule v1)
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	if cur.RuleVersion != 1 {
		t.Fatalf("seeded rule version = %d, want 1", cur.RuleVersion)
	}

	// Identical values → the stored row back, version untouched, even
	// when the caller supplies its own RuleVersion (still ignored).
	in := cur
	in.RuleVersion = 999
	saved, err := as.SetConfig(in)
	if err != nil {
		t.Fatalf("identical save: %v", err)
	}
	if saved != cur {
		t.Errorf("identical save returned %+v, want the stored %+v (no write, no bump)", saved, cur)
	}

	// One field at a time: each bumps by exactly 1 and stores the value;
	// immediately re-saving those stored values bumps nothing.
	changes := []struct {
		name   string
		mutate func(*models.AnalysisConfig)
	}{
		{"tradeWindowS", func(c *models.AnalysisConfig) { c.TradeWindowS += 1.5 }},
		{"ecoFullBuy", func(c *models.AnalysisConfig) { c.EcoFullBuy += 1000 }},
		{"ecoForce", func(c *models.AnalysisConfig) { c.EcoForce += 500 }},
		{"tradeOppDistance", func(c *models.AnalysisConfig) { c.TradeOppDistance += 250 }},
	}
	wantVersion := cur.RuleVersion
	for _, ch := range changes {
		next := cur
		ch.mutate(&next)
		saved, err := as.SetConfig(next)
		if err != nil {
			t.Fatalf("%s change: %v", ch.name, err)
		}
		wantVersion++
		if saved.RuleVersion != wantVersion {
			t.Errorf("%s change: rule_version = %d, want %d (exactly one bump)", ch.name, saved.RuleVersion, wantVersion)
		}
		if saved.TradeWindowS != next.TradeWindowS || saved.EcoFullBuy != next.EcoFullBuy ||
			saved.EcoForce != next.EcoForce || saved.TradeOppDistance != next.TradeOppDistance {
			t.Errorf("%s change: stored %+v, want the mutated values %+v", ch.name, saved, next)
		}
		again, err := as.SetConfig(saved)
		if err != nil {
			t.Fatalf("%s identical re-save: %v", ch.name, err)
		}
		if again.RuleVersion != wantVersion {
			t.Errorf("%s identical re-save: rule_version = %d, want %d (no bump)", ch.name, again.RuleVersion, wantVersion)
		}
		cur = saved
	}

	// Validation precedes the compare: a rejected save never bumps.
	bad := cur
	bad.TradeWindowS = 0
	if _, err := as.SetConfig(bad); err == nil {
		t.Fatal("invalid trade window accepted")
	}
	if got, err := as.GetConfig(); err != nil || got.RuleVersion != wantVersion {
		t.Errorf("rule_version after a rejected save = %d, %v; want %d", got.RuleVersion, err, wantVersion)
	}
}

// TestTradeOppDistanceChangeRecomputesStoredCounts pins the owner ruling
// (2026-11-12 — AGENTS.md "Analysis-rule derived values"): the trade-opp
// distance changes the STORED match_trade_opps counts (analytics gates
// on it at analyze time), so saving a new radius bumps rule_version —
// the analyzed match goes behind — and the re-run rewrites the counts
// under the new radius, while the reads themselves never threshold.
// Full loop: run under the seeded 1000u default → save 200u (bump
// v1→v2, match behind) → re-run → the 500u death leaves the count.
func TestTradeOppDistanceChangeRecomputesStoredCounts(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	as := &AnalyticsService{st: st}

	em := &models.ExtractedMatch{
		Match: models.Match{
			Path: "/d/dist-loop.dem", SHA256: "sha-dist-loop", Size: 1,
			Map: "de_cache", TickRate: 64, RealRounds: 1,
			ScoreCT: 1, ScoreT: 0, ParserVersion: "v6", ExtractedAt: time.Now(),
		},
		Players: []models.Player{
			{SteamID: "100", Name: "alice", Side: "ct", FinalStatePresent: true},
			{SteamID: "200", Name: "bob", Side: "t", FinalStatePresent: true},
			{SteamID: "300", Name: "carl", Side: "ct", FinalStatePresent: true},
			{SteamID: "400", Name: "dave", Side: "ct", FinalStatePresent: true},
		},
		PlayerStats: []models.PlayerStats{
			{SteamID: "100", Side: "ct", Name: "alice", RoundsPlayed: 1},
			{SteamID: "200", Side: "t", Name: "bob", RoundsPlayed: 1},
			{SteamID: "300", Side: "ct", Name: "carl", RoundsPlayed: 1},
			{SteamID: "400", Side: "ct", Name: "dave", RoundsPlayed: 1},
		},
		Rounds: []models.Round{
			{Number: 1, Winner: "ct", StartTick: 64, EndTick: 7200, FreezeEndTick: 64},
		},
		RoundSides: []models.RoundPlayerSide{
			{Round: 1, SteamID: "100", Side: "ct"},
			{Round: 1, SteamID: "200", Side: "t"},
			{Round: 1, SteamID: "300", Side: "ct"},
			{Round: 1, SteamID: "400", Side: "ct"},
		},
		Events: []models.Event{
			// carl dies with a teammate 150u from the killer; dave dies
			// at 500u — inside the 1000u default, outside a 200u save.
			{Tick: 100, Round: 1, Kind: models.EventKill, Attacker: "200", Victim: "300",
				DetailJSON: `{"nearDist":150}`},
			{Tick: 200, Round: 1, Kind: models.EventKill, Attacker: "200", Victim: "400",
				DetailJSON: `{"nearDist":500}`},
		},
	}
	id, err := st.CreateMatchRow(em.Match.Path, em.Match.SHA256, 1)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	if err := st.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}

	missedRow := func(t *testing.T, sid string) int {
		t.Helper()
		rows, err := st.GetCombatStats(id)
		if err != nil {
			t.Fatalf("GetCombatStats: %v", err)
		}
		for _, r := range rows {
			if r.SteamID == sid {
				return r.TradeOppMissed
			}
		}
		return 0
	}
	opps := func(t *testing.T, sid string) int {
		t.Helper()
		n, err := st.CountPlayerTradeOpportunities(sid)
		if err != nil {
			t.Fatalf("CountPlayerTradeOpportunities: %v", err)
		}
		return n
	}

	// Run under the seeded default (1000u): both deaths in range.
	if err := as.RecomputeAnalysis(id); err != nil {
		t.Fatalf("RecomputeAnalysis: %v", err)
	}
	drainRecompute(t, as)
	if missedRow(t, "300") != 1 || missedRow(t, "400") != 1 {
		t.Fatalf("missed @1000 = carl %d / dave %d, want 1/1", missedRow(t, "300"), missedRow(t, "400"))
	}
	if n := opps(t, "100"); n != 2 {
		t.Fatalf("alice opps @1000 = %d, want 2 (both teammate deaths)", n)
	}
	if v, err := st.GetMatchRuleVersion(id); err != nil || v != 1 {
		t.Fatalf("stamp after first run = %d, %v, want 1 (seeded default rules)", v, err)
	}

	// Save a narrower radius: bump v1 → v2 and the match goes behind.
	saved, err := as.SetConfig(models.AnalysisConfig{
		TradeWindowS: 5, EcoFullBuy: 20000, EcoForce: 10000,
		TradeOppDistance: 200, RuleVersion: 1,
	})
	if err != nil {
		t.Fatalf("SetConfig(200): %v", err)
	}
	if saved.RuleVersion != 2 {
		t.Fatalf("rule_version after distance change = %d, want 2 (exactly one bump)", saved.RuleVersion)
	}
	behind, err := st.ListMatches("", "", false, store.MatchListFilter{Behind: true})
	if err != nil {
		t.Fatalf("ListMatches(behind): %v", err)
	}
	found := false
	for _, m := range behind {
		found = found || m.ID == id
	}
	if !found {
		t.Fatal("match not behind after the distance change")
	}

	// Re-run: the stored counts follow the new radius (the 500u death
	// drops out) and the match is current again.
	if err := as.RecomputeAnalysis(id); err != nil {
		t.Fatalf("RecomputeAnalysis (after bump): %v", err)
	}
	drainRecompute(t, as)
	if missedRow(t, "300") != 1 || missedRow(t, "400") != 0 {
		t.Errorf("missed @200 = carl %d / dave %d, want 1/0 (500u death outside the new radius)",
			missedRow(t, "300"), missedRow(t, "400"))
	}
	if n := opps(t, "100"); n != 1 {
		t.Errorf("alice opps @200 = %d, want 1 (only the 150u death)", n)
	}
	if v, err := st.GetMatchRuleVersion(id); err != nil || v != 2 {
		t.Errorf("stamp after re-run = %d, %v, want 2 (current rules)", v, err)
	}
	behind, err = st.ListMatches("", "", false, store.MatchListFilter{Behind: true})
	if err != nil {
		t.Fatalf("ListMatches(behind after): %v", err)
	}
	for _, m := range behind {
		if m.ID == id {
			t.Error("match still behind after the re-run")
		}
	}
}

// TestEcoThresholdChangeRecomputesStoredClasses pins the owner ruling
// (2026-11-12 — AGENTS.md "Analysis-rule derived values", the eco half of
// "all-stored"): the eco thresholds change the STORED round_classifications
// labels AND the stored per-side round_side_classes (analytics.Classify
// applies them at analyze time), so saving a new full-buy line bumps
// rule_version — the analyzed match goes behind — and the re-run rewrites
// the stored classes under the new rules. Between the save and the re-run
// the read returns the OLD stored classes (uniformly stale, honestly so)
// — never the new thresholds: that disagreement between the Economy tab's
// side chips and the round chips is the visible bug this closes.
// Full loop: run under the seeded 20000/10000 defaults → save a 12000
// full line (bump v1→v2, match behind) → the read still says force →
// re-run → the read says full and the match is current again.
func TestEcoThresholdChangeRecomputesStoredClasses(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	as := &AnalyticsService{st: st}

	em := &models.ExtractedMatch{
		Match: models.Match{
			Path: "/d/eco-loop.dem", SHA256: "sha-eco-loop", Size: 1,
			Map: "de_cache", TickRate: 64, RealRounds: 2,
			ScoreCT: 2, ScoreT: 0, ParserVersion: "v6", ExtractedAt: time.Now(),
		},
		Players: []models.Player{
			{SteamID: "100", Name: "alice", Side: "ct", FinalStatePresent: true},
			{SteamID: "200", Name: "bob", Side: "t", FinalStatePresent: true},
		},
		PlayerStats: []models.PlayerStats{
			{SteamID: "100", Side: "ct", Name: "alice", RoundsPlayed: 2},
			{SteamID: "200", Side: "t", Name: "bob", RoundsPlayed: 2},
		},
		Rounds: []models.Round{
			// Round 1: the index-0 pistol round (equip irrelevant).
			{Number: 1, Winner: "ct", StartTick: 64, EndTick: 3600, FreezeEndTick: 96,
				EquipCT: 4000, EquipT: 3600},
			// Round 2: CT 12000 → FORCE under 20000/10000, FULL once the
			// full-buy line drops to 12000; T 8000 stays eco (below the
			// 10000 force line in both configs).
			{Number: 2, Winner: "ct", StartTick: 3600, EndTick: 7200, FreezeEndTick: 3632,
				EquipCT: 12000, EquipT: 8000},
		},
		RoundEconomy: []models.RoundEconomy{
			{Round: 1, Side: "ct", EquipValue: 4000, MoneySamples: 5},
			{Round: 1, Side: "t", EquipValue: 3600, MoneySamples: 5},
			{Round: 2, Side: "ct", EquipValue: 12000, MoneySamples: 5},
			{Round: 2, Side: "t", EquipValue: 8000, MoneySamples: 5},
		},
	}
	id, err := st.CreateMatchRow(em.Match.Path, em.Match.SHA256, 1)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	if err := st.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}

	// round 2's stored classes + round label + pistol flag, read straight
	// from the store (AnalyticsService.GetEconomy is this read verbatim).
	round2 := func(t *testing.T) (ct, tCls, label string, pistol bool) {
		t.Helper()
		rows, err := st.GetEconomy(id)
		if err != nil {
			t.Fatalf("GetEconomy: %v", err)
		}
		for _, r := range rows {
			if r.Round == 2 {
				return r.ClassCT, r.ClassT, r.Label, r.PistolRound
			}
		}
		t.Fatal("round 2 missing from the economy view")
		return "", "", "", false
	}

	// Run under the seeded defaults (20000/10000).
	if err := as.RecomputeAnalysis(id); err != nil {
		t.Fatalf("RecomputeAnalysis: %v", err)
	}
	drainRecompute(t, as)
	if ct, tc, _, _ := round2(t); ct != "force" || tc != "eco" {
		t.Fatalf("round 2 @20000/10000 = %q/%q, want force/eco", ct, tc)
	}
	if v, err := st.GetMatchRuleVersion(id); err != nil || v != 1 {
		t.Fatalf("stamp after first run = %d, %v, want 1 (seeded default rules)", v, err)
	}
	if rows, err := st.GetRoundClasses(id); err != nil || len(rows) != 2 {
		t.Fatalf("round classes = %d, %v, want 2", len(rows), err)
	}

	// Save a lower full-buy line: bump v1 → v2 and the match goes behind.
	saved, err := as.SetConfig(models.AnalysisConfig{
		TradeWindowS: 5, EcoFullBuy: 12000, EcoForce: 10000,
		TradeOppDistance: 1000, RuleVersion: 1,
	})
	if err != nil {
		t.Fatalf("SetConfig(12000): %v", err)
	}
	if saved.RuleVersion != 2 {
		t.Fatalf("rule_version after eco change = %d, want 2 (exactly one bump)", saved.RuleVersion)
	}
	behind, err := st.ListMatches("", "", false, store.MatchListFilter{Behind: true})
	if err != nil {
		t.Fatalf("ListMatches(behind): %v", err)
	}
	found := false
	for _, m := range behind {
		found = found || m.ID == id
	}
	if !found {
		t.Fatal("match not behind after the eco threshold change")
	}

	// BEFORE the re-run the stored classes are the OLD ones — the read
	// never re-classifies, so the Economy tab cannot disagree with the
	// round chips (the bug this test pins away).
	if ct, tc, _, _ := round2(t); ct != "force" || tc != "eco" {
		t.Errorf("round 2 after save, before re-run = %q/%q, want the STORED force/eco (uniformly stale)", ct, tc)
	}

	// Re-run: the stored classes follow the new thresholds and the match
	// is current again.
	if err := as.RecomputeAnalysis(id); err != nil {
		t.Fatalf("RecomputeAnalysis (after bump): %v", err)
	}
	drainRecompute(t, as)
	if ct, tc, _, _ := round2(t); ct != "full" || tc != "eco" {
		t.Errorf("round 2 @12000/10000 = %q/%q, want full/eco (stored rows must follow the thresholds)", ct, tc)
	}
	if v, err := st.GetMatchRuleVersion(id); err != nil || v != 2 {
		t.Errorf("stamp after re-run = %d, %v, want 2 (current rules)", v, err)
	}
	behind, err = st.ListMatches("", "", false, store.MatchListFilter{Behind: true})
	if err != nil {
		t.Fatalf("ListMatches(behind after): %v", err)
	}
	for _, m := range behind {
		if m.ID == id {
			t.Error("match still behind after the re-run")
		}
	}
}

// seedReadyMatch stores a minimal READY match (SaveExtracted sets the
// status) whose stamp stays 0 = never analyzed.
func seedReadyMatch(t *testing.T, st *store.Store, n int) int64 {
	t.Helper()
	path := fmt.Sprintf("/d/bulk/%d.dem", n)
	sha := fmt.Sprintf("sha-bulk-%03d", n)
	id, err := st.CreateMatchRow(path, sha, 1)
	if err != nil {
		t.Fatalf("CreateMatchRow(%d): %v", n, err)
	}
	em := &models.ExtractedMatch{
		Match: models.Match{
			Map: "de_test", TickRate: 64, DurationTicks: 1000, Frames: 100,
			PlaybackTimeS: 15.625, RealRounds: 1, ExtractedAt: time.Now(), ParseMS: 1,
		},
		Players: []models.Player{
			{SteamID: "100", Name: "a", Side: "ct", FinalStatePresent: true},
			{SteamID: "200", Name: "b", Side: "t", FinalStatePresent: true},
		},
		Rounds: []models.Round{{Number: 1, Winner: "ct", StartTick: 0, EndTick: 1000}},
		RoundSides: []models.RoundPlayerSide{
			{Round: 1, SteamID: "100", Side: "ct"},
			{Round: 1, SteamID: "200", Side: "t"},
		},
	}
	if err := st.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted(%d): %v", n, err)
	}
	return id
}

// drainRecompute waits until no run is queued or running.
func drainRecompute(t *testing.T, as *AnalyticsService) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		s := as.RecomputeStates()
		if len(s.Queued) == 0 && len(s.Running) == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("recomputes never drained: %+v", s)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TestRecomputeAllResolvesBehindSet pins the bulk entry: the behind set
// is resolved SERVER-SIDE (ready + stamp < live rule version — the
// queued and the current-stamp rows are not in it), an id already in
// flight is skipped rather than double-run, every member runs and ends
// stamped at the ONE config version captured at submission, and a second
// call therefore reports nothing behind.
func TestRecomputeAllResolvesBehindSet(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	as := &AnalyticsService{st: st}

	id1 := seedReadyMatch(t, st, 1)
	id2 := seedReadyMatch(t, st, 2)
	id3 := seedReadyMatch(t, st, 3)
	// Non-ready: cannot be re-run → never behind.
	idQueued, err := st.CreateMatchRow("/d/bulk/queued.dem", "sha-bulk-queued", 1)
	if err != nil {
		t.Fatalf("CreateMatchRow(queued): %v", err)
	}
	// Current: stamped at the live version (defaults = rule v1).
	idCurrent := seedReadyMatch(t, st, 4)
	if err := st.SetMatchRuleVersion(idCurrent, 1); err != nil {
		t.Fatalf("stamp current: %v", err)
	}

	// Phase 1: one run already in flight — the batch skips it.
	slot := as.rc.gate()
	slot.Lock()
	if err := as.RecomputeAnalysis(id1); err != nil {
		slot.Unlock()
		t.Fatalf("RecomputeAnalysis: %v", err)
	}
	res, err := as.RecomputeAll()
	if err != nil {
		slot.Unlock()
		t.Fatalf("RecomputeAll: %v", err)
	}
	if res != (RecomputeAllResult{Submitted: 2, Skipped: 1, Total: 3}) {
		slot.Unlock()
		t.Fatalf("RecomputeAll = %+v, want {submitted:2 skipped:1 total:3} (id1 in flight → skipped; queued/current not in the set)", res)
	}
	if s := as.RecomputeStates(); len(s.Queued) != 3 || len(s.Running) != 0 {
		slot.Unlock()
		t.Fatalf("states during submission = %+v, want 3 queued, 0 running", s)
	}
	slot.Unlock()

	drainRecompute(t, as)

	// Every member stamped at the captured version (v1 — the defaults);
	// the rows outside the set are untouched.
	for _, id := range []int64{id1, id2, id3} {
		if v, err := st.GetMatchRuleVersion(id); err != nil || v != 1 {
			t.Errorf("match %d stamp = %d, %v; want 1 (the batch's captured rule version)", id, v, err)
		}
	}
	if v, err := st.GetMatchRuleVersion(idQueued); err != nil || v != 0 {
		t.Errorf("queued match stamp = %d, %v; want 0 (excluded from the behind set)", v, err)
	}
	if v, err := st.GetMatchRuleVersion(idCurrent); err != nil || v != 1 {
		t.Errorf("current match stamp = %d, %v; want 1 (unchanged)", v, err)
	}

	// Phase 2: nothing is behind anymore.
	again, err := as.RecomputeAll()
	if err != nil {
		t.Fatalf("RecomputeAll after drain: %v", err)
	}
	if again != (RecomputeAllResult{}) {
		t.Errorf("second RecomputeAll = %+v, want the empty result (everyone is current)", again)
	}
}

// recRecorder is the emit sink the runner tests drive: an ordered,
// mutex-guarded event log.
type recRecorder struct {
	mu   sync.Mutex
	seen []recEvent
}

type recEvent struct {
	name    string
	payload any
}

func (r *recRecorder) emit(name string, payload any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.seen = append(r.seen, recEvent{name: name, payload: payload})
}

func (r *recRecorder) events() []recEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.seen)
}

// TestRecomputeRunnerBatchLifecycle is the bulk twin of
// TestRecomputeRunnerLifecycle: a batch queues behind an in-flight run,
// each member runs EXACTLY once and serialized on the one slot, one
// progress + one done leaves per member (99's pair first — the gate
// drains before any batch run), a repeated id inside the batch is
// deduped, and career is rebuilt EXACTLY ONCE — inside the last member's
// slot hold, immediately before that member's analysis-done (the last
// event of the run).
func TestRecomputeRunnerBatchLifecycle(t *testing.T) {
	rec := &recRecorder{}
	rc := &recomputeRunner{}
	waitFor := func(what string, cond func() bool) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for !cond() {
			if time.Now().After(deadline) {
				t.Fatalf("timed out waiting for %s (states %+v)", what, rc.states())
			}
			time.Sleep(2 * time.Millisecond)
		}
	}

	var mu sync.Mutex
	runs := map[int64]int{}
	inFlight, maxInFlight := 0, 0
	var rebuilds, rebuildIdx int

	// The gate: an in-flight single run holds the slot while the batch
	// queues behind it.
	started, release := make(chan struct{}), make(chan struct{})
	if !rc.submit(99, rec.emit, func() error {
		mu.Lock()
		runs[99]++
		mu.Unlock()
		close(started)
		<-release
		return nil
	}) {
		t.Fatal("gate submit was deduped")
	}
	<-started // 99 is running, inside compute()

	submitted, skipped := rc.submitBatch([]int64{1, 2, 3, 2}, rec.emit,
		func(id int64) error {
			mu.Lock()
			runs[id]++
			inFlight++
			if inFlight > maxInFlight {
				maxInFlight = inFlight
			}
			mu.Unlock()
			time.Sleep(2 * time.Millisecond) // a window overlap would show in maxInFlight
			mu.Lock()
			inFlight--
			mu.Unlock()
			return nil
		},
		func() error {
			rec.mu.Lock()
			defer rec.mu.Unlock()
			rebuilds++
			rebuildIdx = len(rec.seen) // the index the NEXT event (the last done) lands on
			return nil
		})
	if submitted != 3 || skipped != 1 {
		t.Fatalf("submitBatch = (%d, %d), want (3, 1) — id 2 repeated inside the batch is deduped", submitted, skipped)
	}

	// Gated: 99 running, the three members queued, nothing else started.
	waitFor("gate holding + batch queued", func() bool {
		s := rc.states()
		return slices.Equal(s.Running, []int64{99}) && slices.Equal(s.Queued, []int64{1, 2, 3})
	})
	if n := len(rec.events()); n != 1 {
		t.Fatalf("%d events while gated, want 1 (99's progress only)", n)
	}

	close(release)
	waitFor("both runs drained", func() bool {
		s := rc.states()
		return len(s.Running) == 0 && len(s.Queued) == 0
	})

	mu.Lock()
	for _, id := range []int64{1, 2, 3, 99} {
		if runs[id] != 1 {
			t.Errorf("match %d ran %d times, want exactly 1", id, runs[id])
		}
	}
	if maxInFlight != 1 {
		t.Errorf("max concurrent batch computes = %d, want 1 (the slot serializes)", maxInFlight)
	}
	mu.Unlock()

	rec.mu.Lock()
	defer rec.mu.Unlock()
	got := rec.seen
	if len(got) != 8 {
		t.Fatalf("%d events, want 8 (4 runs × progress+done): %+v", len(got), got)
	}
	if got[0].name != eventAnalysisProgress || got[0].payload != (AnalysisProgressEvent{MatchID: 99, Stage: models.StageAnalyze, Done: 0, Total: 0}) {
		t.Errorf("first event = %+v, want 99's progress", got[0])
	}
	if got[1].name != eventAnalysisDone || got[1].payload != (AnalysisDoneEvent{MatchID: 99, Error: ""}) {
		t.Errorf("second event = %+v, want 99's done (the gate drains before any batch run)", got[1])
	}
	progresses, dones := map[int64]int{}, map[int64]int{}
	for _, ev := range got {
		switch p := ev.payload.(type) {
		case AnalysisProgressEvent:
			if ev.name == eventAnalysisProgress {
				progresses[p.MatchID]++
			}
		case AnalysisDoneEvent:
			if ev.name == eventAnalysisDone && p.Error != "" {
				t.Errorf("done event carries an error: %+v", ev)
			}
			dones[p.MatchID]++
		}
	}
	for _, id := range []int64{1, 2, 3} {
		if progresses[id] != 1 || dones[id] != 1 {
			t.Errorf("member %d: %d progress / %d done, want 1/1", id, progresses[id], dones[id])
		}
	}
	if rebuilds != 1 {
		t.Errorf("career rebuilds = %d, want exactly 1 for the batch", rebuilds)
	}
	if rebuildIdx != len(got)-1 {
		t.Fatalf("rebuild landed before %d trailing events, want 0 (it must run in the last member's slot hold)", len(got)-1-rebuildIdx)
	}
	if got[rebuildIdx].name != eventAnalysisDone {
		t.Errorf("event after the rebuild = %+v, want the last member's analysis-done", got[rebuildIdx])
	}
}

// TestRecomputeRunnerBatchSkipsInFlight: an id already running when the
// batch resolves is SKIPPED — never double-run — and it does not join
// the batch (its own run owns its career rebuild), so the batch's
// deferred rebuild still fires exactly once for the members it accepted.
func TestRecomputeRunnerBatchSkipsInFlight(t *testing.T) {
	rec := &recRecorder{}
	rc := &recomputeRunner{}
	waitFor := func(what string, cond func() bool) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for !cond() {
			if time.Now().After(deadline) {
				t.Fatalf("timed out waiting for %s (states %+v)", what, rc.states())
			}
			time.Sleep(2 * time.Millisecond)
		}
	}

	var mu sync.Mutex
	runs := map[int64]int{}
	rebuilds := 0

	started, release := make(chan struct{}), make(chan struct{})
	if !rc.submit(7, rec.emit, func() error {
		mu.Lock()
		runs[7]++
		mu.Unlock()
		close(started)
		<-release
		return nil
	}) {
		t.Fatal("gate submit was deduped")
	}
	<-started
	waitFor("7 running", func() bool { return slices.Equal(rc.states().Running, []int64{7}) })

	submitted, skipped := rc.submitBatch([]int64{7, 8}, rec.emit,
		func(id int64) error {
			mu.Lock()
			runs[id]++
			mu.Unlock()
			return nil
		},
		func() error {
			mu.Lock()
			rebuilds++
			mu.Unlock()
			return nil
		})
	if submitted != 1 || skipped != 1 {
		t.Fatalf("submitBatch = (%d, %d), want (1, 1) — the in-flight id 7 is skipped", submitted, skipped)
	}
	waitFor("8 queued behind 7", func() bool { return slices.Equal(rc.states().Queued, []int64{8}) })

	close(release)
	waitFor("drained", func() bool {
		s := rc.states()
		return len(s.Running) == 0 && len(s.Queued) == 0
	})

	mu.Lock()
	defer mu.Unlock()
	if runs[7] != 1 || runs[8] != 1 {
		t.Errorf("runs = %v, want {7:1 8:1} (no double run for the skipped id)", runs)
	}
	if rebuilds != 1 {
		t.Errorf("career rebuilds = %d, want 1 (only the batch member's own — the in-flight single run owns its rebuild)", rebuilds)
	}
}
