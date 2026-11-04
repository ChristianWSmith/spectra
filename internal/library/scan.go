package library

import (
	"crypto/sha256"
	"encoding/hex"
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

// Demo discovery for the Library's "demos in your folders" list: walk the
// user's configured roots for .dem / .dem.zst files, say which ones are
// already in the library, and keep the walk bounded (see the limits
// below). The walk itself only stats; files are hashed to recognise
// imports that arrived under a different path, behind a per-(path,size,
// mtime) cache so a repeat scan is stat-only.

// Scan limits — the "bounded and cheap" contract of the watched-folder
// list. Everything below is per Scan call.
const (
	// scanMaxDepth is how deep below a root the walk descends (a file
	// directly in the root is depth 0). CS2's replays folder is one level
	// and Downloads is flat in practice; four covers organized folders
	// without ever walking a whole Steam library or home directory.
	scanMaxDepth = 4
	// scanMaxFiles caps how many demos one scan returns.
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

// DemoFile is one file found under a configured root. MatchID != 0 means
// the demo is already in the library (linked match). Hashed reports
// whether the file's sha256 was checked against the library this scan —
// when false, MatchID == 0 means "not checked yet", not "definitely not
// imported".
type DemoFile struct {
	Path    string    `json:"path"`
	Root    string    `json:"root"` // configured dir the file was found under
	Size    int64     `json:"size"`
	ModTime time.Time `json:"modTime"`
	Hashed  bool      `json:"hashed"`
	MatchID int64     `json:"matchId"`
}

// ScannerOptions configures a Scanner. Store is the match index (import
// recognition); DataRoot is the app's own data directory, which is never
// scanned (spectra's managed copies are not the user's demos — default
// data.RootDir() when empty).
type ScannerOptions struct {
	Store    *store.Store
	DataRoot string
}

// Scanner owns the hash cache behind Scan. Create with NewScanner; one
// instance serves the app (the cache is process-wide state). Scan
// serializes against itself, so concurrent service calls cannot interleave
// a cache write.
type Scanner struct {
	st       *store.Store
	dataRoot string

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
		hashes:   map[string]hashEntry{},
	}
}

// Scan returns the demo files under roots, unimported ones first, then
// newest-first. Roots are normalized (NormalizeDirs); missing or
// unreadable roots/dirs are skipped, not errors — a folder the user
// removed or that is currently unmounted simply yields nothing.
//
// Skip rules: hidden directories (dot-prefixed), anything under the app's
// own data root, symlinks (WalkDir never follows them), and non-regular
// files. Only .dem / .dem.zst names qualify (the same rule the import
// pipeline validates with).
func (sc *Scanner) Scan(roots []string) ([]DemoFile, error) {
	sc.mu.Lock()
	defer sc.mu.Unlock()

	// Import index: one pass over the library gives both lookup maps.
	summary, err := sc.st.ListMatches("", "extracted_at", false)
	if err != nil {
		return nil, err
	}
	byPath := make(map[string]int64, len(summary))
	bySHA := make(map[string]int64, len(summary))
	for _, m := range summary {
		if p, err := filepath.Abs(m.Path); err == nil {
			byPath[p] = m.ID
		}
		if m.SHA256 != "" {
			bySHA[m.SHA256] = m.ID
		}
	}

	files, err := sc.collect(NormalizeDirs(roots))
	if err != nil {
		return nil, err
	}

	hashesLeft, bytesLeft := scanMaxNewHashes, scanMaxNewHashBytes
	for i := range files {
		f := &files[i]
		if id, ok := byPath[f.Path]; ok {
			// Imported from this very path — no hashing needed.
			f.MatchID = id
			f.Hashed = true
			continue
		}
		sha, hashed := sc.cachedSHA(f)
		if !hashed {
			if hashesLeft <= 0 || f.Size > bytesLeft {
				continue // budget spent: listed, but unverified
			}
			if sha, err = hashFile(f.Path); err != nil {
				continue // vanished/unreadable between walk and hash
			}
			hashesLeft--
			bytesLeft -= f.Size
			sc.rememberSHA(f, sha)
		}
		f.Hashed = true
		if id, ok := bySHA[sha]; ok {
			f.MatchID = id
		}
	}

	sort.SliceStable(files, func(i, j int) bool {
		bi, bj := files[i].MatchID == 0, files[j].MatchID == 0
		if bi != bj {
			return bi // not (verifiably) imported first
		}
		if !files[i].ModTime.Equal(files[j].ModTime) {
			return files[i].ModTime.After(files[j].ModTime)
		}
		return files[i].Path < files[j].Path
	})
	return files, nil
}

// collect walks the roots and returns the demo files found (path-deduped
// across roots, capped at scanMaxFiles). See Scan for the skip rules.
func (sc *Scanner) collect(roots []string) ([]DemoFile, error) {
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

// hashFile streams a file through sha256 (never loads it whole — demos
// are hundreds of MB).
func hashFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
