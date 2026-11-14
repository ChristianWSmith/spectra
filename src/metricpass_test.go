package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/budget"
	"github.com/ChristianWSmith/spectra/internal/metrics"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// W3 — the compute pass at the SERVICE level (design §3/§4/§7):
// the behind → compute → fresh → behind → recompute cycle (including
// the rules axis), the cascade version bump on a semantic save (A ← B ←
// C) with display-only/rename/no-op staying quiet, topological order +
// the skip-forward-closure rule, the five-word state vocabulary of
// GetMetricComputeState (with the no-version-leak pin), and the
// budget/lock contract (token → lock order + the nil-budget seam).

// coverageOf returns one metric's (behind, freshRows) from THE predicate.
func coverageOf(t *testing.T, st *store.Store, metricID int64) (behind bool, fresh int) {
	t.Helper()
	cfg, err := st.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	all, err := st.MetricCoverage(cfg.RuleVersion)
	if err != nil {
		t.Fatalf("MetricCoverage: %v", err)
	}
	for _, c := range all {
		if c.MetricID == metricID {
			return c.Behind, c.FreshRows
		}
	}
	t.Fatalf("metric %d missing from coverage", metricID)
	return false, 0
}

// stateOf returns one metric's GetMetricComputeState entry.
func stateOf(t *testing.T, svc *MetricsService, metricID int64) MetricComputeState {
	t.Helper()
	states, err := svc.GetMetricComputeState()
	if err != nil {
		t.Fatalf("GetMetricComputeState: %v", err)
	}
	for _, s := range states {
		if s.MetricID == metricID {
			return s
		}
	}
	t.Fatalf("metric %d missing from compute state", metricID)
	return MetricComputeState{}
}

// storedRows counts one metric's stored value rows.
func storedRows(t *testing.T, st *store.Store, metricID int64) int {
	t.Helper()
	res, err := st.QueryWrite(context.Background(),
		`SELECT COUNT(*) FROM metric_values WHERE metric_id = ?`, []any{metricID}, 1)
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	n, _ := res.Rows[0][0].(int64)
	return int(n)
}

// waitFor polls cond until it holds or the timeout expires.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// TestBehindPredicateCycle is the behind-predicate PAIR (design §4,
// pinned like rule_stamp_test.go): a freshly saved metric is behind →
// computes → fresh; a RULES bump (rule_version + 1, with zero writes of
// its own) makes every row fail the predicate → behind again → the next
// sweep recomputes it → fresh. The same behind set drives
// GetMetricComputeState's word for it.
func TestBehindPredicateCycle(t *testing.T) {
	f := newSeededFixture(t)

	m := f.save(t, models.MetricRow{Name: "bpc_metric", Expr: "from events: count()"})

	// Never computed → behind, state behind, zero rows.
	if behind, fresh := coverageOf(t, f.st, m.ID); !behind || fresh != 0 {
		t.Fatalf("fresh save coverage = (behind=%v, fresh=%d), want (true, 0)", behind, fresh)
	}
	if s := stateOf(t, f.svc, m.ID); s.State != MetricStateBehind {
		t.Errorf("state = %q, want %q", s.State, MetricStateBehind)
	}

	// Compute → fresh (predicate AND rows AND state agree).
	if _, err := f.svc.runSweep(t.Context(), nil); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if behind, fresh := coverageOf(t, f.st, m.ID); behind || fresh == 0 {
		t.Fatalf("after sweep coverage = (behind=%v, fresh=%d), want (false, >0)", behind, fresh)
	}
	if s := stateOf(t, f.svc, m.ID); s.State != MetricStateFresh {
		t.Errorf("state = %q, want %q", s.State, MetricStateFresh)
	}
	rowsBefore := storedRows(t, f.st, m.ID)

	// Rules bump: rule_version + 1 (the store writes the version it is
	// given — AnalyticsService.SetConfig owns the bump-on-change logic;
	// here a direct config write is the rules axis) — the metric's rows
	// fail rule_version < live immediately, with NO write of their own
	// (the crash matrix's "outdated rows present but invisible" window:
	// the physical rows are still here, the fresh count is 0).
	cfg, err := f.st.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	cfg.TradeWindowS = cfg.TradeWindowS + 1 // a real change (the service's no-op compare)
	cfg.RuleVersion = cfg.RuleVersion + 1
	bumped, err := f.st.SetConfig(cfg)
	if err != nil {
		t.Fatalf("SetConfig: %v", err)
	}
	if bumped.RuleVersion != cfg.RuleVersion {
		t.Fatalf("rule_version = %d, want %d", bumped.RuleVersion, cfg.RuleVersion)
	}
	if behind, fresh := coverageOf(t, f.st, m.ID); !behind || fresh != 0 {
		t.Errorf("rules-bumped coverage = (behind=%v, fresh=%d), want (true, 0)", behind, fresh)
	}
	if n := storedRows(t, f.st, m.ID); n != rowsBefore {
		t.Errorf("physical rows after rules bump = %d, want %d (SetConfig writes nothing)", n, rowsBefore)
	}
	if s := stateOf(t, f.svc, m.ID); s.State != MetricStateBehind {
		t.Errorf("state after rules bump = %q, want %q", s.State, MetricStateBehind)
	}

	// Recompute → fresh again, stamped under the new rule version.
	if _, err := f.svc.runSweep(t.Context(), nil); err != nil {
		t.Fatalf("second sweep: %v", err)
	}
	if behind, _ := coverageOf(t, f.st, m.ID); behind {
		t.Error("still behind after the recompute")
	}
	if s := stateOf(t, f.svc, m.ID); s.State != MetricStateFresh {
		t.Errorf("state = %q, want %q", s.State, MetricStateFresh)
	}
}

// TestSaveMetricCascadeBump pins design §4's save-time marking: a
// SEMANTIC edit bumps the edited metric AND every transitive dependent
// in one tx (A ← B ← C), the behind set then covers all three, and the
// sweep brings them all fresh. Display-only edits, no-op saves and
// renames bump NOTHING and schedule nothing (W2b's pin, kept).
func TestSaveMetricCascadeBump(t *testing.T) {
	f := newSeededFixture(t)

	a := f.save(t, models.MetricRow{Name: "casc_a", Expr: "from events: count()"})
	b := f.save(t, models.MetricRow{Name: "casc_b", Expr: "from events: ratio(sum(dmg), metric('casc_a'))"})
	c := f.save(t, models.MetricRow{Name: "casc_c", Expr: "from events: metric('casc_b')"})
	if _, err := f.svc.runSweep(t.Context(), nil); err != nil {
		t.Fatalf("initial sweep: %v", err)
	}
	for _, m := range []models.MetricRow{a, b, c} {
		if behind, _ := coverageOf(t, f.st, m.ID); behind {
			t.Errorf("%s behind after the initial sweep", m.Name)
		}
		if v := versionOf(t, f.st, m.ID); v != 1 {
			t.Errorf("%s version = %d, want 1 (create never bumps)", m.Name, v)
		}
	}

	// SEMANTIC edit of A (expr): A, B and C all bump by exactly 1 —
	// B directly references A, C only references B (transitive).
	a.Expr = "from events: count(where kind='kill')"
	a = f.save(t, a)
	for _, tc := range []struct {
		m    models.MetricRow
		want int
	}{{a, 2}, {b, 2}, {c, 2}} {
		if got := versionOf(t, f.st, tc.m.ID); got != tc.want {
			t.Errorf("%s version = %d, want %d (cascade bump)", tc.m.Name, got, tc.want)
		}
		if behind, _ := coverageOf(t, f.st, tc.m.ID); !behind {
			t.Errorf("%s not behind after the cascade (rows stamped with the old version)", tc.m.Name)
		}
		if s := stateOf(t, f.svc, tc.m.ID); s.State != MetricStateBehind {
			t.Errorf("%s state = %q, want %q", tc.m.Name, s.State, MetricStateBehind)
		}
	}

	// The sweep heals all three (dependents after their upstream).
	if _, err := f.svc.runSweep(t.Context(), nil); err != nil {
		t.Fatalf("healing sweep: %v", err)
	}
	for _, m := range []models.MetricRow{a, b, c} {
		if behind, fresh := coverageOf(t, f.st, m.ID); behind || fresh == 0 {
			t.Errorf("%s after healing = (behind=%v, fresh=%d), want (false, >0)", m.Name, behind, fresh)
		}
	}

	// Display-only edit: no bump, no behindness.
	b.Title = "retitled"
	b = f.save(t, b)
	if got := versionOf(t, f.st, b.ID); got != 2 {
		t.Errorf("display-only bump: version = %d, want 2", got)
	}
	// No-op save: identical fields → no bump.
	c = f.save(t, c)
	if got := versionOf(t, f.st, c.ID); got != 2 {
		t.Errorf("no-op bump: version = %d, want 2", got)
	}
	// Rename (with dependents): the splice rewrites B and C's exprs, but
	// a rename changes no semantics — nothing bumps, nothing goes behind.
	a.Name = "casc_a_renamed"
	a = f.save(t, a)
	if got := versionOf(t, f.st, a.ID); got != 2 {
		t.Errorf("rename bumped the upstream: version = %d, want 2", got)
	}
	for _, m := range []models.MetricRow{b, c} {
		if got := versionOf(t, f.st, m.ID); got != 2 {
			t.Errorf("%s version after the rename splice = %d, want 2", m.Name, got)
		}
		if behind, _ := coverageOf(t, f.st, m.ID); behind {
			t.Errorf("%s behind after a rename (semantics unchanged)", m.Name)
		}
	}
	now, err := f.svc.GetMetric(b.ID)
	if err != nil {
		t.Fatalf("GetMetric: %v", err)
	}
	if now.Expr != "from events: ratio(sum(dmg), metric('casc_a_renamed'))" {
		t.Errorf("dependent expr = %q, want the spliced literal", now.Expr)
	}
}

// versionOf reads a metric's live version (the internal counter — this
// test file is the only place a version number is ever asserted on).
func versionOf(t *testing.T, st *store.Store, metricID int64) int {
	t.Helper()
	m, err := st.GetMetric(metricID)
	if err != nil {
		t.Fatalf("GetMetric(%d): %v", metricID, err)
	}
	return m.Version
}

// TestSweepTopologicalOrderAndSkip pins the ordering contract (design
// §2/§4): a dependent's compute comes strictly AFTER its upstream's
// (its ref join then reads committed fresh rows), and a dependent whose
// upstream FAILED is SKIPPED — phase 1 only (its rows are removed, so
// it reads as behind), never computed from stale inputs, and its own
// forward closure follows.
func TestSweepTopologicalOrderAndSkip(t *testing.T) {
	f := newSeededFixture(t)

	up := f.save(t, models.MetricRow{Name: "topo_up", Expr: "from events: count()"})
	mid := f.save(t, models.MetricRow{Name: "topo_mid", Expr: "from events: ratio(sum(dmg), metric('topo_up'))"})
	leaf := f.save(t, models.MetricRow{Name: "topo_leaf", Expr: "from events: metric('topo_mid')"})

	var steps []string
	res, err := f.svc.runSweep(t.Context(), func(p metrics.SweepProgress) {
		steps = append(steps, fmt.Sprintf("%s:%d", p.Stage, p.MetricID))
	})
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if len(res.Failed) > 0 || len(res.Skipped) > 0 {
		t.Fatalf("failures=%v skipped=%v", res.Failed, res.Skipped)
	}
	stepIndex := func(want string) int {
		for i, s := range steps {
			if s == want {
				return i
			}
		}
		t.Fatalf("step %q never happened (steps: %v)", want, steps)
		return -1
	}
	// Dependent computed strictly after its upstream.
	if i, j := stepIndex(fmt.Sprintf("compute:%d", up.ID)), stepIndex(fmt.Sprintf("remove:%d", mid.ID)); i >= j {
		t.Errorf("mid's phase 1 (%d) does not follow upstream's compute (%d) — topo order violated", j, i)
	}
	if i, j := stepIndex(fmt.Sprintf("compute:%d", mid.ID)), stepIndex(fmt.Sprintf("remove:%d", leaf.ID)); i >= j {
		t.Errorf("leaf's phase 1 (%d) does not follow mid's compute (%d) — topo order violated", j, i)
	}
	for _, m := range []models.MetricRow{up, mid, leaf} {
		if storedRows(t, f.st, m.ID) == 0 {
			t.Errorf("%s has no stored rows after a clean sweep", m.Name)
		}
	}

	// System-remove the UPSTREAM at the store level (the API would block
	// it — this is the plugin-disable path): mid's dep_name dangles, so
	// mid FAILS the resolution (the one positioned error copy), and leaf
	// — whose upstream failed — is SKIPPED with phase 1 only.
	if err := f.st.DeleteMetric(up.ID); err != nil {
		t.Fatalf("store delete: %v", err)
	}
	var steps2 []string
	res2, err := f.svc.runSweep(t.Context(), func(p metrics.SweepProgress) {
		steps2 = append(steps2, fmt.Sprintf("%s:%d", p.Stage, p.MetricID))
	})
	if err != nil {
		t.Fatalf("second sweep: %v", err)
	}
	failMsg, failed := res2.Failed[mid.ID]
	if !failed || !strings.Contains(failMsg, `unknown metric reference "topo_up"`) {
		t.Errorf("mid failure = %q (failed=%v), want the positioned unknown-reference copy", failMsg, failed)
	}
	skipped := false
	for _, id := range res2.Skipped {
		if id == leaf.ID {
			skipped = true
		}
	}
	if !skipped {
		t.Errorf("leaf not skipped (skipped=%v) — its upstream failed", res2.Skipped)
	}
	for _, id := range res2.Succeeded {
		if id == mid.ID || id == leaf.ID {
			t.Errorf("metric %d succeeded despite its upstream being unavailable", id)
		}
	}
	// Skipped/failed ⇒ rows gone (phase 1 ran) ⇒ behind, never stale.
	for _, m := range []models.MetricRow{mid, leaf} {
		if n := storedRows(t, f.st, m.ID); n != 0 {
			t.Errorf("%s rows = %d, want 0 (phase 1 only)", m.Name, n)
		}
		if behind, _ := coverageOf(t, f.st, m.ID); !behind {
			t.Errorf("%s not behind after its upstream failed", m.Name)
		}
	}
	// leaf never even got its compute stage.
	for _, s := range steps2 {
		if s == fmt.Sprintf("compute:%d", leaf.ID) {
			t.Errorf("leaf's compute stage ran (%s) — skip-forward-closure violated", s)
		}
	}
	// State vocabulary on the failure: mid FAILED with the resolution
	// error; leaf is behind (it did not fail — its upstream did).
	if s := stateOf(t, f.svc, mid.ID); s.State != MetricStateFailed || !strings.Contains(s.Error, "unknown metric reference") {
		t.Errorf("mid state = %+v, want failed with the resolution error", s)
	}
	if s := stateOf(t, f.svc, leaf.ID); s.State != MetricStateBehind {
		t.Errorf("leaf state = %q, want %q", s.State, MetricStateBehind)
	}
}

// TestGetMetricComputeStateVocabulary walks each of the five
// owner-ruled words to the situation that produces it, and pins the
// no-version-leak contract: no state string, error text or payload key
// ever carries a version (design §7 — stamps are internal-only).
func TestGetMetricComputeStateVocabulary(t *testing.T) {
	// 1. behind — a saved metric with units to compute and no rows.
	f := newSeededFixture(t)
	behindM := f.save(t, models.MetricRow{Name: "vocab_behind", Expr: "from events: count()"})
	if s := stateOf(t, f.svc, behindM.ID); s.State != MetricStateBehind {
		t.Errorf("behind situation: state = %q, want %q", s.State, MetricStateBehind)
	}

	// 2. processing — a live sweep holds the metric in flight (the
	// progress hook parks INSIDE the run at THIS metric's phase-1 start,
	// so the state read happens mid-sweep on this exact metric — the
	// in-flight mark lands before the hook runs).
	started := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	go func() {
		_, _ = f.svc.runSweep(t.Context(), func(p metrics.SweepProgress) {
			if p.MetricID == behindM.ID && p.Stage == metrics.StageRemove {
				once.Do(func() {
					close(started)
					<-release
				})
			}
		})
	}()
	<-started
	if s := stateOf(t, f.svc, behindM.ID); s.State != MetricStateProcessing {
		t.Errorf("in-flight state = %q, want %q", s.State, MetricStateProcessing)
	}
	close(release)
	waitFor(t, "the parked sweep to finish", func() bool {
		s := stateOf(t, f.svc, behindM.ID)
		return s.State == MetricStateFresh
	})

	// 3. fresh — covered above (and again here, explicitly).
	if s := stateOf(t, f.svc, behindM.ID); s.State != MetricStateFresh {
		t.Errorf("fresh situation: state = %q, want %q", s.State, MetricStateFresh)
	}

	// 4. failed — a dangling upstream (system removal) makes the
	// dependent's recompute fail; its rows are gone, so failed + error.
	up := f.save(t, models.MetricRow{Name: "vocab_up", Expr: "from events: count()"})
	dep := f.save(t, models.MetricRow{Name: "vocab_dep", Expr: "from events: metric('vocab_up')"})
	if _, err := f.svc.runSweep(t.Context(), nil); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if err := f.st.DeleteMetric(up.ID); err != nil {
		t.Fatalf("store delete: %v", err)
	}
	if _, err := f.svc.runSweep(t.Context(), nil); err != nil {
		t.Fatalf("failing sweep: %v", err)
	}
	if s := stateOf(t, f.svc, dep.ID); s.State != MetricStateFailed || s.Error == "" {
		t.Errorf("failed situation: state = %+v, want failed with error text", s)
	}

	// 5. no-data — an EMPTY library: nothing to compute, nothing stored
	// (not behind — the unit-absence guards read an empty library as
	// no-data, never an infinite recompute loop).
	empty := newDepsFixture(t)
	emptyM := empty.save(t, models.MetricRow{Name: "vocab_empty", Expr: "from events: count()", Scope: "match"})
	if _, err := empty.svc.runSweep(t.Context(), nil); err != nil {
		t.Fatalf("empty sweep: %v", err)
	}
	if s := stateOf(t, empty.svc, emptyM.ID); s.State != MetricStateNoData {
		t.Errorf("empty-library state = %q, want %q", s.State, MetricStateNoData)
	}
	emptyProfile := empty.save(t, models.MetricRow{Name: "vocab_empty_profile", Expr: "from events: count()", Scope: "profile"})
	if s := stateOf(t, empty.svc, emptyProfile.ID); s.State != MetricStateNoData {
		t.Errorf("empty-library profile state = %q, want %q", s.State, MetricStateNoData)
	}

	// The no-version-leak pin: the whole payload carries NO version-ish
	// key or stamp — states are the five words, errors are engine copy.
	states, err := f.svc.GetMetricComputeState()
	if err != nil {
		t.Fatalf("GetMetricComputeState: %v", err)
	}
	blob, err := json.Marshal(states)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, banned := range []string{`"version`, "rule_version", "metric_version", "computed_at", "rule version"} {
		if strings.Contains(string(blob), banned) {
			t.Errorf("state payload leaks %q: %s", banned, blob)
		}
	}
	allowed := map[string]bool{
		MetricStateProcessing: true, MetricStateFailed: true, MetricStateFresh: true,
		MetricStateNoData: true, MetricStateBehind: true,
	}
	if len(states) == 0 {
		t.Fatal("no states returned")
	}
	for _, s := range states {
		if !allowed[s.State] {
			t.Errorf("metric %d state %q outside the vocabulary", s.MetricID, s.State)
		}
		if strings.Contains(strings.ToLower(s.Error), "version") {
			t.Errorf("metric %d error text mentions a version: %q", s.MetricID, s.Error)
		}
	}
}

// TestSweepTakesTokenBeforeComputeLock pins the lock-order invariant
// (internal/budget's type doc, AGENTS' ceiling rule): the background
// sweep acquires its machine work token BEFORE the compute lock, never
// reversed — with the pool's only token outstanding, the sweep must
// park on the token and must NOT be holding the lock; once the token
// returns, the sweep runs to completion. The nil budget rides the same
// path as the unbudgeted seam (Acquire/Release no-ops).
func TestSweepTakesTokenBeforeComputeLock(t *testing.T) {
	f := newSeededFixture(t)
	probe := f.save(t, models.MetricRow{Name: "lock_probe", Expr: "from events: count()"})
	b := budget.New(1)
	lock := &sync.Mutex{}
	f.svc.useSweeps(b, lock)

	b.Acquire() // the pool's only token is out (held by "another subsystem")
	f.svc.scheduleSweep()

	// Observation window: the sweep goroutine is scheduled but cannot be
	// past the token wait — if it took the lock FIRST, TryLock would
	// fail for the whole window while the token is outstanding.
	deadline := time.Now().Add(750 * time.Millisecond)
	locksaw := 0
	for time.Now().Before(deadline) {
		if !lock.TryLock() {
			t.Fatal("sweep holds the compute lock while the token is outstanding — token → lock order violated")
		}
		lock.Unlock()
		locksaw++
		time.Sleep(10 * time.Millisecond)
	}
	if locksaw == 0 {
		t.Fatal("no lock observations — the probe itself is broken")
	}
	if behind, _ := coverageOf(t, f.st, probe.ID); behind == false {
		t.Fatal("the probe computed while the token was outstanding — it never waited for its token")
	}

	// The token returns → the parked sweep proceeds and computes.
	b.Release()
	waitFor(t, "the token-released sweep", func() bool {
		behind, _ := coverageOf(t, f.st, probe.ID)
		return !behind
	})
}

// TestSweepCoalescesTriggers pins the scheduler's coalescing (design
// §4's "the behind set IS the remaining work"): a save that lands WHILE
// a sweep is blocked from starting is not lost — exactly one follow-up
// sweep consumes it, and the loop drains. The nil budget here is also
// the unbudgeted seam (useSweeps(nil, nil)): the background loop must
// run without a pool wired.
func TestSweepCoalescesTriggers(t *testing.T) {
	f := newSeededFixture(t)
	f.svc.useSweeps(nil, nil)

	first := f.save(t, models.MetricRow{Name: "coal_first", Expr: "from events: count()"})

	// Hold the compute lock: the scheduled sweep parks on it (its token
	// wait is a no-op with the nil budget), which makes the coalescing
	// window deterministic — scheduleSweep sets sweepRunning
	// synchronously, so the mid-park save below is guaranteed to see a
	// running sweep and set the follow-up flag.
	lock := f.svc.gate()
	lock.Lock()
	f.svc.scheduleSweep()
	second := f.save(t, models.MetricRow{Name: "coal_second", Expr: "from events: count(where kind='kill')"})
	lock.Unlock()

	waitFor(t, "both metrics fresh (the parked sweep + its coalesced follow-up)", func() bool {
		for _, id := range []int64{first.ID, second.ID} {
			behind, _ := coverageOf(t, f.st, id)
			if behind {
				return false
			}
		}
		return true
	})
	if s := stateOf(t, f.svc, second.ID); s.State != MetricStateFresh {
		t.Errorf("second metric state = %q, want %q after the coalesced run", s.State, MetricStateFresh)
	}
	// The loop drains (the follow-up consumed the wanted flag).
	waitFor(t, "the scheduler to go idle", func() bool {
		f.svc.mu.Lock()
		defer f.svc.mu.Unlock()
		return !f.svc.sweepRunning
	})
}
