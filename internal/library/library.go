// Package library is the presentation-free import pipeline: a single-worker
// job queue that hashes, dedupes (sha256), decompresses (.dem.zst, streamed
// — never to a temp file) and parses demos via internal/extract, persisting
// through internal/store. Progress and terminal transitions are announced as
// Wails events (spectra:job-progress / spectra:job-done /
// spectra:library-changed) through an injected Emit hook; originals are
// never written.
package library

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/klauspost/compress/zstd"

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
)

// progressMinInterval throttles parse-progress updates to at most one per
// 100 ms. Stage transitions are emitted separately and never throttled.
const progressMinInterval = 100 * time.Millisecond

// zstdMagic is the 4-byte zstd frame magic number (RFC 8878): 28 b5 2f fd.
var zstdMagic = []byte{0x28, 0xb5, 0x2f, 0xfd}

// JobProgressEvent is the payload of spectra:job-progress.
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
// defaulting to data.MatchesDir() when empty (tests point it at a temp
// dir so they never touch the user's real data).
type Options struct {
	Store         *store.Store
	Parse         func(ctx context.Context, r io.Reader, opts extract.ParseOptions) (*models.ExtractedMatch, error)
	Emit          func(event string, data any)
	ParserVersion string
	SidecarDir    string
}

// queueItem is one unit of work for the worker.
type queueItem struct {
	jobID   int64
	kind    string
	path    string
	matchID int64 // reprocess only; 0 for import
}

// Importer owns the single background worker goroutine plus the per-job
// cancellation contexts. Create with New; call Shutdown before closing the
// store.
type Importer struct {
	st            *store.Store
	parse         func(ctx context.Context, r io.Reader, opts extract.ParseOptions) (*models.ExtractedMatch, error)
	emit          func(event string, data any)
	parserVersion string
	sidecarDir    string

	mu        sync.Mutex
	queue     []queueItem
	queued    map[int64]bool // jobs sitting in queue (for Cancel)
	cancels   map[int64]context.CancelFunc
	cancelled map[int64]bool // Cancel() seen but not yet consumed by the worker
	stopping  bool           // Shutdown started: claims are refused
	wake      chan struct{}
	done      chan struct{}
	once      sync.Once
	wg        sync.WaitGroup
}

// New creates an Importer and starts its single worker goroutine.
func New(o Options) *Importer {
	sidecarDir := o.SidecarDir
	if sidecarDir == "" {
		sidecarDir = data.MatchesDir()
	}
	im := &Importer{
		st:            o.Store,
		parse:         o.Parse,
		emit:          o.Emit,
		parserVersion: o.ParserVersion,
		sidecarDir:    sidecarDir,
		queued:        map[int64]bool{},
		cancels:       map[int64]context.CancelFunc{},
		cancelled:     map[int64]bool{},
		wake:          make(chan struct{}, 1),
		done:          make(chan struct{}),
	}
	im.wg.Add(1)
	go im.worker()
	return im
}

// Enqueue creates one import job per path and returns the job IDs in
// argument order. Paths with an unsupported extension or that cannot be
// stat'ed get a job that is failed immediately (with the reason in
// jobs.error) so the UI can surface it; no hashing happens here — the
// response stays fast regardless of file size.
func (im *Importer) Enqueue(paths []string) []int64 {
	ids := make([]int64, 0, len(paths))
	for _, p := range paths {
		id, err := im.st.CreateJob(jobKindImport, p)
		if err != nil {
			slog.Error("library: create import job", "path", p, "error", err)
			continue
		}
		ids = append(ids, id)
		if msg := validateImportPath(p); msg != "" {
			_ = im.st.UpdateJob(id, models.JobFailed, models.StageQueued, 0, msg)
			im.emitEvent(EventJobDone, JobDoneEvent{JobID: id, Status: models.JobFailed, Error: msg})
			im.emitEvent(EventLibraryChanged, LibraryChangedEvent{})
			continue
		}
		im.push(queueItem{jobID: id, kind: jobKindImport, path: p})
	}
	return ids
}

// Reprocess queues a re-parse of an existing match's original file. The
// match must exist (store.ErrNotFound passes through); a reprocess job is
// linked to its match immediately and skips sha256 dedupe.
func (im *Importer) Reprocess(matchID int64) (int64, error) {
	m, err := im.st.GetMatch(matchID)
	if err != nil {
		return 0, err
	}
	id, err := im.st.CreateJob(jobKindReprocess, m.Path)
	if err != nil {
		return 0, err
	}
	if err := im.st.SetJobMatch(id, matchID); err != nil {
		return 0, err
	}
	im.push(queueItem{jobID: id, kind: jobKindReprocess, path: m.Path, matchID: matchID})
	return id, nil
}

// Cancel cancels a queued or running job. Running jobs have their context
// cancelled (the parse aborts); queued jobs are skipped when the worker
// reaches them. store.CancelJob decides the terminal transition — unknown
// ids surface store.ErrNotFound, already-terminal jobs are left untouched
// (and get no event). Jobs the worker has already claimed by the time we
// look are treated as running.
func (im *Importer) Cancel(jobID int64) error {
	im.mu.Lock()
	running := im.cancels[jobID]
	wasQueued := im.queued[jobID]
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
		im.emitEvent(EventJobDone, JobDoneEvent{JobID: jobID, Status: models.JobCancelled})
		im.emitEvent(EventLibraryChanged, LibraryChangedEvent{})
	}
	return nil
}

// Shutdown stops the worker: queued jobs are abandoned (store.Open marks
// them interrupted on next launch), a running parse is cancelled, and the
// call blocks until the worker has exited. Safe to call more than once.
func (im *Importer) Shutdown() {
	im.once.Do(func() {
		im.mu.Lock()
		im.stopping = true
		close(im.done)
		for _, cancel := range im.cancels {
			cancel()
		}
		im.mu.Unlock()
	})
	im.wg.Wait()
}

// worker is the single background goroutine draining the queue.
func (im *Importer) worker() {
	defer im.wg.Done()
	for {
		select {
		case <-im.done:
			return
		default:
		}
		im.mu.Lock()
		if len(im.queue) > 0 {
			item := im.queue[0]
			im.queue = im.queue[1:]
			im.mu.Unlock()
			im.process(item)
			continue
		}
		im.mu.Unlock()
		select {
		case <-im.wake:
		case <-im.done:
			return
		}
	}
}

// push appends to the (unbounded) queue and pokes the worker.
func (im *Importer) push(item queueItem) {
	im.mu.Lock()
	if im.stopping {
		im.mu.Unlock()
		return
	}
	im.queue = append(im.queue, item)
	im.queued[item.jobID] = true
	im.mu.Unlock()
	select {
	case im.wake <- struct{}{}:
	default:
	}
}

// process runs one job end to end. Stage machine:
// queued → (decompress sniff) → parse → store → done, with any error or
// cancellation collapsing to failed/cancelled.
func (im *Importer) process(item queueItem) {
	jobID, kind := item.jobID, item.kind
	matchID := item.matchID // 0 for import until the match row exists

	// Claim the job. The cancelled map serializes against Cancel(): a job
	// cancelled while queued (or between pop and claim) is skipped without
	// touching its terminal store state. Claiming completes under the
	// same lock hold, so Cancel can only ever observe "queued" (pre-claim)
	// or "running" (post-claim) — never the gap. stopping refuses new
	// work once Shutdown begins.
	im.mu.Lock()
	if im.stopping {
		delete(im.queued, jobID)
		im.mu.Unlock()
		return
	}
	if im.cancelled[jobID] {
		delete(im.cancelled, jobID)
		delete(im.queued, jobID)
		im.mu.Unlock()
		return
	}
	if err := im.st.UpdateJob(jobID, models.JobRunning, models.StageQueued, 0, ""); err != nil {
		delete(im.cancelled, jobID)
		delete(im.queued, jobID)
		im.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	im.cancels[jobID] = cancel
	delete(im.queued, jobID)
	im.mu.Unlock()
	defer func() {
		cancel()
		im.mu.Lock()
		delete(im.cancels, jobID)
		im.mu.Unlock()
	}()
	im.emitEvent(EventJobProgress, JobProgressEvent{JobID: jobID, Stage: models.StageQueued, MatchID: matchID})

	// Hash the file as it sits on disk (compressed bytes for .zst).
	f, err := os.Open(item.path)
	if err != nil {
		im.failJob(jobID, matchID, models.StageQueued, err.Error(), false)
		return
	}
	defer f.Close()
	hasher := sha256.New()
	size, err := io.Copy(hasher, f)
	if err != nil {
		im.failJob(jobID, matchID, models.StageQueued, err.Error(), false)
		return
	}
	sha := hex.EncodeToString(hasher.Sum(nil))

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
		matchID, err = im.st.CreateMatchRow(item.path, sha, size)
		if err != nil {
			im.failJob(jobID, 0, models.StageQueued, err.Error(), false)
			return
		}
		if err := im.st.SetJobMatch(jobID, matchID); err != nil {
			im.failJob(jobID, matchID, models.StageQueued, err.Error(), false)
			return
		}
	}

	if err := im.st.SetMatchStatus(matchID, models.StatusParsing, ""); err != nil {
		im.failJob(jobID, matchID, models.StageQueued, err.Error(), false)
		return
	}
	im.emitEvent(EventLibraryChanged, LibraryChangedEvent{})

	// Sniff the zstd magic and wrap the stream; extract.Parse always sees
	// a raw .dem reader. The hash pass left f at EOF — rewind BEFORE the
	// sniff, and rewind again after it so the raw path also starts at 0.
	im.emitEvent(EventJobProgress, JobProgressEvent{JobID: jobID, Stage: models.StageDecompress, MatchID: matchID})
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
	var reader io.Reader = f
	if isZstd {
		dec, err := zstd.NewReader(f)
		if err != nil {
			im.failJob(jobID, matchID, models.StageDecompress, err.Error(), false)
			return
		}
		defer dec.Close()
		reader = dec
	}

	im.emitEvent(EventJobProgress, JobProgressEvent{JobID: jobID, Stage: models.StageParse, MatchID: matchID})

	// Position sidecar (plan M2 §5): sampled frames stream into a per-match
	// directory while the parse runs. Tick rate is unknown until the parse
	// returns, so Close receives it afterwards; any failure from here on
	// removes the half-written sidecar (a failed match never serves stale
	// or partial frames).
	sidecarPath := filepath.Join(im.sidecarDir, strconv.FormatInt(matchID, 10))
	sw, werr := sidecar.NewWriter(sidecarPath, 0)
	if werr != nil {
		im.failJob(jobID, matchID, models.StageParse, werr.Error(), false)
		return
	}
	cleanupSidecar := func() { _ = os.RemoveAll(sidecarPath) }

	var lastProgress atomic.Int64
	lastProgress.Store(time.Now().UnixNano())
	em, err := im.parse(ctx, reader, extract.ParseOptions{
		Progress: func(done, total int) {
			now := time.Now().UnixNano()
			prev := lastProgress.Load()
			if now-prev < int64(progressMinInterval) {
				return
			}
			if !lastProgress.CompareAndSwap(prev, now) {
				return
			}
			var pct float64
			if total > 0 {
				pct = float64(done) / float64(total)
			}
			_ = im.st.UpdateJob(jobID, models.JobRunning, models.StageParse, pct, "")
			im.emitEvent(EventJobProgress, JobProgressEvent{JobID: jobID, Stage: models.StageParse, Progress: pct, MatchID: matchID})
		},
		Positions: sw,
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

	em.Match.ParserVersion = im.parserVersion
	im.emitEvent(EventJobProgress, JobProgressEvent{JobID: jobID, Stage: models.StageStore, Progress: 1, MatchID: matchID})
	// Mirror the sidecar meta onto the match row, then save. SaveExtracted
	// forces match status ready itself — don't double-set.
	if err := im.st.SetPositionMeta(matchID, meta.FormatVersion, meta.SampleRate, meta.Frames); err != nil {
		cleanupSidecar()
		im.failJob(jobID, matchID, models.StageStore, err.Error(), false)
		return
	}
	if err := im.st.SaveExtracted(matchID, em); err != nil {
		cleanupSidecar()
		im.failJob(jobID, matchID, models.StageStore, err.Error(), false)
		return
	}
	_ = im.st.UpdateJob(jobID, models.JobDone, models.StageDone, 1, "")
	im.emitEvent(EventJobDone, JobDoneEvent{JobID: jobID, MatchID: matchID, Status: models.JobDone})
	im.emitEvent(EventLibraryChanged, LibraryChangedEvent{})
}

// failJob records a terminal failure for jobID. When the job had a match
// row (matchID != 0) the match is marked failed with the same message —
// including reprocess failures: any pre-existing extracted rows may remain,
// but the status/error tell the truth. A context cancellation is reported
// as job status cancelled and match error "cancelled".
func (im *Importer) failJob(jobID, matchID int64, stage, errMsg string, cancelled bool) {
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

// validateImportPath returns a user-facing reason the path cannot be
// imported, or "" when it looks importable. Existence only — no hashing.
func validateImportPath(path string) string {
	lower := strings.ToLower(path)
	if !strings.HasSuffix(lower, ".dem") && !strings.HasSuffix(lower, ".dem.zst") {
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
