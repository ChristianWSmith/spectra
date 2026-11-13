// Package library is the presentation-free import pipeline: a bounded
// pool of worker goroutines that hash, dedupe (sha256), optionally copy
// the raw demo into the app's managed demo dir (copy-on-import, the
// default — the source file may later move or vanish; the copy_on_import
// pref skips it, see Options.CopyEnabled), decompress (.dem.zst,
// streamed — never to a temp file) and parse demos via internal/extract,
// persisting through internal/store. Jobs are claimed strictly FIFO and
// run concurrently up to the import_concurrency setting
// (Options.Concurrency — 1 = sequential, the machine's thread count =
// the default; see main.importConcurrencyPref). Progress and terminal
// transitions are announced as Wails events (spectra:job-progress /
// spectra:job-done / spectra:library-changed) through an injected Emit
// hook; originals are never written. The same package owns import-dir
// discovery (Scan, DefaultDemoDirs, RemoveDemoFile) for the Library's
// not-yet-imported list.
package library

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/klauspost/compress/zstd"
	demoinfocs "github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs"

	"github.com/ChristianWSmith/spectra/internal/analytics"
	"github.com/ChristianWSmith/spectra/internal/data"
	"github.com/ChristianWSmith/spectra/internal/extract"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/sidecar"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// Job kinds (jobs.kind).
const (
	jobKindImport    = "import"
	jobKindReprocess = "reprocess"
)

// Event names emitted to the frontend.
const (
	EventJobProgress    = "spectra:job-progress"
	EventJobDone        = "spectra:job-done"
	EventLibraryChanged = "spectra:library-changed"
	// EventScanProgress is one import-dir scan's progress (scan.go). It is
	// deliberately NOT spectra:job-progress: that payload keys a jobId into
	// the frontend's job store (services.js jobProgress map) and a scan is
	// not a job — it has no jobId and never writes a jobs row (the same
	// rule as mappackservice.go's spectra:asset-progress).
	EventScanProgress = "spectra:scan-progress"
)

// progressMinInterval throttles byte-progress updates to at most one per
// 100 ms (per stage — the first tick of a stage always goes through, so
// even a fast stage reports a determinate point). Stage transitions are
// emitted separately and never throttled.
const progressMinInterval = 100 * time.Millisecond

// The job-wide progress mapping (see models.Job and the stage table next
// to the stage constants): every stage owns a fixed slice of 0..1, so the
// points one job emits are monotone no matter which stage reports them.
const (
	progressHashEnd    = 0.10 // hash:     bytes read ÷ file size
	progressCopyStart  = 0.10 // copy:     bytes written ÷ file size
	progressCopyEnd    = 0.20
	progressParseStart = 0.20 // parse:    stream bytes consumed ÷ file size
	progressParseEnd   = 0.90
	progressStore      = 0.90 // store:    coarse step
	progressAnalyze    = 0.95 // analyze:  coarse step
)

// errShuttingDown is the refusal Enqueue/Reprocess surface once Shutdown
// has begun: no worker will ever claim anything new, so a job created
// now would sit queued forever without it.
var errShuttingDown = errors.New("library: importer is shutting down")

// shuttingDownErr is the jobs.error text for such a job (user-facing —
// it lands in the Library's "recent import problems" list).
const shuttingDownErr = "importer is shutting down"

// byteFrac maps consumed bytes of total into 0..1 (clamped). ok is false
// when there is no determinate denominator — an empty or unknown size
// yields no progress point rather than a fabricated one.
func byteFrac(consumed, total int64) (float64, bool) {
	if total <= 0 {
		return 0, false
	}
	f := float64(consumed) / float64(total)
	if f < 0 {
		return 0, true
	}
	if f > 1 {
		return 1, true
	}
	return f, true
}

// inRange maps a 0..1 fraction onto [lo, hi].
func inRange(lo, hi, frac float64) float64 { return lo + (hi-lo)*frac }

// countingReader reports the running byte total to onRead after every
// Read — the ONE byte-progress source for hash, copy and parse. It wraps
// the FILE reader (before zstd), so for a compressed demo the count is
// the compressed bytes pulled so far ÷ the file size: demoinfocs pulls
// from its reader as it parses, which makes bytes-consumed a monotone,
// honest proxy for parse progress (frame totals are unknowable mid-parse
// for CS2 — see extract.ParseOptions.Progress).
type countingReader struct {
	r      io.Reader
	read   int64 // running total
	onRead func(consumed int64)
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	if n > 0 {
		c.read += int64(n)
		if c.onRead != nil {
			c.onRead(c.read)
		}
	}
	return n, err
}

// progressReporter serializes one job's progress points: stage
// transitions (emit) go straight through, byte ticks (tick) are throttled
// to progressMinInterval with the FIRST tick of each stage forced. Every
// point is written to the jobs row — store.UpdateJobProgress only ever
// touches a running job, so a point racing a Cancel cannot resurrect it —
// and announced as spectra:job-progress. Writes are clamped monotone per
// job: a late byte tick can never walk the bar backwards.
type progressReporter struct {
	mu        sync.Mutex
	im        *Importer
	jobID     int64
	matchID   int64
	lastNano  int64
	lastPct   float64
	tickStage string // stage a byte tick was last emitted for
}

// emit records a stage transition (or a forced point) at pct.
func (r *progressReporter) emit(stage string, pct float64) {
	r.mu.Lock()
	r.lastNano = time.Now().UnixNano()
	if pct > r.lastPct {
		r.lastPct = pct
	}
	pct = r.lastPct
	r.mu.Unlock()
	r.im.writeProgress(r.jobID, r.matchID, stage, pct)
}

// tick records a byte-derived point, throttled per stage (the first tick
// of a stage is not).
func (r *progressReporter) tick(stage string, pct float64) {
	now := time.Now().UnixNano()
	r.mu.Lock()
	if r.tickStage == stage && now-r.lastNano < int64(progressMinInterval) {
		r.mu.Unlock()
		return
	}
	r.tickStage = stage
	r.lastNano = now
	if pct > r.lastPct {
		r.lastPct = pct
	}
	pct = r.lastPct
	r.mu.Unlock()
	r.im.writeProgress(r.jobID, r.matchID, stage, pct)
}

// writeProgress stamps the jobs row and announces the point.
func (im *Importer) writeProgress(jobID, matchID int64, stage string, pct float64) {
	_ = im.st.UpdateJobProgress(jobID, stage, pct)
	im.emitEvent(EventJobProgress, JobProgressEvent{JobID: jobID, Stage: stage, Progress: pct, MatchID: matchID})
}

// zstdMagic is the 4-byte zstd frame magic number (RFC 8878): 28 b5 2f fd.
var zstdMagic = []byte{0x28, 0xb5, 0x2f, 0xfd}

// JobProgressEvent is the payload of spectra:job-progress. Progress is
// the job-wide 0..1 point (models.Job — NOT per-stage): 0 means
// "indeterminate" and the UI draws a moving bar for it, never 0%.
// Stage names the pipeline step (models stage constants) and is what the
// chip labels the bar with.
type JobProgressEvent struct {
	JobID    int64   `json:"jobId"`
	Stage    string  `json:"stage"`
	Progress float64 `json:"progress"`
	MatchID  int64   `json:"matchId"`
}

// JobDoneEvent is the payload of spectra:job-done. Status is done, failed
// or cancelled; Error is "" unless non-empty.
type JobDoneEvent struct {
	JobID   int64  `json:"jobId"`
	MatchID int64  `json:"matchId"`
	Status  string `json:"status"`
	Error   string `json:"error"`
}

// LibraryChangedEvent is the (empty) payload of spectra:library-changed:
// any view backed by the matches/jobs tables should refetch.
type LibraryChangedEvent struct{}

// Options configures an Importer. Parse is the extraction entry point
// (normally extract.Parse); Emit receives event name + payload and may be
// nil; ParserVersion is stamped onto extracted matches; SidecarDir is the
// root that holds one position-sidecar directory per match (<root>/<id>),
// defaulting to data.MatchesDir() when empty; CopyDir is where raw demos
// are copied when copy-on-import runs (<copyDir>/<sha256>.dem[.zst]),
// defaulting to data.DemosDir() when empty (tests point both at temp dirs
// so they never touch the user's real data). CopyEnabled is the
// copy-on-import setting read ONCE PER JOB at process time (so a Settings
// toggle applies to jobs already queued); nil ⇒ copy — the default every
// construction site without a pref gets. Concurrency is the
// concurrent-imports setting read ONCE PER JOB at claim time (so a
// Settings change applies to jobs already queued), clamped to
// [1, workerCount]; nil ⇒ 1 (strictly sequential — the fallback for a
// construction site with no pref wired; production wires
// main.importConcurrencyPref, whose own default is the machine's thread
// count). ComputeLock serializes this importer's analytics pass against
// every other analytics.Compute in the process — main wires ONE lock
// into the importer and AnalyticsService's background recompute (rationale
// in im.analyze); nil ⇒ a private lock (Computes still serialize within
// this importer; only the cross-service sharing needs wiring).
type Options struct {
	Store         *store.Store
	Parse         func(ctx context.Context, r io.Reader, opts extract.ParseOptions) (*models.ExtractedMatch, error)
	Emit          func(event string, data any)
	ParserVersion string
	SidecarDir    string
	CopyDir       string
	CopyEnabled   func() bool
	Concurrency   func() int
	ComputeLock   *sync.Mutex
}

// queueItem is one unit of work for the worker.
type queueItem struct {
	jobID   int64
	kind    string
	path    string
	matchID int64 // reprocess only; 0 for import
}

// matchLifecycle is a match row's lifecycle state as it stood BEFORE
// Reprocess flipped it to "queued" (the visible wait). A dequeue, or a
// queued job the worker never claims, puts the row back exactly as it
// was — the artificial flip must never outlive the job that caused it.
type matchLifecycle struct {
	status string
	errMsg string
}

// workerCount is the worker-pool size: the machine's hardware threads —
// runtime.NumCPU reports the logical CPUs usable by the process, which IS
// rung 1 of the owner's thread ladder ("as many as the number of threads
// available on the machine"; Go has no portable physical-core API, so the
// cores rung cannot be taken portably and the floor is the
// single-threaded rung — guarded by the n<1 check below). Evaluated once
// at package init (NumCPU is constant for the process's life). The
// concurrency pref is clamped to [1, workerCount] (concurrencyLimit), so
// the goroutine count and the admission bound can never disagree: the
// pool is sized for the MOST the setting may ask, and a setting of 1
// simply parks all but one worker.
var workerCount = func() int {
	if n := runtime.NumCPU(); n >= 1 {
		return n
	}
	return 1
}()

// Importer owns the pool of background worker goroutines plus the
// per-job cancellation contexts. Create with New; call Shutdown before
// closing the store.
type Importer struct {
	st            *store.Store
	parse         func(ctx context.Context, r io.Reader, opts extract.ParseOptions) (*models.ExtractedMatch, error)
	emit          func(event string, data any)
	parserVersion string
	sidecarDir    string
	copyDir       string
	copyEnabled   func() bool // nil ⇒ copy (the default)
	concurrency   func() int  // nil ⇒ 1 (sequential; see Options.Concurrency)
	computeLock   *sync.Mutex // nil ⇒ a private lock (see im.analyze)

	mu        sync.Mutex
	cond      *sync.Cond // workers wait for work AND a free slot
	queue     []queueItem
	queued    map[int64]queueItem // jobs sitting in queue (for Cancel): kind+matchID
	cancels   map[int64]context.CancelFunc
	cancelled map[int64]bool           // Cancel() seen but not yet consumed by the worker
	pending   map[int64]matchLifecycle // match rows Reprocess queued: prior state (key = matchID)
	stopping  bool                     // Shutdown started: claims are refused
	running   int                      // jobs holding a concurrency slot (claimed → body done)
	sha       *shaGate                 // per-content-hash admission (shagate.go)
	once      sync.Once
	wg        sync.WaitGroup
}

// New creates an Importer and starts its worker pool (workerCount
// goroutines; how many may hold a job at once is the per-job concurrency
// pref — see Options.Concurrency).
func New(o Options) *Importer {
	sidecarDir := o.SidecarDir
	if sidecarDir == "" {
		sidecarDir = data.MatchesDir()
	}
	copyDir := o.CopyDir
	if copyDir == "" {
		copyDir = data.DemosDir()
	}
	im := &Importer{
		st:            o.Store,
		parse:         o.Parse,
		emit:          o.Emit,
		parserVersion: o.ParserVersion,
		sidecarDir:    sidecarDir,
		copyDir:       copyDir,
		copyEnabled:   o.CopyEnabled,
		concurrency:   o.Concurrency,
		computeLock:   o.ComputeLock,
		queued:        map[int64]queueItem{},
		cancels:       map[int64]context.CancelFunc{},
		cancelled:     map[int64]bool{},
		pending:       map[int64]matchLifecycle{},
		sha:           newSHAGate(),
	}
	if im.computeLock == nil {
		im.computeLock = &sync.Mutex{}
	}
	im.cond = sync.NewCond(&im.mu)
	im.wg.Add(workerCount)
	for i := 0; i < workerCount; i++ {
		go im.worker()
	}
	return im
}

// concurrencyLimit is the admission bound for the NEXT claim: the
// concurrency pref read once per claim (never at Enqueue/Reprocess — a
// Settings change applies to jobs already queued, exactly like
// copy-on-import), clamped to [1, workerCount]. Called with im.mu held.
func (im *Importer) concurrencyLimit() int {
	n := 1
	if im.concurrency != nil {
		n = im.concurrency()
	}
	if n < 1 {
		n = 1 // single-threaded floor (a degenerate pref never stalls the pool)
	}
	if n > workerCount {
		n = workerCount // never more than the pool has goroutines
	}
	return n
}

// copyOn is the copy-on-import decision for ONE job, read when the job
// runs (never at Enqueue/Reprocess time), so flipping the setting in
// Settings applies to jobs already queued. A nil CopyEnabled (no pref
// wired — tests, and every construction site that predates the setting)
// means "copy", the default.
func (im *Importer) copyOn() bool {
	if im.copyEnabled == nil {
		return true
	}
	return im.copyEnabled()
}

// Enqueue creates one import job per path and returns the job IDs in
// argument order. Paths with an unsupported extension or that cannot be
// stat'ed get a job that is failed immediately (with the reason in
// jobs.error) so the UI can surface it; no hashing happens here — the
// response stays fast regardless of file size.
//
// Dedupe: a path that already has a non-terminal (queued/running) job is
// MERGED into it — the existing job's id comes back and no second job is
// created. Two jobs for the same bytes would otherwise guarantee an
// "already imported" failure for the loser once the winner lands. Paths
// are matched exactly as given (the same string the import-dir rows and
// the dialog hand us — see store.FindPendingJobByPath).
//
// Once Shutdown has begun every new job fails immediately (never a job
// stuck in queued with no worker to claim it).
func (im *Importer) Enqueue(paths []string) []int64 {
	ids := make([]int64, 0, len(paths))
	for _, p := range paths {
		if job, found, err := im.st.FindPendingJobByPath(p); err != nil {
			slog.Error("library: pending-job lookup", "path", p, "error", err)
		} else if found {
			ids = append(ids, job.ID) // merged into the job already in flight
			continue
		}
		id, err := im.st.CreateJob(jobKindImport, p)
		if err != nil {
			slog.Error("library: create import job", "path", p, "error", err)
			continue
		}
		ids = append(ids, id)
		if msg := validateImportPath(p); msg != "" {
			im.failNewJob(id, 0, msg)
			continue
		}
		if !im.push(queueItem{jobID: id, kind: jobKindImport, path: p}) {
			im.failNewJob(id, 0, shuttingDownErr)
		}
	}
	return ids
}

// failNewJob records a job that never entered the queue (invalid path,
// importer stopping) as failed immediately, announcing the same event
// pair a worker-side failure does so every view refreshes.
func (im *Importer) failNewJob(jobID, matchID int64, msg string) {
	_ = im.st.UpdateJob(jobID, models.JobFailed, models.StageQueued, 0, msg)
	im.emitEvent(EventJobDone, JobDoneEvent{JobID: jobID, MatchID: matchID, Status: models.JobFailed, Error: msg})
	im.emitEvent(EventLibraryChanged, LibraryChangedEvent{})
}

// Reprocess queues a re-parse of a match's demo file: spectra's own copy
// when one exists (copy-on-import), else the stored path — rows imported
// without a copy point at the user's original file. The match must exist
// (store.ErrNotFound passes through); a reprocess job is linked to its
// match immediately and skips sha256 dedupe.
//
// Fail fast when NEITHER file exists (copy evicted AND the source gone —
// state "missing"): no job is queued and the row never flips to queued,
// but the reason still lands in "recent import problems" via failNewJob,
// so the Library shows why Re-parse refused.
//
// Coalesce: when a non-terminal job already references the match, that
// job's id comes back untouched — one reparse in flight per match (no
// second job, and no status flip: a running job already moved the row to
// parsing).
//
// The match row flips to "queued" for the wait (visible queued state);
// the row's prior lifecycle state is remembered so a dequeue puts it
// back — see Cancel and the worker's pre-claim skip paths.
func (im *Importer) Reprocess(matchID int64) (int64, error) {
	m, err := im.st.GetMatch(matchID)
	if err != nil {
		return 0, err
	}
	if job, found, err := im.st.FindPendingJobByMatch(matchID); err != nil {
		return 0, err
	} else if found {
		return job.ID, nil
	}
	path := im.resolveDemoFile(m.SHA256, m.Path)
	if _, serr := os.Stat(path); serr != nil {
		// The demo file itself is gone: parse would fail at the job claim's
		// os.Open anyway — this says WHY, in player language, before any
		// queueing or status flip happens. A job row is still created and
		// failed immediately so the Library's problem list carries it.
		msg := fmt.Sprintf("Demo file not found: %s — Spectra's copy was freed. Restore the file, or delete the match.", path)
		jid, jerr := im.st.CreateJob(jobKindReprocess, path)
		if jerr != nil {
			slog.Error("library: create missing-file reprocess job", "path", path, "error", jerr)
			return 0, errors.New(msg)
		}
		_ = im.st.SetJobMatch(jid, matchID) // best-effort: the row still carries the match link
		im.failNewJob(jid, matchID, msg)
		return 0, errors.New(msg)
	}
	id, err := im.st.CreateJob(jobKindReprocess, path)
	if err != nil {
		return 0, err
	}
	if err := im.st.SetJobMatch(id, matchID); err != nil {
		im.failNewJob(id, matchID, playerJobError(models.StageQueued, err.Error()))
		return 0, err
	}
	im.mu.Lock()
	im.pending[matchID] = matchLifecycle{status: m.Status, errMsg: m.Error}
	im.mu.Unlock()
	if err := im.st.SetMatchStatus(matchID, models.StatusQueued, ""); err != nil {
		im.restoreMatch(matchID)
		im.failNewJob(id, matchID, playerJobError(models.StageQueued, err.Error()))
		return 0, err
	}
	if !im.push(queueItem{jobID: id, kind: jobKindReprocess, path: path, matchID: matchID}) {
		im.restoreMatch(matchID)
		im.failNewJob(id, matchID, shuttingDownErr)
		return 0, errShuttingDown
	}
	return id, nil
}

// restoreMatch hands a match row back to the lifecycle state recorded
// before Reprocess queued it. Nothing recorded (an import job's row, or a
// match Reprocess never touched) leaves the row alone. Called on the
// dequeue paths: Cancel of a queued job and the worker's pre-claim skips
// (cancelled / stopping), where the job never got to touch the row
// itself.
func (im *Importer) restoreMatch(matchID int64) {
	if matchID == 0 {
		return
	}
	im.mu.Lock()
	prev, ok := im.pending[matchID]
	delete(im.pending, matchID)
	im.mu.Unlock()
	if ok {
		_ = im.st.SetMatchStatus(matchID, prev.status, prev.errMsg)
	}
}

// Cancel cancels a queued or running job. Running jobs have their context
// cancelled (the parse aborts); queued jobs are skipped when the worker
// reaches them. store.CancelJob decides the terminal transition — unknown
// ids surface store.ErrNotFound, already-terminal jobs are left untouched
// (and get no event). Jobs the worker has already claimed by the time we
// look are treated as running.
//
// Outcomes (the Library's cancel/dequeue state machine):
//   - queued IMPORT: the synthetic row disappears (job → cancelled, shown
//     in "recent import problems"); no match row ever existed, so nothing
//     can be stranded.
//   - running IMPORT/REPROCESS: the parse aborts and the worker's
//     failJob marks the match row failed ("cancelled") — openable, with
//     Reprocess/Delete enabled.
//   - queued REPROCESS: the worker skips it silently, so Cancel announces
//     the terminal state itself AND hands the match row back to the
//     lifecycle state Reprocess queued it from (the job never touched
//     the row).
func (im *Importer) Cancel(jobID int64) error {
	im.mu.Lock()
	running := im.cancels[jobID]
	item, wasQueued := im.queued[jobID]
	if running == nil && wasQueued {
		im.cancelled[jobID] = true
	}
	im.mu.Unlock()
	if running != nil {
		running()
	}
	if err := im.st.CancelJob(jobID); err != nil {
		return err
	}
	if running == nil && wasQueued {
		// Queued: the worker will skip it silently, so announce the
		// terminal state here.
		im.restoreMatch(item.matchID)
		im.emitEvent(EventJobDone, JobDoneEvent{JobID: jobID, Status: models.JobCancelled})
		im.emitEvent(EventLibraryChanged, LibraryChangedEvent{})
	}
	return nil
}

// Shutdown stops the pool: queued jobs are abandoned (store.Open marks
// them interrupted on next launch), every running parse is cancelled
// (the cancel-all loop iterates im.cancels — whatever N jobs hold one),
// and the call blocks until every worker has exited. Safe to call more
// than once.
func (im *Importer) Shutdown() {
	im.once.Do(func() {
		im.mu.Lock()
		im.stopping = true
		for _, cancel := range im.cancels {
			cancel()
		}
		im.cond.Broadcast() // every parked worker re-checks stopping and exits
		im.mu.Unlock()
	})
	im.wg.Wait()
}

// worker is ONE background goroutine of the pool. It parks on im.cond
// until BOTH hold — the queue has a head AND a concurrency slot is free
// (im.running < the limit read for THIS claim) — then pops the head and
// claims it in the SAME critical section. Consequences, all deliberate:
//
//   - Claims stay strictly FIFO no matter how many workers race for a
//     wake (queue[0] pops in enqueue order, the claim lands inside the
//     same mutex hold), while job BODIES run concurrently up to the
//     configured concurrency — the old "job2 queued while job1 runs"
//     behavior is now exactly "job2 queued while every slot is full".
//   - Cancel can only ever observe "queued" (pre-claim) or "running"
//     (post-claim) — never the gap, because there is no gap.
//   - The wait loop re-checks stopping under the mutex Shutdown flips it
//     under, so no worker can park after shutdown began; Shutdown's
//     Broadcast is what frees the parked ones. This replaces the old
//     buffered(1) wake channel: one poke could only ever wake one of N
//     workers, and a slot release must wake the pool to re-check.
//
// A pre-claim skip (cancelled while queued) hands a reprocess's match row
// back (restoreMatch) and moves on without taking a slot; after a job
// body returns, its slot is released and every waiter re-checks.
func (im *Importer) worker() {
	defer im.wg.Done()
	for {
		im.mu.Lock()
		for !im.stopping && (len(im.queue) == 0 || im.running >= im.concurrencyLimit()) {
			im.cond.Wait()
		}
		if im.stopping {
			im.mu.Unlock()
			return
		}
		item := im.queue[0]
		im.queue = im.queue[1:]

		// Claim the job (atomic with the pop — see the doc above). The
		// cancelled map serializes against Cancel(): a job cancelled
		// while queued (or before this claim landed) is skipped without
		// touching its terminal store state; UpdateJob completes under
		// this same lock hold. Every pre-claim exit hands a reprocess's
		// match row back (restoreMatch): the job never touched it, so
		// the artificial queued flip must not outlive the job.
		if im.cancelled[item.jobID] {
			delete(im.cancelled, item.jobID)
			delete(im.queued, item.jobID)
			im.mu.Unlock()
			im.restoreMatch(item.matchID)
			continue
		}
		if err := im.st.UpdateJob(item.jobID, models.JobRunning, models.StageQueued, 0, ""); err != nil {
			delete(im.cancelled, item.jobID)
			delete(im.queued, item.jobID)
			im.mu.Unlock()
			im.restoreMatch(item.matchID)
			continue
		}
		// The job owns the row from here: its own transitions (parsing →
		// ready/failed) replace the queued flip, so drop the remembered state.
		delete(im.pending, item.matchID)
		ctx, cancel := context.WithCancel(context.Background())
		im.cancels[item.jobID] = cancel
		delete(im.queued, item.jobID)
		im.running++
		im.mu.Unlock()

		im.process(item, ctx, cancel)

		im.mu.Lock()
		im.running--
		im.cond.Broadcast() // a slot freed: wake the pool to re-check
		im.mu.Unlock()
	}
}

// push appends to the (unbounded) queue and wakes the pool. It reports
// false when the importer is stopping (Shutdown began): nothing will
// ever claim the item, so the caller fails the job immediately instead of
// leaving it queued forever.
func (im *Importer) push(item queueItem) bool {
	im.mu.Lock()
	if im.stopping {
		im.mu.Unlock()
		return false
	}
	im.queue = append(im.queue, item)
	im.queued[item.jobID] = item
	// Broadcast, not a one-shot poke: every parked worker re-checks — one
	// claims this item, the others re-park (or claim too when the
	// concurrency pref leaves slots free).
	im.cond.Broadcast()
	im.mu.Unlock()
	return true
}

// process runs ONE claimed job end to end — the worker holds a
// concurrency slot for the whole call. Stage machine: queued (emitted at
// entry) → hash → (import only) copy → decompress sniff → parse → store
// → analyze → done, with any error or cancellation collapsing to
// failed/cancelled. Progress is the job-wide mapping documented with
// progressHashEnd — per job: a job's own points are monotone no matter
// which stages of OTHER jobs interleave with them.
//
// ctx/cancel come from the worker's claim (im.cancels holds cancel until
// this returns); the deferred cleanup below releases both on every exit.
func (im *Importer) process(item queueItem, ctx context.Context, cancel context.CancelFunc) {
	jobID, kind := item.jobID, item.kind
	matchID := item.matchID // 0 for import until the match row exists

	defer func() {
		cancel()
		im.mu.Lock()
		delete(im.cancels, jobID)
		im.mu.Unlock()
	}()
	im.emitEvent(EventJobProgress, JobProgressEvent{JobID: jobID, Stage: models.StageQueued, MatchID: matchID})

	// Every progress point below funnels through one reporter: stage
	// transitions straight through, byte ticks throttled (first tick of a
	// stage forced), all clamped monotone — see progressReporter.
	rep := &progressReporter{im: im, jobID: jobID, matchID: matchID}

	// Hash the file as it sits on disk (compressed bytes for .zst) — the
	// first stage with determinate progress (bytes read ÷ file size).
	f, err := os.Open(item.path)
	if err != nil {
		im.failJob(jobID, matchID, models.StageQueued, err.Error(), false)
		return
	}
	defer f.Close()
	var total int64 // file size: the denominator of every byte fraction
	if fi, serr := f.Stat(); serr == nil {
		total = fi.Size()
	}
	rep.emit(models.StageHash, 0)
	hasher := sha256.New()
	size, err := io.Copy(hasher, &countingReader{r: f, onRead: func(consumed int64) {
		if frac, ok := byteFrac(consumed, total); ok {
			rep.tick(models.StageHash, inRange(0, progressHashEnd, frac))
		}
	}})
	if err != nil {
		im.failJob(jobID, matchID, models.StageQueued, err.Error(), false)
		return
	}
	sha := hex.EncodeToString(hasher.Sum(nil))

	// Per-sha admission (shagate.go): with concurrent workers two jobs
	// can hash identical bytes from different paths (or an import can
	// race a reprocess's re-copy of the same content). The whole
	// sha-critical section below — dedupe check → copy-on-import →
	// CreateMatchRow, or the reprocess re-copy — runs one job at a time
	// per hash, so the loser waits and then takes the clean "already
	// imported (match N)" path instead of racing the UNIQUE
	// matches.sha256 insert (a raw constraint error in the jobs list) or
	// the managed-copy rename. Released before the long parse (release()
	// after the branches): only the row-creating section is sha-scoped.
	unlockSHA := im.sha.lock(sha)
	shaHeld := true
	// release ends the sha-critical section; calling it twice is a no-op,
	// so the deferred call below stays correct on every early exit.
	release := func() {
		if shaHeld {
			shaHeld = false
			unlockSHA()
		}
	}
	defer release()

	// The copy-on-import decision for THIS job: read when the job runs,
	// never at Enqueue/Reprocess time, so a Settings toggle applies to
	// jobs already queued (see Options.CopyEnabled).
	copyOn := im.copyOn()

	// Delete-on-fail: a copy THIS job created (createdCopy) survives only
	// once its match row reached SaveExtracted (matchSaved). Any earlier
	// terminal exit — row-create, store, parse or cancel — drops the copy
	// again, so failed imports stop hoarding copies. The sha-unique dedupe
	// above means an import job is the copy's only owner: a copy that
	// already existed (orphan from an older import, or a reprocess reading
	// a pre-existing backup) makes createdCopy false, and is NEVER this
	// job's to delete — a failed reprocess can therefore never delete a
	// backup it did not make. Analytics failure is past SaveExtracted:
	// the match stays ready and the copy is kept.
	createdCopy := false
	matchSaved := false
	defer func() {
		if createdCopy && !matchSaved {
			_, _ = im.RemoveManagedDemo(sha)
		}
	}()

	if kind == jobKindImport {
		existing, found, err := im.st.GetMatchBySHA(sha)
		if err != nil {
			im.failJob(jobID, 0, models.StageQueued, err.Error(), false)
			return
		}
		if found {
			msg := fmt.Sprintf("already imported (match %d)", existing)
			_ = im.st.UpdateJob(jobID, models.JobFailed, models.StageQueued, 0, msg)
			im.emitEvent(EventJobDone, JobDoneEvent{JobID: jobID, MatchID: existing, Status: models.JobFailed, Error: msg})
			im.emitEvent(EventLibraryChanged, LibraryChangedEvent{})
			return
		}
		// Copy-on-import (the default; skipped when the copy_on_import
		// pref is off): the raw demo lands in the managed dir before any
		// row exists, so a failed copy never leaves a match that cannot
		// be reprocessed later. matches.path keeps the SOURCE path (the
		// file the user handed us — searchable, and what DeleteMatch
		// refuses to touch); the managed copy is found by content hash
		// instead. Bytes written ÷ file size drives the copy stage (a
		// reused copy returns without reading, so the stage just passes
		// through). With the pref off no copy is made and StageCopy is
		// never emitted — hash (≤0.10) → decompress (0.20) stays
		// monotone without the stage in between.
		if copyOn {
			hadCopy := im.ManagedDemoPath(sha) != ""
			rep.emit(models.StageCopy, progressCopyStart)
			if _, cerr := im.copyDemo(item.path, sha, func(consumed int64) {
				if frac, ok := byteFrac(consumed, total); ok {
					rep.tick(models.StageCopy, inRange(progressCopyStart, progressCopyEnd, frac))
				}
			}); cerr != nil {
				im.failJob(jobID, 0, models.StageQueued, cerr.Error(), false)
				return
			}
			createdCopy = !hadCopy
		}
		// With copy_on_import off: no copyDemo call ran above, no .info
		// companion is copied either — chat was already decrypted at
		// import (voice_presence.key_found, the key read off the SOURCE's
		// companion in netKeyFromInfoFile), and any later reprocess reads
		// the companion beside the stored path (infoCompanionCandidates).
		// Row content is identical either way: path = source, sha, size.
		matchID, err = im.st.CreateMatchRow(item.path, sha, size)
		if err != nil {
			im.failJob(jobID, 0, models.StageQueued, err.Error(), false)
			return
		}
		if err := im.st.SetJobMatch(jobID, matchID); err != nil {
			im.failJob(jobID, matchID, models.StageQueued, err.Error(), false)
			return
		}
	} else if copyOn && im.ManagedDemoPath(sha) == "" {
		// Reprocess RE-COPY: the match has no managed copy (a skip-copied
		// import whose source now points elsewhere, or an evicted one the
		// user restored) and the pref is back on — make the backup this
		// parse needs. The branch condition (no copy exists) is what makes
		// createdCopy honest: a reprocess reading a pre-existing backup
		// never enters here, so its failure can't delete the copy that
		// kept the match alive.
		rep.emit(models.StageCopy, progressCopyStart)
		if _, cerr := im.copyDemo(item.path, sha, func(consumed int64) {
			if frac, ok := byteFrac(consumed, total); ok {
				rep.tick(models.StageCopy, inRange(progressCopyStart, progressCopyEnd, frac))
			}
		}); cerr != nil {
			im.failJob(jobID, matchID, models.StageQueued, cerr.Error(), false)
			return
		}
		createdCopy = true
	}

	// Row create / re-copy done: this job either owns its match row or
	// bailed out above — the sha-critical section ends here, before the
	// long parse (the deferred release above becomes a no-op).
	release()

	if err := im.st.SetMatchStatus(matchID, models.StatusParsing, ""); err != nil {
		im.failJob(jobID, matchID, models.StageQueued, err.Error(), false)
		return
	}
	im.emitEvent(EventLibraryChanged, LibraryChangedEvent{})

	// Sniff the zstd magic and wrap the stream; extract.Parse always sees
	// a raw .dem reader. The hash pass left f at EOF — rewind BEFORE the
	// sniff, and rewind again after it so the raw path also starts at 0.
	// The stage entry carries the parse range's START (0.20): the byte
	// counter below runs over the FILE stream (compressed bytes for a
	// .zst), so decompress+parse are one continuum up to 0.90.
	rep.emit(models.StageDecompress, progressParseStart)
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		im.failJob(jobID, matchID, models.StageDecompress, err.Error(), ctx.Err() != nil)
		return
	}
	var magic [4]byte
	n, _ := io.ReadFull(f, magic[:]) // short files just aren't zstd
	isZstd := n == len(zstdMagic) && bytes.Equal(magic[:], zstdMagic)
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		im.failJob(jobID, matchID, models.StageDecompress, err.Error(), ctx.Err() != nil)
		return
	}
	// Wrap BEFORE the decoder: zstd pulls compressed bytes through this
	// reader as it decompresses, the raw path pulls them directly — either
	// way consumed ÷ total tracks how far the parse has read.
	var reader io.Reader = &countingReader{r: f, onRead: func(consumed int64) {
		if frac, ok := byteFrac(consumed, total); ok {
			rep.tick(models.StageParse, inRange(progressParseStart, progressParseEnd, frac))
		}
	}}
	if isZstd {
		dec, err := zstd.NewReader(reader)
		if err != nil {
			im.failJob(jobID, matchID, models.StageDecompress, err.Error(), false)
			return
		}
		defer dec.Close()
		reader = dec
	}

	rep.emit(models.StageParse, progressParseStart)

	// Position sidecar: sampled frames stream into a per-match
	// directory while the parse runs. Tick rate is unknown until the parse
	// returns, so Close receives it afterwards; any failure from here on
	// removes the half-written sidecar (a failed match never serves stale
	// or partial frames). The sparse player-state stream (state.bin/idx)
	// is written by the same Writer — created lazily on the first state
	// sample, removed with the directory on failure, and never migrated:
	// matches imported before it simply lack the files (readers fail
	// soft; Reprocess re-parses to gain them).
	//
	// Voice sidecar mirrors the positions lifecycle exactly: wiped +
	// created before the parse, payloads stream into per-player .opus
	// files via the extract.VoiceSink, and the per-player .idx chunk
	// index is written when the writer closes (right below, BEFORE the
	// match row is saved — sidecar-first ordering, see the Close call).
	sidecarPath := filepath.Join(im.sidecarDir, strconv.FormatInt(matchID, 10))
	sw, werr := sidecar.NewWriter(sidecarPath, 0)
	if werr != nil {
		im.failJob(jobID, matchID, models.StageParse, werr.Error(), false)
		return
	}
	cleanupSidecar := func() { _ = os.RemoveAll(sidecarPath) }

	if err := os.RemoveAll(filepath.Join(sidecarPath, sidecar.VoiceDirName)); err != nil {
		cleanupSidecar()
		im.failJob(jobID, matchID, models.StageParse, err.Error(), false)
		return
	}
	vw, verr := sidecar.NewVoiceWriter(sidecarPath)
	if verr != nil {
		cleanupSidecar()
		im.failJob(jobID, matchID, models.StageParse, verr.Error(), false)
		return
	}
	// Release the per-player file handles on any early-exit path; the
	// success path Close below wins (a second Close is a harmless error).
	defer func() { _, _, _ = vw.Close() }()

	// Chat decryption key: a <demo>.info companion next to the
	// demo supplies the GC key for svc_EncryptedData. Discovery/extraction
	// failures never fail the import — the demo simply imports without
	// decryption (KeyFound=false on the voice_presence row).
	netKey := netKeyFromInfoFile(item.path)

	em, err := im.parse(ctx, reader, extract.ParseOptions{
		// Frames carry no determinate point mid-parse: a Source 2 demo
		// only reveals its frame total at the very end (see
		// extract.ParseOptions.Progress), so bytes read drive the bar.
		// The callback's calls with a known total (the final call) pin the
		// top of the parse range — that is all frames are used for.
		Progress: func(framesDone, framesTotal int) {
			if framesTotal > 0 {
				rep.emit(models.StageParse, progressParseEnd)
			}
		},
		Positions: sw,
		// State stream rides the same Writer: it reuses the position
		// stream's slot table and shares its lifecycle (cleanupSidecar
		// removes state.bin/idx with the rest on any failure below).
		State:  sw,
		Voice:  vw,
		NetKey: netKey,
	})
	if err != nil {
		cleanupSidecar()
		cancelled := ctx.Err() != nil
		msg := err.Error()
		if cancelled {
			msg = "cancelled"
		}
		im.failJob(jobID, matchID, models.StageParse, msg, cancelled)
		return
	}
	// A parser that ignores cancellation must not overwrite the terminal
	// state a concurrent Cancel() already wrote.
	if err := ctx.Err(); err != nil {
		cleanupSidecar()
		im.failJob(jobID, matchID, models.StageParse, "cancelled", true)
		return
	}

	meta, err := sw.Close(em.Match.TickRate)
	if err != nil {
		cleanupSidecar()
		im.failJob(jobID, matchID, models.StageStore, err.Error(), false)
		return
	}

	// Voice index closes BEFORE the match row is saved — sidecar-first
	// ordering: ready implies voice/*.idx exists (strictly better than the
	// old insert-after-save, which could leave ready with zero voice). The
	// rows are serialized to the per-player .idx files right here; only the
	// presence header still needs the store, after SaveExtracted.
	voiceMeta, _, cerr := vw.Close()
	if cerr != nil {
		cleanupSidecar()
		im.failJob(jobID, matchID, models.StageStore, cerr.Error(), false)
		return
	}

	em.Match.ParserVersion = im.parserVersion
	rep.emit(models.StageStore, progressStore)
	// Mirror the sidecar meta onto the match row, then save. SaveExtracted
	// forces match status ready itself — don't double-set.
	if err := im.st.SetPositionMeta(matchID, meta.SampleRate, meta.Frames); err != nil {
		cleanupSidecar()
		im.failJob(jobID, matchID, models.StageStore, err.Error(), false)
		return
	}
	if err := im.st.SaveExtracted(matchID, em); err != nil {
		cleanupSidecar()
		im.failJob(jobID, matchID, models.StageStore, err.Error(), false)
		return
	}
	// The match row has landed: from here on the copy belongs to the
	// saved match, not to this job (the deferred delete-on-fail above
	// stops applying — including to the store/analyze failures below).
	matchSaved = true

	// Voice presence header: the chunk index is already on disk (vw.Close
	// above, before the save), so this writes one row of provenance counts.
	// SaveExtracted just cleared any stale row through childTables, so the
	// delete-then-insert shape would delete nothing — a single INSERT is
	// the whole write.
	if err := im.st.SaveVoicePresence(matchID, models.VoicePresenceRow{
		ChunkCount:    voiceMeta.Chunks,
		PlayerCount:   voiceMeta.Players,
		CasterCount:   voiceMeta.Casters,
		KeyFound:      netKey != nil,
		OutSampleRate: models.VoiceOutSampleRate,
	}); err != nil {
		cleanupSidecar()
		im.failJob(jobID, matchID, models.StageStore, err.Error(), false)
		return
	}

	// M3 analytics pass: classification/KAST/clutch/engagement/
	// utility rows + career rebuild over the stored events. Failure
	// here must NOT lose the extracted data: the match stays ready and only
	// the job is marked failed (with the analytics error prefixed).
	rep.emit(models.StageAnalyze, progressAnalyze)
	if aerr := im.analyze(matchID); aerr != nil {
		msg := playerJobError(models.StageAnalyze, aerr.Error())
		_ = im.st.UpdateJob(jobID, models.JobFailed, models.StageAnalyze, progressAnalyze, msg)
		im.emitEvent(EventJobDone, JobDoneEvent{JobID: jobID, MatchID: matchID, Status: models.JobFailed, Error: msg})
		im.emitEvent(EventLibraryChanged, LibraryChangedEvent{})
		return
	}

	_ = im.st.UpdateJob(jobID, models.JobDone, models.StageDone, 1, "")
	im.emitEvent(EventJobDone, JobDoneEvent{JobID: jobID, MatchID: matchID, Status: models.JobDone})
	im.emitEvent(EventLibraryChanged, LibraryChangedEvent{})
}

// analyze runs analytics.Compute for one match under the stored config,
// holding the compute lock for the WHOLE pass: Compute ends in
// store.RebuildCareer, a read-modify-write over every match's
// player_stats, so two overlapping Computes — this importer's N
// concurrent jobs, or an import racing AnalyticsService's background
// recompute — could commit a career rollup built from a pre-recompute
// snapshot. Main wires ONE lock into both sides (library.Options and
// AnalyticsService.computeLock); without that wiring the nil-option
// private lock still serializes this importer's own Computes.
func (im *Importer) analyze(matchID int64) error {
	cfg, err := im.st.GetConfig()
	if err != nil {
		return err
	}
	im.computeLock.Lock()
	defer im.computeLock.Unlock()
	return analytics.Compute(im.st, matchID, analytics.ConfigFrom(cfg, 0))
}

// jobErrPrefixes are the package/context prefixes pipeline errors wrap
// themselves in ("store: create match row: …", "extract: parse failed:
// demoinfocs: …"). They are developer vocabulary — dropped at the
// failJob boundary so "Recent import problems" and the chip titles read
// as player language. Known context segments (parse failed, the sink
// names, copy demo) go too; the loop peels nested prefixes.
var jobErrPrefixes = []string{
	"store: ", "extract: ", "analytics: ", "sidecar: ", "library: ",
	"demoinfocs: ", "zstd: ", "copy demo: ",
	"parse failed: ", "parse cancelled: ",
	"voice sink: ", "position sink: ", "state sink: ",
}

// playerJobError frames a raw pipeline error for jobs.error and the
// match's error text: the message is wrapped in what failed for the
// player — reading the file, saving the import, or the analysis pass —
// with the package prefixes stripped. Already-friendly strings
// ("cancelled", "already imported (match N)", "unsupported file type
// …", "importer is shutting down") never reach here or pass through
// unchanged; a cancellation must stay cancellable-looking.
func playerJobError(stage, msg string) string {
	if msg == "" || msg == "cancelled" {
		return msg
	}
	var frame string
	switch {
	case stage == models.StageAnalyze || strings.HasPrefix(msg, "analytics: "):
		frame = "Analysis failed: "
	case stage == models.StageStore ||
		strings.HasPrefix(msg, "store: ") ||
		strings.HasPrefix(msg, "copy demo: ") ||
		strings.HasPrefix(msg, "sidecar: "):
		frame = "Couldn't save the import: "
	default:
		frame = "Couldn't read this file: "
	}
	for {
		changed := false
		for _, p := range jobErrPrefixes {
			if strings.HasPrefix(msg, p) {
				msg = strings.TrimPrefix(msg, p)
				changed = true
			}
		}
		if !changed {
			break
		}
	}
	return frame + msg
}

// failJob records a terminal failure for jobID. When the job had a match
// row (matchID != 0) the match is marked failed with the same message —
// including reprocess failures: any pre-existing extracted rows may remain,
// but the status/error tell the truth. A context cancellation is reported
// as job status cancelled and match error "cancelled". The message is
// framed as player language here — the ONE boundary for job errors.
func (im *Importer) failJob(jobID, matchID int64, stage, errMsg string, cancelled bool) {
	errMsg = playerJobError(stage, errMsg)
	status := models.JobFailed
	if cancelled {
		status = models.JobCancelled
	}
	_ = im.st.UpdateJob(jobID, status, stage, 0, errMsg)
	if matchID != 0 {
		_ = im.st.SetMatchStatus(matchID, models.StatusFailed, errMsg)
	}
	im.emitEvent(EventJobDone, JobDoneEvent{JobID: jobID, MatchID: matchID, Status: status, Error: errMsg})
	im.emitEvent(EventLibraryChanged, LibraryChangedEvent{})
}

// emitEvent forwards to the injected Emit hook (nil-safe).
func (im *Importer) emitEvent(name string, data any) {
	if im.emit != nil {
		im.emit(name, data)
	}
}

// isDemoFilename reports whether a file NAME is an importable demo:
// .dem or .dem.zst, case-insensitive. The one extension rule — both
// validateImportPath (dialog/drop/typed paths) and the import-dir
// scanner apply it.
func isDemoFilename(name string) bool {
	lower := strings.ToLower(name)
	return strings.HasSuffix(lower, ".dem") || strings.HasSuffix(lower, ".dem.zst")
}

// validateImportPath returns a user-facing reason the path cannot be
// imported, or "" when it looks importable. Existence only — no hashing.
func validateImportPath(path string) string {
	if !isDemoFilename(filepath.Base(path)) {
		return "unsupported file type (expected .dem or .dem.zst)"
	}
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Sprintf("cannot access file: %v", err)
	}
	if info.IsDir() {
		return "not a file"
	}
	return ""
}

// infoCompanionCandidates returns the <demo>.info candidate paths in
// discovery order: the classic Valve match730 naming sits
// next to the demo with the .dem suffix replaced by .info; the other two
// candidates cover companions named after the full demo filename.
func infoCompanionCandidates(path string) []string {
	return []string{
		strings.TrimSuffix(path, ".dem.zst") + ".info",
		strings.TrimSuffix(path, ".dem") + ".info",
		path + ".info",
	}
}

// findInfoFile returns the first existing non-directory companion
// <demo>.info candidate, or "" when none exists.
func findInfoFile(path string) string {
	for _, c := range infoCompanionCandidates(path) {
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			return c
		}
	}
	return ""
}

// netKeyFromInfoFile discovers and extracts the chat decryption key from a
// <demo>.info companion. Missing/unreadable/unparseable
// companions never fail the import — they log and return nil (the demo
// imports without decryption; presence.key_found records the miss).
func netKeyFromInfoFile(path string) []byte {
	infoPath := findInfoFile(path)
	if infoPath == "" {
		return nil
	}
	raw, err := os.ReadFile(infoPath) //nolint:gosec // path is the user-selected demo's sibling companion
	if err != nil {
		slog.Warn("library: read .info companion", "path", infoPath, "error", err)
		return nil
	}
	key, err := demoinfocs.MatchInfoDecryptionKey(raw)
	if err != nil {
		slog.Warn("library: extract chat decryption key", "path", infoPath, "error", err)
		return nil
	}
	return key
}
