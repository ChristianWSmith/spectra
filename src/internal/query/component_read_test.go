package query_test

import (
	"strconv"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/query"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// TestComponentReadSkipsHistoryAndCap: a component's query(sql) reads past
// the console row cap, records nothing in the console history, and keeps
// the console's refusals (writes, parameters) as Err text.
func TestComponentReadSkipsHistoryAndCap(t *testing.T) {
	st := seededStore(t)
	s := query.New(st)

	want := store.DefaultRowLimit + 10
	res := s.ComponentRead(
		`WITH RECURSIVE c(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM c WHERE x < ` +
			strconv.Itoa(want) + `) SELECT x FROM c`,
	)
	if res.Err != "" {
		t.Fatalf("err: %s", res.Err)
	}
	if res.RowCount != want || res.Truncated {
		t.Fatalf("rows=%d truncated=%v, want %d untruncated", res.RowCount, res.Truncated, want)
	}
	if res := s.ComponentRead(`DELETE FROM events`); res.Err == "" {
		t.Error("write verb accepted")
	}
	if res := s.ComponentRead(`SELECT * FROM events WHERE id = ?`); res.Err == "" {
		t.Error("parameterized statement accepted")
	}
	hist, err := st.ListQueryHistory(0)
	if err != nil {
		t.Fatalf("history: %v", err)
	}
	if len(hist) != 0 {
		t.Fatalf("history has %d entries after component reads, want 0", len(hist))
	}
}
