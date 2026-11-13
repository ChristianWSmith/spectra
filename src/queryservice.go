package main

import (
	"errors"
	"fmt"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/query"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// QueryService is M5 §2.2: the read-only SQL console (PRD §5.17 power-user
// escape hatch). Runs open a SEPARATE read-only connection (file:…?mode=ro
// + query_only) with a statement timeout and row cap — the write connection
// is never reachable from the console. History + saved queries persist in
// `query_history` / `saved_queries`.
//
// Every row type here is a models type (the shared contract package): the
// SQL engine (internal/query) and the store produce them directly and this
// service only validates input — no re-typing.

// QueryService — see doc comment above.
type QueryService struct {
	st  *store.Store
	app *application.App
}

// Run executes one statement read-only (multi-statement input rejected).
// limit ≤0 uses the default row cap; timeout ≤0 uses the 5 s default.
//
// Failures — single-statement/write-verb rejection, SQL errors, and the
// statement timeout — are reported in QueryResult.Err (so the grid can
// show them AND history records ok=false); the Go error stays reserved for
// harness failures and is nil in practice.
func (s *QueryService) Run(sql string, limit int, timeoutMS int) (models.QueryResult, error) {
	return query.New(s.st).Run(sql, limit, timeoutMS), nil
}

// GetSchema returns tables + columns with notes for the sidebar
// (internal/query attaches the provenance notes).
func (s *QueryService) GetSchema() ([]models.SchemaTableRow, error) {
	return query.New(s.st).Schema()
}

// Saved queries + history.
func (s *QueryService) ListSavedQueries() ([]models.SavedQueryRow, error) {
	return s.st.ListSavedQueries()
}

// ListSavedQueriesPage returns ONE keyset window of the saved-query list
// (the SQL console's "Load more"): the rows strictly after afterName
// ("" = the first window) in name ASC order, at most limit rows (0 = the
// store's default window), plus HasNext (another window follows). The
// cursor is the last row's name — saved names are unique, so no id
// tie-break is needed. ListSavedQueries stays unbounded for
// CommandPalette's whole-list fuzzy search (see store.ListSavedQueriesPage).
func (s *QueryService) ListSavedQueriesPage(afterName string, limit int) (*models.SavedQueryPage, error) {
	return s.st.ListSavedQueriesPage(afterName, limit)
}

func (s *QueryService) SaveQuery(name, sql string) (models.SavedQueryRow, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return models.SavedQueryRow{}, errors.New("query: query name is required")
	}
	if strings.TrimSpace(sql) == "" {
		return models.SavedQueryRow{}, errors.New("query: SQL is required")
	}
	return s.st.SaveQuery(name, sql)
}

func (s *QueryService) DeleteQuery(id int64) error {
	if err := s.st.DeleteQuery(id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("query: no saved query with id %d", id)
		}
		return err
	}
	return nil
}

func (s *QueryService) ListHistory(limit int) ([]models.QueryHistoryRow, error) {
	if limit <= 0 {
		limit = query.HistoryDefault
	}
	return s.st.ListQueryHistory(limit)
}

func (s *QueryService) ClearHistory() error { return s.st.ClearHistory() }
