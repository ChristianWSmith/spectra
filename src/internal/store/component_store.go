package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// This file is the Component Builder's persistence surface: the writers
// and readers over `components` (schema.sql; layout_store.go holds the
// column lists and the placement read). Builtin components are code,
// never rows, so every row here is a user component. A component is
// addressed by its name, because placements reference it by name
// (layout_placements.component).
//
// The writers never validate the SOURCE: the Svelte compile check runs in
// the webview (frontend componentruntime/compile.js checkComponentSource)
// before the service is called, because the Go side has no Svelte
// compiler. The store and the service refuse what they can decide:
// an empty name or source, a duplicate name, and a delete or rename of a
// component that a placement still references.

// ComponentRow is one stored user component (every components column but
// id; the service maps it to its own DTO).
type ComponentRow struct {
	Name      string
	Source    string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// ComponentInUseError refuses a delete or rename of a component that a
// placement references. Placements names every referencing placement so
// the service can name them to the user.
type ComponentInUseError struct {
	Name       string
	Placements []Placement
}

func (e *ComponentInUseError) Error() string {
	return fmt.Sprintf("the component %q is placed on %d surface(s)", e.Name, len(e.Placements))
}

// queryer is the read half shared by *sql.DB and *sql.Tx.
type queryer interface {
	Query(query string, args ...any) (*sql.Rows, error)
}

func scanComponent(row interface{ Scan(...any) error }) (ComponentRow, error) {
	var r ComponentRow
	if err := row.Scan(&r.Name, &r.Source, &r.CreatedAt, &r.UpdatedAt); err != nil {
		return ComponentRow{}, err
	}
	return r, nil
}

// ListComponents returns every stored user component, name ASC
// (case-insensitive, then exact, so the order is total).
func (s *Store) ListComponents() ([]ComponentRow, error) {
	rows, err := s.db.Query(`SELECT ` + componentCols + ` FROM components WHERE origin = 'user' ORDER BY name COLLATE NOCASE ASC, name ASC`)
	if err != nil {
		return nil, fmt.Errorf("couldn't load your components: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []ComponentRow{}
	for rows.Next() {
		r, err := scanComponent(rows)
		if err != nil {
			return nil, fmt.Errorf("couldn't load your components: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("couldn't load your components: %w", err)
	}
	return out, nil
}

// GetComponent reads one component by name (ErrNotFound when absent).
func (s *Store) GetComponent(name string) (ComponentRow, error) {
	r, err := scanComponent(s.db.QueryRow(`SELECT `+componentCols+` FROM components WHERE name = ? AND origin = 'user'`, scrub(name)))
	if errors.Is(err, sql.ErrNoRows) {
		return ComponentRow{}, ErrNotFound
	}
	if err != nil {
		return ComponentRow{}, fmt.Errorf("couldn't load the component: %w", err)
	}
	return r, nil
}

// PlacementsReferencing returns every placement, on any surface, whose
// component is `name` (surface, then position order). Builtin ids never
// collide with a user name (the service reserves their prefix), so an
// exact match is the whole rule.
func (s *Store) PlacementsReferencing(name string) ([]Placement, error) {
	return placementsReferencing(s.db, name)
}

func placementsReferencing(q queryer, name string) ([]Placement, error) {
	rows, err := q.Query(
		`SELECT `+layoutPlacementCols+` FROM layout_placements WHERE component = ? ORDER BY surface ASC, position ASC`,
		scrub(name),
	)
	if err != nil {
		return nil, fmt.Errorf("couldn't read where the component is placed: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []Placement
	for rows.Next() {
		var p Placement
		var hidden int
		if err := rows.Scan(&p.Surface, &p.Position, &p.Component, &p.Props, &hidden); err != nil {
			return nil, fmt.Errorf("couldn't read where the component is placed: %w", err)
		}
		p.Hidden = hidden != 0
		out = append(out, p)
	}
	return out, rows.Err()
}

// SaveComponent writes one user component. An empty `original` creates a
// row named `name`; otherwise the row named `original` is replaced with
// `name` + `source`. A rename (name != original) is refused with
// *ComponentInUseError while a placement references the old name, because
// a placement addresses its component by name and would be left
// dangling. The check and the write share one transaction.
func (s *Store) SaveComponent(original, name, source string, refs ComponentRefs) (ComponentRow, error) {
	name, source, original = scrub(name), scrub(source), scrub(original)
	if strings.TrimSpace(name) == "" {
		return ComponentRow{}, fmt.Errorf("a component needs a name")
	}
	if strings.TrimSpace(source) == "" {
		return ComponentRow{}, fmt.Errorf("a component needs source")
	}
	tx, err := s.db.Begin()
	if err != nil {
		return ComponentRow{}, fmt.Errorf("couldn't save the component: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if original != "" {
		if builtin, err := isBuiltinNamed(tx, original); err != nil {
			return ComponentRow{}, err
		} else if builtin {
			return ComponentRow{}, fmt.Errorf("the built-in component %q can't be renamed or changed here", original)
		}
	}
	if name != original {
		if builtin, err := isBuiltinNamed(tx, name); err != nil {
			return ComponentRow{}, err
		} else if builtin {
			return ComponentRow{}, fmt.Errorf("%q is the name of a built-in component", name)
		}
	}
	now := time.Now()
	if original == "" {
		if _, err := tx.Exec(
			`INSERT INTO components (`+componentCols+`) VALUES (?, ?, ?, ?)`, name, source, now, now,
		); err != nil {
			if isUniqueErr(err) {
				return ComponentRow{}, fmt.Errorf("a component named %q already exists", name)
			}
			return ComponentRow{}, fmt.Errorf("couldn't save the component: %w", err)
		}
	} else {
		if name != original {
			refs, err := placementsReferencing(tx, original)
			if err != nil {
				return ComponentRow{}, err
			}
			if len(refs) > 0 {
				return ComponentRow{}, &ComponentInUseError{Name: original, Placements: refs}
			}
			if err := refuseIfReferenced(tx, "component", original, original); err != nil {
				return ComponentRow{}, err
			}
		}
		res, err := tx.Exec(`UPDATE components SET name = ?, source = ?, updated_at = ? WHERE name = ? AND origin = 'user'`, name, source, now, original)
		if err != nil {
			if isUniqueErr(err) {
				return ComponentRow{}, fmt.Errorf("a component named %q already exists", name)
			}
			return ComponentRow{}, fmt.Errorf("couldn't save the component: %w", err)
		}
		if err := affectedOrNotFound(res, "saving the component"); err != nil {
			return ComponentRow{}, err
		}
	}
	if err := replaceComponentRefs(tx, original, name, refs); err != nil {
		return ComponentRow{}, err
	}
	out, err := scanComponent(tx.QueryRow(`SELECT `+componentCols+` FROM components WHERE name = ?`, name))
	if err != nil {
		return ComponentRow{}, fmt.Errorf("couldn't save the component: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return ComponentRow{}, fmt.Errorf("couldn't save the component: %w", err)
	}
	return out, nil
}

// DeleteComponent removes one user component. Refused with
// *ComponentInUseError while any placement references it (nothing is
// deleted); an unknown name yields ErrNotFound. The check and the delete
// share one transaction.
func (s *Store) DeleteComponent(name string) error {
	name = scrub(name)
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("couldn't delete the component: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if builtin, err := isBuiltinNamed(tx, name); err != nil {
		return err
	} else if builtin {
		return fmt.Errorf("the built-in component %q can't be deleted", name)
	}
	refs, err := placementsReferencing(tx, name)
	if err != nil {
		return err
	}
	if len(refs) > 0 {
		return &ComponentInUseError{Name: name, Placements: refs}
	}
	if err := refuseIfReferenced(tx, "component", name, name); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM component_refs WHERE referrer = ?`, name); err != nil {
		return fmt.Errorf("couldn't delete the component: %w", err)
	}
	res, err := tx.Exec(`DELETE FROM components WHERE name = ? AND origin = 'user'`, name)
	if err != nil {
		return fmt.Errorf("couldn't delete the component: %w", err)
	}
	if err := affectedOrNotFound(res, "deleting the component"); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("couldn't delete the component: %w", err)
	}
	return nil
}
