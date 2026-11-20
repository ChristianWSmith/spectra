package store

import "testing"

// SetPlacements writes one surface's rows in index order, replaces that
// surface wholesale, and leaves every other surface alone.
func TestSetPlacementsReplacesOneSurface(t *testing.T) {
	s := openMem(t)
	if err := s.SetPlacements("match-view", []PlacementRow{
		{Component: "builtin-a", Props: `{"n":1}`},
		{Component: "mine", Hidden: true},
	}); err != nil {
		t.Fatalf("SetPlacements: %v", err)
	}
	if err := s.SetPlacements("profile-view", []PlacementRow{{Component: "builtin-b"}}); err != nil {
		t.Fatalf("SetPlacements profile: %v", err)
	}
	if err := s.SetPlacements("match-view", []PlacementRow{{Component: "builtin-c"}}); err != nil {
		t.Fatalf("SetPlacements replace: %v", err)
	}
	got, err := s.ListPlacements("match-view", nil)
	if err != nil {
		t.Fatalf("ListPlacements: %v", err)
	}
	if len(got) != 1 || got[0].Component != "builtin-c" || got[0].Position != 0 || got[0].Props != "{}" || got[0].Hidden {
		t.Fatalf("match-view after replace = %+v, want one builtin-c row at 0 with props {}", got)
	}
	other, _ := s.ListPlacements("profile-view", nil)
	if len(other) != 1 || other[0].Component != "builtin-b" {
		t.Fatalf("profile-view changed by a match-view write: %+v", other)
	}
}

// Hidden and props round-trip verbatim, in position order.
func TestSetPlacementsRoundTripsPropsAndHidden(t *testing.T) {
	s := openMem(t)
	rows := []PlacementRow{{Component: "builtin-a", Props: `{"order":["kd","adr"]}`, Hidden: true}, {Component: "builtin-b", Props: `{}`}}
	if err := s.SetPlacements("match-view", rows); err != nil {
		t.Fatalf("SetPlacements: %v", err)
	}
	got, err := s.ListPlacements("match-view", nil)
	if err != nil {
		t.Fatalf("ListPlacements: %v", err)
	}
	if len(got) != 2 || got[0].Position != 0 || got[1].Position != 1 {
		t.Fatalf("order/positions wrong: %+v", got)
	}
	if got[0].Props != `{"order":["kd","adr"]}` || !got[0].Hidden || got[1].Hidden {
		t.Fatalf("props/hidden not verbatim: %+v", got)
	}
}

// Refusals store nothing: an empty surface, an empty rows list (absence is
// the reset, never an empty write), a row with no component, and props that
// are not a JSON object. The existing layout on the surface survives each.
func TestSetPlacementsRefusals(t *testing.T) {
	s := openMem(t)
	if err := s.SetPlacements("match-view", []PlacementRow{{Component: "keep"}}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	cases := []struct {
		name    string
		surface string
		rows    []PlacementRow
	}{
		{"empty surface", "", []PlacementRow{{Component: "x"}}},
		{"empty rows", "match-view", nil},
		{"no component", "match-view", []PlacementRow{{Component: "  "}}},
		{"props array", "match-view", []PlacementRow{{Component: "x", Props: `[1]`}}},
		{"props not json", "match-view", []PlacementRow{{Component: "x", Props: `{oops`}}},
		{"props null", "match-view", []PlacementRow{{Component: "x", Props: `null`}}},
	}
	for _, c := range cases {
		if err := s.SetPlacements(c.surface, c.rows); err == nil {
			t.Errorf("%s: SetPlacements accepted a refused write", c.name)
		}
	}
	got, _ := s.ListPlacements("match-view", nil)
	if len(got) != 1 || got[0].Component != "keep" {
		t.Fatalf("a refused write changed the surface: %+v", got)
	}
}

// Reset deletes one surface's rows (absence is the builtin again) and
// leaves the others; resetting an empty surface is not an error.
func TestResetPlacementsDeletesOnlyThatSurface(t *testing.T) {
	s := openMem(t)
	for _, surf := range []string{"match-view", "profile-view"} {
		if err := s.SetPlacements(surf, []PlacementRow{{Component: "builtin-a"}, {Component: "builtin-b"}}); err != nil {
			t.Fatalf("seed %s: %v", surf, err)
		}
	}
	if err := s.ResetPlacements("match-view"); err != nil {
		t.Fatalf("ResetPlacements: %v", err)
	}
	if got, _ := s.ListPlacements("match-view", nil); len(got) != 0 {
		t.Fatalf("match-view after reset = %+v, want absent", got)
	}
	if got, _ := s.ListPlacements("profile-view", nil); len(got) != 2 {
		t.Fatalf("profile-view changed by reset of match-view: %+v", got)
	}
	if err := s.ResetPlacements("match-view"); err != nil {
		t.Fatalf("reset of an absent surface: %v", err)
	}
	if err := s.ResetPlacements(""); err == nil {
		t.Fatal("reset with no surface was accepted")
	}
}
