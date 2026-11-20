package store

import "testing"

// TestReadUnboundedHasNoRowCap: the component read path returns every row
// past the console's DefaultRowLimit (never Truncated) and keeps the
// read-only validation (a write verb is refused before execution).
func TestReadUnboundedHasNoRowCap(t *testing.T) {
	s := openROFileStore(t)
	seedROData(t, s)
	want := DefaultRowLimit + 1000
	res, err := s.ReadUnbounded(
		`WITH RECURSIVE c(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM c WHERE x < ?) SELECT x FROM c`,
		[]any{want},
	)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(res.Rows) != want || res.Truncated {
		t.Fatalf("rows = %d truncated = %v, want %d untruncated", len(res.Rows), res.Truncated, want)
	}
	if _, err := s.ReadUnbounded(`DELETE FROM events`, nil); err == nil {
		t.Fatal("ReadUnbounded accepted a write verb")
	}
	if n := roCount(t, s, "events"); n != 1 {
		t.Fatalf("events = %d after a refused write, want 1", n)
	}
}
