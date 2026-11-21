package main

import (
	"context"
	"fmt"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ChristianWSmith/spectra/internal/budget"
	"github.com/ChristianWSmith/spectra/internal/metrics"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// The metric compute machinery (stored-metrics design §4): scheduling,
// the two events, and the transient per-metric state. This file is the
// service half of the pass — the WORK itself is metrics.Sweep
// (internal/metrics/pass.go); here we own the budget token, the shared
// compute lock, the 100 ms progress throttle, and the in-memory
// processing/failed records GetMetricComputeState serves.
//
// Event names — deliberately NOT spectra:job-progress / spectra:job-done
// (the library-jobs rationale verbatim, analyticservice.go's block):
// a metric recompute is not a library job — no jobs row. Progress is
// progress-only; the done event is THE data change.
//
//	spectra:metric-progress {metricId, stage, done, total} — throttled
//	  100 ms (import-body runs do NOT emit it: their progress funnels
//	  into the job's own job-progress, one mechanism per invocation).
//	spectra:metric-done {ok, error, metricIds} — one event per sweep
//	  that touched rows; the read-cache flush signal (the listener
//	  beside analysis-done), and ok:false marks the attempt failed.
//
// Version stamps are INTERNAL-ONLY: no event payload, state string or
// error text ever carries a version number (design §7 pins this).
const (
	eventMetricProgress = "spectra:metric-progress"
	eventMetricDone     = "spectra:metric-done"
)

// metricProgressMinInterval throttles spectra:metric-progress to at most
// one per 100 ms — the same cadence as library.go's progressMinInterval,
// mappackservice.go's assetProgressMinInterval and analyticservice.go's
// heatmapProgressMinInterval. The closing point (done >= total) is never
// throttled, so the bar always lands on its end.
const metricProgressMinInterval = 100 * time.Millisecond

// The state vocabulary (owner-ruled — state only, never a version
// number; design §5's five words, surfaced at metric granularity by
// GetMetricComputeState):
//
//	processing  a sweep is computing this metric right now (transient —
//	            lost on restart, where nothing IS in flight)
//	failed      the last attempt failed and no fresh row exists (the
//	            error text is carried in Error — never a stamp)
//	fresh       the canonical predicate passes AND rows exist
//	no-data     nothing pending and nothing stored — the library has no
//	            units to compute over (an empty library), never a
//	            fabricated 0
//	behind      recompute pending (never computed, outdated-and-deleted,
//	            rules-behind — no distinction surfaced, design §5)
const (
	MetricStateProcessing = "processing"
	MetricStateFailed     = "failed"
	MetricStateFresh      = "fresh"
	MetricStateNoData     = "no-data"
	MetricStateBehind     = "behind"
)

// MetricProgressEvent is the payload of spectra:metric-progress — the
// sweep's honest k/N (Done = metrics finished before this point, Total =
// the work list) attributed to the metric currently being processed.
type MetricProgressEvent struct {
	MetricID int64  `json:"metricId"`
	Stage    string `json:"stage"` // metrics.StageRemove | metrics.StageCompute
	Done     int    `json:"done"`
	Total    int    `json:"total"`
}

// MetricDoneEvent is the payload of spectra:metric-done — ONE event per
// sweep that attempted at least one metric (the DATA change: rows were
// replaced). OK is false when any metric failed/skipped or the sweep was
// interrupted; Error carries the failure summary (metric name: text) or
// the interruption, "" on full success; MetricIDs is every metric the
// sweep touched (attempted — successes and failures alike).
type MetricDoneEvent struct {
	OK        bool    `json:"ok"`
	Error     string  `json:"error"`
	MetricIDs []int64 `json:"metricIds"`
}

// MetricComputeState is ONE metric's answer from GetMetricComputeState.
// State ∈ {processing, failed, fresh, no-data, behind}; Error is set for
// failed only and is the engine's failure text — never a version.
type MetricComputeState struct {
	MetricID int64  `json:"metricId"`
	State    string `json:"state"`
	Error    string `json:"error,omitempty"`
}

// useSweeps wires the background sweep machinery — called by main
// BEFORE service registration (the hand-wired dependency pattern:
// ONE shared compute lock beside AnalyticsService/import, ONE shared
// budget token pool). After this, save/import/RecomputeAll triggers
// SPAWN sweeps; without it (every package test constructs the service
// bare) scheduleSweep is a no-op and tests drive runSweep
// synchronously — no stray goroutine ever races a test's store.
// First-wins adoption (mirrors recomputeRunner.useComputeLock /
// useBudget): a later call never writes a field a spawned run reads.
func (s *MetricsService) useSweeps(b *budget.Budget, lock *sync.Mutex) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if b != nil && s.budget == nil {
		s.budget = b
	}
	if lock != nil && s.computeLock == nil {
		s.computeLock = lock
	}
	if s.sweepIdle == nil {
		s.sweepIdle = sync.NewCond(&s.mu)
	}
	s.sweepsOn = true
}

// gate returns the compute lock — the shared one when wired, else a
// private slot created on first use (the recomputeRunner.gate pattern:
// unwired tests stay serialized among themselves).
func (s *MetricsService) gate() *sync.Mutex {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.computeLock == nil {
		s.computeLock = &sync.Mutex{}
	}
	return s.computeLock
}

// scheduleSweep is the ONE entry for every sweep trigger: an import's
// analyze pass (sweepForJob), a save, a plugin operation, a RecomputeAll
// completion and the startup sweep. It never blocks and never starts a
// second concurrent sweep (owner ruling, 2026-11-21):
//   - no sweep running → start one now (eager);
//   - a sweep running → set the single "run again" flag. When that sweep
//     ends and the flag is set, sweepLoop clears it and runs exactly ONE
//     follow-up. Triggers during the follow-up only set the flag again.
//
// A running sweep is never cancelled. Each sweep re-resolves the behind
// set when it starts (metrics.Sweep), so a follow-up sees everything
// marked behind before it started. No-op unless useSweeps wired the
// scheduler (package tests drive runSweep directly).
func (s *MetricsService) scheduleSweep() {
	s.mu.Lock()
	if !s.sweepsOn {
		s.mu.Unlock()
		return
	}
	if s.sweepRunning {
		s.sweepWanted = true
		s.mu.Unlock()
		return
	}
	s.sweepRunning = true
	s.mu.Unlock()
	go s.sweepLoop()
}

// sweepLoop is the background scheduler: ONE machine work token for the
// whole run (Acquire BEFORE the compute lock — token → lock, never
// reversed; the lock holder always owns its own token, so lock waiters
// can never starve it), then runSweep, then either drain the coalesced
// want or stop. It is the only caller of runSweep outside tests, and
// sweepRunning is true for its whole life, so at most one sweep is ever
// inside the pass. Its token wait happens while the job or trigger that
// requested it has already returned, so no caller holds a token while
// it waits on this sweep.
func (s *MetricsService) sweepLoop() {
	for {
		s.mu.Lock()
		b := s.budget
		s.mu.Unlock()
		b.Acquire() // nil budget = the unbudgeted no-op seam
		_, _ = s.runSweep(context.Background(), s.emitMetricProgress)
		b.Release()

		s.mu.Lock()
		if !s.sweepWanted {
			s.sweepRunning = false
			s.sweepIdle.Broadcast()
			s.mu.Unlock()
			return
		}
		s.sweepWanted = false
		s.mu.Unlock()
	}
}

// waitSweepsIdle blocks until no sweep is running or pending. Only the
// headless import calls it, before exiting: the import job returns as
// soon as its sweep is requested, so the process must outlive the sweep.
// Returns at once when the scheduler was never wired.
func (s *MetricsService) waitSweepsIdle() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for s.sweepRunning && s.sweepIdle != nil {
		s.sweepIdle.Wait()
	}
}

// runSweep runs ONE sweep under the compute lock and records its
// outcome in the transient state (design §4: in-flight/failed live in
// memory — busy/error never restore). The CALLER owns any work token:
// the background loop took one first, the import body rides its job's
// held token, tests need none. progress (may be nil) receives the
// pass's per-metric points AFTER the in-flight mark is set, so a state
// read inside a progress hook sees processing. Emits
// spectra:metric-done when the sweep touched any metric — the data
// change — regardless of which caller drove it.
func (s *MetricsService) runSweep(ctx context.Context, progress func(metrics.SweepProgress)) (metrics.SweepResult, error) {
	lock := s.gate()
	lock.Lock()
	defer lock.Unlock()
	if hook := s.sweepHook; hook != nil {
		hook(true)
		defer hook(false) // runs before the unlock above (LIFO)
	}

	wrapped := func(p metrics.SweepProgress) {
		s.mu.Lock()
		if s.inflight == nil {
			s.inflight = map[int64]bool{}
		}
		if p.Stage == metrics.StageRemove {
			s.inflight[p.MetricID] = true
		}
		s.mu.Unlock()
		if progress != nil {
			progress(p)
		}
	}
	res, err := metrics.Sweep(ctx, s.st, wrapped, s.startRun)
	// The user's cancels hold their metrics: the hold is what keeps later
	// background sweeps from re-running them (metrics.SweepResult.Cancelled).
	for _, id := range res.Cancelled {
		if herr := s.st.HoldMetric(id); herr != nil && err == nil {
			err = herr
		}
	}

	// Record the outcome: every metric this sweep touched leaves the
	// in-flight set; failures stick until a later sweep succeeds on the
	// same metric (the failed → fresh transition), successes clear a
	// stale error.
	s.mu.Lock()
	for id := range s.inflight {
		delete(s.inflight, id)
	}
	if len(res.Failed) > 0 && s.errs == nil {
		s.errs = map[int64]string{}
	}
	for id, msg := range res.Failed {
		s.errs[id] = msg
	}
	for _, id := range res.Succeeded {
		delete(s.errs, id)
	}
	s.mu.Unlock()

	if len(res.Attempted) > 0 {
		s.emitMetricDone(res, err)
	}
	return res, err
}

// startRun registers one running metric statement under metricID and
// returns the context it runs with (derived from parent) plus its
// release — the metrics.MetricContext the sweep takes, and the preview's
// run context. Every registered run is reachable from CancelMetric
// until released.
func (s *MetricsService) startRun(parent context.Context, metricID int64) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(parent)
	s.runsMu.Lock()
	if s.runs == nil {
		s.runs = map[int64]map[uint64]context.CancelFunc{}
	}
	s.runSeq++
	token := s.runSeq
	if s.runs[metricID] == nil {
		s.runs[metricID] = map[uint64]context.CancelFunc{}
	}
	s.runs[metricID][token] = cancel
	s.runsMu.Unlock()
	return ctx, func() {
		s.runsMu.Lock()
		delete(s.runs[metricID], token)
		if len(s.runs[metricID]) == 0 {
			delete(s.runs, metricID)
		}
		s.runsMu.Unlock()
		cancel()
	}
}

// RunningMetric is one saved metric with a statement running right now
// (a sweep's or a preview's) — the Builder's running-metrics popup row.
// Name is the metric's display title (its name when it has none); a
// draft preview (id 0) has no row here, it has nothing to cancel by id.
type RunningMetric struct {
	MetricID int64  `json:"metricId"`
	Name     string `json:"name"`
}

// ListRunningMetrics returns every saved metric that has a statement
// running right now, by id. A metric deleted while running drops out.
func (s *MetricsService) ListRunningMetrics() ([]RunningMetric, error) {
	s.runsMu.Lock()
	ids := make([]int64, 0, len(s.runs))
	for id := range s.runs {
		if id > 0 {
			ids = append(ids, id)
		}
	}
	s.runsMu.Unlock()
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	out := make([]RunningMetric, 0, len(ids))
	for _, id := range ids {
		m, err := s.st.GetMetric(id)
		if err != nil {
			continue
		}
		name := m.Title
		if name == "" {
			name = m.Name
		}
		out = append(out, RunningMetric{MetricID: id, Name: name})
	}
	return out, nil
}

// CancelMetric stops every running statement of one metric — its sweep
// run and any preview of it (id 0 = an unsaved draft's preview). The
// statement is interrupted and nothing is written: a swept metric is
// marked failed with the reason "cancelled" (its old rows were already
// removed, so it reads as failed until a later run succeeds), its
// dependents are skipped this sweep, and the sweep moves on to the rest;
// a preview returns the cancellation as its error. Returns whether
// anything was running.
func (s *MetricsService) CancelMetric(id int64) bool {
	s.runsMu.Lock()
	defer s.runsMu.Unlock()
	runs := s.runs[id]
	for _, cancel := range runs {
		cancel()
	}
	return len(runs) > 0
}

// emitMetricProgress sends one throttled spectra:metric-progress point
// (100 ms window; the closing done >= total point always goes through —
// the heatmap emitter's completion exemption). Nil app (package tests)
// emits nothing.
func (s *MetricsService) emitMetricProgress(p metrics.SweepProgress) {
	if s.app == nil {
		return
	}
	ev := MetricProgressEvent{MetricID: p.MetricID, Stage: p.Stage, Done: p.Done, Total: p.Total}
	complete := p.Total > 0 && p.Done >= p.Total
	now := time.Now()
	s.progMu.Lock()
	if !complete && !s.progLast.IsZero() && now.Sub(s.progLast) < metricProgressMinInterval {
		s.progMu.Unlock()
		return
	}
	s.progLast = now
	s.progMu.Unlock()
	s.app.Event.Emit(eventMetricProgress, ev)
}

// emitMetricDone sends the ONE spectra:metric-done for a sweep that
// attempted at least one metric. OK = every attempted metric committed
// and the sweep was not interrupted; Error is the interruption or the
// failure summary (name: text) — metric NAMES only, never a version.
func (s *MetricsService) emitMetricDone(res metrics.SweepResult, sweepErr error) {
	if s.app == nil {
		return
	}
	ev := MetricDoneEvent{OK: sweepErr == nil && len(res.Failed) == 0, MetricIDs: append([]int64{}, res.Attempted...)}
	switch {
	case sweepErr != nil:
		ev.Error = sweepErr.Error()
	case len(res.Failed) > 0:
		// Names for the failure summary (one cheap catalog read, only
		// when something actually failed).
		var parts []string
		if rows, err := s.st.ListMetrics(); err == nil {
			byID := map[int64]string{}
			for _, m := range rows {
				byID[m.ID] = m.Name
			}
			for id, msg := range res.Failed {
				parts = append(parts, fmt.Sprintf("%s: %s", byID[id], msg))
			}
		} else {
			for id, msg := range res.Failed {
				parts = append(parts, fmt.Sprintf("metric %d: %s", id, msg))
			}
		}
		sort.Strings(parts)
		ev.Error = strings.Join(parts, "; ")
	}
	s.app.Event.Emit(eventMetricDone, ev)
}

// sweepForJob is the import-body entry (library.Options.AfterAnalyze).
// It only REQUESTS the sweep through scheduleSweep and returns: the job
// holds its work token for its whole body, and the sweep needs a token of
// its own, so waiting here would deadlock a pool of one. The job never
// queues on the compute lock, and a batch of N imports coalesces into one
// running sweep plus at most one follow-up. The sweep reports through
// spectra:metric-progress (the floater's metrics source) and the running-
// metrics list, exactly like a save-triggered sweep. It always returns
// nil: a metric failure is carried by spectra:metric-done and the compute
// state, and never fails the import job.
func (s *MetricsService) sweepForJob(_ context.Context) error {
	s.scheduleSweep()
	return nil
}

// GetMetricComputeState returns EVERY metric's state (the mount-time
// read design §4 asks for — deliberately uncached, like
// RecomputeStates): the transient processing/failed words come from this
// process's memory, fresh/no-data/behind from the ONE behind predicate
// (store.MetricCoverage — the same spelling the sweep's selection
// uses). Ordered like ListMetrics (the coverage read's canonical order).
// No field ever carries a version number.
func (s *MetricsService) GetMetricComputeState() ([]MetricComputeState, error) {
	cfg, err := s.st.GetConfig()
	if err != nil {
		return nil, err
	}
	coverage, err := s.st.MetricCoverage(cfg.RuleVersion)
	if err != nil {
		return nil, err
	}
	held, err := s.st.HeldMetricIDs()
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]MetricComputeState, 0, len(coverage))
	for _, c := range coverage {
		out = append(out, s.computeStateLocked(c.MetricID, c.Behind, c.FreshRows, held[c.MetricID]))
	}
	return out, nil
}

// GetMetricStates is the SCOPED state read: EVERY metric's state for ONE unit,
// where scope is "match" (id is a match id) or "player" (id is a steam id).
// A metric is behind for that unit only when that unit is behind, so another
// match or player being behind never marks it. A metric with no per-unit
// breakdown (library-wide or round units) keeps the library answer.
// GetMetricComputeState stays the library-wide word the Builder labels "any
// match behind".
func (s *MetricsService) GetMetricStates(scope, id string) ([]MetricComputeState, error) {
	cfg, err := s.st.GetConfig()
	if err != nil {
		return nil, err
	}
	coverage, err := s.st.MetricCoverage(cfg.RuleVersion)
	if err != nil {
		return nil, err
	}
	var fresh map[int64]int
	var behindOf func(c store.MetricCoverage) bool
	switch scope {
	case "match":
		matchID, perr := strconv.ParseInt(id, 10, 64)
		if perr != nil {
			return nil, fmt.Errorf("match id %q is not a number", id)
		}
		if fresh, err = s.st.MetricFreshForMatch(matchID, cfg.RuleVersion); err != nil {
			return nil, err
		}
		behindOf = func(c store.MetricCoverage) bool {
			if len(c.BehindMatches) > 0 {
				return slices.Contains(c.BehindMatches, matchID)
			}
			return c.Behind
		}
	case "player":
		if id == "" {
			return nil, fmt.Errorf("player id is empty")
		}
		if fresh, err = s.st.MetricFreshForPlayer(id, cfg.RuleVersion); err != nil {
			return nil, err
		}
		behindOf = func(c store.MetricCoverage) bool {
			if len(c.BehindSteams) > 0 {
				return slices.Contains(c.BehindSteams, id)
			}
			return c.Behind
		}
	default:
		return nil, fmt.Errorf("unknown metric state scope %q", scope)
	}
	held, err := s.st.HeldMetricIDs()
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]MetricComputeState, 0, len(coverage))
	for _, c := range coverage {
		out = append(out, s.computeStateLocked(c.MetricID, behindOf(c), fresh[c.MetricID], held[c.MetricID]))
	}
	return out, nil
}

// computeStateLocked is the precedence both reads share: processing in lieu of
// everything, then failed (an error or a cancel hold with no fresh row), then
// behind, then fresh or no-data by the fresh-row count. behind and fresh are the
// read's own scope. The caller holds s.mu.
func (s *MetricsService) computeStateLocked(metricID int64, behind bool, fresh int, held bool) MetricComputeState {
	state := MetricComputeState{MetricID: metricID}
	errMsg := ""
	if s.errs != nil {
		errMsg = s.errs[metricID]
	}
	switch {
	case s.inflight[metricID]:
		// In lieu of everything (design §5): never a stale number,
		// never bare no-data mid-flight.
		state.State = MetricStateProcessing
	case errMsg != "" && fresh == 0:
		// Failed requires NO fresh row (design §5 state 2): the last
		// attempt's phase 1 already removed the old rows, so this is
		// exactly "failed + no fresh row".
		state.State = MetricStateFailed
		state.Error = errMsg
	case held && fresh == 0:
		// The user cancelled this metric's run and it has not been
		// saved since (the hold survives a restart; the reason is the
		// same word the in-memory failure carries).
		state.State = MetricStateFailed
		state.Error = metrics.CancelledReason
	case behind:
		state.State = MetricStateBehind
	case fresh == 0:
		// Not behind and nothing stored: the sweep had nothing to
		// compute (empty library) — an honest "no data", never a 0.
		state.State = MetricStateNoData
	default:
		state.State = MetricStateFresh
	}
	return state
}
