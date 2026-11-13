package main

import (
	"errors"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/store"
)

// newQueryService opens an in-memory store and returns a bare
// QueryService (the save/update paths never touch the app handle).
func newQueryService(t *testing.T) *QueryService {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return &QueryService{st: st}
}

// TestSaveQueryRequiresNameAndDescription pins the save-side validation
// split: saving needs name AND description (plus SQL) — all trimmed, all
// server-side (the check a frontend cannot bypass). The Run path is
// untouched by construction: Run takes raw SQL only and never reads
// either field.
func TestSaveQueryRequiresNameAndDescription(t *testing.T) {
	s := newQueryService(t)

	cases := []struct {
		name, sql, desc string
		want            string
	}{
		{"", "SELECT 1", "d", "query name is required"},
		{"   ", "SELECT 1", "d", "query name is required"},
		{"q", "SELECT 1", "", "query description is required"},
		{"q", "SELECT 1", "   ", "query description is required"},
		{"q", "", "d", "SQL is required"},
		{"q", "  ", "d", "SQL is required"},
	}
	for _, c := range cases {
		if _, err := s.SaveQuery(c.name, c.sql, c.desc); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("SaveQuery(%q,%q,%q) err = %v, want %q", c.name, c.sql, c.desc, err, c.want)
		}
	}

	// Happy path: trimmed values land in the row.
	q, err := s.SaveQuery("  openings  ", "SELECT 1", "  first bloods  ")
	if err != nil {
		t.Fatalf("SaveQuery: %v", err)
	}
	if q.Name != "openings" || q.Description != "first bloods" {
		t.Errorf("stored = %+v, want trimmed name and description", q)
	}
	// An insert whose name duplicates an existing row keeps the friendly
	// uniqueness error.
	if _, err := s.SaveQuery("openings", "SELECT 2", "d"); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Errorf("duplicate err = %v, want friendly uniqueness error", err)
	}
}

// TestUpdateQueryServiceFlow pins the update path: an existing row's
// SQL/description/name can be rewritten (the typo fix INSERT-only save
// could never do), the same required-field validation applies, a name
// colliding with a DIFFERENT row errors friendly, and an unknown id
// reports the friendly not-found message (store.ErrNotFound mapped).
func TestUpdateQueryServiceFlow(t *testing.T) {
	s := newQueryService(t)

	q, err := s.SaveQuery("openings", "SELECT 1", "wrong wording")
	if err != nil {
		t.Fatalf("SaveQuery: %v", err)
	}

	// Validation mirrors SaveQuery — an update can never blank a field.
	for _, c := range []struct {
		name, sql, desc, want string
	}{
		{"", "SELECT 1", "d", "query name is required"},
		{"q", "SELECT 1", " ", "query description is required"},
		{"q", " ", "d", "SQL is required"},
	} {
		if _, err := s.UpdateQuery(q.ID, c.name, c.sql, c.desc); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("UpdateQuery(%q,%q,%q) err = %v, want %q", c.name, c.sql, c.desc, err, c.want)
		}
	}

	// Round-trip: correct the wording + the SQL, same id.
	up, err := s.UpdateQuery(q.ID, "openings", "SELECT 2", "fixed description")
	if err != nil {
		t.Fatalf("UpdateQuery: %v", err)
	}
	if up.ID != q.ID || up.Description != "fixed description" || up.SQL != "SELECT 2" {
		t.Fatalf("updated = %+v, want the rewritten row", up)
	}
	list, err := s.ListSavedQueries()
	if err != nil || len(list) != 1 || list[0].Description != "fixed description" {
		t.Fatalf("list = %+v (err %v), want the updated row", list, err)
	}

	// A name colliding with a DIFFERENT row → friendly uniqueness error.
	if _, err := s.SaveQuery("taken", "SELECT 3", "other"); err != nil {
		t.Fatalf("SaveQuery(taken): %v", err)
	}
	if _, err := s.UpdateQuery(q.ID, "taken", "SELECT 2", "d"); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Errorf("colliding update err = %v, want friendly uniqueness error", err)
	}

	// Unknown id → the friendly not-found message (not a raw ErrNotFound).
	if _, err := s.UpdateQuery(9999, "x", "SELECT 1", "d"); err == nil || !strings.Contains(err.Error(), "no saved query with id") {
		t.Errorf("unknown-id err = %v, want friendly not-found message", err)
	}
	if _, err := s.UpdateQuery(9999, "x", "SELECT 1", "d"); errors.Is(err, store.ErrNotFound) {
		t.Errorf("service leaked raw store.ErrNotFound: %v", err)
	}
}
