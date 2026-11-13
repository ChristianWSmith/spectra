package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/adrg/xdg"
	"github.com/wailsapp/wails/v3/pkg/services/kvstore"

	"github.com/ChristianWSmith/spectra/internal/budget"
	"github.com/ChristianWSmith/spectra/internal/data"
	"github.com/ChristianWSmith/spectra/internal/extract"
	"github.com/ChristianWSmith/spectra/internal/library"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// newDemoDirsService builds the slice of LibraryService the demo-dir
// methods touch (the kvstore), in memory — no prefs file is written.
func newDemoDirsService(t *testing.T) *LibraryService {
	t.Helper()
	return &LibraryService{kvs: kvstore.New()}
}

// TestGetDemoDirsDefaults pins the unset-pref contract: no stored list
// means "defaults in effect" (Custom=false) and the effective list is
// exactly library.DefaultDemoDirs (Downloads + CS2's replay folder).
func TestGetDemoDirsDefaults(t *testing.T) {
	svc := newDemoDirsService(t)
	got := svc.GetDemoDirs()
	if got.Custom {
		t.Error("unset pref reported Custom=true")
	}
	want := library.DefaultDemoDirs()
	if len(got.Dirs) != len(want) {
		t.Fatalf("default dirs = %v, want %v", got.Dirs, want)
	}
	for i := range want {
		if got.Dirs[i] != want[i] {
			t.Errorf("default dirs[%d] = %q, want %q", i, got.Dirs[i], want[i])
		}
	}
}

// TestDemoDirsRoundTrip: Set normalizes (absolute, cleaned, deduped,
// blanks dropped) and persists; Get then reports the stored list as
// custom; Reset drops back to the defaults.
func TestDemoDirsRoundTrip(t *testing.T) {
	svc := newDemoDirsService(t)
	base := t.TempDir()
	a := filepath.Join(base, "new")
	b := filepath.Join(base, "old")
	// Whitespace-padded duplicate + a path with a redundant segment: all
	// three normalize to [a b].
	if err := svc.SetDemoDirs([]string{a, " " + a + " ", filepath.Join(base, "x", "..", "old"), ""}); err != nil {
		t.Fatalf("SetDemoDirs: %v", err)
	}
	got := svc.GetDemoDirs()
	if !got.Custom {
		t.Error("stored list reported Custom=false")
	}
	want := []string{a, b}
	if len(got.Dirs) != len(want) {
		t.Fatalf("stored dirs = %v, want %v", got.Dirs, want)
	}
	for i := range want {
		if got.Dirs[i] != want[i] {
			t.Errorf("stored dirs[%d] = %q, want %q", i, got.Dirs[i], want[i])
		}
	}

	// Watching nothing is a legitimate custom state (empties dropped, the
	// list itself survives as an empty array).
	if err := svc.SetDemoDirs([]string{"", "  "}); err != nil {
		t.Fatalf("SetDemoDirs(empty): %v", err)
	}
	if got := svc.GetDemoDirs(); !got.Custom || len(got.Dirs) != 0 {
		t.Fatalf("empty list = %+v, want Custom with no dirs", got)
	}

	if err := svc.ResetDemoDirs(); err != nil {
		t.Fatalf("ResetDemoDirs: %v", err)
	}
	if got := svc.GetDemoDirs(); got.Custom {
		t.Error("after reset Custom is still true")
	}
}

// TestGetDemoDirsCorruptPref: a pref that is not a list of strings must
// fall back to the defaults instead of breaking the settings tab.
func TestGetDemoDirsCorruptPref(t *testing.T) {
	svc := newDemoDirsService(t)
	if err := svc.kvs.Set(prefsDemoDirsKey, "not a list"); err != nil {
		t.Fatalf("seed corrupt pref: %v", err)
	}
	got := svc.GetDemoDirs()
	if got.Custom {
		t.Error("corrupt pref reported Custom=true")
	}
	if len(got.Dirs) != len(library.DefaultDemoDirs()) {
		t.Errorf("corrupt pref dirs = %v, want the defaults", got.Dirs)
	}
}

// TestPrefStrings covers the kvstore value shapes the demo-dir pref can
// arrive in (in-memory []string vs. JSON-round-tripped []any).
func TestPrefStrings(t *testing.T) {
	tests := []struct {
		name string
		in   any
		want []string
		ok   bool
	}{
		{"absent", nil, nil, false},
		{"not a list", "x", nil, false},
		{"in-memory shape", []string{"/a", "/b"}, []string{"/a", "/b"}, true},
		{"json shape", []any{"/a", "/b"}, []string{"/a", "/b"}, true},
		{"empty json list", []any{}, []string{}, true},
		{"mixed types", []any{"/a", 42}, nil, false},
		{"list of numbers", []any{1, 2}, nil, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := prefStrings(tt.in)
			if ok != tt.ok {
				t.Fatalf("prefStrings(%v) ok = %v, want %v", tt.in, ok, tt.ok)
			}
			if !ok {
				return
			}
			if len(got) != len(tt.want) {
				t.Fatalf("prefStrings(%v) = %q, want %q", tt.in, got, tt.want)
			}
			for i := range tt.want {
				if got[i] != tt.want[i] {
					t.Errorf("prefStrings[%d] = %q, want %q", i, got[i], tt.want[i])
				}
			}
		})
	}
}

// TestPrefBool covers the kvstore value shapes the copy-on-import pref
// can arrive in. ok is what tells the caller "unset/corrupt → use MY
// default" — for a default-true pref, reading a corrupt value as plain
// false would silently stop making backups.
func TestPrefBool(t *testing.T) {
	tests := []struct {
		name string
		in   any
		want bool
		ok   bool
	}{
		{"absent", nil, false, false},
		{"true", true, true, true},
		{"false", false, false, true},
		{"string", "true", false, false},
		{"number", float64(1), false, false},
		{"list", []any{}, false, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := prefBool(tt.in)
			if ok != tt.ok || (ok && got != tt.want) {
				t.Errorf("prefBool(%#v) = (%v, %v), want (%v, %v)", tt.in, got, ok, tt.want, tt.ok)
			}
		})
	}
}

// TestDemoCopyOnImportRoundTrip pins the Settings toggle's contract:
// unset (or corrupt) reads as COPY (the default), Set false/true sticks,
// and the pipeline-side closure (library.Options.CopyEnabled) reads the
// SAME key — the display half and the decision half never disagree.
func TestDemoCopyOnImportRoundTrip(t *testing.T) {
	svc := newDemoDirsService(t)
	enabled := copyOnImportPref(svc.kvs)

	if !svc.GetDemoCopyOnImport() {
		t.Error("unset pref reported copy-off, want the default (copy on)")
	}
	if !enabled() {
		t.Error("pipeline closure reported copy-off for an unset pref")
	}
	if err := svc.SetDemoCopyOnImport(false); err != nil {
		t.Fatalf("SetDemoCopyOnImport(false): %v", err)
	}
	if svc.GetDemoCopyOnImport() {
		t.Error("Get after Set(false) still reports copy-on")
	}
	if enabled() {
		t.Error("pipeline closure still reports copy-on after Set(false)")
	}
	if err := svc.SetDemoCopyOnImport(true); err != nil {
		t.Fatalf("SetDemoCopyOnImport(true): %v", err)
	}
	if !svc.GetDemoCopyOnImport() || !enabled() {
		t.Error("Set(true) did not stick (either reader)")
	}

	// A corrupt value falls back to the DEFAULT — copying — never to
	// silently skipping copies.
	if err := svc.kvs.Set(prefsCopyOnImportKey, "not a bool"); err != nil {
		t.Fatalf("seed corrupt pref: %v", err)
	}
	if !svc.GetDemoCopyOnImport() {
		t.Error("corrupt pref reported copy-off, want the default (copy on)")
	}
	if !enabled() {
		t.Error("pipeline closure reported copy-off for a corrupt pref")
	}
}

// TestParallelWorkRoundTrip pins the Settings control's contract:
// unset (or corrupt) reads as the DEFAULT — this machine's parallelism
// (budget.MachineTokens) — Set sticks, out-of-range values clamp into
// [1, Max] on the way in, the pipeline-side read (parallelWorkPref —
// what main sizes the budget with) reads the SAME key, and Set resizes
// the LIVE work-token budget (b.Size follows): display half, stored
// pref and pool never disagree. BEHAVIOR pin of the new pref.
func TestParallelWorkRoundTrip(t *testing.T) {
	b := budget.New(budget.MachineTokens())
	svc := &LibraryService{kvs: kvstore.New(), budget: b}
	max := budget.MachineTokens()

	if got := svc.GetParallelWork(); got.Value != max || got.Max != max {
		t.Errorf("unset pref = %+v, want {Value:%d Max:%d} (default = this machine's parallelism)", got, max, max)
	}
	if got := parallelWorkPref(svc.kvs); got != max {
		t.Errorf("pipeline read = %d, want the default %d", got, max)
	}

	if err := svc.SetParallelWork(1); err != nil {
		t.Fatalf("SetParallelWork(1): %v", err)
	}
	if got := svc.GetParallelWork().Value; got != 1 {
		t.Errorf("Get after Set(1) = %d, want 1", got)
	}
	if got := parallelWorkPref(svc.kvs); got != 1 {
		t.Errorf("pipeline read after Set(1) = %d, want 1 (one heavy task at a time)", got)
	}
	if got := b.Size(); got != 1 {
		t.Errorf("live budget after Set(1) = %d, want 1 (the pool follows the setting)", got)
	}

	// Above the ceiling clamps — never more than the machine's parallelism.
	if err := svc.SetParallelWork(max + 5); err != nil {
		t.Fatalf("SetParallelWork(max+5): %v", err)
	}
	if got := svc.GetParallelWork().Value; got != max {
		t.Errorf("Get after Set(max+5) = %d, want the ceiling %d", got, max)
	}
	if got, size := parallelWorkPref(svc.kvs), b.Size(); got != max || size != max {
		t.Errorf("pipeline = %d, live budget = %d, want the ceiling %d", got, size, max)
	}

	// Below the floor clamps to the single-task rung.
	if err := svc.SetParallelWork(-3); err != nil {
		t.Fatalf("SetParallelWork(-3): %v", err)
	}
	if got := svc.GetParallelWork().Value; got != 1 || parallelWorkPref(svc.kvs) != 1 || b.Size() != 1 {
		t.Errorf("after Set(-3): Get = %d, pipeline = %d, budget = %d, want 1/1/1",
			svc.GetParallelWork().Value, parallelWorkPref(svc.kvs), b.Size())
	}

	// A corrupt value falls back to the DEFAULT (the machine's
	// parallelism), never to 0 (which would stall every heavy task) and
	// never to a stale guess.
	if err := svc.kvs.Set(prefsParallelWorkKey, "lots"); err != nil {
		t.Fatalf("seed corrupt pref: %v", err)
	}
	if got := svc.GetParallelWork().Value; got != max || parallelWorkPref(svc.kvs) != max {
		t.Errorf("corrupt pref: Get = %d, pipeline = %d, want the default %d",
			svc.GetParallelWork().Value, parallelWorkPref(svc.kvs), max)
	}
}

// TestSetParallelWorkAppliesToQueuedJobs pins the owner liveness rule
// end to end: a resize applies to work already QUEUED. With the budget
// at 1, job2 cannot even claim (it stays queued — never a fake
// "running"), and SetParallelWork(2) both resizes the live pool and
// wakes the import pool, so job2 claims AND takes a token immediately —
// the token comes AFTER the claim (the token-before-compute-lock order
// is untouched; see library.worker).
func TestSetParallelWorkAppliesToQueuedJobs(t *testing.T) {
	if budget.MachineTokens() < 2 {
		t.Skipf("machine has %d token(s) — cannot grow the budget past the ceiling", budget.MachineTokens())
	}
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	b := budget.New(1)
	entered := make(chan struct{}, 2)
	block := make(chan struct{})
	release := sync.OnceFunc(func() { close(block) })
	defer release()
	parse := func(ctx context.Context, r io.Reader, opts extract.ParseOptions) (*models.ExtractedMatch, error) {
		entered <- struct{}{} // announce parse ENTRY (token already held)
		select {
		case <-block:
		case <-ctx.Done():
		}
		return stubParse(ctx, r, opts)
	}
	imp := library.New(library.Options{
		Store:         st,
		Parse:         parse,
		ParserVersion: "test",
		SidecarDir:    t.TempDir(),
		CopyDir:       t.TempDir(),
		Concurrency:   b.Size, // production's seam: the budget's live size
		Budget:        b,
	})
	t.Cleanup(imp.Shutdown)
	svc := &LibraryService{st: st, imp: imp, kvs: kvstore.New(), budget: b}

	ids := make([]string, 0, 2)
	for _, name := range []string{"pw-1.dem", "pw-2.dem"} {
		p := filepath.Join(t.TempDir(), name)
		if err := os.WriteFile(p, []byte(name), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
		ids = append(ids, p)
	}
	jobIDs := imp.Enqueue(ids)
	if len(jobIDs) != 2 {
		t.Fatalf("Enqueue returned %d ids, want 2", len(jobIDs))
	}

	// Job1 claims at budget size 1, takes the token, parks in parse.
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("job1 never entered parse — the budget never handed out its token")
	}
	// Job2 cannot claim above the bound: it stays QUEUED (honest
	// display — a job waiting for a budget slot has not started).
	if j, err := st.ListJobs(); err != nil {
		t.Fatalf("ListJobs: %v", err)
	} else {
		for _, job := range j {
			if job.ID == jobIDs[1] && job.Status != models.JobQueued {
				t.Fatalf("job2 status = %q, want queued while the budget admits one task", job.Status)
			}
		}
	}

	// The Settings change: persist (clamped) → resize the live pool →
	// wake the import pool. Job2 must claim AND get a token from the
	// grow alone.
	if err := svc.SetParallelWork(2); err != nil {
		t.Fatalf("SetParallelWork(2): %v", err)
	}
	if got := b.Size(); got != 2 {
		t.Errorf("live budget after Set(2) = %d, want 2", got)
	}
	if got := svc.GetParallelWork().Value; got != 2 {
		t.Errorf("Get after Set(2) = %d, want 2", got)
	}
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("queued job never entered parse after the budget grew — the resize did not apply to queued work")
	}
	release() // let both parses finish (Shutdown in cleanup then joins cleanly)
}

// TestListMatchesPageStampsCopyState pins the ONE list-side annotation:
// every row the Library renders carries its fs-derived CopyState
// (copied/external/missing), while the store's own unbounded ListMatches
// stays unstamped — the field is service-owned, the store never fills it
// (scanner/MatchPicker readers don't pay for the stats).
func TestListMatchesPageStampsCopyState(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	copyDir := t.TempDir()
	imp := library.New(library.Options{
		Store:         st,
		Parse:         stubParse,
		ParserVersion: "test",
		SidecarDir:    t.TempDir(),
		CopyDir:       copyDir,
	})
	t.Cleanup(imp.Shutdown)
	svc := &LibraryService{st: st, imp: imp}

	copiedSrc := filepath.Join(t.TempDir(), "copied.dem")
	if err := os.WriteFile(copiedSrc, []byte("a"), 0o644); err != nil {
		t.Fatalf("write source: %v", err)
	}
	externalSrc := filepath.Join(t.TempDir(), "external.dem")
	if err := os.WriteFile(externalSrc, []byte("b"), 0o644); err != nil {
		t.Fatalf("write source: %v", err)
	}
	missingSrc := filepath.Join(t.TempDir(), "gone.dem") // never written
	if err := os.WriteFile(filepath.Join(copyDir, "sha-copied.dem"), []byte("a"), 0o644); err != nil {
		t.Fatalf("write copy: %v", err)
	}

	idCopied, err := st.CreateMatchRow(copiedSrc, "sha-copied", 1)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	idExternal, err := st.CreateMatchRow(externalSrc, "sha-external", 1)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	idMissing, err := st.CreateMatchRow(missingSrc, "sha-missing", 1)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}

	page, err := svc.ListMatchesPage("", "extracted_at", false, 0, 0, store.MatchListFilter{})
	if err != nil {
		t.Fatalf("ListMatchesPage: %v", err)
	}
	want := map[int64]string{idCopied: "copied", idExternal: "external", idMissing: "missing"}
	seen := map[int64]bool{}
	for _, row := range page.Rows {
		w, ok := want[row.ID]
		if !ok {
			continue
		}
		seen[row.ID] = true
		if row.CopyState != w {
			t.Errorf("row %d CopyState = %q, want %q", row.ID, row.CopyState, w)
		}
	}
	for id := range want {
		if !seen[id] {
			t.Errorf("match %d missing from the page", id)
		}
	}

	// The unbounded store read stays unstamped (the field is service-owned).
	rows, err := st.ListMatches("", "extracted_at", false)
	if err != nil {
		t.Fatalf("ListMatches: %v", err)
	}
	for _, row := range rows {
		if row.CopyState != "" {
			t.Errorf("store.ListMatches row %d CopyState = %q, want \"\" (the store never fills it)", row.ID, row.CopyState)
		}
	}
}

// TestDeleteDemoFileGatesOnConfiguredDirs pins the service wiring behind
// the Library's "Delete from disk" button: the effective import dirs
// (the pref) are what gate the delete — a demo under a configured dir is
// removed, a demo anywhere else is refused with an error and left alone.
func TestDeleteDemoFileGatesOnConfiguredDirs(t *testing.T) {
	svc := newDemoDirsService(t)
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	svc.sc = library.NewScanner(library.ScannerOptions{
		Store:    st,
		DataRoot: filepath.Join(t.TempDir(), "spectra-data"),
	})

	configured := t.TempDir()
	elsewhere := t.TempDir()
	if err := svc.SetDemoDirs([]string{configured}); err != nil {
		t.Fatalf("SetDemoDirs: %v", err)
	}
	inside := filepath.Join(configured, "demo.dem")
	outside := filepath.Join(elsewhere, "demo.dem")
	for _, p := range []string{inside, outside} {
		if err := os.WriteFile(p, []byte("demo bytes"), 0o644); err != nil {
			t.Fatalf("write %s: %v", p, err)
		}
	}

	if err := svc.DeleteDemoFile(inside); err != nil {
		t.Fatalf("DeleteDemoFile(configured dir): %v", err)
	}
	if _, err := os.Lstat(inside); !os.IsNotExist(err) {
		t.Errorf("configured-dir demo survived (err=%v)", err)
	}

	if err := svc.DeleteDemoFile(outside); err == nil {
		t.Error("DeleteDemoFile outside every import dir succeeded")
	}
	if _, err := os.Lstat(outside); err != nil {
		t.Errorf("outside demo removed despite the refusal: %v", err)
	}
}

// redirectDataRoot points XDG's data home at a temp dir for one test
// (the mappackservice_test.go pattern) so data.DemosDir/MatchesDir land
// in the test's own directory — these tests never touch the user's real
// data.
func redirectDataRoot(t *testing.T) {
	t.Helper()
	prev := xdg.DataHome
	xdg.DataHome = t.TempDir()
	t.Cleanup(func() { xdg.DataHome = prev })
}

// stubParse stands in for extract.Parse in tests that never enqueue a
// job (the copy-dir methods below only touch the filesystem).
func stubParse(_ context.Context, _ io.Reader, _ extract.ParseOptions) (*models.ExtractedMatch, error) {
	return &models.ExtractedMatch{}, nil
}

// TestEvictDemoCopy pins the "Free copy" action end to end: the managed
// demo AND its .info companion are removed, while the stored source file,
// the match's sidecar directory and the match row itself are all left
// alone. A second evict is (0, nil) — not an error — and a match with no
// row surfaces store.ErrNotFound.
func TestEvictDemoCopy(t *testing.T) {
	redirectDataRoot(t)
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	imp := library.New(library.Options{
		Store:         st,
		Parse:         stubParse,
		ParserVersion: "test",
		SidecarDir:    t.TempDir(),
		CopyDir:       data.DemosDir(),
	})
	t.Cleanup(imp.Shutdown)
	svc := &LibraryService{st: st, imp: imp, kvs: kvstore.New()}

	content := "demo bytes to evict"
	sha := fmt.Sprintf("%x", sha256.Sum256([]byte(content)))
	src := filepath.Join(t.TempDir(), "original.dem")
	if err := os.WriteFile(src, []byte(content), 0o644); err != nil {
		t.Fatalf("write source: %v", err)
	}
	const size = 4096 // the size the match row records (what freeing returns)
	matchID, err := st.CreateMatchRow(src, sha, size)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	copyPath := filepath.Join(data.DemosDir(), sha+".dem")
	companion := filepath.Join(data.DemosDir(), sha+".info")
	for _, p := range []string{copyPath, companion} {
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", p, err)
		}
	}
	sidecarDir := filepath.Join(data.MatchesDir(), strconv.FormatInt(matchID, 10))
	marker := filepath.Join(sidecarDir, "meta.json")
	if err := os.MkdirAll(sidecarDir, 0o755); err != nil {
		t.Fatalf("mkdir sidecar: %v", err)
	}
	if err := os.WriteFile(marker, []byte("{}"), 0o644); err != nil {
		t.Fatalf("write sidecar marker: %v", err)
	}
	if got := imp.CopyState(sha, src); got != "copied" {
		t.Fatalf("CopyState before evict = %q, want copied", got)
	}

	freed, err := svc.EvictDemoCopy(matchID)
	if err != nil {
		t.Fatalf("EvictDemoCopy: %v", err)
	}
	if freed != size {
		t.Errorf("freed = %d, want the match's size %d", freed, size)
	}
	// The copy and its companion are gone…
	for _, p := range []string{copyPath, companion} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%s survived the evict (err=%v)", p, err)
		}
	}
	// …while everything else stays: source, sidecars, match row.
	if _, err := os.Stat(src); err != nil {
		t.Errorf("stored source was touched: %v", err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Errorf("sidecar dir was touched: %v", err)
	}
	m, err := st.GetMatch(matchID)
	if err != nil {
		t.Fatalf("GetMatch after evict: %v", err)
	}
	if m.Path != src || m.SHA256 != sha || m.Size != size {
		t.Errorf("match row after evict = (path %q, sha %q, size %d), want unchanged", m.Path, m.SHA256, m.Size)
	}
	if got := imp.CopyState(m.SHA256, m.Path); got != "external" {
		t.Errorf("CopyState after evict = %q, want external (source still there)", got)
	}

	// Evicting again is a no-op that reports honestly, not an error.
	freed, err = svc.EvictDemoCopy(matchID)
	if err != nil || freed != 0 {
		t.Errorf("second EvictDemoCopy = (%d, %v), want (0, nil)", freed, err)
	}
	// An unknown match is a real error (the caller showed a row that is
	// no longer there).
	if _, err := svc.EvictDemoCopy(999999); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("EvictDemoCopy(unknown) err = %v, want store.ErrNotFound", err)
	}
}

// TestFreeAllDemoCopiesAndDataInfo pins Settings → Data's bulk free:
// GetDataInfo counts/sums the managed copy dir in one readdir, the free
// removes exactly those files (everything under data.DemosDir is
// spectra' property) and reports the bytes, a second call is (0, nil),
// and sidecar data is never in scope.
func TestFreeAllDemoCopiesAndDataInfo(t *testing.T) {
	redirectDataRoot(t)
	svc := &LibraryService{kvs: kvstore.New()}
	demosDir := data.DemosDir()

	files := map[string]int{
		"aaa.dem":     100,
		"bbb.dem.zst": 50,
		"aaa.info":    10, // companion: same dir, same sweep
	}
	var wantBytes int64
	for name, n := range files {
		if err := os.WriteFile(filepath.Join(demosDir, name), bytes.Repeat([]byte{'x'}, n), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
		wantBytes += int64(n)
	}
	sidecarMarker := filepath.Join(data.MatchesDir(), "7", "meta.json")
	if err := os.MkdirAll(filepath.Dir(sidecarMarker), 0o755); err != nil {
		t.Fatalf("mkdir sidecar: %v", err)
	}
	if err := os.WriteFile(sidecarMarker, []byte("{}"), 0o644); err != nil {
		t.Fatalf("write sidecar marker: %v", err)
	}

	info := svc.GetDataInfo()
	if info.DemosDir != demosDir {
		t.Errorf("DataInfo.demosDir = %q, want %q", info.DemosDir, demosDir)
	}
	if info.DemoCount != len(files) || info.DemoBytes != wantBytes {
		t.Errorf("DataInfo demos = (%d files, %d bytes), want (%d, %d)",
			info.DemoCount, info.DemoBytes, len(files), wantBytes)
	}
	if info.DBPath == "" || info.MatchesDir == "" || info.ParserVersion == "" {
		t.Errorf("DataInfo missing locations/version: %+v", info)
	}

	freed, err := svc.FreeAllDemoCopies()
	if err != nil {
		t.Fatalf("FreeAllDemoCopies: %v", err)
	}
	if freed != wantBytes {
		t.Errorf("freed = %d, want %d", freed, wantBytes)
	}
	if entries, err := os.ReadDir(demosDir); err != nil || len(entries) != 0 {
		t.Errorf("copy dir after free = %v (err %v), want empty", entries, err)
	}
	if _, err := os.Stat(sidecarMarker); err != nil {
		t.Errorf("sidecar data was swept too: %v", err)
	}
	freed, err = svc.FreeAllDemoCopies()
	if err != nil || freed != 0 {
		t.Errorf("second FreeAllDemoCopies = (%d, %v), want (0, nil)", freed, err)
	}
}
