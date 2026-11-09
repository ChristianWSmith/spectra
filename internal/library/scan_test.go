package library

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
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

// TestScanOmitsImportedFiles pins the list contract (the characterization
// of the old flagging behaviour lives in this test's history: imported
// rows used to be returned with a MatchID): a demo already in the library
// never reaches the list — neither the exact matches.path match (no
// hashing needed) nor a content-hash match for a copy of the demo under a
// different path. Fresh files still come back, marked verified.
func TestScanOmitsImportedFiles(t *testing.T) {
	root := t.TempDir()
	sameContent := "identical demo bytes"
	pathMatched := writeScanFile(t, filepath.Join(root, "already.dem"), "original bytes")
	hashMatched := writeScanFile(t, filepath.Join(root, "elsewhere", "copy.dem"), sameContent)
	fresh := writeScanFile(t, filepath.Join(root, "fresh.dem"), "brand new bytes")

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
	if _, ok := got[pathMatched]; ok {
		t.Error("path-matched file still listed — it is already imported")
	}
	if _, ok := got[hashMatched]; ok {
		t.Error("content-identical copy still listed — it is already imported")
	}
	f, ok := got[fresh]
	if !ok {
		t.Fatalf("fresh file missing from the list (got %d rows)", len(files))
	}
	if !f.Hashed {
		t.Error("listed fresh file should be marked verified")
	}
}

// TestScanSortsNewestFirst: the list is newest-first with the path as
// the tiebreak — everything it returns is unimported, so there is no
// longer an "unimported first" group to order by.
func TestScanSortsNewestFirst(t *testing.T) {
	root := t.TempDir()
	older := writeScanFile(t, filepath.Join(root, "older.dem"), "older bytes")
	newer := writeScanFile(t, filepath.Join(root, "newer.dem"), "newer bytes")
	oldTime := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(older, oldTime, oldTime); err != nil {
		t.Fatalf("chtimes: %v", err)
	}

	sc, _ := newTestScanner(t, filepath.Join(t.TempDir(), "data"))
	files, err := sc.Scan([]string{root})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(files) != 2 {
		t.Fatalf("Scan returned %d files, want 2", len(files))
	}
	if files[0].Path != newer || files[1].Path != older {
		t.Errorf("order = [%s %s], want newest %s first", files[0].Path, files[1].Path, newer)
	}
}

// TestScanListsAgainAfterMatchDelete: keeping imported demos out of the
// list is a view of the matches table — deleting the match must bring
// both flavours of recognition back (imported from this path, and
// imported from elsewhere but copied into the folder).
func TestScanListsAgainAfterMatchDelete(t *testing.T) {
	root := t.TempDir()
	sameContent := "shared demo bytes"
	ownPath := writeScanFile(t, filepath.Join(root, "own.dem"), sameContent)
	elsewhere := writeScanFile(t, filepath.Join(root, "sub", "copy.dem"), sameContent)

	sc, st := newTestScanner(t, filepath.Join(t.TempDir(), "data"))
	fromOwnPath, err := st.CreateMatchRow(ownPath, "sha-of-something-else", 1)
	if err != nil {
		t.Fatalf("create match (path): %v", err)
	}
	fromElsewhere, err := st.CreateMatchRow("/elsewhere/original.dem", shaOf(sameContent), int64(len(sameContent)))
	if err != nil {
		t.Fatalf("create match (hash): %v", err)
	}

	files, err := sc.Scan([]string{root})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(files) != 0 {
		t.Fatalf("Scan returned %d rows for imported demos, want 0", len(files))
	}

	for _, id := range []int64{fromOwnPath, fromElsewhere} {
		if err := st.DeleteMatchData(id); err != nil {
			t.Fatalf("DeleteMatchData(%d): %v", id, err)
		}
	}
	files, err = sc.Scan([]string{root})
	if err != nil {
		t.Fatalf("Scan after delete: %v", err)
	}
	got := foundPaths(files)
	for _, want := range []string{ownPath, elsewhere} {
		if _, ok := got[want]; !ok {
			t.Errorf("demo %s did not reappear after its match was deleted", want)
		}
	}
}

// TestScanCapCountsUnimported: scanMaxFiles bounds the list, not the
// walk — already-imported files are skipped while walking, so a folder
// whose imported files sort first still yields every fresh one instead
// of spending the whole budget on rows that will be dropped.
func TestScanCapCountsUnimported(t *testing.T) {
	root := t.TempDir()
	const importedCount = scanMaxFiles + 2
	const freshCount = 3
	sc, st := newTestScanner(t, filepath.Join(t.TempDir(), "data"))
	for i := 0; i < importedCount; i++ {
		p := writeScanFile(t, filepath.Join(root, fmt.Sprintf("aaa-%03d.dem", i)), fmt.Sprintf("imported-%d", i))
		// Path recognition only — a placeholder hash is enough (the walk
		// never hashes a file it recognises by path).
		if _, err := st.CreateMatchRow(p, fmt.Sprintf("sha-%03d", i), 1); err != nil {
			t.Fatalf("create match: %v", err)
		}
	}
	for i := 0; i < freshCount; i++ {
		writeScanFile(t, filepath.Join(root, fmt.Sprintf("zzz-%03d.dem", i)), fmt.Sprintf("fresh-%d", i))
	}

	files, err := sc.Scan([]string{root})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(files) != freshCount {
		t.Fatalf("Scan returned %d rows, want the %d fresh ones", len(files), freshCount)
	}
	for _, f := range files {
		if strings.HasPrefix(filepath.Base(f.Path), "aaa") {
			t.Errorf("already-imported file listed: %s", f.Path)
		}
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

// TestScanMarksPendingImports: a demo whose import job is still
// queued/running — and therefore has no match row yet, which is exactly
// why it is still listed — comes back marked Pending (the Library flips
// its chip and disables Import for it). Terminal or absent jobs never
// flag a row; the flag is read from the ONE pending-job lookup, so
// recognition itself is untouched.
func TestScanMarksPendingImports(t *testing.T) {
	root := t.TempDir()
	pending := writeScanFile(t, filepath.Join(root, "pending.dem"), "pending bytes")
	finished := writeScanFile(t, filepath.Join(root, "finished.dem"), "finished bytes")
	fresh := writeScanFile(t, filepath.Join(root, "fresh.dem"), "fresh bytes")

	sc, st := newTestScanner(t, filepath.Join(t.TempDir(), "data"))
	queued, err := st.CreateJob("import", pending)
	if err != nil {
		t.Fatalf("CreateJob (queued): %v", err)
	}
	if job, found, err := st.FindPendingJobByPath(pending); err != nil || !found || job.ID != queued {
		t.Fatalf("setup: pending job for %s = (%d, %v, %v)", pending, job.ID, found, err)
	}
	done, err := st.CreateJob("import", finished)
	if err != nil {
		t.Fatalf("CreateJob (done): %v", err)
	}
	if err := st.UpdateJob(done, models.JobDone, models.StageDone, 1, ""); err != nil {
		t.Fatalf("UpdateJob done: %v", err)
	}

	files, err := sc.Scan([]string{root})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	got := foundPaths(files)
	for _, path := range []string{pending, finished, fresh} {
		if _, ok := got[path]; !ok {
			t.Fatalf("scan missing %s", path)
		}
	}
	if !got[pending].Pending {
		t.Error("file with a queued import job not marked Pending")
	}
	if got[finished].Pending {
		t.Error("file whose job finished marked Pending")
	}
	if got[fresh].Pending {
		t.Error("file with no job marked Pending")
	}
}

// TestRemoveDemoFile deletes a demo the scanner would list: a regular
// .dem file under a configured import dir goes away, the cached hash
// goes with it, and the next scan reports nothing.
func TestRemoveDemoFile(t *testing.T) {
	root := t.TempDir()
	path := writeScanFile(t, filepath.Join(root, "sub", "gone.dem"), "gone bytes")
	sc, _ := newTestScanner(t, filepath.Join(t.TempDir(), "data"))

	// First scan populates the hash cache for this path.
	if _, err := sc.Scan([]string{root}); err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if err := sc.RemoveDemoFile([]string{root}, path); err != nil {
		t.Fatalf("RemoveDemoFile: %v", err)
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Errorf("file still present after RemoveDemoFile (err=%v)", err)
	}
	sc.mu.Lock()
	_, cached := sc.hashes[path]
	slot := false
	for _, p := range sc.order {
		slot = slot || p == path
	}
	sc.mu.Unlock()
	if cached || slot {
		t.Errorf("deleted file kept its hash cache entry (cached=%v, slot=%v)", cached, slot)
	}
	files, err := sc.Scan([]string{root})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(files) != 0 {
		t.Errorf("Scan still lists %d rows after the delete", len(files))
	}
}

// TestRemoveDemoFileRefusals pins every invariant that keeps "delete from
// disk" from ever being an arbitrary-file delete: nothing outside a
// configured import dir, nothing inside the app's own data folder,
// nothing that is not a demo file, and nothing the library still points
// at. Every refusal must leave the file in place.
func TestRemoveDemoFileRefusals(t *testing.T) {
	outer := t.TempDir()
	root := filepath.Join(outer, "import-dir")
	// The data folder deliberately nested under the import dir: the user
	// configured a parent of it, which the walk skips and the delete must
	// refuse too.
	dataRoot := filepath.Join(root, "spectra-data")
	sc, st := newTestScanner(t, dataRoot)
	roots := []string{root}

	exists := func(path string) bool {
		_, err := os.Lstat(path)
		return err == nil
	}
	refuse := func(name, path, want string) {
		t.Helper()
		err := sc.RemoveDemoFile(roots, path)
		if err == nil {
			t.Errorf("%s: RemoveDemoFile succeeded, want refusal", name)
			return
		}
		if !strings.Contains(err.Error(), want) {
			t.Errorf("%s: error %q does not mention %q", name, err, want)
		}
	}

	outside := writeScanFile(t, filepath.Join(outer, "outside.dem"), "outside")
	managed := writeScanFile(t, filepath.Join(dataRoot, "managed.dem"), "managed")
	inLibrary := writeScanFile(t, filepath.Join(root, "in-library.dem"), "in library")
	notes := writeScanFile(t, filepath.Join(root, "notes.txt"), "not a demo")
	if err := os.MkdirAll(filepath.Join(root, "folder.dem"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if _, err := st.CreateMatchRow(inLibrary, "sha-in-library", 12); err != nil {
		t.Fatalf("create match: %v", err)
	}

	refuse("empty path", "", "empty path")
	refuse("outside every import dir", outside, "not under a configured import dir")
	refuse("inside the data folder", managed, "data folder")
	refuse("library match's stored path", inLibrary, "already in the library")
	refuse("non-demo extension", notes, "not a .dem/.dem.zst file")
	refuse("directory", filepath.Join(root, "folder.dem"), "not a regular file")
	refuse("missing file", filepath.Join(root, "never.dem"), "no such file")

	// Every refused file must still be on disk.
	for _, p := range []string{outside, managed, inLibrary, notes, filepath.Join(root, "folder.dem")} {
		if !exists(p) {
			t.Errorf("%s was deleted despite the refusal", p)
		}
	}

	// A file the checks pass through is actually removed.
	good := writeScanFile(t, filepath.Join(root, "keep-me-not.dem"), "deletable")
	if err := sc.RemoveDemoFile(roots, good); err != nil {
		t.Fatalf("RemoveDemoFile(good): %v", err)
	}
	if exists(good) {
		t.Error("valid file survived RemoveDemoFile")
	}
}
