package main

import (
	"errors"
	"fmt"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/ChristianWSmith/spectra/internal/query"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// QueryService is M5 §2.2: the read-only SQL console (PRD §5.17 power-user
// escape hatch). Runs open a SEPARATE read-only connection (file:…?mode=ro
// + query_only) with a statement timeout and row cap — the write connection
// is never reachable from the console. History + saved queries persist in
// `query_history` / `saved_queries`.

// QueryResult is one console result (columns + row-major values; values are
// JSON scalars — numbers/strings/nil).
type QueryResult struct {
	Columns   []string        `json:"columns"`
	Rows      [][]interface{} `json:"rows"`
	RowCount  int             `json:"rowCount"`  // returned rows (≤ cap)
	Truncated bool            `json:"truncated"` // hit the cap
	MS        int64           `json:"ms"`
	Err       string          `json:"err,omitempty"`
}

// SchemaTable describes one table for the schema browser.
type SchemaTable struct {
	Name    string         `json:"name"`
	Note    string         `json:"note"` // provenance/schema notes for known tables
	Columns []SchemaColumn `json:"columns"`
}

// SchemaColumn is one column + note.
type SchemaColumn struct {
	Name string `json:"name"`
	Type string `json:"type"`
	Note string `json:"note"`
}

// SavedQuery is a named query (scope "sql").
type SavedQuery struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	SQL       string `json:"sql"`
	CreatedAt string `json:"createdAt"`
}

// HistoryEntry is one run.
type HistoryEntry struct {
	ID    int64  `json:"id"`
	SQL   string `json:"sql"`
	MS    int64  `json:"ms"`
	Rows  int    `json:"rows"`
	OK    bool   `json:"ok"`
	RanAt string `json:"ranAt"`
}

// timeFormat is THE timestamp layout every service renders JSON times
// with (query history/saved queries, saved filters, profile history) —
// one const, never a per-service literal.
const timeFormat = "2006-01-02T15:04:05Z07:00"

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
func (s *QueryService) Run(sql string, limit int, timeoutMS int) (QueryResult, error) {
	res := query.New(s.st).Run(sql, limit, timeoutMS)
	return QueryResult{
		Columns: res.Columns, Rows: res.Rows, RowCount: res.RowCount,
		Truncated: res.Truncated, MS: res.MS, Err: res.Err,
	}, nil
}

// GetSchema returns tables + columns with notes for the sidebar.
func (s *QueryService) GetSchema() ([]SchemaTable, error) {
	tables, err := query.New(s.st).Schema()
	if err != nil {
		return nil, err
	}
	out := make([]SchemaTable, len(tables))
	for i, t := range tables {
		st := SchemaTable{Name: t.Name, Note: t.Note}
		st.Columns = make([]SchemaColumn, len(t.Columns))
		for j, c := range t.Columns {
			st.Columns[j] = SchemaColumn{Name: c.Name, Type: c.Type, Note: c.Note}
		}
		out[i] = st
	}
	return out, nil
}

// Saved queries + history.
func (s *QueryService) ListSavedQueries() ([]SavedQuery, error) {
	rows, err := s.st.ListSavedQueries()
	if err != nil {
		return nil, err
	}
	out := make([]SavedQuery, len(rows))
	for i, r := range rows {
		out[i] = SavedQuery{ID: r.ID, Name: r.Name, SQL: r.SQL, CreatedAt: r.CreatedAt.Format(timeFormat)}
	}
	return out, nil
}

func (s *QueryService) SaveQuery(name, sql string) (SavedQuery, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return SavedQuery{}, errors.New("query: query name is required")
	}
	if strings.TrimSpace(sql) == "" {
		return SavedQuery{}, errors.New("query: SQL is required")
	}
	r, err := s.st.SaveQuery(name, sql)
	if err != nil {
		return SavedQuery{}, err
	}
	return SavedQuery{ID: r.ID, Name: r.Name, SQL: r.SQL, CreatedAt: r.CreatedAt.Format(timeFormat)}, nil
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

func (s *QueryService) ListHistory(limit int) ([]HistoryEntry, error) {
	if limit <= 0 {
		limit = query.HistoryDefault
	}
	rows, err := s.st.ListQueryHistory(limit)
	if err != nil {
		return nil, err
	}
	out := make([]HistoryEntry, len(rows))
	for i, r := range rows {
		out[i] = HistoryEntry{ID: r.ID, SQL: r.SQL, MS: r.MS, Rows: r.Rows, OK: r.OK, RanAt: r.RanAt.Format(timeFormat)}
	}
	return out, nil
}

func (s *QueryService) ClearHistory() error { return s.st.ClearHistory() }
