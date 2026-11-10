// Package query is the read-only SQL console session (PRD §5.17
// power-user escape hatch): statement validation + execution on
// the store's separate read-only connection, result mapping with row cap
// and timing, run history, and the schema browser with provenance notes.
//
// Safety layers live in internal/store (documented on RunReadOnly): the
// single-statement/write-verb validator runs BEFORE execution, the session
// connection is `mode=ro` + `query_only` (the write handle is never
// reachable from a console statement), a context deadline is interrupted
// server-side by the driver's progress handler, and reads stop at the row
// cap. This package composes them and owns the console-facing policy:
// defaults (5 000 rows / 5 000 ms), history FIFO depth
// (100, newest kept), and the schema notes for known tables.
package query

import (
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

const (
	// DefaultLimit / DefaultTimeoutMS are the console defaults (bounded by
	// the timeout, default 5 s). Re-exported from the store so
	// the numbers have one owner.
	DefaultLimit     = store.DefaultRowLimit
	DefaultTimeoutMS = store.DefaultTimeoutMS
	// HistoryDefault is the history list page size when callers pass a
	// non-positive limit.
	HistoryDefault = 50
)

// Session is one console session over a store (the console opens its own
// read-only connection lazily inside the store — one per store).
type Session struct {
	st *store.Store
}

// New returns a console session bound to st.
func New(st *store.Store) *Session { return &Session{st: st} }

// Run validates sqlText (single statement, read verbs only), executes it
// read-only with the row cap and statement timeout, and appends a history
// entry — success or failure. The result is models.QueryResult (row-major
// JSON scalars + timing + truncation + an Err string instead of a rejected
// call, so history can record failures too). Defaults are the store's
// (limit ≤0 → DefaultLimit = store.DefaultRowLimit, timeoutMS ≤0 →
// DefaultTimeoutMS): RunReadOnly owns the normalization, this session only
// re-exports the numbers so they have one owner.
func (s *Session) Run(sqlText string, limit, timeoutMS int) models.QueryResult {
	res, err := s.st.RunReadOnly(sqlText, nil, limit, timeoutMS)
	out := models.QueryResult{
		Columns:   res.Columns,
		Rows:      res.Rows,
		RowCount:  len(res.Rows),
		Truncated: res.Truncated,
		MS:        res.MS,
	}
	if err != nil {
		out.Err = err.Error()
	}
	// History is best-effort: a persistence hiccup must never mask the
	// query result (ClearHistory/ListHistory still surface store errors).
	_ = s.st.AppendQueryHistory(models.QueryHistoryRow{
		SQL:  sqlText,
		MS:   out.MS,
		Rows: out.RowCount,
		OK:   err == nil,
	})
	return out
}

// Schema returns the schema browser model: every user table from
// sqlite_master with PRAGMA table_info columns (models.SchemaTableRow — the
// store's raw rows), annotated with the notes below (unknown tables/columns
// keep Note "" per contract).
func (s *Session) Schema() ([]models.SchemaTableRow, error) {
	out, err := s.st.Schema()
	if err != nil {
		return nil, err
	}
	for i := range out {
		out[i].Note = tableNotes[out[i].Name]
		for j := range out[i].Columns {
			out[i].Columns[j].Note = columnNote(out[i].Name, out[i].Columns[j].Name)
		}
	}
	return out, nil
}
