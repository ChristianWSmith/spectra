package store

import (
	"database/sql"
	"fmt"
	"strings"
)

// ComponentRefs is what a user component's source references, as the frontend parsed it.
type ComponentRefs struct {
	Components []string
	Metrics    []string
}

// ComponentReferencedError refuses a rename or delete that would leave a reference dangling: a
// component mounted by another component (kind "component"), or a metric a component reads by
// name (kind "metric"). By names the referring user components.
type ComponentReferencedError struct {
	Name string
	Kind string
	By   []string
}

func (e *ComponentReferencedError) Error() string {
	verb := "mounts"
	if e.Kind == "metric" {
		verb = "reads"
	}
	return fmt.Sprintf("can't change %q while %s %s it", e.Name, strings.Join(e.By, ", "), verb)
}

// referrersOf names the user components that reference target by kind, other than exclude.
func referrersOf(q queryer, kind, target, exclude string) ([]string, error) {
	rows, err := q.Query(`SELECT referrer FROM component_refs WHERE kind = ? AND target = ? AND referrer <> ? ORDER BY referrer`, kind, target, exclude)
	if err != nil {
		return nil, fmt.Errorf("couldn't check the references: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var by []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, fmt.Errorf("couldn't check the references: %w", err)
		}
		by = append(by, n)
	}
	return by, rows.Err()
}

// refuseIfReferenced refuses when another user component references target by kind.
func refuseIfReferenced(q queryer, kind, target, exclude string) error {
	by, err := referrersOf(q, kind, target, exclude)
	if err != nil {
		return err
	}
	if len(by) > 0 {
		return &ComponentReferencedError{Name: target, Kind: kind, By: by}
	}
	return nil
}

// replaceComponentRefs stores the references of the component being saved: its rows are rewritten
// wholesale (the source is the only truth, as metric_deps is for metrics). owner is the name it
// had before this save (name for a create).
func replaceComponentRefs(tx *sql.Tx, original, name string, refs ComponentRefs) error {
	owner := original
	if owner == "" {
		owner = name
	}
	if _, err := tx.Exec(`DELETE FROM component_refs WHERE referrer IN (?, ?)`, owner, name); err != nil {
		return fmt.Errorf("couldn't save the component: %w", err)
	}
	for _, c := range refs.Components {
		if _, err := tx.Exec(`INSERT OR IGNORE INTO component_refs (referrer, kind, target) VALUES (?, 'component', ?)`, name, scrub(c)); err != nil {
			return fmt.Errorf("couldn't save the component: %w", err)
		}
	}
	for _, m := range refs.Metrics {
		if _, err := tx.Exec(`INSERT OR IGNORE INTO component_refs (referrer, kind, target) VALUES (?, 'metric', ?)`, name, scrub(m)); err != nil {
			return fmt.Errorf("couldn't save the component: %w", err)
		}
	}
	return nil
}

// isBuiltinNamed reports whether name is a seeded builtin component.
func isBuiltinNamed(q interface {
	QueryRow(query string, args ...any) *sql.Row
}, name string) (bool, error) {
	var n int
	if err := q.QueryRow(`SELECT COUNT(*) FROM components WHERE name = ? AND origin = 'builtin'`, scrub(name)).Scan(&n); err != nil {
		return false, fmt.Errorf("couldn't read the builtin components: %w", err)
	}
	return n > 0, nil
}

// IsBuiltinComponent reports whether name is a seeded builtin component.
func (s *Store) IsBuiltinComponent(name string) (bool, error) {
	return isBuiltinNamed(s.db, name)
}

// BuiltinComponentNames lists every seeded builtin component name.
func (s *Store) BuiltinComponentNames() ([]string, error) {
	rows, err := s.db.Query(`SELECT name FROM components WHERE origin = 'builtin' ORDER BY name`)
	if err != nil {
		return nil, fmt.Errorf("couldn't read the builtin components: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, fmt.Errorf("couldn't read the builtin components: %w", err)
		}
		out = append(out, n)
	}
	return out, rows.Err()
}
