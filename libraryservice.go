package main

import (
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
// copy of the demo (the copy-on-import file under data.DemosDir) is
// removed from disk as well — a user's original file is never ours to
// delete, so rows without a managed copy remove nothing. A missing match
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
type DataInfo struct {
	DBPath        string `json:"dbPath"`
	MatchesDir    string `json:"matchesDir"`
	ParserVersion string `json:"parserVersion"`
}

// GetDataInfo returns the on-disk data locations and the parser version
// recorded per match (PRD: users must know where their data lives).
func (s *LibraryService) GetDataInfo() DataInfo {
	return DataInfo{
		DBPath:        data.DBPath(),
		MatchesDir:    data.MatchesDir(),
		ParserVersion: extract.ParserVersion,
	}
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
