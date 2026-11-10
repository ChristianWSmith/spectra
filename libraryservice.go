package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/services/kvstore"

	"github.com/ChristianWSmith/spectra/internal/data"
	"github.com/ChristianWSmith/spectra/internal/extract"
	"github.com/ChristianWSmith/spectra/internal/library"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// LibraryService is the frontend-facing library surface: import (dialog +
// paths), the import-dir demo list, the match list, delete/reprocess,
// job control, and the raw-data inspectors. Thin delegate over
// internal/store and the import pipeline.
type LibraryService struct {
	st  *store.Store
	imp *library.Importer
	sc  *library.Scanner
	kvs *kvstore.KVStoreService
	app *application.App
}

// ImportDialog opens the native file picker for CS2 demos (.dem, .dem.zst)
// and returns the selected paths; an empty slice means cancel. Filtering
// happens client-side too — Enqueue validates again for drops/typed paths.
func (s *LibraryService) ImportDialog() []string {
	paths, err := s.app.Dialog.OpenFile().
		AddFilter("CS2 demos", "*.dem;*.dem.zst").
		PromptForMultipleSelection()
	if err != nil || len(paths) == 0 {
		return []string{}
	}
	return paths
}

// ImportPaths queues one import job per path and returns the job IDs in
// argument order (invalid paths become immediately-failed jobs). A path
// that already has a non-terminal job is MERGED into it — the existing
// id comes back, no duplicate job (see library.Importer.Enqueue).
func (s *LibraryService) ImportPaths(paths []string) []int64 {
	return s.imp.Enqueue(paths)
}

// --- Import dirs (Settings → "Import dirs") ----------------------------------

// DemoDirsResult is Settings' import-dirs list: Dirs is the effective
// list — the stored pref, or the defaults when Custom is false.
type DemoDirsResult struct {
	Dirs   []string `json:"dirs"`
	Custom bool     `json:"custom"` // false = defaults, nothing persisted
}

// GetDemoDirs returns the import dirs the Library scans for demos. An
// unset (or corrupt) pref means "defaults in effect": the user's Downloads
// folder plus CS2's replay folder, recomputed on every read.
func (s *LibraryService) GetDemoDirs() DemoDirsResult {
	dirs, ok := prefStrings(s.kvs.Get(prefsDemoDirsKey))
	if !ok {
		return DemoDirsResult{Dirs: library.DefaultDemoDirs(), Custom: false}
	}
	return DemoDirsResult{Dirs: dirs, Custom: true}
}

// SetDemoDirs replaces the import-dir list — normalized (absolute,
// cleaned, deduped, empties dropped) — and persists it. From then on the
// stored list, not the defaults, is what the scanner uses; an empty list
// means "scan nothing" (ResetDemoDirs restores the defaults).
func (s *LibraryService) SetDemoDirs(dirs []string) error {
	return s.kvs.Set(prefsDemoDirsKey, library.NormalizeDirs(dirs))
}

// ResetDemoDirs drops the stored list so the defaults apply again (the
// pref is deleted, not overwritten: future default changes keep flowing).
func (s *LibraryService) ResetDemoDirs() error {
	return s.kvs.Delete(prefsDemoDirsKey)
}

// GetDemoCopyOnImport reports whether imports copy the demo into
// data.DemosDir (the copy Reprocess survives on). Unset or corrupt pref
// ⇒ true — copying is the default and a broken pref never silently turns
// backups off. The pipeline reads the same pref per job
// (library.Options.CopyEnabled), so this is the display half of it.
func (s *LibraryService) GetDemoCopyOnImport() bool {
	enabled, ok := prefBool(s.kvs.Get(prefsCopyOnImportKey))
	return !ok || enabled
}

// SetDemoCopyOnImport stores the copy-on-import toggle (Settings →
// Import dirs). It applies to jobs from the NEXT process() on — queued
// jobs pick the new value up too, because the importer reads the pref
// per job, never at enqueue time.
func (s *LibraryService) SetDemoCopyOnImport(copy bool) error {
	return s.kvs.Set(prefsCopyOnImportKey, copy)
}

// ChooseDemoDir opens the native folder picker for the import-dir list;
// an empty string means cancel. The caller persists the choice (the
// picker itself is dialogs.go's chooseDirectory, shared with
// MapPackService).
func (s *LibraryService) ChooseDemoDir() string {
	dir, err := chooseDirectory(s.app, "Choose an import directory")
	if err != nil || dir == "" {
		return ""
	}
	return dir
}

// ListDemoFiles scans the configured import dirs for .dem / .dem.zst
// files that are NOT already in the library — recognised imports (by
// path, or by content hash when the demo was imported from elsewhere)
// are omitted, and deleting the match brings the file back on the next
// scan. The walk is bounded — see internal/library Scan for depth/skip/
// hash rules. Missing or unmounted folders simply yield no rows.
func (s *LibraryService) ListDemoFiles() ([]library.DemoFile, error) {
	return s.sc.Scan(s.GetDemoDirs().Dirs)
}

// DeleteDemoFile removes the demo file at path from disk — the "Delete
// from disk" action on an import-dir row in the Library. The scanner
// validates the path before anything is removed (a .dem/.dem.zst file
// under a configured import dir, outside the app's data dir, not a
// match's stored path), so an arbitrary path can never be deleted here;
// every refusal surfaces as an error. The frontend asks for confirmation
// first — this method never deletes silently.
func (s *LibraryService) DeleteDemoFile(path string) error {
	return s.sc.RemoveDemoFile(s.GetDemoDirs().Dirs, path)
}

// ListMatches returns the searchable, sortable library list, narrowed by
// the structured filter (map facet + "has player X" — see
// store.MatchListFilter): the facets AND with each other and with the
// free-text query. This is the one ListMatches binding that forwards a
// filter (other callers use the unconstrained store method).
func (s *LibraryService) ListMatches(query, sortKey string, desc bool, filter store.MatchListFilter) ([]models.MatchSummary, error) {
	return s.st.ListMatches(query, sortKey, desc, filter)
}

// ListMatchesPage returns ONE keyset window of the same list ListMatches
// returns: the rows after afterID (0 = the first window) for the same
// query/sortKey/desc/filter, at most limit rows (0 = the store's default
// window), plus HasNext (another window follows) and the roster rows the
// Library's Matchup column synthesizes `team_<player>` names from (see
// store.ListMatchesPage / models.MatchListPage) — the one binding the
// Library's "Load more" pagination and its single-call list load go
// through. ListMatches itself stays unbounded for its whole-library
// readers (import dedupe, MatchPicker, Settings' recompute list).
//
// Every row also gets its fs-derived CopyState stamped here (bounded:
// ~50 rows × ≤3 stats per row, sub-ms — the ONE list-side annotation; the
// unbounded ListMatches deliberately stays unstamped, see
// models.MatchSummary.CopyState).
func (s *LibraryService) ListMatchesPage(query, sortKey string, desc bool, afterID int64, limit int, filter store.MatchListFilter) (*models.MatchListPage, error) {
	page, err := s.st.ListMatchesPage(query, sortKey, desc, afterID, limit, filter)
	if err != nil {
		return nil, err
	}
	for i := range page.Rows {
		page.Rows[i].CopyState = s.imp.CopyState(page.Rows[i].SHA256, page.Rows[i].Path)
	}
	return page, nil
}

// ListMapNames returns the distinct, non-empty map names in the library
// (A→Z) — the suggestion source for the Library's map facet. The facet
// itself stays a substring LIKE (store.MatchListFilter): a suggestion is
// a shortcut to an exact name, never a constraint on what can be typed.
func (s *LibraryService) ListMapNames() ([]string, error) {
	return s.st.ListMapNames()
}

// DeleteMatch removes a match and its extracted data, including the
// per-match position sidecar directory (best-effort — the delete
// cascade removes the directory). When deleteDemo is set, spectra's OWN
// copy of the demo (the managed copy under data.DemosDir) is removed
// from disk as well — a user's original file is never ours to delete,
// so rows without a managed copy remove nothing. A missing match
// surfaces store.ErrNotFound. The bool reports whether a demo file was
// actually deleted.
func (s *LibraryService) DeleteMatch(id int64, deleteDemo bool) (bool, error) {
	var sha string
	if deleteDemo {
		m, err := s.st.GetMatch(id)
		if err != nil {
			return false, err
		}
		sha = m.SHA256
	}
	if err := s.st.DeleteMatchData(id); err != nil {
		return false, err
	}
	_ = os.RemoveAll(filepath.Join(data.MatchesDir(), strconv.FormatInt(id, 10)))
	if !deleteDemo {
		return false, nil
	}
	return s.imp.RemoveManagedDemo(sha)
}

// EvictDemoCopy frees spectra's OWN copy of a match's demo — the "Free
// copy" action — WITHOUT touching anything else: the match row, its
// sidecars (<matchDir>) and the stored SOURCE path are all left alone
// (RemoveManagedDemo only ever deletes inside data.DemosDir). freedBytes
// is the match's recorded size; no copy at all (already evicted, or
// imported with copy-on-import off) resolves to (0, nil) — evicting twice
// is not an error. Afterwards the match reprocesses from the stored path
// (CopyState "external"), or fails fast in Reprocess's missing-file
// pre-check when the source is gone too ("missing").
func (s *LibraryService) EvictDemoCopy(id int64) (int64, error) {
	m, err := s.st.GetMatch(id)
	if err != nil {
		return 0, err
	}
	removed, err := s.imp.RemoveManagedDemo(m.SHA256)
	if err != nil {
		return 0, err
	}
	if !removed {
		return 0, nil
	}
	return m.Size, nil
}

// Reprocess queues a re-parse of a match's demo file: the managed copy
// when one exists, else the stored path (see Importer.Reprocess). A
// pending job for the same match coalesces into that job's id, and the
// match row shows "queued" until the job claims it (a dequeue hands the
// row back to its previous state).
func (s *LibraryService) Reprocess(id int64) (int64, error) {
	return s.imp.Reprocess(id)
}

// CancelJob cancels a queued or running job — the Library's Cancel
// (running) / Remove (queued) control. A queued job is removed from the
// queue and announced as cancelled; a running one aborts its parse. The
// match/import row is never left stranded — see library.Importer.Cancel
// for the per-outcome state machine.
func (s *LibraryService) CancelJob(id int64) error {
	return s.imp.Cancel(id)
}

// ListJobs returns all jobs, newest first.
func (s *LibraryService) ListJobs() ([]models.Job, error) {
	return s.st.ListJobs()
}

// GetGenericHistogram returns the raw game-event name counts for a match.
func (s *LibraryService) GetGenericHistogram(id int64) ([]models.NameCount, error) {
	return s.st.GetGenericHistogram(id)
}

// GetWarnings returns a match's extraction warnings in order.
func (s *LibraryService) GetWarnings(id int64) ([]string, error) {
	return s.st.GetWarnings(id)
}

// DataInfo describes where Spectra keeps its state — Settings shows it.
// DemosDir/DemoCount/DemoBytes describe the managed copy dir from ONE
// readdir: everything under data.DemosDir is spectra' own property
// (content-hash demo copies + their .info companions), so the count and
// bytes are exactly what "Free all demo copies" reclaims.
type DataInfo struct {
	DBPath        string `json:"dbPath"`
	MatchesDir    string `json:"matchesDir"`
	ParserVersion string `json:"parserVersion"`
	DemosDir      string `json:"demosDir"`
	DemoCount     int    `json:"demoCount"`
	DemoBytes     int64  `json:"demoBytes"`
}

// GetDataInfo returns the on-disk data locations and the parser version
// recorded per match (PRD: users must know where their data lives).
func (s *LibraryService) GetDataInfo() DataInfo {
	demosDir := data.DemosDir()
	count, bytes := countManagedDemoFiles(demosDir)
	return DataInfo{
		DBPath:        data.DBPath(),
		MatchesDir:    data.MatchesDir(),
		ParserVersion: extract.ParserVersion,
		DemosDir:      demosDir,
		DemoCount:     count,
		DemoBytes:     bytes,
	}
}

// countManagedDemoFiles counts the regular files under dir and their
// total size in ONE readdir (the copy dir is flat — no recursion). A
// missing/unreadable dir yields (0, 0): no copies to report, no error to
// surface on a Settings tab.
func countManagedDemoFiles(dir string) (int, int64) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0, 0
	}
	var count int
	var bytes int64
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		count++
		if info, err := e.Info(); err == nil {
			bytes += info.Size()
		}
	}
	return count, bytes
}

// FreeAllDemoCopies removes every file spectra keeps under
// data.DemosDir — Settings → Data's "Free all demo copies" — and reports
// the bytes reclaimed. Everything under that directory is spectra'
// property (see data.DemosDir), so a whole-dir sweep cannot catch a
// match row, a sidecar (<matchDir>) or a user file; matches keep playing
// from their stored data and simply reprocess from their stored source
// afterwards (or hit Reprocess's missing-file pre-check when the source
// is gone too). Callers gate on pending jobs — an import mid-copy would
// land its file after the sweep — and a second call reports (0, nil).
func (s *LibraryService) FreeAllDemoCopies() (int64, error) {
	demosDir := data.DemosDir()
	entries, err := os.ReadDir(demosDir)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	var freed int64
	for _, e := range entries {
		p := filepath.Join(demosDir, e.Name())
		if e.IsDir() {
			continue // spectra never nests the copy dir; leave anything else alone
		}
		info, ierr := e.Info()
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			return freed, fmt.Errorf("free demo copy: %w", err)
		}
		if ierr == nil {
			freed += info.Size()
		}
	}
	return freed, nil
}

// GetGenericEvents returns raw game-event rows for one name ("" = all),
// round < 0 = all rounds, insertion order, paged by limit/offset — the
// Replay landmark feed's generic-event source. Every row is labelled by
// the ONE labeler (eventlabels.go): server_cvar/team payloads are parsed
// there so no second parser exists in the frontend.
func (s *LibraryService) GetGenericEvents(id int64, name string, round int, limit int, offset int) ([]models.GenericEvent, error) {
	rows, err := s.st.GetGenericEvents(id, name, round, limit, offset)
	if err != nil {
		return nil, err
	}
	for i := range rows {
		rows[i].Who, rows[i].Label = labelGenericEvent(rows[i].Name, rows[i].PayloadJSON)
	}
	return rows, nil
}
