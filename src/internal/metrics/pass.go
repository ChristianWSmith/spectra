package metrics

import (
	"context"
	"runtime"
	"sort"
	"strings"
	"sync"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// The compute pass (stored-metrics design §3/§4): the ONE writer of
// metric_values. It lives beside RunPreview (the executor primitive it
// reuses) and NEVER inside analytics.Compute (that package's rule-stamp
// contract is untouched). The service (MetricsService.runSweep) owns the
// budget token, the compute lock, the events and the in-memory state —
// this package owns the WORK: behind-set resolution, ordering, and the
// two-phase per-metric unit.
//
// THE BEHIND PREDICATE lives in ONE place: store.MetricCoverage (the
// shared spelling the sweep's selection AND the read-state surface both
// call). Sweep adds the graph clauses the predicate deliberately does
// not spell (design §4 keeps the predicate row-shaped):
//
//   - forward closure — a metric joins the work list when ANY of its
//     upstreams is behind (or its dep_name dangles: a system-removed
//     upstream), so a dependent is never left serving a fresh-looking
//     value built on changed inputs — the chain clause of design §3's
//     behind definition;
//   - topological order (Kahn) — an upstream's fresh rows COMMIT before
//     its dependents' statements read them through the ref join;
//   - skip-forward-closure — a metric whose upstream failed or was
//     skipped is phase-1'd (rows removed) and NOT computed: absent →
//     behind, never a value computed from stale inputs (INNER
//     semantics: absent ≠ 0).
//
// Per metric, TWO committed phases (no stale-value retention):
//
//	phase 1  ClearMetricUnits — remove the rows of the STALE units only
//	         (SweepUnits), commit (design §4's remove-outdated step, per
//	         unit: a sweep of match M never removes another match's rows,
//	         ruling 20; a library-wide unit is the whole unbound result)
//	phase 2  run the statement once per stale unit (RunRaw), replacing
//	         that unit's rows in one tx stamped with BOTH
//	         current versions — THAT commit is the commit marker:
//	         committed = fresh, anything else = not-fresh (crash matrix:
//	         a failure in phase 2 leaves the metric absent → behind →
//	         retried)
//
// Execution: every statement runs through store.QueryMetric — the
// metric path's read-only connection, no timeout, no row cap — so a
// slow metric never holds the single writer (imports keep committing
// while it runs); only phase 1's delete and phase 2's insert use the
// writer.
//
// Two cancellations, two outcomes:
//
//   - the SWEEP's ctx (a cancelled import job, shutdown) aborts BETWEEN
//     metrics and mid-query: whatever was not reached keeps its rows
//     and stays behind — the behind set IS the remaining work, so the
//     next sweep resumes exactly there. Nothing persisted tracks
//     progress. The interrupted metric is not a failure.
//   - ONE METRIC's ctx (MetricContext — the user's cancel) interrupts
//     that metric's statement: it FAILS with CancelledReason, writes no
//     rows (phase 1 already removed the old ones; the insert never
//     runs), its dependents are skipped, and the sweep goes on. The
//     service then HOLDS it (SweepResult.Cancelled): later sweeps leave
//     it and its dependents alone until the metric is saved again.
const (
	// StageRemove / StageCompute are the pass's per-metric stages (the
	// metric-progress payload's stage values): phase 1 (rows removed)
	// and phase 2 (plan running / rows inserted).
	StageRemove  = "remove"
	StageCompute = "compute"
)

// CancelledReason is the failure text of a metric whose run was
// cancelled (the state's error word — user's domain, no version).
const CancelledReason = "cancelled"

// MetricContext derives the context ONE metric's statement runs under
// from the sweep's (the per-metric cancel seam: the service registers
// the returned cancel so a user can stop that metric alone). The
// returned func releases it and is always called. nil = the sweep's ctx.
type MetricContext func(parent context.Context, metricID int64) (context.Context, context.CancelFunc)

// SweepProgress is one progress point of the sweep: the metric being
// processed, its stage, and the sweep's honest k/N — Done counts metrics
// FINISHED before this point, Total is the whole work list. Progress-only
// (it changes no row); the service throttles it onto
// spectra:metric-progress (100 ms) or funnels it into an import job's
// job-progress.
type SweepProgress struct {
	MetricID int64  `json:"metricId"`
	Stage    string `json:"stage"` // StageRemove | StageCompute
	Done     int    `json:"done"`
	Total    int    `json:"total"`
}

// SweepResult is one sweep's outcome — what the service turns into
// spectra:metric-done and its in-memory per-metric state:
//
//	Attempted metrics whose phase 1 ran (their old rows are gone)
//	Succeeded  Attempted ∩ computed and committed
//	Failed     Attempted → the failure text (never a version number —
//	           the texts are the engine's own error copies)
//	Skipped    Attempted but not computed: an upstream failed or was
//	           skipped this run (rows cleared → behind, not failed)
//	Cancelled  Failed by the USER's cancel (a subset of Failed) — the
//	           service holds these so no background sweep re-runs them
//	Total      the work list's size (the progress denominator)
type SweepResult struct {
	Attempted []int64
	Succeeded []int64
	Failed    map[int64]string
	Skipped   []int64
	Cancelled []int64
	Total     int
}

// Sweep runs ONE full compute pass over the behind set (design §3/§4).
// The caller owns the budget token and the compute lock (service: token
// → lock, never reversed); this function only needs the store and a
// context. progress may be nil. The returned error is a SETUP failure
// (config/catalog read) or ctx.Err() on cancellation — per-metric
// failures are data in the SweepResult, never a returned error: one
// broken metric must not abort the sweep of the others. metricCtx may be
// nil (no per-metric cancel).
func Sweep(ctx context.Context, st *store.Store, progress func(SweepProgress), metricCtx MetricContext) (SweepResult, error) {
	// ONE config read for the whole sweep (design §4 — the
	// RecomputeAll one-config-read pattern): the live rule stamp every
	// fresh row is stamped with and every ref join binds.
	cfg, err := st.GetConfig()
	if err != nil {
		return SweepResult{}, err
	}
	coverage, err := st.MetricCoverage(cfg.RuleVersion)
	if err != nil {
		return SweepResult{}, err
	}
	all, err := st.ListMetrics()
	if err != nil {
		return SweepResult{}, err
	}
	edges, err := st.ListMetricEdges()
	if err != nil {
		return SweepResult{}, err
	}

	byID := make(map[int64]models.MetricRow, len(all))
	byName := make(map[string]models.MetricRow, len(all))
	for _, m := range all {
		byID[m.ID] = m
		byName[m.Name] = m
	}
	// Direct behind set (THE predicate) + the graph clauses.
	depsOf := make(map[int64][]int64, len(all))
	dangling := map[int64]bool{} // an unresolvable dep_name (system removal)
	for _, m := range all {
		for _, name := range edges[m.Name] {
			if t, ok := byName[name]; ok {
				depsOf[m.ID] = append(depsOf[m.ID], t.ID)
			} else {
				dangling[m.ID] = true
			}
		}
	}
	work := map[int64]bool{}
	for _, c := range coverage {
		if c.Behind {
			work[c.MetricID] = true
		}
	}
	for id := range dangling {
		work[id] = true
	}
	// Forward closure: anything downstream of work joins work (fixpoint
	// over the edges — the metric count is small, clarity over
	// cleverness).
	for changed := true; changed; {
		changed = false
		for _, m := range all {
			if work[m.ID] {
				continue
			}
			for _, d := range depsOf[m.ID] {
				if work[d] {
					work[m.ID] = true
					changed = true
					break
				}
			}
		}
	}
	// The user-cancel hold: a held metric and everything downstream of it
	// leave the work list before ordering. Nothing about them is touched
	// (no phase 1, no attempt): the held metric keeps reading as cancelled
	// and its dependents as behind, until saving the metric clears the hold.
	held, err := st.HeldMetricIDs()
	if err != nil {
		return SweepResult{}, err
	}
	blocked := map[int64]bool{}
	for id := range held {
		if _, ok := byID[id]; ok {
			blocked[id] = true
		}
	}
	for changed := len(blocked) > 0; changed; {
		changed = false
		for _, m := range all {
			if blocked[m.ID] {
				continue
			}
			for _, d := range depsOf[m.ID] {
				if blocked[d] {
					blocked[m.ID] = true
					changed = true
					break
				}
			}
		}
	}
	for id := range blocked {
		delete(work, id)
	}
	res := SweepResult{Failed: map[int64]string{}, Total: len(work)}
	if len(work) == 0 {
		return res, nil
	}

	// Kahn over the work subgraph (in-edges counted only among work
	// members: a dep OUTSIDE work is fresh by construction and needs no
	// ordering). Deterministic tie-break: smallest id first.
	indeg := make(map[int64]int, len(work))
	dependents := make(map[int64][]int64, len(work))
	for id := range work {
		for _, d := range depsOf[id] {
			if work[d] {
				indeg[id]++
				dependents[d] = append(dependents[d], id)
			}
		}
	}
	var ready []int64
	for id := range work {
		if indeg[id] == 0 {
			ready = append(ready, id)
		}
	}
	sortIDs := func(ids []int64) {
		sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	}
	sortIDs(ready)
	order := make([]int64, 0, len(work))
	for len(ready) > 0 {
		id := ready[0]
		ready = ready[1:]
		order = append(order, id)
		for _, dep := range dependents[id] {
			indeg[dep]--
			if indeg[dep] == 0 {
				ready = append(ready, dep)
				sortIDs(ready)
			}
		}
	}
	// Kahn leftovers = nodes Kahn could not order: a cycle (hand-edited
	// graph — the save path rejects cycles, design §2) or something
	// downstream of one. Save rejects cycles, so this is defensive: the
	// pass turns them into FAILED metrics, never a hang.
	leftover := map[int64]bool{}
	for id := range work {
		if !containsID(order, id) {
			leftover[id] = true
		}
	}

	// unavailable = upstream failed or was skipped THIS run: its
	// forward closure must not compute (phase 1 only → absent → behind).
	unavailable := map[int64]bool{}
	finished := 0
	total := len(work)

	start := func(id int64, stage string) {
		if progress != nil {
			progress(SweepProgress{MetricID: id, Stage: stage, Done: finished, Total: total})
		}
	}
	// finishAttempt records the metric's phase-1 attempt (the caller
	// has already appended it to res.Attempted) and bumps k.
	finishAttempt := func() { finished++ }

	// process runs the two-phase unit for ONE metric. Every path that
	// reaches phase 1 lands in Attempted; a failure/skip leaves the
	// metric with NO rows (phase 1 already committed) — absent → behind,
	// retried by the next sweep.
	process := func(m models.MetricRow) {
		// The metric's own context exists before its first progress
		// point, so a cancel issued while it is processing always lands.
		mctx, release := ctx, context.CancelFunc(func() {})
		if metricCtx != nil {
			mctx, release = metricCtx(ctx, m.ID)
		}
		defer release()
		start(m.ID, StageRemove)
		// The units this run recomputes: the STALE units only (raw.go
		// SweepUnits). A gate or scope-read failure means the metric cannot
		// run at all, so its rows go as a whole and it fails.
		units, err := SweepUnits(st, m, cfg.RuleVersion)
		if err != nil {
			_ = st.ClearMetricValues(m.ID)
			res.Attempted = append(res.Attempted, m.ID)
			res.Failed[m.ID] = err.Error()
			unavailable[m.ID] = true
			finishAttempt()
			return
		}
		// Phase 1 removes only those units' rows (ruling 20): every fresh
		// unit of this metric, and every other match's values, stay as they
		// are.
		if err := st.ClearMetricUnits(m.ID, units); err != nil {
			res.Attempted = append(res.Attempted, m.ID)
			res.Failed[m.ID] = err.Error()
			unavailable[m.ID] = true
			finishAttempt()
			return
		}
		res.Attempted = append(res.Attempted, m.ID) // phase 1 committed: stale units gone
		// An upstream that failed or was skipped this run: never compute
		// from stale/absent inputs. The stale units are already cleared, so
		// the metric reads as behind (not failed — it did not fail), and the
		// next sweep retries it once its upstream is healthy.
		for _, d := range depsOf[m.ID] {
			if unavailable[d] {
				res.Skipped = append(res.Skipped, m.ID)
				unavailable[m.ID] = true
				finishAttempt()
				return
			}
		}
		start(m.ID, StageCompute)

		fail := func(msg string) {
			res.Failed[m.ID] = msg
			unavailable[m.ID] = true
			finishAttempt()
		}
		// cancelled: the user stopped THIS metric — failed with the cancel
		// reason, and reported so the service holds it.
		cancelled := func() {
			res.Cancelled = append(res.Cancelled, m.ID)
			fail(CancelledReason)
		}

		// Each unit is one atomic run (RunRaw replaces its own rows in one
		// transaction), so a stop never leaves a unit half-written: a unit
		// that did not commit stays absent (behind), and the units that did
		// commit stay fresh.
		err = runUnits(mctx, st, m, units, cfg.RuleVersion)
		if ctx.Err() != nil {
			return // sweep cancelled: absent → behind, resumed next sweep
		}
		if mctx.Err() != nil {
			cancelled()
			return
		}
		if err != nil {
			fail(err.Error())
			return
		}
		res.Succeeded = append(res.Succeeded, m.ID)
		finishAttempt()
	}

	// Main sweep: topological order (dependents after their upstreams).
	for _, id := range order {
		if ctx.Err() != nil {
			return res, ctx.Err()
		}
		process(byID[id])
	}
	// Leftovers (hand-edited cycles and their forward closure), in
	// passes until no node can be decided: a cycle member fails with the
	// cycle path first, then its downstream becomes skippable in the
	// next pass.
	for len(leftover) > 0 {
		if ctx.Err() != nil {
			return res, ctx.Err()
		}
		ids := make([]int64, 0, len(leftover))
		for id := range leftover {
			ids = append(ids, id)
		}
		sortIDs(ids)
		progressed := false
		for _, id := range ids {
			if ctx.Err() != nil {
				return res, ctx.Err()
			}
			m := byID[id]
			// A member OF a cycle fails with the friendly path (the same
			// copy checkMetricCycle spells at save time); its rows go in
			// the same phase-1 step.
			if cycle := FindCycle(m.Name, edges); cycle != nil {
				start(m.ID, StageRemove)
				if err := st.ClearMetricValues(m.ID); err != nil {
					res.Attempted = append(res.Attempted, m.ID)
					res.Failed[m.ID] = err.Error()
				} else {
					res.Attempted = append(res.Attempted, m.ID)
					res.Failed[m.ID] = "cyclic metric reference: " + strings.Join(cycle, " → ")
				}
				unavailable[m.ID] = true
				finishAttempt()
				delete(leftover, id)
				progressed = true
				continue
			}
			// Not on a cycle: decide it only once every work-dep has
			// been decided (cycle members leave `leftover` first, so
			// their downstream resolves on a later pass).
			decided := true
			for _, d := range depsOf[id] {
				if leftover[d] {
					decided = false
					break
				}
			}
			if !decided {
				continue
			}
			process(m)
			delete(leftover, id)
			progressed = true
		}
		if !progressed {
			// Defensive floor: every remaining node has an undecided dep
			// and none is on a cycle through itself — impossible unless
			// the graph changed under us; fail them so they never hang.
			for _, id := range ids {
				if _, still := leftover[id]; !still {
					continue
				}
				m := byID[id]
				start(m.ID, StageRemove)
				if err := st.ClearMetricValues(m.ID); err != nil {
					res.Failed[m.ID] = err.Error()
				} else {
					res.Failed[m.ID] = "cyclic metric reference (unorderable dependency graph)"
				}
				res.Attempted = append(res.Attempted, m.ID)
				unavailable[m.ID] = true
				finishAttempt()
				delete(leftover, id)
			}
		}
	}

	// Completion point (never throttled by the service's 100 ms window —
	// the closing call the heatmap progress emitter's exemption
	// mirrors): only when the WHOLE work list actually finished; a
	// cancelled sweep reports its partial k/N and rides
	// metric-done{ok:false}. The ctx check below catches a cancellation
	// that landed on the LAST metric (its insert was skipped, so the
	// work list is NOT complete even though every loop exited clean).
	if err := ctx.Err(); err != nil {
		return res, err
	}
	if finished >= total && progress != nil {
		progress(SweepProgress{Stage: StageCompute, Done: total, Total: total})
	}
	return res, nil
}

// containsID reports membership (small slices — clarity over a set).
func containsID(ids []int64, id int64) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

// unitWorkers bounds how many of one metric's stale units run at once. A unit's
// SQL reads through the read-only pool, and its write is one transaction on the
// writer connection (WAL: readers never block the writer), so reads overlap and
// writes serialize. Metrics themselves still run one at a time in dependency
// order.
var unitWorkers = runtime.GOMAXPROCS(0)

// SetUnitWorkers sets how many of one metric's units run at once, returning the
// previous value. 1 is the sequential sweep; the default is GOMAXPROCS.
func SetUnitWorkers(n int) int {
	prev := unitWorkers
	unitWorkers = n
	return prev
}

// runUnits runs one metric's stale units with up to unitWorkers in flight. The
// first unit error stops the launch of further units; units already running
// finish, so each unit is still one atomic run. It returns that first error.
// Cancellation is classified by the caller (sweep ctx, then the metric's ctx).
func runUnits(mctx context.Context, st *store.Store, m models.MetricRow, units []store.RawScope, ruleVersion int) error {
	workers := unitWorkers
	if workers < 1 {
		workers = 1
	}
	if workers > len(units) {
		workers = len(units)
	}
	if workers == 0 {
		return nil
	}
	stop := make(chan struct{})
	var once sync.Once
	var firstErr error
	fail := func(err error) {
		once.Do(func() {
			firstErr = err
			close(stop)
		})
	}
	next := make(chan store.RawScope)
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for sc := range next {
				if err := RunRaw(mctx, st, m.ID, m.Version, ruleVersion, m.RunExpr, sc); err != nil {
					fail(err)
				}
			}
		}()
	}
feed:
	for _, sc := range units {
		select {
		case <-stop:
			break feed
		case <-mctx.Done():
			break feed
		case next <- sc:
		}
	}
	close(next)
	wg.Wait()
	return firstErr
}
