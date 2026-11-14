package main

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/ChristianWSmith/spectra/internal/budget"
	"github.com/ChristianWSmith/spectra/internal/metrics"
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

// scheduleSweep spawns (or coalesces onto) a background sweep. A save,
// an import and RecomputeAll completion can all fire while one is
// running: the wanted flag makes exactly ONE follow-up run happen after
// it drains, so a bump that lands mid-sweep is never lost (the behind
// set is re-resolved inside the next run — nothing persisted).
// No-op unless useSweeps wired the scheduler (package tests).
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
// want or stop.
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
			s.mu.Unlock()
			return
		}
		s.sweepWanted = false
		s.mu.Unlock()
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
	res, err := metrics.Sweep(ctx, s.st, wrapped)

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

// sweepForJob is the import-body entry (library.Options.AfterAnalyze —
// design §4's "the pass runs in the job body"): the job ALREADY holds
// its work token for the whole body, so this takes only the compute
// lock (still token → lock: the job's token came first). Progress
// funnels into the JOB's mechanism (frac → the job's job-progress
// range): this path deliberately does NOT emit spectra:metric-progress —
// one progress mechanism per invocation, always through StatusChip.
// The error rides back to the hook, which drops it by contract (a
// metric failure never fails the job).
func (s *MetricsService) sweepForJob(ctx context.Context, progress func(frac float64)) error {
	_, err := s.runSweep(ctx, func(p metrics.SweepProgress) {
		if progress == nil || p.Total <= 0 {
			return
		}
		progress(float64(p.Done) / float64(p.Total))
	})
	return err
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
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]MetricComputeState, 0, len(coverage))
	for _, c := range coverage {
		state := MetricComputeState{MetricID: c.MetricID}
		errMsg := ""
		if s.errs != nil {
			errMsg = s.errs[c.MetricID]
		}
		switch {
		case s.inflight[c.MetricID]:
			// In lieu of everything (design §5): never a stale number,
			// never bare no-data mid-flight.
			state.State = MetricStateProcessing
		case errMsg != "" && c.FreshRows == 0:
			// Failed requires NO fresh row (design §5 state 2): the last
			// attempt's phase 1 already removed the old rows, so this is
			// exactly "failed + no fresh row".
			state.State = MetricStateFailed
			state.Error = errMsg
		case c.Behind:
			state.State = MetricStateBehind
		case c.FreshRows == 0:
			// Not behind and nothing stored: the sweep had nothing to
			// compute (empty library) — an honest "no data", never a 0.
			state.State = MetricStateNoData
		default:
			state.State = MetricStateFresh
		}
		out = append(out, state)
	}
	return out, nil
}
