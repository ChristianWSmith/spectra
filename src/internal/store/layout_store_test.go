package store

import "testing"

// A placement referencing a component that is neither a builtin nor a stored
// component is reported (MissingComponent), not an error, and does not stop
// the surface's other placements from reading.
func TestListPlacementsReportsMissingComponent(t *testing.T) {
	s := openMem(t)
	ts := "2026-11-20T00:00:00Z"
	if _, err := s.db.Exec(`INSERT INTO components (name, source, created_at, updated_at) VALUES ('mine', '<p>hi</p>', ?, ?)`, ts, ts); err != nil {
		t.Fatal(err)
	}
	for i, c := range []string{"builtin-scoreboard", "mine", "ghost"} {
		if _, err := s.db.Exec(`INSERT INTO layout_placements (surface, position, component) VALUES ('match-view', ?, ?)`, i, c); err != nil {
			t.Fatal(err)
		}
	}
	got, err := s.ListPlacements("match-view", func(id string) bool { return id == "builtin-scoreboard" })
	if err != nil {
		t.Fatalf("ListPlacements: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("got %d placements, want 3", len(got))
	}
	want := []bool{false, false, true}
	for i, p := range got {
		if p.MissingComponent != want[i] {
			t.Errorf("%s: MissingComponent = %v, want %v", p.Component, p.MissingComponent, want[i])
		}
		if p.Props != "{}" || p.Hidden {
			t.Errorf("%s: defaults wrong: props=%q hidden=%v", p.Component, p.Props, p.Hidden)
		}
	}
	none, err := s.ListPlacements("profile-view", nil)
	if err != nil || len(none) != 0 {
		t.Errorf("empty surface: %v, %v (absence means the builtin)", none, err)
	}
}
