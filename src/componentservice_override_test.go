package main

import (
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/store"
)

// TestBuiltinOverrideServiceRoundTrip: an edit of a builtin is stored by
// its builtin id, replaced on a second save, listed, and removed by
// restore. Restoring a builtin that has no edit is not an error.
func TestBuiltinOverrideServiceRoundTrip(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	svc := &ComponentService{st: st}

	if _, err := svc.SaveBuiltinOverride("builtin-match-overview", "<p>one</p>"); err != nil {
		t.Fatalf("SaveBuiltinOverride: %v", err)
	}
	if _, err := svc.SaveBuiltinOverride("builtin-match-overview", "<p>two</p>"); err != nil {
		t.Fatalf("second SaveBuiltinOverride: %v", err)
	}
	got, err := svc.ListBuiltinOverrides()
	if err != nil {
		t.Fatalf("ListBuiltinOverrides: %v", err)
	}
	if len(got) != 1 || got[0].ID != "builtin-match-overview" || got[0].Source != "<p>two</p>" {
		t.Fatalf("list = %+v, want one replaced override", got)
	}
	if err := svc.DeleteBuiltinOverride("builtin-match-overview"); err != nil {
		t.Fatalf("DeleteBuiltinOverride: %v", err)
	}
	if got, _ := svc.ListBuiltinOverrides(); len(got) != 0 {
		t.Fatalf("after restore = %+v, want none", got)
	}
	if err := svc.DeleteBuiltinOverride("builtin-match-overview"); err != nil {
		t.Fatalf("restore with no edit: %v", err)
	}
}

// TestBuiltinOverrideRefusesUserNamesAndEmptySource: an edit names a builtin
// (the builtin- namespace) and carries source; a user component's name and
// an empty source are refused.
func TestBuiltinOverrideRefusesUserNamesAndEmptySource(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	svc := &ComponentService{st: st}

	if _, err := svc.SaveBuiltinOverride("my copy", "<p>x</p>"); err == nil || !strings.Contains(err.Error(), "built-in") {
		t.Fatalf("user name err = %v, want a built-in refusal", err)
	}
	if err := svc.DeleteBuiltinOverride("my copy"); err == nil {
		t.Fatalf("delete of a user name succeeded, want a refusal")
	}
	if _, err := svc.SaveBuiltinOverride("builtin-match-overview", "  "); err == nil {
		t.Fatalf("empty source saved, want a refusal")
	}
	if _, err := svc.SaveBuiltinOverride("builtin-", "<p>x</p>"); err == nil {
		t.Fatalf("bare prefix saved, want a refusal")
	}
}
