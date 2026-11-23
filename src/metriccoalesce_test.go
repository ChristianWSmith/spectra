package main

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/budget"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// Sweep coalescing (owner ruling, 2026-11-21): ONE running sweep and at
// most ONE follow-up, across every trigger — import, save, plugin op.
// These tests drive the real scheduler (useSweeps with a token budget and
// a compute lock, like production) and observe the sweeps through
// sweepHook, which counts entries into the pass and the peak number of
// sweeps inside it at once.

// sweepProbe counts sweeps entering the pass. When gate is set, the first
// sweep to enter parks there until the test closes it, which makes the
// "a sweep is running" window deterministic.
type sweepProbe struct {
	inside    atomic.Int32
	maxInside atomic.Int32
	entries   atomic.Int32
	delay     time.Duration // widens the overlap window (concurrency test)
	gate      chan struct{} // non-nil ⇒ an entering sweep parks until closed
}

func (p *sweepProbe) hook(entering bool) {
	if !entering {
		p.inside.Add(-1)
		return
	}
	n := p.inside.Add(1)
	for {
		old := p.maxInside.Load()
		if n <= old || p.maxInside.CompareAndSwap(old, n) {
			break
		}
	}
	p.entries.Add(1)
	if p.delay > 0 {
		time.Sleep(p.delay)
	}
	if p.gate != nil {
		<-p.gate
	}
}

// newCoalesceFixture is a seeded library wired like production: one
// token budget and one compute lock, the probe installed before any
// trigger can run.
func newCoalesceFixture(t *testing.T, gated bool) (*depsFixture, *sweepProbe) {
	t.Helper()
	f := newSeededFixture(t)
	p := &sweepProbe{}
	if gated {
		p.gate = make(chan struct{})
	}
	f.svc.useSweeps(budget.New(2), &sync.Mutex{})
	f.svc.sweepHook = p.hook
	return f, p
}

// openGate releases the parked sweep (idempotent).
func (p *sweepProbe) openGate() {
	if p.gate == nil {
		return
	}
	select {
	case <-p.gate:
	default:
		close(p.gate)
	}
}

// schedulerState reads the running and wanted flags under the scheduler's
// own lock.
func schedulerState(f *depsFixture) (running, wanted bool) {
	f.svc.mu.Lock()
	defer f.svc.mu.Unlock()
	return f.svc.sweepRunning, f.svc.sweepWanted
}

// seedBatchMatch stores one more ready match (an import's worth of rows).
func seedBatchMatch(t *testing.T, st *store.Store, sha string) {
	t.Helper()
	id, err := st.CreateMatchRow("/seed/"+sha+".dem", sha, 1)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	em := &models.ExtractedMatch{
		Match: models.Match{
			Path: "/seed/" + sha + ".dem", SHA256: sha,
			Map: "de_dust2", TickRate: 64, ExtractedAt: time.Now(),
		},
		Players:     []models.Player{{SteamID: eqHumanSID, Name: "dana", Side: "ct"}},
		PlayerStats: []models.PlayerStats{{SteamID: eqHumanSID, Name: "dana", Side: "ct"}},
		Events: []models.Event{
			{Seq: 0, Tick: 100, Round: 1, Kind: "damage", Attacker: eqHumanSID, Victim: eqHumanSID, Weapon: "ak47", Dmg: 10},
		},
	}
	if err := st.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
}

// (a) Two imports that finish while a sweep is running cause exactly one
// follow-up sweep, not two.
func TestImportsDuringSweepCauseOneFollowUp(t *testing.T) {
	f, p := newCoalesceFixture(t, true)
	defer p.openGate()

	mustNoErr(t, f.svc.sweepForJob(t.Context())) // import 1: starts the sweep, which parks
	waitFor(t, "the first sweep to enter the pass", func() bool { return p.entries.Load() == 1 })

	mustNoErr(t, f.svc.sweepForJob(t.Context())) // import 2 finishes while the sweep runs
	mustNoErr(t, f.svc.sweepForJob(t.Context())) // import 3 finishes while the sweep runs
	if n := p.entries.Load(); n != 1 {
		t.Fatalf("a second sweep started while the first was running: %d entries", n)
	}
	if _, wanted := schedulerState(f); !wanted {
		t.Fatal("imports during a running sweep did not set the run-again flag")
	}

	p.openGate()
	waitForSweepIdle(t, f)
	if n := p.entries.Load(); n != 2 {
		t.Fatalf("entries = %d, want 2 (the running sweep plus exactly one follow-up)", n)
	}
	if peak := p.maxInside.Load(); peak != 1 {
		t.Fatalf("peak concurrent sweeps = %d, want 1", peak)
	}
}

// (b) An import that finishes while the scheduler is idle starts a sweep
// at once.
func TestImportWhenIdleStartsSweepAtOnce(t *testing.T) {
	f, p := newCoalesceFixture(t, true)
	defer p.openGate()

	mustNoErr(t, f.svc.sweepForJob(t.Context()))
	if running, _ := schedulerState(f); !running {
		t.Fatal("an import on an idle scheduler did not start a sweep at once")
	}
	waitFor(t, "the immediately started sweep to enter the pass", func() bool { return p.entries.Load() == 1 })

	p.openGate()
	waitForSweepIdle(t, f)
	if n := p.entries.Load(); n != 1 {
		t.Fatalf("entries = %d, want 1 (no trigger asked for a follow-up)", n)
	}
}

// (c) A batch of three imports leaves every value current once the final
// follow-up finishes.
func TestBatchOfThreeImportsLeavesAllValuesCurrent(t *testing.T) {
	f, p := newCoalesceFixture(t, false)
	m := f.save(t, models.MetricRow{Name: "batch_count", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id"})
	waitForSweepIdle(t, f)

	for _, sha := range []string{"batch-1", "batch-2", "batch-3"} {
		seedBatchMatch(t, f.st, sha) // the import's rows: the match is behind
		mustNoErr(t, f.svc.sweepForJob(t.Context()))
	}
	waitForSweepIdle(t, f)

	behind, fresh := coverageOf(t, f.st, m.ID)
	if behind {
		t.Fatal("the metric is still behind after the final follow-up")
	}
	if want := len(readyMatchIDs(t, f.st)); fresh != want {
		t.Fatalf("fresh rows = %d, want one per ready match (%d)", fresh, want)
	}
	if s := stateOf(t, f.svc, m.ID); s.State != MetricStateFresh {
		t.Fatalf("state = %q, want %q", s.State, MetricStateFresh)
	}
	if peak := p.maxInside.Load(); peak != 1 {
		t.Fatalf("peak concurrent sweeps = %d, want 1", peak)
	}
}

// (d) A save that triggers a sweep during an import's sweep joins the
// running sweep: it sets the one follow-up flag, and no second sweep starts.
func TestSaveDuringImportSweepJoinsRunningSweep(t *testing.T) {
	f, p := newCoalesceFixture(t, true)
	defer p.openGate()

	mustNoErr(t, f.svc.sweepForJob(t.Context()))
	waitFor(t, "the import's sweep to enter the pass", func() bool { return p.entries.Load() == 1 })

	saved := f.save(t, models.MetricRow{Name: "save_mid_import", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id"})
	if n := p.entries.Load(); n != 1 {
		t.Fatalf("the save started a second sweep: %d entries", n)
	}
	if _, wanted := schedulerState(f); !wanted {
		t.Fatal("the save during a running sweep did not join it (no follow-up flag)")
	}

	p.openGate()
	waitForSweepIdle(t, f)
	if n := p.entries.Load(); n != 2 {
		t.Fatalf("entries = %d, want 2 (the import's sweep plus one follow-up for the save)", n)
	}
	if behind, fresh := coverageOf(t, f.st, saved.ID); behind || fresh == 0 {
		t.Fatalf("the saved metric is not current after the follow-up (behind %v, fresh %d)", behind, fresh)
	}
}

// (e) No sweep runs concurrently with another, under many triggers at once.
func TestNoConcurrentSweepsUnderManyTriggers(t *testing.T) {
	f, p := newCoalesceFixture(t, false)
	p.delay = 2 * time.Millisecond

	var wg sync.WaitGroup
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if i%2 == 0 {
				_ = f.svc.sweepForJob(t.Context())
			} else {
				f.svc.scheduleSweep()
			}
		}(i)
	}
	wg.Wait()
	waitForSweepIdle(t, f)

	if peak := p.maxInside.Load(); peak != 1 {
		t.Fatalf("peak concurrent sweeps = %d, want 1", peak)
	}
	if p.entries.Load() == 0 {
		t.Fatal("no sweep ran at all")
	}
}

// (f) A metric failure does not fail the import job: the hook returns nil
// and the failure is carried by the metric's own compute state.
func TestMetricFailureDoesNotFailImport(t *testing.T) {
	f, _ := newCoalesceFixture(t, false)
	bad := f.save(t, models.MetricRow{Name: "always_fails", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE no_such_column = 1 AND match_id = :match_id"})

	if err := f.svc.sweepForJob(t.Context()); err != nil {
		t.Fatalf("sweepForJob returned %v; a metric failure must not fail the import", err)
	}
	waitForSweepIdle(t, f)
	if s := stateOf(t, f.svc, bad.ID); s.State != MetricStateFailed || s.Error == "" {
		t.Fatalf("failing metric state = %+v, want failed with error text", s)
	}
}

// mustNoErr fails the test on an error from a call whose result the test needs
// to be nil (the sweep entry point always returns nil by contract).
func mustNoErr(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
