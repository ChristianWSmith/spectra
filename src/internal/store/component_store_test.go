package store

import (
	"errors"
	"testing"
)

// placeComponent writes one layout_placements row directly: the placement
// writers belong to a later wave, so the refusal tests seed the row here.
func placeComponent(t *testing.T, s *Store, surface string, position int, component string) {
	t.Helper()
	if _, err := s.db.Exec(
		`INSERT INTO layout_placements (surface, position, component, props, hidden) VALUES (?, ?, ?, '{}', 0)`,
		surface, position, component,
	); err != nil {
		t.Fatalf("place %q on %q: %v", component, surface, err)
	}
}

// TestComponentCreateListGet: a saved component reads back by name, and
// the list is name order (case-insensitive, then exact).
func TestComponentCreateListGet(t *testing.T) {
	s := openMem(t)
	if _, err := s.SaveComponent("", "beta", "<p>b</p>"); err != nil {
		t.Fatalf("save beta: %v", err)
	}
	if _, err := s.SaveComponent("", "Alpha", "<p>a</p>"); err != nil {
		t.Fatalf("save Alpha: %v", err)
	}
	rows, err := s.ListComponents()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(rows) != 2 || rows[0].Name != "Alpha" || rows[1].Name != "beta" {
		t.Fatalf("list order = %+v, want Alpha then beta", rows)
	}
	got, err := s.GetComponent("beta")
	if err != nil || got.Source != "<p>b</p>" {
		t.Fatalf("get beta = %+v, %v", got, err)
	}
	if _, err := s.GetComponent("missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get missing err = %v, want ErrNotFound", err)
	}
}

// TestComponentDuplicateNameRefused: a second create under the same name
// is refused with the user's words, and nothing is overwritten.
func TestComponentDuplicateNameRefused(t *testing.T) {
	s := openMem(t)
	if _, err := s.SaveComponent("", "one", "<p>1</p>"); err != nil {
		t.Fatalf("save: %v", err)
	}
	_, err := s.SaveComponent("", "one", "<p>2</p>")
	if err == nil {
		t.Fatal("duplicate create was accepted")
	}
	if got, _ := s.GetComponent("one"); got.Source != "<p>1</p>" {
		t.Fatalf("source overwritten: %q", got.Source)
	}
}

// TestComponentRenameAndReplace: an edit replaces the source under the
// same name; a rename of an unplaced component moves the row.
func TestComponentRenameAndReplace(t *testing.T) {
	s := openMem(t)
	if _, err := s.SaveComponent("", "one", "<p>1</p>"); err != nil {
		t.Fatalf("save: %v", err)
	}
	if _, err := s.SaveComponent("one", "one", "<p>edited</p>"); err != nil {
		t.Fatalf("edit: %v", err)
	}
	if _, err := s.SaveComponent("one", "uno", "<p>edited</p>"); err != nil {
		t.Fatalf("rename: %v", err)
	}
	if _, err := s.GetComponent("one"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("old name still present: %v", err)
	}
	if got, err := s.GetComponent("uno"); err != nil || got.Source != "<p>edited</p>" {
		t.Fatalf("renamed = %+v, %v", got, err)
	}
}

// TestComponentPlacedRenameAndDeleteRefused: while a placement names the
// component, a rename and a delete are refused with every placement
// listed, and nothing changes. An edit that keeps the name still saves.
func TestComponentPlacedRenameAndDeleteRefused(t *testing.T) {
	s := openMem(t)
	if _, err := s.SaveComponent("", "mine", "<p>m</p>"); err != nil {
		t.Fatalf("save: %v", err)
	}
	placeComponent(t, s, "match-view", 0, "mine")
	placeComponent(t, s, "reports-appendix", 0, "mine")

	_, err := s.SaveComponent("mine", "renamed", "<p>m</p>")
	var inUse *ComponentInUseError
	if !errors.As(err, &inUse) || len(inUse.Placements) != 2 {
		t.Fatalf("rename err = %v, want ComponentInUseError with 2 placements", err)
	}
	if err := s.DeleteComponent("mine"); !errors.As(err, &inUse) || len(inUse.Placements) != 2 {
		t.Fatalf("delete err = %v, want ComponentInUseError with 2 placements", err)
	}
	if _, err := s.GetComponent("mine"); err != nil {
		t.Fatalf("refused delete removed the component: %v", err)
	}
	if _, err := s.SaveComponent("mine", "mine", "<p>edited</p>"); err != nil {
		t.Fatalf("same-name edit while placed: %v", err)
	}
}

// TestComponentDeleteUnplaced: an unplaced component deletes; a second
// delete of the same name is ErrNotFound.
func TestComponentDeleteUnplaced(t *testing.T) {
	s := openMem(t)
	if _, err := s.SaveComponent("", "gone", "<p>g</p>"); err != nil {
		t.Fatalf("save: %v", err)
	}
	if err := s.DeleteComponent("gone"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if err := s.DeleteComponent("gone"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete err = %v, want ErrNotFound", err)
	}
}

// TestPlacementsReferencingOnlyNamed: the reference lookup returns the
// placements that name the component and no others.
func TestPlacementsReferencingOnlyNamed(t *testing.T) {
	s := openMem(t)
	placeComponent(t, s, "match-view", 0, "mine")
	placeComponent(t, s, "match-view", 1, "other")
	refs, err := s.PlacementsReferencing("mine")
	if err != nil {
		t.Fatalf("refs: %v", err)
	}
	if len(refs) != 1 || refs[0].Component != "mine" {
		t.Fatalf("refs = %+v, want the one placement of mine", refs)
	}
}
