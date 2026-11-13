package library

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"github.com/ChristianWSmith/spectra/internal/extract"
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

// newCopyTestImporter is newImporterWithCopyDir plus Options: the test
// supplies Parse / Emit / CopyEnabled (copy toggle, failure injection,
// event observation) and the helper fills in the copy-test defaults.
func newCopyTestImporter(t *testing.T, copyDir string, o Options) (*Importer, *store.Store) {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if o.Parse == nil {
		o.Parse = fakeParse
	}
	o.Store = st
	o.ParserVersion = "test"
	o.SidecarDir = t.TempDir()
	o.CopyDir = copyDir
	im := New(o)
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

// dirNames lists a directory's entries for failure messages.
func dirNames(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir %s: %v", dir, err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

// waitDirEmpty polls until dir holds no entries — a failed job frees the
// copy it made, but the removal lands in process()'s defer AFTER the job
// already announced its terminal state, so a test waiting on the job
// status must still wait for the file to go.
func waitDirEmpty(t *testing.T, dir string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if entries, err := os.ReadDir(dir); err == nil && len(entries) == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("copy dir still holds %v, want empty (a failed job must free the copy it made)", dirNames(t, dir))
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

// TestCopyStateThreeWay pins the fs-derived demo state
// (models.MatchSummary.CopyState / models.Match.CopyState): a managed
// copy wins, else a live stored path, else missing. It is read fresh from
// the filesystem every time — nothing stored, nothing to go stale.
func TestCopyStateThreeWay(t *testing.T) {
	copyDir := t.TempDir()
	im, _ := newImporterWithCopyDir(t, copyDir)
	sha := shaOf("state bytes")
	source := writeDemo(t, "state-source.dem", "state bytes")
	gone := filepath.Join(t.TempDir(), "deleted.dem") // never written

	// No copy yet: the stored source decides external vs missing.
	if got := im.CopyState(sha, source); got != CopyStateExternal {
		t.Errorf("CopyState(no copy, live source) = %q, want %q", got, CopyStateExternal)
	}
	if got := im.CopyState(sha, gone); got != CopyStateMissing {
		t.Errorf("CopyState(no copy, gone source) = %q, want %q", got, CopyStateMissing)
	}
	if got := im.CopyState(sha, ""); got != CopyStateMissing {
		t.Errorf("CopyState(no copy, empty path) = %q, want %q", got, CopyStateMissing)
	}

	// The copy exists: it wins even though the source is alive too.
	if _, err := im.copyDemo(source, sha, nil); err != nil {
		t.Fatalf("copyDemo: %v", err)
	}
	if got := im.CopyState(sha, source); got != CopyStateCopied {
		t.Errorf("CopyState(copy + live source) = %q, want %q", got, CopyStateCopied)
	}
	// …and the copy alone (source gone) is still "copied": eviction — not
	// source loss — is what makes an imported match external/missing.
	if got := im.CopyState(sha, gone); got != CopyStateCopied {
		t.Errorf("CopyState(copy, gone source) = %q, want %q", got, CopyStateCopied)
	}

	// Evict: back to external, and missing once the source is gone too.
	if removed, err := im.RemoveManagedDemo(sha); err != nil || !removed {
		t.Fatalf("RemoveManagedDemo = (%v, %v), want (true, nil)", removed, err)
	}
	if got := im.CopyState(sha, source); got != CopyStateExternal {
		t.Errorf("after evict CopyState(live source) = %q, want %q", got, CopyStateExternal)
	}
	if got := im.CopyState(sha, gone); got != CopyStateMissing {
		t.Errorf("after evict CopyState(gone source) = %q, want %q", got, CopyStateMissing)
	}
}

// collectProgress records every spectra:job-progress point the importer
// emits — the observation seam for the copy-stage pins below.
type progressLog struct {
	mu     sync.Mutex
	events []JobProgressEvent
}

func (l *progressLog) emit(name string, data any) {
	if name != EventJobProgress {
		return
	}
	if ev, ok := data.(JobProgressEvent); ok {
		l.mu.Lock()
		l.events = append(l.events, ev)
		l.mu.Unlock()
	}
}

func (l *progressLog) snapshot() []JobProgressEvent {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]JobProgressEvent(nil), l.events...)
}

// TestImportSkipsCopyWhenDisabled pins the copy_on_import=off contract:
// no copy is written (the managed dir stays empty — demo AND .info
// companion), matches.path still holds the SOURCE, the row's sha/size are
// byte-identical to a copied import, StageCopy is never announced (the
// hash→decompress hand-off stays monotone without it), and Reprocess
// reads the source file itself.
func TestImportSkipsCopyWhenDisabled(t *testing.T) {
	copyDir := t.TempDir()
	log := &progressLog{}
	im, st := newCopyTestImporter(t, copyDir, Options{
		CopyEnabled: func() bool { return false },
		Emit:        log.emit,
	})
	content := "skip the copy"
	src := writeDemo(t, "nocopy.dem", content)
	if err := os.WriteFile(strings.TrimSuffix(src, ".dem")+".info", []byte("chat-key"), 0o644); err != nil {
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

	// No file landed anywhere in the managed dir — neither the demo nor
	// its companion (the key stays beside the source).
	if names := dirNames(t, copyDir); len(names) != 0 {
		t.Errorf("managed dir holds %v, want nothing (copy_on_import off)", names)
	}
	// Row content identical to a copied import: path = source, sha, size.
	if m.Path != src {
		t.Errorf("matches.path = %q, want the source %q", m.Path, src)
	}
	if m.SHA256 != shaOf(content) {
		t.Errorf("matches.sha256 = %q, want %q", m.SHA256, shaOf(content))
	}
	if m.Size != int64(len(content)) {
		t.Errorf("matches.size = %d, want %d", m.Size, len(content))
	}
	if m.Status != models.StatusReady {
		t.Errorf("match status = %q, want ready", m.Status)
	}

	// StageCopy never emitted; every point is monotone, hash ≤ 0.10 and
	// the first post-hash point is the parse range's start (0.20).
	var last float64
	sawCopy := false
	afterHash := false
	for _, ev := range log.snapshot() {
		if ev.Stage == models.StageCopy {
			sawCopy = true
		}
		if ev.Progress < last {
			t.Errorf("progress regressed: %v → %v at stage %q", last, ev.Progress, ev.Stage)
		}
		last = ev.Progress
		switch ev.Stage {
		case models.StageHash:
			if ev.Progress > progressHashEnd {
				t.Errorf("hash progress %v > %v", ev.Progress, progressHashEnd)
			}
		case models.StageDecompress, models.StageParse:
			if ev.Progress < progressParseStart {
				t.Errorf("stage %q progress %v < %v without a copy stage in between", ev.Stage, ev.Progress, progressParseStart)
			}
			afterHash = true
		}
	}
	if sawCopy {
		t.Error("StageCopy announced despite copy_on_import off")
	}
	if !afterHash {
		t.Error("no parse-range progress points recorded")
	}
	if last != progressAnalyze {
		t.Errorf("last progress point = %v, want the analyze step %v", last, progressAnalyze)
	}

	// Reprocess reads the SOURCE (there is nothing else to read).
	reID, err := im.Reprocess(job.MatchID)
	if err != nil {
		t.Fatalf("Reprocess: %v", err)
	}
	if reJob := waitStatus(t, st, reID, models.JobDone); reJob.Path != src {
		t.Errorf("reprocess path = %q, want the source %q", reJob.Path, src)
	}
	if names := dirNames(t, copyDir); len(names) != 0 {
		t.Errorf("reprocess created a copy despite copy_on_import off: %v", names)
	}
}

// TestFailedImportRemovesCreatedCopy pins delete-on-fail for every
// terminal exit BEFORE the match row is saved: the copy this job created
// is gone afterwards (no hoarding, no orphan), while the source file is
// never touched. Each subtest injects one failure point.
func TestFailedImportRemovesCreatedCopy(t *testing.T) {
	t.Run("parse failure", func(t *testing.T) {
		copyDir := t.TempDir()
		parseErr := errors.New("demoinfocs: not really a demo")
		im, st := newCopyTestImporter(t, copyDir, Options{
			Parse: func(context.Context, io.Reader, extract.ParseOptions) (*models.ExtractedMatch, error) {
				return nil, parseErr
			},
		})
		src := writeDemo(t, "badparse.dem", "will not parse")
		ids := im.Enqueue([]string{src})
		job := waitStatus(t, st, ids[0], models.JobFailed)
		if !strings.Contains(job.Error, "Couldn't read this file") {
			t.Errorf("job error = %q, want the read-failure framing", job.Error)
		}
		waitDirEmpty(t, copyDir)
		if _, err := os.Stat(src); err != nil {
			t.Errorf("source file was touched by a failed import: %v", err)
		}
		// The match row itself survives as a failed row (openable, no copy).
		rows, err := st.ListMatches("", "extracted_at", false)
		if err != nil {
			t.Fatalf("ListMatches: %v", err)
		}
		if len(rows) != 1 || rows[0].Status != models.StatusFailed {
			t.Errorf("match rows = %+v, want one failed row", rows)
		}
		if got := im.CopyState(rows[0].SHA256, rows[0].Path); got != CopyStateExternal {
			t.Errorf("failed import's CopyState = %q, want %q (source still there)", got, CopyStateExternal)
		}
	})

	t.Run("cancel while running", func(t *testing.T) {
		copyDir := t.TempDir()
		var calls atomic.Int32
		im, st := newCopyTestImporter(t, copyDir, Options{Parse: blockingParse(0, &calls)})
		id := im.Enqueue([]string{writeDemo(t, "cancelled.dem", "cancel me")})[0]
		waitStatus(t, st, id, models.JobRunning)
		if err := im.Cancel(id); err != nil {
			t.Fatalf("Cancel: %v", err)
		}
		waitStatus(t, st, id, models.JobCancelled)
		waitDirEmpty(t, copyDir)
	})

	// Row-create failure = the orphan case this rule exists for: the copy
	// landed, then the matches insert failed (matches.sha256 UNIQUE — a
	// competing row seeded through the StageCopy point, which fires after
	// the sha dedupe and before CreateMatchRow). Before delete-on-fail the
	// copy stayed behind with no row pointing at it.
	t.Run("row create failure leaves no orphan", func(t *testing.T) {
		copyDir := t.TempDir()
		content := "orphan bait"
		sha := shaOf(content)
		var st *store.Store
		seeded := false
		im, st := newCopyTestImporter(t, copyDir, Options{
			Emit: func(name string, data any) {
				if name != EventJobProgress || seeded {
					return
				}
				ev, ok := data.(JobProgressEvent)
				if !ok || ev.Stage != models.StageCopy {
					return
				}
				seeded = true
				if _, err := st.CreateMatchRow("/seeded/dup.dem", sha, 1); err != nil {
					t.Errorf("seed duplicate sha row: %v", err)
				}
			},
		})
		src := writeDemo(t, "orphan.dem", content)
		ids := im.Enqueue([]string{src})
		job := waitStatus(t, st, ids[0], models.JobFailed)
		if !seeded {
			t.Fatal("duplicate-sha seed never ran (StageCopy point missing)")
		}
		if !strings.Contains(job.Error, "Couldn't save the import") {
			t.Errorf("job error = %q, want the save-failure framing", job.Error)
		}
		waitDirEmpty(t, copyDir)
		rows, err := st.ListMatches("", "extracted_at", false)
		if err != nil {
			t.Fatalf("ListMatches: %v", err)
		}
		if len(rows) != 1 || rows[0].Path != "/seeded/dup.dem" {
			t.Errorf("match rows = %+v, want only the seeded row (no row for the failed import)", rows)
		}
	})

	// Store failure after the row exists: the match row is dropped at the
	// StageStore point, so SetPositionMeta fails affectedOrNotFound —
	// still before SaveExtracted, so the copy goes with the job. (The
	// progress event's matchId is 0 for imports — the reporter is stamped
	// at claim time, before the row exists — so the hook reads the link
	// off the job row instead.)
	t.Run("store failure", func(t *testing.T) {
		copyDir := t.TempDir()
		var st *store.Store
		dropped := false
		im, st := newCopyTestImporter(t, copyDir, Options{
			Emit: func(name string, data any) {
				if name != EventJobProgress || dropped {
					return
				}
				ev, ok := data.(JobProgressEvent)
				if !ok || ev.Stage != models.StageStore {
					return
				}
				var matchID int64
				jobs, err := st.ListJobs()
				if err != nil {
					t.Errorf("list jobs: %v", err)
					return
				}
				for _, j := range jobs {
					if j.ID == ev.JobID {
						matchID = j.MatchID
					}
				}
				if matchID == 0 {
					return
				}
				dropped = true
				if err := st.DeleteMatchData(matchID); err != nil {
					t.Errorf("drop match row: %v", err)
				}
			},
		})
		ids := im.Enqueue([]string{writeDemo(t, "storefail.dem", "store will fail")})
		job := waitStatus(t, st, ids[0], models.JobFailed)
		if !dropped {
			t.Fatal("StageStore point never emitted")
		}
		if !strings.Contains(job.Error, "Couldn't save the import") {
			t.Errorf("job error = %q, want the save-failure framing", job.Error)
		}
		waitDirEmpty(t, copyDir)
	})
}

// TestAnalyzeFailureKeepsCopyAndMatch pins the OTHER side of
// delete-on-fail: a failure PAST SaveExtracted (the analytics pass) keeps
// the match ready and keeps the copy — the data landed, so the backup
// belongs to the match now. The pass is broken by corrupting the rules
// config row it reads first (store.GetConfig), through a second
// connection to the same file-backed database.
func TestAnalyzeFailureKeepsCopyAndMatch(t *testing.T) {
	copyDir := t.TempDir()
	dbPath := filepath.Join(t.TempDir(), "analyze.db")
	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatalf("store.Open: %v", err)
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

	// Seed the config row (GetConfig writes the defaults on first read),
	// then corrupt it: the scan now fails, and im.analyze — the first
	// reader after SaveExtracted — takes the failure.
	if _, err := st.GetConfig(); err != nil {
		t.Fatalf("seed config: %v", err)
	}
	db, err := sql.Open("sqlite", dbPath+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("open side connection: %v", err)
	}
	defer func() { _ = db.Close() }()
	res, err := db.Exec(`UPDATE analysis_config SET trade_window_s = 'corrupt' WHERE id = 1`)
	if err != nil {
		t.Fatalf("corrupt config: %v", err)
	}
	if n, _ := res.RowsAffected(); n != 1 {
		t.Fatalf("config row not corrupted (rows = %d)", n)
	}

	src := writeDemo(t, "analyzefail.dem", "parses fine, analysis breaks")
	ids := im.Enqueue([]string{src})
	job := waitStatus(t, st, ids[0], models.JobFailed)
	if job.Stage != models.StageAnalyze {
		t.Errorf("job stage = %q, want %q", job.Stage, models.StageAnalyze)
	}
	if !strings.Contains(job.Error, "Analysis failed") {
		t.Errorf("job error = %q, want the analysis framing", job.Error)
	}
	// The match stays ready (the failure path only marks the JOB) …
	m := waitMatchStatus(t, st, job.MatchID, models.StatusReady)
	// … and its copy is kept: matchSaved was already true.
	if names := dirNames(t, copyDir); len(names) != 1 {
		t.Errorf("managed dir holds %v, want the copy kept", names)
	}
	if got := im.CopyState(m.SHA256, m.Path); got != CopyStateCopied {
		t.Errorf("CopyState after analysis failure = %q, want %q", got, CopyStateCopied)
	}
}

// TestCopyFileConcurrentSameDst: concurrent copies of the same content
// to the SAME destination both succeed and leave the bytes intact. Every
// writer parks inside its first progress callback — with its OWN temp
// file open (os.CreateTemp, unique per call) — before any byte lands;
// under the old fixed dst+".part" temp all writers would share (and
// truncate) one file, all but the first rename would fail ENOENT, and a
// partial landing could pass for the real copy. BEHAVIOR pin (the
// concurrent-copy guarantee the per-sha gate sits on top of).
func TestCopyFileConcurrentSameDst(t *testing.T) {
	copyDir := t.TempDir()
	dst := filepath.Join(copyDir, "target.dem")
	// Multi-chunk source: io.Copy reads in 32 KiB chunks, so onProgress
	// fires mid-copy — that is where each writer parks.
	src := filepath.Join(t.TempDir(), "src.dem")
	big := make([]byte, 128*1024)
	for i := range big {
		big[i] = byte(i * 7)
	}
	if err := os.WriteFile(src, big, 0o644); err != nil {
		t.Fatalf("write source: %v", err)
	}

	const copies = 4
	parked := make(chan struct{}, copies)
	resume := make(chan struct{})
	errs := make(chan error, copies)
	var wg sync.WaitGroup
	for i := 0; i < copies; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var once sync.Once
			errs <- copyFile(src, dst, func(int64) {
				once.Do(func() {
					parked <- struct{}{}
					<-resume
				})
			})
		}()
	}
	// Every writer is parked with its temp open — channels, not sleeps.
	for i := 0; i < copies; i++ {
		select {
		case <-parked:
		case <-time.After(5 * time.Second):
			t.Fatalf("writer %d never started — concurrent copies must all reach their temp", i+1)
		}
	}
	close(resume)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Errorf("concurrent copyFile: %v, want all nil (unique temps)", err)
		}
	}
	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatalf("read destination: %v", err)
	}
	if !bytes.Equal(got, big) {
		t.Errorf("destination bytes = %d long, correct=%v, want the intact %d source bytes", len(got), bytes.Equal(got, big), len(big))
	}
}

// TestReprocessMissingSourceFailsFast pins the pre-check message and its
// state machine: with the copy evicted AND the source gone, Reprocess
// queues nothing (no parse, no queued flip of the row), reports the exact
// player-facing reason, and records it on an immediately-failed job so the
// Library's problem list shows it.
func TestReprocessMissingSourceFailsFast(t *testing.T) {
	copyDir := t.TempDir()
	var calls atomic.Int32
	im, st := newCopyTestImporter(t, copyDir, Options{
		Parse: func(ctx context.Context, r io.Reader, opts extract.ParseOptions) (*models.ExtractedMatch, error) {
			calls.Add(1)
			return fakeParse(ctx, r, opts)
		},
	})
	src := writeDemo(t, "vanished.dem", "about to disappear")
	imported := waitStatus(t, st, im.Enqueue([]string{src})[0], models.JobDone)
	parsesAfterImport := calls.Load()
	m, err := st.GetMatch(imported.MatchID)
	if err != nil {
		t.Fatalf("GetMatch: %v", err)
	}

	// Evict the copy, then lose the source: state "missing".
	if removed, err := im.RemoveManagedDemo(m.SHA256); err != nil || !removed {
		t.Fatalf("RemoveManagedDemo = (%v, %v), want (true, nil)", removed, err)
	}
	if err := os.Remove(src); err != nil {
		t.Fatalf("remove source: %v", err)
	}
	if got := im.CopyState(m.SHA256, m.Path); got != CopyStateMissing {
		t.Fatalf("CopyState = %q, want %q", got, CopyStateMissing)
	}

	jobsBefore := len(mustJobs(t, st))
	id, err := im.Reprocess(imported.MatchID)
	if id != 0 {
		t.Errorf("Reprocess returned job id %d, want 0 (nothing queued)", id)
	}
	want := fmt.Sprintf("Demo file not found: %s — Spectra's copy was freed. Restore the file, or delete the match.", m.Path)
	if err == nil || err.Error() != want {
		t.Errorf("Reprocess err = %v, want exactly %q", err, want)
	}
	// The row never flipped: still ready with no error text.
	after, err := st.GetMatch(imported.MatchID)
	if err != nil {
		t.Fatalf("GetMatch: %v", err)
	}
	if after.Status != models.StatusReady || after.Error != "" {
		t.Errorf("match after refused Reprocess = (%q, %q), want untouched ready", after.Status, after.Error)
	}
	// Exactly one NEW job row exists — created and failed on the spot
	// (failNewJob), never queued — and it carries the same message.
	jobs := mustJobs(t, st)
	if len(jobs) != jobsBefore+1 {
		t.Fatalf("jobs = %d, want %d (one created-and-failed job)", len(jobs), jobsBefore+1)
	}
	var created models.Job
	found := false
	for _, j := range jobs {
		if j.ID != imported.ID {
			created, found = j, true
			break
		}
	}
	if !found {
		t.Fatal("no new job row beyond the import")
	}
	if created.Status != models.JobFailed || created.Error != want || created.MatchID != imported.MatchID {
		t.Errorf("job = (%q, %q, match %d), want (failed, %q, match %d)",
			created.Status, created.Error, created.MatchID, want, imported.MatchID)
	}
	// The parse never ran (only the import's own parse has, so far).
	if calls.Load() != parsesAfterImport {
		t.Errorf("parse ran %d times, want %d (a missing file must not reach the parser)", calls.Load(), parsesAfterImport)
	}
}

// TestReprocessRecopyAndCreatedFlagGuard covers the re-copy rule and the
// created-flag invariant: with the pref ON a reprocess without a copy
// MAKES one (copy-on-import off imports and evicted copies alike), while
// a failed reprocess never deletes a copy it did not create.
func TestReprocessRecopyAndCreatedFlagGuard(t *testing.T) {
	copyDir := t.TempDir()
	var copyOn atomic.Bool
	var failParse atomic.Bool
	var stages sync.Map // stage name → count
	log := &progressLog{}
	im, st := newCopyTestImporter(t, copyDir, Options{
		CopyEnabled: func() bool { return copyOn.Load() },
		Parse: func(ctx context.Context, r io.Reader, opts extract.ParseOptions) (*models.ExtractedMatch, error) {
			if failParse.Load() {
				return nil, errors.New("injected parse failure")
			}
			return fakeParse(ctx, r, opts)
		},
		Emit: func(name string, data any) {
			log.emit(name, data)
			if name == EventJobProgress {
				if ev, ok := data.(JobProgressEvent); ok && ev.Stage == models.StageCopy {
					stages.Store("copy", 1)
				}
			}
		},
	})

	// Import with the pref OFF: no copy, source-stored row.
	src := writeDemo(t, "recopy.dem", "re-copy me later")
	imported := waitStatus(t, st, im.Enqueue([]string{src})[0], models.JobDone)
	if names := dirNames(t, copyDir); len(names) != 0 {
		t.Fatalf("import with pref off created %v", names)
	}

	// Pref flips back ON: the reprocess re-creates the copy (StageCopy
	// runs, the copy lands) and reads the source it was queued with.
	copyOn.Store(true)
	reID, err := im.Reprocess(imported.MatchID)
	if err != nil {
		t.Fatalf("Reprocess: %v", err)
	}
	reJob := waitStatus(t, st, reID, models.JobDone)
	if reJob.Path != src {
		t.Errorf("reprocess path = %q, want the source %q", reJob.Path, src)
	}
	m, err := st.GetMatch(imported.MatchID)
	if err != nil {
		t.Fatalf("GetMatch: %v", err)
	}
	copyPath := filepath.Join(copyDir, m.SHA256+".dem")
	if got := readFile(t, copyPath); got != "re-copy me later" {
		t.Fatalf("re-copy content = %q", got)
	}
	if _, ok := stages.Load("copy"); !ok {
		t.Error("StageCopy never announced on the re-copy")
	}

	// Now a reprocess whose parse FAILS: the copy existed before this job
	// ran (createdCopy false), so it must SURVIVE — a failed reprocess can
	// never delete the backup that keeps the match alive.
	failParse.Store(true)
	boom, err := im.Reprocess(imported.MatchID)
	if err != nil {
		t.Fatalf("Reprocess (failing): %v", err)
	}
	waitStatus(t, st, boom, models.JobFailed)
	if got := readFile(t, copyPath); got != "re-copy me later" {
		t.Errorf("pre-existing copy after a failed reprocess = %q, want it untouched", got)
	}
	// failJob writes the job row and the match row as two statements —
	// waitStatus saw the job half land, so poll for the match half
	// instead of one-shotting it (a one-shot read races the second
	// write and sees the stale "parsing").
	m2 := waitMatchStatus(t, st, imported.MatchID, models.StatusFailed)
	if got := im.CopyState(m2.SHA256, m2.Path); got != CopyStateCopied {
		t.Errorf("CopyState after failed reprocess = %q, want %q", got, CopyStateCopied)
	}
}
