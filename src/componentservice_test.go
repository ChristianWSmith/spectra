package main

import (
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/store"
)

// TestComponentServiceRefusals: the service refuses what Go can decide,
// each with a user-facing reason, and stores nothing for a refused save.
func TestComponentServiceRefusals(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	svc := &ComponentService{st: st}

	cases := []struct {
		name, source, want string
	}{
		{"   ", "<p>x</p>", "a component needs a name"},
		{"fine", "   ", "a component needs source"},
		{"match", "<p>x</p>", "already exists"},
		{strings.Repeat("n", maxComponentName+1), "<p>x</p>", "at most 60 characters"},
	}
	for _, c := range cases {
		if _, err := svc.SaveComponent("", c.name, c.source); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("SaveComponent(%q) err = %v, want it to contain %q", c.name, err, c.want)
		}
	}
	if list, _ := svc.ListComponents(); len(list) != 0 {
		t.Fatalf("refused saves stored %d component(s)", len(list))
	}
}

// TestComponentServiceRoundTrip: create, duplicate-name refusal, rename
// of an unplaced component, delete, and the unknown-name delete.
func TestComponentServiceRoundTrip(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	svc := &ComponentService{st: st}

	if _, err := svc.SaveComponent("", "Rounds", "<p>r</p>"); err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := svc.SaveComponent("", "Rounds", "<p>r2</p>"); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("duplicate create err = %v, want already exists", err)
	}
	saved, err := svc.SaveComponent("Rounds", "Rounds two", "<p>r</p>")
	if err != nil || saved.Name != "Rounds two" {
		t.Fatalf("rename = %+v, %v", saved, err)
	}
	if err := svc.DeleteComponent("Rounds two"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if err := svc.DeleteComponent("Rounds two"); err == nil || !strings.Contains(err.Error(), "no component named") {
		t.Fatalf("second delete err = %v, want no component named", err)
	}
	if _, err := svc.SaveComponent("ghost", "ghost", "<p>x</p>"); err == nil || !strings.Contains(err.Error(), "no component named") {
		t.Fatalf("edit of a missing component err = %v", err)
	}
}

// TestPlacementListNamesSurfaces: the refusal names each surface once,
// in the user's words, and an unknown surface is shown as stored.
func TestPlacementListNamesSurfaces(t *testing.T) {
	got := placementList([]store.Placement{
		{Surface: "match-view"},
		{Surface: "match-view"},
		{Surface: "reports-appendix"},
		{Surface: "profile-view:7656"},
		{Surface: "other-surface"},
	})
	want := "the Match view, the Reports appendix, a Profile view, other-surface"
	if got != want {
		t.Fatalf("placementList = %q, want %q", got, want)
	}
}
