package library

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/ChristianWSmith/spectra/internal/data"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// Demo discovery for the Library's "demos from your import dirs" list:
// walk the user's configured roots for .dem / .dem.zst files, drop the
// ones already in the library (the list only carries rows the user can
// still act on), and keep the walk bounded (see the limits below). The
// walk itself only stats; files are hashed to recognise imports that
// arrived under a different path, behind a per-(path,size, mtime) cache
// so a repeat scan is stat-only.

// Scan limits — the "bounded and cheap" contract of the import-dirs
// list. Everything below is per Scan call.
const (
	// scanMaxDepth is how deep below a root the walk descends (a file
	// directly in the root is depth 0). CS2's replays folder is one level
	// and Downloads is flat in practice; four covers organized folders
	// without ever walking a whole Steam library or home directory.
	scanMaxDepth = 4
	// scanMaxFiles caps how many demos one scan collects (already-imported
	// files are skipped while walking, so the cap counts listable rows).
	scanMaxFiles = 500
	// scanMaxNewHashes / scanMaxNewHashBytes cap the bytes one scan may
	// hash that its cache has not seen (demos are hundreds of MB). Files
	// past the budget are still listed — just with Hashed=false, meaning
	// their import state is unknown until a later scan hashes them;
	// importing them is always safe, the pipeline's sha256 dedupe decides.
	scanMaxNewHashes          = 64
	scanMaxNewHashBytes int64 = 2 << 30 // 2 GiB
	// hashCacheMax bounds the per-path hash cache (FIFO eviction).
	hashCacheMax = 4096
)

// DemoFile is one file found under a configured root that is not (as far
// as this scan could tell) already in the library — files recognised as
// imported are omitted from Scan's result entirely, so the list only ever
// carries rows the user can still act on. Hashed reports whether the
// file's sha256 was checked against the library this scan; when false the
// row is listed unverified (it may still turn out to be a duplicate,
// which the import pipeline's sha256 dedupe catches on import).
type DemoFile struct {
	Path    string    `json:"path"`
	Root    string    `json:"root"` // configured dir the file was found under
	Size    int64     `json:"size"`
	ModTime time.Time `json:"modTime"`
	Hashed  bool      `json:"hashed"`
	// Pending marks a file the job queue is already working on (its
	// import is queued/running and no match row exists yet — which is
	// exactly why it is still listed): the Library flips the chip and
	// disables Import for it. The state comes from the ONE pending-job
	// lookup (store.FindPendingJobByPath) — the recognition rules above
	// are untouched; Enqueue dedupes by path regardless, this is the
	// visible half of that contract.
	Pending bool `json:"pending"`
}

// ScannerOptions configures a Scanner. Store is the match index (import
// recognition); DataRoot is the app's own data directory, which is never
// scanned (spectra's managed copies are not the user's demos — default
// data.RootDir() when empty); Emit receives the scan's progress event name
// + payload (see EventScanProgress) and may be nil (tests, headless runs).
type ScannerOptions struct {
	Store    *store.Store
	DataRoot string
	Emit     func(event string, data any)
}

// Scanner owns the hash cache behind Scan. Create with NewScanner; one
// instance serves the app (the cache is process-wide state). Scan
// serializes against itself, so concurrent service calls cannot interleave
// a cache write.
type Scanner struct {
	st       *store.Store
	dataRoot string
	emit     func(event string, data any)

	mu     sync.Mutex
	hashes map[string]hashEntry
	order  []string // FIFO eviction order over hashes' keys
}

type hashEntry struct {
	size  int64
	mtime time.Time
	sha   string
}

// NewScanner creates a Scanner (see ScannerOptions).
func NewScanner(o ScannerOptions) *Scanner {
	root := o.DataRoot
	if root == "" {
		root = data.RootDir()
	}
	return &Scanner{
		st:       o.Store,
		dataRoot: root,
		emit:     o.Emit,
		hashes:   map[string]hashEntry{},
	}
}

// Scan phases — ScanProgressEvent.Stage. The split is the honesty rule:
// the walk has no denominator, the hash pass does.
const (
	// scanStageWalk is the stat-only directory walk (plus the import
	// recognition it feeds): the number of files is unknown until the walk
	// is over, so its progress is always 0 = indeterminate — never a
	// fabricated percentage.
	scanStageWalk = "walk"
	// scanStageHash is sha256 over the files this scan has never seen:
	// bytes read ÷ the bytes it will hash (measured up front from the file
	// sizes), a real 0..1 fraction.
	scanStageHash = "hash"
)

// ScanProgressEvent is the payload of spectra:scan-progress — one
// import-dir scan's progress, announced while the binding call runs.
// Deliberately NOT spectra:job-progress: that payload keys a jobId into
// the frontend's job store (services.js jobProgress map) and a colliding
// id there would corrupt it — a scan is not a job, has no jobId, and
// NEVER writes a row into the jobs table (see mappackservice.go's
// equivalent note for spectra:asset-progress). Stage is scanStageWalk
// (Progress 0 = indeterminate) or scanStageHash (a real byte fraction;
// Done/Total are that phase's hashed/total bytes). The frontend renders it
// through StatusChip only — no second progress widget.
type ScanProgressEvent struct {
	Stage    string  `json:"stage"`
	Progress float64 `json:"progress"`
	Done     int64   `json:"done"`
	Total    int64   `json:"total"`
}

// scanProgress serializes ONE scan's progress events, mirroring the job
// reporter's split (progressReporter.emit/tick in library.go): entry
// announces a phase transition and is never throttled; tick announces a
// byte-derived point and is throttled to progressMinInterval, with the
// FIRST tick of each phase forced through (the same cadence and rule the
// import pipeline's bar uses — the throttle kit lives there; this copy
// holds no job state, so it cannot reuse that reporter without dragging
// the jobs table into a scan). scanProgress is a Scan-local value guarded
// by the scanner mutex Scan already holds — no lock of its own.
type scanProgress struct {
	emit      func(event string, data any)
	tickStage string // stage a byte tick was last emitted for
	lastNano  int64
	lastPct   float64 // monotone clamp: the bar never walks backwards
}

// entry announces a phase (walk / hash) at frac — unthrottled.
func (p *scanProgress) entry(stage string, frac float64, done, total int64) {
	if p.emit == nil {
		return
	}
	p.lastNano = time.Now().UnixNano()
	p.send(stage, frac, done, total)
}

// tick announces a byte-derived point, throttled per phase (the first
// tick of a phase always goes through).
func (p *scanProgress) tick(stage string, frac float64, done, total int64) {
	if p.emit == nil {
		return
	}
	now := time.Now().UnixNano()
	if p.tickStage == stage && now-p.lastNano < int64(progressMinInterval) {
		return
	}
	p.tickStage = stage
	p.lastNano = now
	p.send(stage, frac, done, total)
}

func (p *scanProgress) send(stage string, frac float64, done, total int64) {
	// Clamped monotone, exactly like the job reporter's points: a late
	// (or byte-count-mismatched) reading can never walk the bar backwards.
	if frac < p.lastPct {
		frac = p.lastPct
	} else {
		p.lastPct = frac
	}
	p.emit(EventScanProgress, ScanProgressEvent{
		Stage:    stage,
		Progress: frac,
		Done:     done,
		Total:    total,
	})
}

// importIndex is the library lookup the scan is built on: one pass over
// the matches table yields the two sets that decide whether a file is
// already imported — its stored path (absolute) and its content hash.
type importIndex struct {
	byPath map[string]bool // matches.path, absolute
	bySHA  map[string]bool // matches.sha256
}

// importIndex reads the index from the store. A store error fails the
// scan: a list that silently lost its own import recognition would show
// already-imported demos as new.
func (sc *Scanner) importIndex() (importIndex, error) {
	summary, err := sc.st.ListMatches("", "extracted_at", false)
	if err != nil {
		return importIndex{}, err
	}
	idx := importIndex{
		byPath: make(map[string]bool, len(summary)),
		bySHA:  make(map[string]bool, len(summary)),
	}
	for _, m := range summary {
		if p, err := filepath.Abs(m.Path); err == nil {
			idx.byPath[p] = true
		}
		if m.SHA256 != "" {
			idx.bySHA[m.SHA256] = true
		}
	}
	return idx, nil
}

// Scan returns the demo files under roots that are not already in the
// library, newest-first (path breaks ties). Roots are normalized
// (NormalizeDirs); missing or unreadable roots/dirs are skipped, not
// errors — a folder the user removed or that is currently unmounted
// simply yields nothing.
//
// Skip rules: hidden directories (dot-prefixed), anything under the app's
// own data root, symlinks (WalkDir never follows them), non-regular
// files, and files already imported. Only .dem / .dem.zst names qualify
// (the same rule the import pipeline validates with). Recognition runs
// twice: by stored path during the walk — no hashing needed, and
// skipping there keeps the file budget for rows that are listable — and
// by content hash after it, which is what recognises an imported demo
// sitting under a different path. Deleting the match therefore makes the
// file reappear on the next scan.
//
// Progress: the scan announces itself as spectra:scan-progress (see
// ScanProgressEvent) — an indeterminate walk point first, then a real
// byte fraction while it hashes (the walk's file count is unknowable
// before the walk, so the walk phase never fabricates a percentage).
// Scans are SLOW on first run (up to scanMaxNewHashBytes of sha256), so
// the frontend schedules them after first paint / off event bursts rather
// than inline.
func (sc *Scanner) Scan(roots []string) ([]DemoFile, error) {
	sc.mu.Lock()
	defer sc.mu.Unlock()

	sg := &scanProgress{emit: sc.emit}
	sg.entry(scanStageWalk, 0, 0, 0)

	idx, err := sc.importIndex()
	if err != nil {
		return nil, err
	}

	files, err := sc.collect(NormalizeDirs(roots), idx.byPath)
	if err != nil {
		return nil, err
	}

	// The hash phase's honest denominator: the sizes of exactly the files
	// this scan will hash (cache misses, inside the SAME budget the loop
	// below enforces — pre-rolled so the first byte read already has a
	// total to divide by). A file that later fails to hash leaves its
	// planned bytes uncounted, so the fraction may land below 1; it never
	// moves backwards and the scan's end is the call resolving anyway.
	hashesLeft, bytesLeft := scanMaxNewHashes, scanMaxNewHashBytes
	var hashTotal int64
	for i := range files {
		if _, ok := sc.cachedSHA(&files[i]); ok {
			continue
		}
		if hashesLeft <= 0 || files[i].Size > bytesLeft {
			continue
		}
		hashesLeft--
		bytesLeft -= files[i].Size
		hashTotal += files[i].Size
	}
	if hashTotal > 0 {
		sg.entry(scanStageHash, 0, 0, hashTotal)
	}
	hashesLeft, bytesLeft = scanMaxNewHashes, scanMaxNewHashBytes

	var hashed int64 // bytes hashed so far — the numerator's base per file
	listed := make([]DemoFile, 0, len(files))
	for _, f := range files {
		sha, ok := sc.cachedSHA(&f)
		if !ok {
			if hashesLeft <= 0 || f.Size > bytesLeft {
				listed = append(listed, f) // budget spent: listed, unverified
				continue
			}
			if sha, err = hashFile(f.Path, func(consumed int64) {
				if frac, all := byteFrac(hashed+consumed, hashTotal); all {
					sg.tick(scanStageHash, frac, hashed+consumed, hashTotal)
				}
			}); err != nil {
				listed = append(listed, f) // vanished/unreadable: listed unverified
				continue
			}
			hashesLeft--
			bytesLeft -= f.Size
			hashed += f.Size
			sc.rememberSHA(&f, sha)
		}
		if idx.bySHA[sha] {
			continue // content-identical to a match imported elsewhere
		}
		f.Hashed = true
		listed = append(listed, f)
	}

	sort.SliceStable(listed, func(i, j int) bool {
		if !listed[i].ModTime.Equal(listed[j].ModTime) {
			return listed[i].ModTime.After(listed[j].ModTime)
		}
		return listed[i].Path < listed[j].Path
	})
	// Pending-job awareness (see DemoFile.Pending): a file the queue is
	// already importing flips to "queued". Consults the ONE pending-job
	// lookup rather than re-deriving anything about recognition here; a
	// lookup failure is deliberately not a scan failure (importIndex above
	// already failed the scan for the errors that matter — worst case a
	// pending row still says "not imported", and Enqueue's dedupe holds
	// either way).
	for i := range listed {
		if _, found, err := sc.st.FindPendingJobByPath(listed[i].Path); err == nil && found {
			listed[i].Pending = true
		}
	}
	return listed, nil
}

// collect walks the roots and returns the demo files found that are not
// already in the library (path-deduped across roots, capped at
// scanMaxFiles). See Scan for the skip rules.
func (sc *Scanner) collect(roots []string, imported map[string]bool) ([]DemoFile, error) {
	seen := make(map[string]bool)
	var out []DemoFile
	for _, root := range roots {
		if isUnder(sc.dataRoot, root) {
			// The app's own data dir is not a demo folder.
			continue
		}
		if fi, err := os.Stat(root); err != nil || !fi.IsDir() {
			continue
		}
		err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil // unreadable entry: skip it, keep walking
			}
			rel := ""
			if path != root {
				rel = strings.TrimPrefix(path, root+string(filepath.Separator))
			}
			comps := 0
			if rel != "" {
				comps = strings.Count(rel, string(filepath.Separator)) + 1
			}
			if d.IsDir() {
				if path != root && (strings.HasPrefix(d.Name(), ".") || comps > scanMaxDepth) {
					return fs.SkipDir
				}
				if path != root && isUnder(sc.dataRoot, path) {
					return fs.SkipDir
				}
				return nil
			}
			if comps > scanMaxDepth+1 || !d.Type().IsRegular() || !isDemoFilename(d.Name()) {
				return nil
			}
			abs, err := filepath.Abs(path)
			if err != nil || seen[abs] {
				return nil
			}
			if imported[abs] {
				// Already in the library from this very path: not
				// listable, and skipped before it can consume the
				// scanMaxFiles budget.
				return nil
			}
			seen[abs] = true
			info, err := d.Info()
			if err != nil {
				return nil
			}
			out = append(out, DemoFile{
				Path:    abs,
				Root:    root,
				Size:    info.Size(),
				ModTime: info.ModTime(),
			})
			if len(out) >= scanMaxFiles {
				return fs.SkipAll
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

// RemoveDemoFile permanently deletes the demo file at path — the
// "Delete from disk" action on a Library import-dir row. Nothing is
// removed unless every invariant holds: a non-empty path that is a
// regular .dem/.dem.zst file sitting under one of roots, outside the
// app's own data dir, and not the stored path of a match already in the
// library (that demo belongs to the match — with no managed copy beside
// it (copy-on-import off, or evicted) it is the only file, so delete the
// match instead). Every failed check returns an error naming the reason;
// the frontend's confirmation dialog precedes this call, it never
// replaces these checks.
func (sc *Scanner) RemoveDemoFile(roots []string, path string) error {
	if strings.TrimSpace(path) == "" {
		return fmt.Errorf("delete demo file: empty path")
	}
	abs, err := filepath.Abs(strings.TrimSpace(path))
	if err != nil {
		return fmt.Errorf("delete demo file: %w", err)
	}
	if !isDemoFilename(filepath.Base(abs)) {
		return fmt.Errorf("delete demo file: %q is not a .dem/.dem.zst file", path)
	}
	underRoot := false
	for _, root := range NormalizeDirs(roots) {
		if isUnder(root, abs) {
			underRoot = true
			break
		}
	}
	if !underRoot {
		return fmt.Errorf("delete demo file: %q is not under a configured import dir", path)
	}
	if isUnder(sc.dataRoot, abs) {
		return fmt.Errorf("delete demo file: %q is inside Spectra's data folder", path)
	}
	idx, err := sc.importIndex()
	if err != nil {
		return fmt.Errorf("delete demo file: %w", err)
	}
	if idx.byPath[abs] {
		return fmt.Errorf("delete demo file: %q is already in the library — delete the match instead", path)
	}
	info, err := os.Lstat(abs)
	if err != nil {
		return fmt.Errorf("delete demo file: %w", err)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("delete demo file: %q is not a regular file", path)
	}
	sc.mu.Lock()
	defer sc.mu.Unlock()
	if err := os.Remove(abs); err != nil {
		return fmt.Errorf("delete demo file: %w", err)
	}
	sc.forgetSHA(abs)
	return nil
}

// cachedSHA returns the cached hash for f when the path, size and mtime
// still match what was hashed before — the whole point of the cache is
// that a rescan of unchanged demos costs one stat each.
func (sc *Scanner) cachedSHA(f *DemoFile) (string, bool) {
	e, ok := sc.hashes[f.Path]
	if !ok || e.size != f.Size || !e.mtime.Equal(f.ModTime) {
		return "", false
	}
	return e.sha, true
}

// rememberSHA records a hash for a file and evicts the oldest entries
// past hashCacheMax (order slice preserves insertion order).
func (sc *Scanner) rememberSHA(f *DemoFile, sha string) {
	if _, ok := sc.hashes[f.Path]; !ok {
		sc.order = append(sc.order, f.Path)
	}
	sc.hashes[f.Path] = hashEntry{size: f.Size, mtime: f.ModTime, sha: sha}
	for len(sc.order) > hashCacheMax {
		delete(sc.hashes, sc.order[0])
		sc.order = sc.order[1:]
	}
}

// forgetSHA drops the cached hash of path together with its FIFO slot —
// the file is gone, so a later file at the same path must not inherit
// its hash, and leaving the slot behind would let eviction delete a live
// entry twice. Callers hold sc.mu.
func (sc *Scanner) forgetSHA(path string) {
	if _, ok := sc.hashes[path]; !ok {
		return
	}
	delete(sc.hashes, path)
	for i, p := range sc.order {
		if p == path {
			sc.order = append(sc.order[:i], sc.order[i+1:]...)
			return
		}
	}
}

// hashFile streams a file through sha256 (never loads it whole — demos
// are hundreds of MB). onRead (optional) receives the running byte total
// after every read — the SAME countingReader the import pipeline's hash
// stage uses (library.go), so the scan's hash phase reports an honest
// bytes-read fraction instead of a bare spinner.
func hashFile(path string, onRead func(consumed int64)) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, &countingReader{r: f, onRead: onRead}); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
