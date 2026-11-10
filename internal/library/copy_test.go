package library

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// newImporterWithCopyDir builds an Importer whose managed-copy dir is
// dir (tests never touch the real data.DemosDir).
func newImporterWithCopyDir(t *testing.T, copyDir string) (*Importer, *store.Store) {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	im := New(Options{
		Store:         st,
		Parse:         fakeParse,
		ParserVersion: "test",
		SidecarDir:    t.TempDir(),
		CopyDir:       copyDir,
	})
	t.Cleanup(im.Shutdown)
	return im, st
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}

// TestCopyDemo: the copy lands under the content hash with the source
// extension, carries the .info chat-key companion along, and an existing
// copy is reused rather than rewritten.
func TestCopyDemo(t *testing.T) {
	copyDir := t.TempDir()
	im, _ := newImporterWithCopyDir(t, copyDir)

	src := writeDemo(t, "match.dem.zst", "compressed demo bytes")
	infoPath := strings.TrimSuffix(src, ".dem.zst") + ".info"
	if err := os.WriteFile(infoPath, []byte("chat-key"), 0o644); err != nil {
		t.Fatalf("write .info: %v", err)
	}
	sha := shaOf("compressed demo bytes")

	dst, err := im.copyDemo(src, sha, nil)
	if err != nil {
		t.Fatalf("copyDemo: %v", err)
	}
	want := filepath.Join(copyDir, sha+".dem.zst")
	if dst != want {
		t.Fatalf("copyDemo = %q, want %q", dst, want)
	}
	if got := readFile(t, dst); got != "compressed demo bytes" {
		t.Errorf("copy content = %q, want the source bytes", got)
	}
	companion := filepath.Join(copyDir, sha+".info")
	if got := readFile(t, companion); got != "chat-key" {
		t.Errorf("companion copy = %q, want %q", got, "chat-key")
	}

	// Reuse: a second copy of the same content must not rewrite the file.
	if err := os.WriteFile(dst, []byte("already copied"), 0o644); err != nil {
		t.Fatalf("seed dst: %v", err)
	}
	again, err := im.copyDemo(src, sha, nil)
	if err != nil {
		t.Fatalf("copyDemo (second): %v", err)
	}
	if again != dst {
		t.Fatalf("second copyDemo = %q, want the same %q", again, dst)
	}
	if got := readFile(t, dst); got != "already copied" {
		t.Errorf("existing copy was rewritten: %q", got)
	}
}

// TestCopyDemoIsNoOpForManagedSource: importing a file that already sits
// in the managed dir must not copy a file onto itself.
func TestCopyDemoIsNoOpForManagedSource(t *testing.T) {
	copyDir := t.TempDir()
	im, _ := newImporterWithCopyDir(t, copyDir)
	sha := shaOf("in place")
	src := filepath.Join(copyDir, sha+".dem")
	if err := os.WriteFile(src, []byte("in place"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	dst, err := im.copyDemo(src, sha, nil)
	if err != nil {
		t.Fatalf("copyDemo: %v", err)
	}
	if dst != src {
		t.Fatalf("copyDemo = %q, want the source %q unchanged", dst, src)
	}
	if got := readFile(t, src); got != "in place" {
		t.Errorf("self-copy clobbered the file: %q", got)
	}
}

// TestManagedDemoPathAndRemove: lookup + delete cover both extensions,
// remove the .info companion, report honestly, and — critically — never
// delete anything outside the managed dir (a hash with path traversal
// must be refused, not escaped through).
func TestManagedDemoPathAndRemove(t *testing.T) {
	copyDir := t.TempDir()
	im, _ := newImporterWithCopyDir(t, copyDir)

	if got := im.ManagedDemoPath(""); got != "" {
		t.Errorf("ManagedDemoPath(\"%s\") = %q, want \"\"", "", got)
	}
	if got := im.ManagedDemoPath("deadbeef"); got != "" {
		t.Errorf("ManagedDemoPath(missing) = %q, want \"\"", got)
	}

	// .dem copy + companion.
	sha := shaOf("plain demo")
	demo := filepath.Join(copyDir, sha+".dem")
	if err := os.WriteFile(demo, []byte("plain demo"), 0o644); err != nil {
		t.Fatalf("write demo: %v", err)
	}
	if err := os.WriteFile(filepath.Join(copyDir, sha+".info"), []byte("key"), 0o644); err != nil {
		t.Fatalf("write info: %v", err)
	}
	if got := im.ManagedDemoPath(sha); got != demo {
		t.Fatalf("ManagedDemoPath = %q, want %q", got, demo)
	}
	removed, err := im.RemoveManagedDemo(sha)
	if err != nil || !removed {
		t.Fatalf("RemoveManagedDemo = (%v, %v), want (true, nil)", removed, err)
	}
	if _, err := os.Stat(demo); !os.IsNotExist(err) {
		t.Errorf("managed demo still on disk (stat err %v)", err)
	}
	if _, err := os.Stat(filepath.Join(copyDir, sha+".info")); !os.IsNotExist(err) {
		t.Errorf("companion copy still on disk (stat err %v)", err)
	}
	if removed, err := im.RemoveManagedDemo(sha); err != nil || removed {
		t.Errorf("second RemoveManagedDemo = (%v, %v), want (false, nil)", removed, err)
	}

	// A hash that escapes the managed dir is refused: nothing outside
	// copyDir is ever deleted, even if a lookup resolves there.
	outside := filepath.Join(filepath.Dir(copyDir), "outside.dem")
	if err := os.WriteFile(outside, []byte("user file"), 0o644); err != nil {
		t.Fatalf("write outside: %v", err)
	}
	if got := im.ManagedDemoPath("../outside"); got != outside {
		t.Fatalf("ManagedDemoPath(traversal) resolved to %q, want the escaped %q", got, outside)
	}
	removed, err = im.RemoveManagedDemo("../outside")
	if err != nil || removed {
		t.Fatalf("RemoveManagedDemo(traversal) = (%v, %v), want (false, nil)", removed, err)
	}
	if _, err := os.Stat(outside); err != nil {
		t.Errorf("file outside the managed dir was deleted: %v", err)
	}
}

// TestImportCopiesDemoAndReprocessesFromCopy is the migration story end
// to end: an import copies the raw demo (source path stays on the match
// row), and once the user's original is gone Reprocess still parses —
// from the managed copy.
func TestImportCopiesDemoAndReprocessesFromCopy(t *testing.T) {
	copyDir := t.TempDir()
	im, st := newImporterWithCopyDir(t, copyDir)
	src := writeDemo(t, "original.dem", "bytes that will be deleted")
	if err := os.WriteFile(strings.TrimSuffix(src, ".dem")+".info", []byte("key"), 0o644); err != nil {
		t.Fatalf("write .info: %v", err)
	}

	ids := im.Enqueue([]string{src})
	if len(ids) != 1 {
		t.Fatalf("Enqueue returned %d ids, want 1", len(ids))
	}
	job := waitStatus(t, st, ids[0], models.JobDone)
	m, err := st.GetMatch(job.MatchID)
	if err != nil {
		t.Fatalf("GetMatch: %v", err)
	}
	if m.Path != src {
		t.Errorf("matches.path = %q, want the source %q (searchable, never deleted)", m.Path, src)
	}
	copyPath := filepath.Join(copyDir, m.SHA256+".dem")
	if got := readFile(t, copyPath); got != "bytes that will be deleted" {
		t.Fatalf("managed copy content = %q", got)
	}

	// The original disappears (user cleans Downloads) — reprocess must
	// read the copy, not the stale stored path.
	if err := os.Remove(src); err != nil {
		t.Fatalf("remove source: %v", err)
	}
	reID, err := im.Reprocess(job.MatchID)
	if err != nil {
		t.Fatalf("Reprocess: %v", err)
	}
	reJob := waitStatus(t, st, reID, models.JobDone)
	if reJob.Path != copyPath {
		t.Errorf("reprocess job path = %q, want the managed copy %q", reJob.Path, copyPath)
	}
}

// TestImportCopyFailureFailsJob: a demo that cannot be copied never
// becomes a match row — the contract is "imported ⇒ managed", so the
// failure surfaces in the job list instead of a silent half-import.
func TestImportCopyFailureFailsJob(t *testing.T) {
	blocker := writeDemo(t, "blocker", "a regular file where the copy dir should be")
	im, st := newImporterWithCopyDir(t, blocker)

	ids := im.Enqueue([]string{writeDemo(t, "doomed.dem", "cannot be copied")})
	if len(ids) != 1 {
		t.Fatalf("Enqueue returned %d ids, want 1", len(ids))
	}
	job := waitStatus(t, st, ids[0], models.JobFailed)
	// failJob frames the copy failure in player language (library.playerJobError).
	if !strings.Contains(job.Error, "Couldn't save the import") {
		t.Errorf("job error = %q, want it to mention the copy failure", job.Error)
	}
	rows, err := st.ListMatches("", "extracted_at", false)
	if err != nil {
		t.Fatalf("ListMatches: %v", err)
	}
	if len(rows) != 0 {
		t.Errorf("a failed copy left %d match rows, want none", len(rows))
	}
}

func TestIsUnder(t *testing.T) {
	tests := []struct {
		dir, path string
		want      bool
	}{
		{"/data/demos", "/data/demos/a.dem", true},
		{"/data/demos", "/data/demos", true},
		{"/data/demos", "/data/demos-other/a.dem", false},
		{"/data/demos", "/data/a.dem", false},
		{"/data/demos", "/etc/passwd", false},
	}
	for _, tt := range tests {
		if got := isUnder(tt.dir, tt.path); got != tt.want {
			t.Errorf("isUnder(%q, %q) = %v, want %v", tt.dir, tt.path, got, tt.want)
		}
	}
}
