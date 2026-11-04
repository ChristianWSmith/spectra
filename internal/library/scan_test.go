package library

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/store"
)

func newTestScanner(t *testing.T, dataRoot string) (*Scanner, *store.Store) {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return NewScanner(ScannerOptions{Store: st, DataRoot: dataRoot}), st
}

// writeScanFile creates a demo file (and its parent dirs) with content.
func writeScanFile(t *testing.T, path, content string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	return path
}

func shaOf(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func foundPaths(files []DemoFile) map[string]DemoFile {
	out := make(map[string]DemoFile, len(files))
	for _, f := range files {
		out[f.Path] = f
	}
	return out
}

// TestScanFiltersAndDepth pins the walk's extension filter, depth cap,
// hidden-dir skip and non-regular-file skip.
func TestScanFiltersAndDepth(t *testing.T) {
	root := t.TempDir()
	dataRoot := filepath.Join(t.TempDir(), "spectra-data")

	writeScanFile(t, filepath.Join(root, "top.dem"), "top")
	writeScanFile(t, filepath.Join(root, "top.DEM.ZST"), "upper")
	writeScanFile(t, filepath.Join(root, "notes.txt"), "not a demo")
	writeScanFile(t, filepath.Join(root, "sub", "one.dem"), "one")
	writeScanFile(t, filepath.Join(root, "sub", "deep", "two.dem.zst"), "two")
	writeScanFile(t, filepath.Join(root, "a", "b", "c", "d", "four.dem"), "four")      // depth 4: kept
	writeScanFile(t, filepath.Join(root, "a", "b", "c", "d", "e", "five.dem"), "five") // depth 5: cut
	writeScanFile(t, filepath.Join(root, ".hidden", "gone.dem"), "hidden")
	writeScanFile(t, filepath.Join(root, "empty.dem"), "")

	sc, _ := newTestScanner(t, dataRoot)
	files, err := sc.Scan([]string{root})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	got := foundPaths(files)
	want := []string{
		filepath.Join(root, "top.dem"),
		filepath.Join(root, "top.DEM.ZST"),
		filepath.Join(root, "sub", "one.dem"),
		filepath.Join(root, "sub", "deep", "two.dem.zst"),
		filepath.Join(root, "a", "b", "c", "d", "four.dem"),
		filepath.Join(root, "empty.dem"),
	}
	if len(got) != len(want) {
		var names []string
		for p := range got {
			names = append(names, p)
		}
		t.Fatalf("Scan found %d files %v, want %d", len(got), names, len(want))
	}
	for _, w := range want {
		if _, ok := got[w]; !ok {
			t.Errorf("Scan missing %s", w)
		}
	}
	for _, bad := range []string{
		filepath.Join(root, "notes.txt"),
		filepath.Join(root, "a", "b", "c", "d", "e", "five.dem"),
		filepath.Join(root, ".hidden", "gone.dem"),
	} {
		if _, ok := got[bad]; ok {
			t.Errorf("Scan returned excluded file %s", bad)
		}
	}
}

// TestScanDedupesNestedRoots: the same file reachable from two configured
// dirs is listed once (first root wins).
func TestScanDedupesNestedRoots(t *testing.T) {
	outer := t.TempDir()
	inner := filepath.Join(outer, "inner")
	writeScanFile(t, filepath.Join(inner, "same.dem"), "same")
	writeScanFile(t, filepath.Join(outer, "outer.dem"), "outer")

	sc, _ := newTestScanner(t, filepath.Join(t.TempDir(), "data"))
	files, err := sc.Scan([]string{inner, outer})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	got := foundPaths(files)
	if len(got) != 2 {
		t.Fatalf("Scan returned %d unique paths, want 2", len(got))
	}
	same := got[filepath.Join(inner, "same.dem")]
	if same.Root != inner {
		t.Errorf("nested file's Root = %q, want the first root %q", same.Root, inner)
	}
}

// TestScanRecognizesImportedFiles covers both recognition paths: an exact
// matches.path match (no hashing needed) and a content-hash match for a
// copy of the demo under a different path.
func TestScanRecognizesImportedFiles(t *testing.T) {
	root := t.TempDir()
	sameContent := "identical demo bytes"
	pathMatched := writeScanFile(t, filepath.Join(root, "already.dem"), "original bytes")
	hashMatched := writeScanFile(t, filepath.Join(root, "elsewhere", "copy.dem"), sameContent)
	writeScanFile(t, filepath.Join(root, "fresh.dem"), "brand new bytes")

	sc, st := newTestScanner(t, filepath.Join(t.TempDir(), "data"))
	if _, err := st.CreateMatchRow(pathMatched, "sha-of-something-else", 1); err != nil {
		t.Fatalf("create match (path): %v", err)
	}
	// Imported from a path outside every configured root: only the hash
	// can recognise the copy sitting in the scan.
	if _, err := st.CreateMatchRow("/elsewhere/original.dem", shaOf(sameContent), int64(len(sameContent))); err != nil {
		t.Fatalf("create match (hash): %v", err)
	}

	files, err := sc.Scan([]string{root})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	got := foundPaths(files)
	if id := got[pathMatched].MatchID; id == 0 {
		t.Error("path-matched file not recognised as imported")
	}
	if !got[pathMatched].Hashed {
		t.Error("path-matched file should be marked verified")
	}
	if id := got[hashMatched].MatchID; id == 0 {
		t.Error("content-identical copy not recognised via sha256")
	}
	if !got[hashMatched].Hashed {
		t.Error("hashed file should be marked verified")
	}
	if id := got[filepath.Join(root, "fresh.dem")].MatchID; id != 0 {
		t.Errorf("fresh file reported as import %d, want 0", id)
	}
}

// TestScanSortsUnimportedFirst: the Library shows actionable rows on top.
func TestScanSortsUnimportedFirst(t *testing.T) {
	root := t.TempDir()
	old := writeScanFile(t, filepath.Join(root, "imported.dem"), "imported bytes")
	fresh := writeScanFile(t, filepath.Join(root, "new.dem"), "new bytes")
	oldTime := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(old, oldTime, oldTime); err != nil {
		t.Fatalf("chtimes: %v", err)
	}

	sc, st := newTestScanner(t, filepath.Join(t.TempDir(), "data"))
	if _, err := st.CreateMatchRow(old, shaOf("imported bytes"), 14); err != nil {
		t.Fatalf("create match: %v", err)
	}
	files, err := sc.Scan([]string{root})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(files) != 2 {
		t.Fatalf("Scan returned %d files, want 2", len(files))
	}
	if files[0].Path != fresh || files[1].Path != old {
		t.Errorf("order = [%s %s], want unimported %s first", files[0].Path, files[1].Path, fresh)
	}
}

// TestScanSkipsAppDataDir: spectra's own data root is never scanned, no
// matter how it is reached (as a root or nested under one).
func TestScanSkipsAppDataDir(t *testing.T) {
	outer := t.TempDir()
	dataRoot := filepath.Join(outer, "spectra-data")
	writeScanFile(t, filepath.Join(dataRoot, "demos", "managed.dem"), "managed copy")
	writeScanFile(t, filepath.Join(outer, "real.dem"), "real")

	sc, _ := newTestScanner(t, dataRoot)

	files, err := sc.Scan([]string{outer})
	if err != nil {
		t.Fatalf("Scan(outer): %v", err)
	}
	if got := foundPaths(files); len(got) != 1 || got[filepath.Join(outer, "real.dem")].Path == "" {
		t.Errorf("Scan(outer) = %v, want only the real demo", got)
	}

	files, err = sc.Scan([]string{filepath.Join(dataRoot, "demos")})
	if err != nil {
		t.Fatalf("Scan(data root): %v", err)
	}
	if len(files) != 0 {
		t.Errorf("Scan(data root) returned %d files, want 0", len(files))
	}
}

// TestScanHashBudget: one scan verifies at most scanMaxNewHashes files it
// has never seen (demos are hundreds of MB — hashing is capped, listing
// is not); the next scan picks up where the budget stopped.
func TestScanHashBudget(t *testing.T) {
	root := t.TempDir()
	const total = scanMaxNewHashes + 6
	for i := 0; i < total; i++ {
		name := filepath.Join(root, fmt.Sprintf("demo-%03d.dem", i))
		writeScanFile(t, name, "content-"+strconv.Itoa(i))
	}
	sc, _ := newTestScanner(t, filepath.Join(t.TempDir(), "data"))

	files, err := sc.Scan([]string{root})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	hashed, unverified := 0, 0
	for _, f := range files {
		if f.Hashed {
			hashed++
		} else {
			unverified++
		}
	}
	if hashed != scanMaxNewHashes {
		t.Errorf("first scan verified %d files, want %d", hashed, scanMaxNewHashes)
	}
	if unverified != total-scanMaxNewHashes {
		t.Errorf("first scan left %d files unverified, want %d", unverified, total-scanMaxNewHashes)
	}

	// Second scan: the cached 64 cost nothing, so the remaining six fit
	// in a fresh budget and every row comes back verified.
	files, err = sc.Scan([]string{root})
	if err != nil {
		t.Fatalf("Scan (2): %v", err)
	}
	for _, f := range files {
		if !f.Hashed {
			t.Errorf("second scan left %s unverified", f.Path)
		}
	}
}

// TestScannerHashCache: an unchanged file's hash is served from the
// cache (path+size+mtime), a touched one is rehashed.
func TestScannerHashCache(t *testing.T) {
	path := writeScanFile(t, filepath.Join(t.TempDir(), "cached.dem"), "bytes")
	sc, _ := newTestScanner(t, filepath.Join(t.TempDir(), "data"))

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	f := DemoFile{Path: path, Size: info.Size(), ModTime: info.ModTime()}
	sc.rememberSHA(&f, "cached-sha")
	if sha, ok := sc.cachedSHA(&f); !ok || sha != "cached-sha" {
		t.Fatalf("cachedSHA hit = (%q, %v), want (cached-sha, true)", sha, ok)
	}
	touched := f
	touched.ModTime = f.ModTime.Add(time.Second)
	if _, ok := sc.cachedSHA(&touched); ok {
		t.Error("cachedSHA ignored a changed mtime")
	}
	sized := f
	sized.Size = f.Size + 1
	if _, ok := sc.cachedSHA(&sized); ok {
		t.Error("cachedSHA ignored a changed size")
	}
}
