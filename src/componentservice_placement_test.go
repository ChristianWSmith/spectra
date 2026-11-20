package main

import (
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/store"
)

// TestPlacementServiceRoundTrip: the service writes, reads and resets one
// surface's layout and refuses an empty list (the reset is the way to
// clear a layout). A placement naming no component is not refused here;
// the frontend reports it as a dangling reference.
func TestPlacementServiceRoundTrip(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	svc := &ComponentService{st: st}

	if err := svc.SetPlacements("match-view", []Placement{{Component: "builtin-example", Props: `{"k":2}`}, {Component: "ghost", Hidden: true}}); err != nil {
		t.Fatalf("SetPlacements: %v", err)
	}
	got, err := svc.ListPlacements("match-view")
	if err != nil {
		t.Fatalf("ListPlacements: %v", err)
	}
	if len(got) != 2 || got[0].Component != "builtin-example" || got[0].Props != `{"k":2}` || got[1].Component != "ghost" || !got[1].Hidden {
		t.Fatalf("round trip = %+v", got)
	}
	if err := svc.SetPlacements("match-view", nil); err == nil || !strings.Contains(err.Error(), "reset") {
		t.Fatalf("empty SetPlacements err = %v, want a reset hint", err)
	}
	if err := svc.ResetPlacements("match-view"); err != nil {
		t.Fatalf("ResetPlacements: %v", err)
	}
	if got, _ := svc.ListPlacements("match-view"); len(got) != 0 {
		t.Fatalf("after reset = %+v, want absent", got)
	}
}
