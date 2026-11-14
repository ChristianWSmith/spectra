package metrics

import (
	"context"
	"fmt"
	"sort"
	"strings"

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
//	phase 1  ClearMetricValues — remove the metric's rows, commit
//	         (design §4's remove-outdated step; wholesale per metric,
//	         see the store doc for why the two spellings coincide)
//	phase 2  run the plan (CompilePassMatch batched for match scope,
//	         scope "" for profile), fetch, insert the fresh set stamped
//	         with BOTH current versions + computed_at — ONE tx, and
//	         THAT commit is the commit marker: committed-insert = fresh,
//	         anything else = not-fresh (crash matrix: a failure in
//	         phase 2 leaves the metric absent → behind → retried)
//
// ctx cancellation aborts BETWEEN metrics (and mid-query via the write
// handle's context): whatever was not reached keeps its rows and stays
// behind — the behind set IS the remaining work, so the next sweep
// resumes exactly there. Nothing persisted tracks progress.
const (
	// StageRemove / StageCompute are the pass's per-metric stages (the
	// metric-progress payload's stage values): phase 1 (rows removed)
	// and phase 2 (plan running / rows inserted).
	StageRemove  = "remove"
	StageCompute = "compute"
)

const (
	// passGroupedCap is the row cap for batched aggregate statements —
	// one row per (match, subject): matches × players, with headroom. A
	// truncated plan is a FAILED compute (never silently partial values).
	passGroupedCap = 1 << 20
	// passRawCap is the percentile raw-fetch cap — the same bound
	// RunPreview applies (percentileCap), same truncation rule.
	passRawCap = percentileCap
)

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
//	Total      the work list's size (the progress denominator)
type SweepResult struct {
	Attempted []int64
	Succeeded []int64
	Failed    map[int64]string
	Skipped   []int64
	Total     int
}

// Sweep runs ONE full compute pass over the behind set (design §3/§4).
// The caller owns the budget token and the compute lock (service: token
// → lock, never reversed); this function only needs the store and a
// context. progress may be nil. The returned error is a SETUP failure
// (config/catalog read) or ctx.Err() on cancellation — per-metric
// failures are data in the SweepResult, never a returned error: one
// broken metric must not abort the sweep of the others.
func Sweep(ctx context.Context, st *store.Store, progress func(SweepProgress)) (SweepResult, error) {
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
		start(m.ID, StageRemove)
		if err := st.ClearMetricValues(m.ID); err != nil {
			res.Attempted = append(res.Attempted, m.ID)
			res.Failed[m.ID] = err.Error()
			unavailable[m.ID] = true
			finishAttempt()
			return
		}
		res.Attempted = append(res.Attempted, m.ID) // phase 1 committed: old rows gone
		// An upstream that failed or was skipped this run: never compute
		// from stale/absent inputs. The rows are already cleared, so the
		// metric reads as behind (not failed — it did not fail), and the
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

		// Resolve the metric()'s references against the CURRENT catalog
		// (the same RefTarget shape PreviewMetric/SaveMetric bind; live
		// stamps = this sweep's config read). A dangling name is simply
		// left out — CompileRefs reports the ONE positioned
		// "unknown metric reference" copy, so pass, save and preview can
		// never disagree.
		refs := map[string]RefTarget{}
		spec, perr := Parse(m.Expr)
		if perr != nil {
			fail(perr.Message)
			return
		}
		for _, r := range MetricRefs(spec) {
			if t, ok := byName[r.Name]; ok {
				refs[r.Name] = RefTarget{
					ID: t.ID, Scope: t.Scope, Version: t.Version,
					RuleVersion: cfg.RuleVersion,
				}
			}
		}
		// Compile ONCE for execution — the plan itself carries every
		// validation (a failure here IS the validation failure; the
		// compiler is pure and cheap, so error and plan ride one path).
		var plan Plan
		var cperr *ParseError
		if m.Scope == "profile" {
			// Profile computes with the "" library statement — the
			// career grain, one row per subject at match_id = 0 (design
			// §3: a career value is stored directly, never rolled up
			// from per-match rows).
			plan, cperr = CompileRefs(m.Expr, m.Denominator, "", refs)
		} else {
			plan, cperr = CompilePassMatch(m.Expr, m.Denominator, refs)
		}
		if cperr != nil {
			fail(cperr.Message)
			return
		}

		rowCap := passGroupedCap
		if plan.Mode == ModePercentile {
			rowCap = passRawCap
		}
		fetched, err := st.QueryWrite(ctx, plan.SQL, plan.Args, rowCap)
		if err != nil {
			if ctx.Err() != nil {
				// Cancelled mid-metric: phase 1 already committed, so this
				// metric is absent → behind → resumed next sweep. NOT a
				// metric failure (it was interrupted, not broken) — the
				// sweep surfaces the cancellation as its returned error.
				return
			}
			fail(err.Error())
			return
		}
		if fetched.Truncated {
			fail("compute returned too many rows (truncated — the metric stays behind)")
			return
		}
		if ctx.Err() != nil {
			return // interrupted before the insert: absent → behind → resumed
		}
		values, err := valuesFromPlan(plan, fetched.Rows)
		if err != nil {
			fail(err.Error())
			return
		}
		if err := st.InsertMetricValues(m.ID, m.Version, cfg.RuleVersion, values); err != nil {
			if ctx.Err() != nil {
				return // interrupted: the insert tx rolled back → absent → behind
			}
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

// valuesFromPlan turns a plan's fetched rows into the metric_values
// insert set — the pass's row-shape adapter (the ONE place the stored
// layout is derived from a Plan):
//
//	ModeGrouped     [match_id, subject, v0..vK, n] (MatchAddress) or
//	                [subject, v0..vK, n] — the stored value is the
//	                FIRST aggregation (the same row Value Preview
//	                surfaces), n the trailing sample size, the match
//	                key 0 for the profile grain.
//	ModePercentile   raw rows partitioned by the row's address —
//	                (match_id, subject) batched, subject at profile
//	                scope — the p-quantile over each partition's own
//	                sample, denominator from the partition's OWN row
//	                (career-correlated at profile scope, the row's
//	                match scalar in the batch), N = the numeric values
//	                behind it. Mirrors RunPreview's percentile branch
//	                exactly — preview and stored agree by construction.
//
// A row too short to carry its shape is skipped (defensive — the
// emitter always emits the full shape).
func valuesFromPlan(plan Plan, rows [][]any) ([]store.MetricValueRow, error) {
	out := make([]store.MetricValueRow, 0, len(rows))
	switch plan.Mode {
	case ModeGrouped:
		valueIdx := 1
		if plan.MatchAddress {
			valueIdx = 2
		}
		for _, r := range rows {
			if len(r) < valueIdx+2 { // subject, value, n — never shorter
				continue
			}
			var mid int64
			if plan.MatchAddress {
				f, ok := numeric(r[0])
				if !ok {
					continue
				}
				mid = int64(f)
			}
			out = append(out, store.MetricValueRow{
				MatchID: mid,
				SteamID: toKey(r[valueIdx-1]),
				Value:   toFloat(r[valueIdx]),
				N:       toN(r[len(r)-1]),
			})
		}
		return out, nil
	case ModePercentile:
		// Partition address: (match_id, subject) batched, subject at
		// profile scope — a struct key keeps the two apart without
		// string surgery.
		type partKey struct {
			mid     int64
			subject string
		}
		type partition struct {
			vals     []float64
			denom    float64
			denomSet bool
		}
		parts := map[partKey]*partition{}
		for _, r := range rows {
			if len(r) < 2 {
				continue
			}
			offset := 0
			var mid int64
			if plan.MatchAddress {
				f, ok := numeric(r[0])
				if !ok {
					continue
				}
				mid = int64(f)
				offset = 1
			}
			if len(r) < offset+2 {
				continue
			}
			key := partKey{mid: mid, subject: toKey(r[offset])}
			p := parts[key]
			if p == nil {
				p = &partition{}
				parts[key] = p
			}
			if v, ok := numeric(r[offset+1]); ok {
				p.vals = append(p.vals, v)
			}
			if plan.HasDenom && !p.denomSet {
				p.denom = toFloat(r[len(r)-1])
				p.denomSet = true
			}
		}
		for key, p := range parts {
			sort.Float64s(p.vals)
			v := percentileOf(p.vals, plan.PercentileP)
			if plan.HasDenom {
				if p.denom != 0 {
					v /= p.denom
				} else {
					v = 0
				}
			}
			out = append(out, store.MetricValueRow{
				MatchID: key.mid,
				SteamID: key.subject,
				Value:   v,
				N:       len(p.vals),
			})
		}
		return out, nil
	}
	return nil, fmt.Errorf("metrics: unsupported plan mode %d", plan.Mode)
}
