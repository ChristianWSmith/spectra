package main

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/ChristianWSmith/spectra/internal/data"
	"github.com/ChristianWSmith/spectra/internal/extract"
	"github.com/ChristianWSmith/spectra/internal/library"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// LibraryService is the frontend-facing library surface: import (dialog +
// paths), the match list, delete/reprocess, job control, and the raw-data
// inspectors. Thin delegate over internal/store and the import pipeline.
type LibraryService struct {
	st  *store.Store
	imp *library.Importer
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
// argument order (invalid paths become immediately-failed jobs).
func (s *LibraryService) ImportPaths(paths []string) []int64 {
	return s.imp.Enqueue(paths)
}

// ListMatches returns the searchable, sortable library list.
func (s *LibraryService) ListMatches(query, sortKey string, desc bool) ([]models.MatchSummary, error) {
	return s.st.ListMatches(query, sortKey, desc)
}

// DeleteMatch removes a match and its extracted data, including the
// per-match position sidecar directory (best-effort — the delete
// cascade removes the directory). When deleteOriginal is set the source
// demo file is removed from disk as well — its path is looked up before
// the row is deleted. A missing match surfaces store.ErrNotFound.
func (s *LibraryService) DeleteMatch(id int64, deleteOriginal bool) error {
	var path string
	if deleteOriginal {
		m, err := s.st.GetMatch(id)
		if err != nil {
			return err
		}
		path = m.Path
	}
	if err := s.st.DeleteMatchData(id); err != nil {
		return err
	}
	_ = os.RemoveAll(filepath.Join(data.MatchesDir(), strconv.FormatInt(id, 10)))
	if deleteOriginal && path != "" {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

// Reprocess queues a re-parse of a match's original demo file.
func (s *LibraryService) Reprocess(id int64) (int64, error) {
	return s.imp.Reprocess(id)
}

// CancelJob cancels a queued or running job.
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
