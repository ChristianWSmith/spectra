package library

// Queue/progress/cancel pins for the import pipeline: dedupe and
// coalesce (one job per path / per match), the configured-N concurrency
// semantics (the admission semaphore bounds in-flight parses, claims
// stay FIFO; N=1 — Options.Concurrency unset — in most tests), the
// job-wide byte-progress mapping (monotone, stage-ranged),
// Enqueue/Reprocess after Shutdown, and the cancel/dequeue state machine
// for both job kinds. See library_test.go for the pipeline's happy path.

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/extract"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// waitMatchStatus polls until the match row reaches want — the match-row
// half of waitStatus (a cancel announces the job terminal state first;
// the worker's failJob lands the row transition right after).
func waitMatchStatus(t *testing.T, st *store.Store, matchID int64, want string) *models.Match {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		m, err := st.GetMatch(matchID)
		if err != nil {
			t.Fatalf("GetMatch(%d): %v", matchID, err)
		}
		if m.Status == want {
			return m
		}
		time.Sleep(10 * time.Millisecond)
	}
	m, err := st.GetMatch(matchID)
	if err != nil {
		t.Fatalf("GetMatch(%d): %v", matchID, err)
	}
	t.Fatalf("match %d status = %q, want %q", matchID, m.Status, want)
	return nil
}

// blockingParse holds the job on every parse after the first `skip`
// calls, releasing on ctx.Done like the real parser does — so a Cancel
// of the RUNNING job unblocks it exactly as extract.Parse would.
// Ordering: claim ORDER is FIFO at any N, but at N≥2 job BODIES overlap,
// which would race the `skip` call counting — every test using this runs
// at the default seam (Options.Concurrency nil ⇒ 1), where the single
// admitted parse makes calls strictly ordered.
func blockingParse(skip int32, calls *atomic.Int32) func(context.Context, io.Reader, extract.ParseOptions) (*models.ExtractedMatch, error) {
	return func(ctx context.Context, r io.Reader, opts extract.ParseOptions) (*models.ExtractedMatch, error) {
		if calls.Add(1) > skip {
			<-ctx.Done()
			return nil, ctx.Err()
		}
		return fakeParse(ctx, r, opts)
	}
}

// TestEnqueueDedupesPendingPath: a path with a non-terminal job is
// MERGED into that job (same id back, no second row) whether the pending
// job is running or still queued — the guard against a duplicate import
// failing "already imported" once the first one lands.
func TestEnqueueDedupesPendingPath(t *testing.T) {
	block := make(chan struct{})
	release := sync.OnceFunc(func() { close(block) })
	defer release()
	parse := func(ctx context.Context, r io.Reader, opts extract.ParseOptions) (*models.ExtractedMatch, error) {
		<-block // hold the worker so the second path stays queued
		return fakeParse(ctx, r, opts)
	}
	im, st := newTestImporter(t, parse)

	pathA := writeDemo(t, "dedupe-a.dem", "aaa")
	pathB := writeDemo(t, "dedupe-b.dem", "bbb")

	running := im.Enqueue([]string{pathA})[0]
	waitStatus(t, st, running, models.JobRunning)
	queued := im.Enqueue([]string{pathB})[0]

	if got := im.Enqueue([]string{pathB})[0]; got != queued {
		t.Errorf("re-Enqueue of a QUEUED path = %d, want the pending job %d", got, queued)
	}
	if got := im.Enqueue([]string{pathA})[0]; got != running {
		t.Errorf("re-Enqueue of a RUNNING path = %d, want the pending job %d", got, running)
	}
	// Merged enqueues must not have created rows: exactly one job per path.
	jobs, err := st.ListJobs()
	if err != nil {
		t.Fatalf("ListJobs: %v", err)
	}
	if len(jobs) != 2 {
		t.Fatalf("ListJobs len = %d, want 2 (dedupe merged, not duplicated)", len(jobs))
	}
	// A DIFFERENT path still queues its own job.
	if other := im.Enqueue([]string{writeDemo(t, "dedupe-c.dem", "ccc")}); len(other) != 1 || other[0] == running || other[0] == queued {
		t.Errorf("Enqueue of a fresh path = %v, want a new job id", other)
	}

	release()
	waitStatus(t, st, running, models.JobDone)
	waitStatus(t, st, queued, models.JobDone)
}

// TestEnqueueMultiPathCreatesOneJobPerPath pins the multi-file contract:
// one Enqueue call with N paths yields N jobs (one per path, argument
// order) — the frontend's multi-select dialog rides this.
func TestEnqueueMultiPathCreatesOneJobPerPath(t *testing.T) {
	im, st := newTestImporter(t, fakeParse)
	paths := []string{
		writeDemo(t, "multi-1.dem", "one"),
		writeDemo(t, "multi-2.dem", "two"),
		writeDemo(t, "multi-3.dem", "three"),
	}
	ids := im.Enqueue(paths)
	if len(ids) != 3 {
		t.Fatalf("Enqueue returned %d ids, want 3", len(ids))
	}
	seen := map[int64]bool{}
	for _, id := range ids {
		if seen[id] {
			t.Fatalf("duplicate job id %d", id)
		}
		seen[id] = true
		waitStatus(t, st, id, models.JobDone)
	}
	jobs, err := st.ListJobs()
	if err != nil {
		t.Fatalf("ListJobs: %v", err)
	}
	if len(jobs) != 3 {
		t.Errorf("ListJobs len = %d, want 3 (one job per path)", len(jobs))
	}
}

// TestReprocessCoalescesPendingJob: a second Reprocess of a match that
// already has a non-terminal job returns THAT job — no second job, and
// no status flip under a running parse.
func TestReprocessCoalescesPendingJob(t *testing.T) {
	block := make(chan struct{})
	release := sync.OnceFunc(func() { close(block) })
	defer release()
	var calls atomic.Int32
	// call 1 = the import (completes), call 2 = the holder (blocks the
	// worker so the reprocess below is deterministically QUEUED).
	parse := func(ctx context.Context, r io.Reader, opts extract.ParseOptions) (*models.ExtractedMatch, error) {
		if calls.Add(1) == 2 {
			<-block
		}
		return fakeParse(ctx, r, opts)
	}
	im, st := newTestImporter(t, parse)

	imported := waitStatus(t, st, im.Enqueue([]string{writeDemo(t, "coalesce.dem", "coalesce")})[0], models.JobDone)
	matchID := imported.MatchID
	holder := im.Enqueue([]string{writeDemo(t, "holder.dem", "hold")})[0]
	waitStatus(t, st, holder, models.JobRunning)

	first, err := im.Reprocess(matchID)
	if err != nil {
		t.Fatalf("Reprocess: %v", err)
	}
	// Visible queued state: the match row flips to queued for the wait.
	if m, err := st.GetMatch(matchID); err != nil || m.Status != models.StatusQueued {
		t.Errorf("match after Reprocess = (%q, %v), want queued", m.Status, err)
	}
	second, err := im.Reprocess(matchID)
	if err != nil {
		t.Fatalf("second Reprocess: %v", err)
	}
	if second != first {
		t.Errorf("coalesced Reprocess = %d, want the pending job %d", second, first)
	}
	jobs, err := st.ListJobs()
	if err != nil {
		t.Fatalf("ListJobs: %v", err)
	}
	if len(jobs) != 3 { // import + holder + ONE reprocess
		t.Errorf("ListJobs len = %d, want 3 (coalesce must not add a job)", len(jobs))
	}

	release()
	waitStatus(t, st, first, models.JobDone)
	if m, err := st.GetMatch(matchID); err != nil || m.Status != models.StatusReady {
		t.Errorf("match after the coalesced reprocess = (%q, %v), want ready", m.Status, err)
	}
}

// TestParseConcurrency re-pins the old TestSingleParseInFlight (which
// asserted max concurrent == 1, an artifact of the single worker) to the
// configured-N semantics. The seam is Options.Concurrency — read once
// per claim and clamped to [1, workerCount], exactly like the shared
// budget's live size production wires in (budget.Size — the "parallel
// work" setting). BEHAVIOR pins:
//   - N=1 admits exactly one parse and leaves job2 queued until job1's
//     slot frees (the old assertion, now attributable to the admission
//     semaphore instead of to a lone goroutine);
//   - N=2 admits TWO parses at once — both jobs reach the parser before
//     either returns, observed through channels (no sleeps) — and the
//     semaphore STILL bounds: a third job stays queued while both slots
//     are held, and concurrency never exceeds 2.
func TestParseConcurrency(t *testing.T) {
	t.Run("N=1 bounds to one parse in flight", func(t *testing.T) {
		block := make(chan struct{})
		release := sync.OnceFunc(func() { close(block) })
		defer release()
		var inFlight, maxInFlight atomic.Int32
		parse := func(ctx context.Context, r io.Reader, opts extract.ParseOptions) (*models.ExtractedMatch, error) {
			n := inFlight.Add(1)
			for {
				old := maxInFlight.Load()
				if n <= old || maxInFlight.CompareAndSwap(old, n) {
					break
				}
			}
			defer inFlight.Add(-1)
			<-block
			return fakeParse(ctx, r, opts)
		}
		im, st := newTestImporterN(t, parse, 1)

		ids := im.Enqueue([]string{writeDemo(t, "single-1.dem", "1"), writeDemo(t, "single-2.dem", "2")})
		if len(ids) != 2 {
			t.Fatalf("Enqueue returned %d ids, want 2", len(ids))
		}
		waitStatus(t, st, ids[0], models.JobRunning)
		if j := jobByID(t, st, ids[1]); j.Status != models.JobQueued {
			t.Errorf("job2 status = %q, want queued while job1 holds the only slot", j.Status)
		}

		release()
		waitStatus(t, st, ids[1], models.JobDone)
		if got := maxInFlight.Load(); got != 1 {
			t.Errorf("max concurrent parses = %d, want 1 at N=1", got)
		}
	})

	t.Run("N=2 overlaps two parses and bounds at two", func(t *testing.T) {
		if workerCount < 2 {
			t.Skipf("worker pool size %d — this machine cannot admit 2 workers", workerCount)
		}
		entered := make(chan struct{}, 4) // one token per parse ENTRY
		block := make(chan struct{})
		release := sync.OnceFunc(func() { close(block) })
		defer release()
		var inFlight, maxInFlight atomic.Int32
		parse := func(ctx context.Context, r io.Reader, opts extract.ParseOptions) (*models.ExtractedMatch, error) {
			n := inFlight.Add(1)
			for {
				old := maxInFlight.Load()
				if n <= old || maxInFlight.CompareAndSwap(old, n) {
					break
				}
			}
			defer inFlight.Add(-1)
			entered <- struct{}{} // announce before parking: the overlap proof
			select {
			case <-block:
			case <-ctx.Done():
			}
			return fakeParse(ctx, r, opts)
		}
		im, st := newTestImporterN(t, parse, 2)

		ids := im.Enqueue([]string{
			writeDemo(t, "overlap-1.dem", "1"),
			writeDemo(t, "overlap-2.dem", "2"),
			writeDemo(t, "overlap-3.dem", "3"),
		})
		if len(ids) != 3 {
			t.Fatalf("Enqueue returned %d ids, want 3", len(ids))
		}
		// Both admitted parses announce themselves while the other is
		// still parked in parse — channels, not sleeps. The watchdog turns
		// a broken admission (no second entry ever) into a failure, not a
		// hang.
		for i := 0; i < 2; i++ {
			select {
			case <-entered:
			case <-time.After(5 * time.Second):
				t.Fatalf("parse entry %d never happened — N=2 must admit two overlapping parses", i+1)
			}
		}
		if got := maxInFlight.Load(); got < 2 {
			t.Fatalf("max concurrent parses = %d, want ≥2 at N=2", got)
		}
		// The bound holds too: with both slots parked in parse, job3 cannot
		// be claimed — deterministic, because no slot frees until release().
		if j := jobByID(t, st, ids[2]); j.Status != models.JobQueued {
			t.Errorf("job3 status = %q, want queued while both slots are held", j.Status)
		}

		release()
		deadline := time.Now().Add(5 * time.Second)
		for _, id := range ids {
			for jobByID(t, st, id).Status != models.JobDone {
				if time.Now().After(deadline) {
					for _, d := range ids {
						j := jobByID(t, st, d)
						t.Logf("job %d = status %q stage %q progress %v error %q",
							j.ID, j.Status, j.Stage, j.Progress, j.Error)
					}
					t.Fatalf("job %d never reached done", id)
				}
				time.Sleep(10 * time.Millisecond)
			}
		}
		if got := maxInFlight.Load(); got != 2 {
			t.Errorf("max concurrent parses = %d, want exactly 2 (the N=2 bound)", got)
		}
	})
}

// TestRealDemoConcurrentImportSmoke is the N=2 REAL-DEMO concurrency
// smoke: the synthetic pins above prove the admission bound; this runs
// two archived golden demos (different content — nothing for the sha
// gate to arbitrate) through the real extract.Parse at N=2 and requires
// BOTH imports to land with the parses genuinely overlapping (max
// concurrent = 2, recorded by the parse wrapper). Skipped under -short
// and when the golden pool is absent (git lfs pull) — the same rule
// internal/integration's acceptance tests use. It logs wall time, the
// per-parse time sum (wall < sum = real overlap) and the process peak
// RSS (Linux /proc) — the memory figure that matters for running the
// default concurrency on a small box.
func TestRealDemoConcurrentImportSmoke(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping the real-demo concurrency smoke in -short mode (two full parses)")
	}
	goldenDir := filepath.Join("..", "..", "..", "golden")
	demos := []string{
		filepath.Join(goldenDir, "de_cache.dem.zst"),
		filepath.Join(goldenDir, "de_dust2.dem.zst"),
	}
	for _, d := range demos {
		fi, err := os.Stat(d)
		if err != nil || fi.Size() < 1<<20 {
			t.Skipf("golden demo absent (run git lfs pull): %s", d)
		}
	}
	if workerCount < 2 {
		t.Skipf("worker pool size %d — cannot run 2 workers", workerCount)
	}

	var mu sync.Mutex
	var inFlight, maxInFlight int
	var parseSum time.Duration
	entered := make(chan struct{}, 2)
	parse := func(ctx context.Context, r io.Reader, opts extract.ParseOptions) (*models.ExtractedMatch, error) {
		start := time.Now()
		mu.Lock()
		inFlight++
		if inFlight > maxInFlight {
			maxInFlight = inFlight
		}
		mu.Unlock()
		entered <- struct{}{}
		defer func() {
			mu.Lock()
			inFlight--
			parseSum += time.Since(start)
			mu.Unlock()
		}()
		return extract.Parse(ctx, r, opts)
	}
	im, st := newTestImporterWith(t, Options{
		Parse:       parse,
		Concurrency: func() int { return 2 },
	})

	wallStart := time.Now()
	ids := im.Enqueue(demos)
	if len(ids) != 2 {
		t.Fatalf("Enqueue returned %d ids, want 2", len(ids))
	}
	// Both parses must START (hash + copy of ~180-190 MiB first — a
	// generous watchdog, still channel-observed, never a sleep).
	for i := 0; i < 2; i++ {
		select {
		case <-entered:
		case <-time.After(2 * time.Minute):
			t.Fatalf("parse %d never started — N=2 did not admit both real parses", i+1)
		}
	}
	deadline := time.Now().Add(15 * time.Minute)
	for _, id := range ids {
		for jobByID(t, st, id).Status != models.JobDone {
			if time.Now().After(deadline) {
				for _, d := range ids {
					j := jobByID(t, st, d)
					t.Logf("job %d = status %q stage %q progress %v error %q",
						j.ID, j.Status, j.Stage, j.Progress, j.Error)
				}
				t.Fatalf("job %d never finished the real-demo import", id)
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	wall := time.Since(wallStart)

	mu.Lock()
	maxSeen, sum := maxInFlight, parseSum
	mu.Unlock()
	if maxSeen != 2 {
		t.Errorf("max concurrent real parses = %d, want exactly 2 (overlap + bound)", maxSeen)
	}
	rows, err := st.ListMatches("", "extracted_at", false)
	if err != nil {
		t.Fatalf("ListMatches: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("match rows = %d, want 2 (both golden demos imported)", len(rows))
	}
	for _, r := range rows {
		if r.Status != models.StatusReady {
			t.Errorf("match %d status = %q, want ready", r.ID, r.Status)
		}
	}
	t.Logf("N=2 real-demo smoke: wall=%s, Σparse=%s (Σ>wall ⇒ overlap), maxConcurrent=%d, peakRSS=%s",
		wall.Round(time.Millisecond), sum.Round(time.Millisecond), maxSeen, peakRSS())
}

// peakRSS reads VmHWM (process high-water RSS) from /proc — Linux only
// (every perf figure in this repo is; "" elsewhere).
func peakRSS() string {
	raw, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return "n/a"
	}
	for line := range strings.SplitSeq(string(raw), "\n") {
		if rest, ok := strings.CutPrefix(line, "VmHWM:"); ok {
			return strings.TrimSpace(rest)
		}
	}
	return "n/a"
}

// jobByID returns the job with id, failing when it is absent.
func jobByID(t *testing.T, st *store.Store, id int64) models.Job {
	t.Helper()
	jobs, err := st.ListJobs()
	if err != nil {
		t.Fatalf("ListJobs: %v", err)
	}
	for _, j := range jobs {
		if j.ID == id {
			return j
		}
	}
	t.Fatalf("job %d not found", id)
	return models.Job{}
}

// TestJobProgressMonotoneAcrossStages pins the job-wide progress
// mapping: every spectra:job-progress point is in 0..1, never regresses,
// and each stage lands inside ITS range — hash ≤0.10, copy ≤0.20,
// decompress/parse start at 0.20, parse ≤0.90, store 0.90 (the old
// progress-1-then-0.95 regression), analyze 0.95. Byte stages must
// report determinate points (>0), not just the stage entry.
func TestJobProgressMonotoneAcrossStages(t *testing.T) {
	var mu sync.Mutex
	var seen []JobProgressEvent
	im, st := newTestImporterEmit(t, fakeParse, func(name string, data any) {
		if name != EventJobProgress {
			return
		}
		if ev, ok := data.(JobProgressEvent); ok {
			mu.Lock()
			seen = append(seen, ev)
			mu.Unlock()
		}
	})
	// A demo large enough that the hash/copy/parse passes each read real
	// bytes (still one Read per pass — the FIRST tick of a stage is
	// forced, so determinate points are not throttled away).
	path := writeDemo(t, "progress.dem", strings.Repeat("demo-bytes ", 4096))
	ids := im.Enqueue([]string{path})
	if len(ids) != 1 {
		t.Fatalf("Enqueue returned %d ids, want 1", len(ids))
	}
	job := waitStatus(t, st, ids[0], models.JobDone)

	mu.Lock()
	defer mu.Unlock()
	if len(seen) == 0 {
		t.Fatal("no spectra:job-progress events")
	}
	ranges := map[string][2]float64{
		models.StageHash:       {0, progressHashEnd},
		models.StageCopy:       {progressCopyStart, progressCopyEnd},
		models.StageDecompress: {progressParseStart, progressParseStart},
		models.StageParse:      {progressParseStart, progressParseEnd},
		models.StageStore:      {progressStore, progressStore},
		models.StageAnalyze:    {progressAnalyze, progressAnalyze},
	}
	var last float64
	present := map[string]bool{}
	determinate := map[string]bool{}
	for _, ev := range seen {
		if ev.Progress < 0 || ev.Progress > 1 {
			t.Errorf("stage %q progress %v outside 0..1", ev.Stage, ev.Progress)
		}
		if ev.Progress < last {
			t.Errorf("progress regressed: %v → %v at stage %q", last, ev.Progress, ev.Stage)
		}
		last = ev.Progress
		rng, ok := ranges[ev.Stage]
		if !ok {
			if ev.Stage != models.StageQueued {
				t.Errorf("unexpected stage %q", ev.Stage)
			}
			continue
		}
		if ev.Progress < rng[0] || ev.Progress > rng[1] {
			t.Errorf("stage %q progress %v outside [%v, %v]", ev.Stage, ev.Progress, rng[0], rng[1])
		}
		present[ev.Stage] = true
		// The byte-driven stages must move INSIDE their range (a stage
		// entry alone would be progress 0 in disguise); store/analyze are
		// point ranges — being present at their point is the pin.
		if rng[1] > rng[0] && ev.Progress > rng[0] {
			determinate[ev.Stage] = true
		}
	}
	for stage := range ranges {
		if !present[stage] {
			t.Errorf("no progress event for stage %q", stage)
		}
	}
	for _, stage := range []string{models.StageHash, models.StageCopy, models.StageParse} {
		if !determinate[stage] {
			t.Errorf("stage %q never reported a determinate point above its range start", stage)
		}
	}
	if last != progressAnalyze {
		t.Errorf("last progress point = %v, want the analyze step %v", last, progressAnalyze)
	}
	// The jobs row agrees at the end (job-wide progress, done = 1).
	if job.Progress != 1 || job.Stage != models.StageDone {
		t.Errorf("finished job = progress %v stage %q, want 1/done", job.Progress, job.Stage)
	}
}

// TestEnqueueAfterShutdownFailsImmediately: once Shutdown has begun no
// job may be left queued with no worker to claim it — Enqueue fails it
// immediately, Reprocess refuses (error) AND fails its job, and the
// match row never stays stuck on the artificial queued flip.
func TestEnqueueAfterShutdownFailsImmediately(t *testing.T) {
	im, st := newTestImporter(t, fakeParse)
	imported := waitStatus(t, st, im.Enqueue([]string{writeDemo(t, "shut.dem", "shut")})[0], models.JobDone)
	matchID := imported.MatchID

	im.Shutdown()

	ids := im.Enqueue([]string{writeDemo(t, "late.dem", "late")})
	if len(ids) != 1 {
		t.Fatalf("Enqueue after Shutdown returned %d ids, want 1", len(ids))
	}
	job := waitStatus(t, st, ids[0], models.JobFailed)
	if job.Error != shuttingDownErr {
		t.Errorf("job error = %q, want %q", job.Error, shuttingDownErr)
	}
	if job.Status == models.JobQueued {
		t.Error("job left queued after Shutdown")
	}

	if _, err := im.Reprocess(matchID); !errors.Is(err, errShuttingDown) {
		t.Errorf("Reprocess after Shutdown err = %v, want errShuttingDown", err)
	}
	if m, err := st.GetMatch(matchID); err != nil || m.Status != models.StatusReady {
		t.Errorf("match after the refused Reprocess = (%q, %v), want ready (restored)", m.Status, err)
	}
	for _, j := range mustJobs(t, st) {
		if j.Status == models.JobQueued || j.Status == models.JobRunning {
			t.Errorf("job %d left %q after Shutdown", j.ID, j.Status)
		}
	}
}

func mustJobs(t *testing.T, st *store.Store) []models.Job {
	t.Helper()
	jobs, err := st.ListJobs()
	if err != nil {
		t.Fatalf("ListJobs: %v", err)
	}
	return jobs
}

// TestCancelStateMachine pins the four cancel outcomes (the Library's
// cancel/dequeue buttons):
//   - running import  → job cancelled, match row failed/"cancelled"
//     (openable again: Reprocess/Delete gate only on queued/parsing);
//   - queued import   → dequeue: job cancelled, NO match row ever exists;
//   - queued reprocess → dequeue: job cancelled, match row handed back to
//     the state Reprocess queued it from (ready here);
//   - running reprocess → job cancelled, match row failed/"cancelled"
//     (the row is usable again — not stuck on parsing).
func TestCancelStateMachine(t *testing.T) {
	t.Run("running import cancel fails the match row", func(t *testing.T) {
		var calls atomic.Int32
		im, st := newTestImporter(t, blockingParse(0, &calls))
		id := im.Enqueue([]string{writeDemo(t, "cancel-run.dem", "x")})[0]
		waitStatus(t, st, id, models.JobRunning)

		if err := im.Cancel(id); err != nil {
			t.Fatalf("Cancel: %v", err)
		}
		waitStatus(t, st, id, models.JobCancelled)
		// Cancel marks the job terminal synchronously, but an import's
		// match row is created only after hash+copy — the JobRunning
		// snapshot can carry match_id = 0. Resolve the link fresh (the
		// claimed worker creates and links the row even with a cancelled
		// ctx — no ctx check before CreateMatchRow), then wait for
		// failJob's match-row write.
		m := waitMatchStatus(t, st, waitJobMatch(t, st, id), models.StatusFailed)
		if m.Error != "cancelled" {
			t.Errorf("match error = %q, want cancelled", m.Error)
		}
	})

	t.Run("queued import dequeue leaves no match row", func(t *testing.T) {
		var calls atomic.Int32
		im, st := newTestImporter(t, blockingParse(0, &calls))
		first := im.Enqueue([]string{writeDemo(t, "dequeue-1.dem", "1")})[0]
		waitStatus(t, st, first, models.JobRunning)
		second := im.Enqueue([]string{writeDemo(t, "dequeue-2.dem", "2")})[0]

		if err := im.Cancel(second); err != nil {
			t.Fatalf("Cancel(queued): %v", err)
		}
		waitStatus(t, st, second, models.JobCancelled)
		// The dequeued import never became a match: only the first job's
		// row exists (still parsing — its own cancel comes next). That
		// row lands only after the first job's hash+copy, so wait for
		// its link before counting.
		waitJobMatch(t, st, first)
		rows, err := st.ListMatches("", "extracted_at", false)
		if err != nil {
			t.Fatalf("ListMatches: %v", err)
		}
		if len(rows) != 1 {
			t.Errorf("match rows = %d, want 1 (the dequeued import created none)", len(rows))
		}
		if err := im.Cancel(first); err != nil {
			t.Fatalf("Cancel(running): %v", err)
		}
		waitStatus(t, st, first, models.JobCancelled)
	})

	t.Run("queued reprocess dequeue restores the match row", func(t *testing.T) {
		block := make(chan struct{})
		release := sync.OnceFunc(func() { close(block) })
		defer release()
		var calls atomic.Int32
		// call 1 = import (completes), call 2 = holder (blocks the worker
		// so the reprocess is deterministically queued).
		parse := func(ctx context.Context, r io.Reader, opts extract.ParseOptions) (*models.ExtractedMatch, error) {
			if calls.Add(1) == 2 {
				<-block
			}
			return fakeParse(ctx, r, opts)
		}
		im, st := newTestImporter(t, parse)
		imported := waitStatus(t, st, im.Enqueue([]string{writeDemo(t, "rq.dem", "rq")})[0], models.JobDone)
		matchID := imported.MatchID
		holder := im.Enqueue([]string{writeDemo(t, "rq-holder.dem", "h")})[0]
		waitStatus(t, st, holder, models.JobRunning)

		reID, err := im.Reprocess(matchID)
		if err != nil {
			t.Fatalf("Reprocess: %v", err)
		}
		if m, _ := st.GetMatch(matchID); m.Status != models.StatusQueued {
			t.Fatalf("match status = %q, want queued (the visible wait)", m.Status)
		}
		if err := im.Cancel(reID); err != nil {
			t.Fatalf("Cancel(queued reprocess): %v", err)
		}
		waitStatus(t, st, reID, models.JobCancelled)
		m := waitMatchStatus(t, st, matchID, models.StatusReady)
		if m.Error != "" {
			t.Errorf("restored match error = %q, want empty (state before Reprocess)", m.Error)
		}

		release()
		waitStatus(t, st, holder, models.JobDone)
	})

	t.Run("running reprocess cancel fails the match row", func(t *testing.T) {
		var calls atomic.Int32
		im, st := newTestImporter(t, blockingParse(1, &calls))
		imported := waitStatus(t, st, im.Enqueue([]string{writeDemo(t, "rc.dem", "rc")})[0], models.JobDone)
		matchID := imported.MatchID

		reID, err := im.Reprocess(matchID)
		if err != nil {
			t.Fatalf("Reprocess: %v", err)
		}
		waitStatus(t, st, reID, models.JobRunning)
		if err := im.Cancel(reID); err != nil {
			t.Fatalf("Cancel(running reprocess): %v", err)
		}
		waitStatus(t, st, reID, models.JobCancelled)
		m := waitMatchStatus(t, st, matchID, models.StatusFailed)
		if m.Error != "cancelled" {
			t.Errorf("match error = %q, want cancelled", m.Error)
		}
		// Not stranded: the row is out of parsing/queued, so Reprocess and
		// Delete are enabled again (the UI's isOpenable gate).
		if m.Status == models.StatusQueued || m.Status == models.StatusParsing {
			t.Errorf("match still %q after a cancelled reprocess", m.Status)
		}
		if _, err := im.Reprocess(matchID); err != nil {
			t.Errorf("Reprocess after a cancelled reprocess: %v", err)
		}
	})
}
