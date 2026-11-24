package store

import (
	"fmt"
	"regexp"
	"strings"
)

// ComponentReferencedError refuses a rename or delete that would leave a reference dangling: a
// component mounted by another component (kind "component"), or a metric a component reads by
// name (kind "metric"). By names the referring user components.
type ComponentReferencedError struct {
	Name string
	Kind string
	By   []string
}

func (e *ComponentReferencedError) Error() string {
	what := "mounted"
	if e.Kind == "metric" {
		what = "read"
	}
	return fmt.Sprintf("can't change %q: %s by %s", e.Name, what, strings.Join(e.By, ", "))
}

// referencedByComponents refuses when another user component names target. For a component
// rename, newName is the name it would take; the component itself is never a referrer of itself.
func referencedByComponents(q queryer, target, newName, kind string) error {
	var pat *regexp.Regexp
	switch kind {
	case "component":
		pat = regexp.MustCompile(`spectra\.Child\s+name\s*=\s*["']` + regexp.QuoteMeta(target) + `["']`)
	case "metric":
		pat = regexp.MustCompile(`spectra\.metric\(\s*["']` + regexp.QuoteMeta(target) + `["']`)
	default:
		return fmt.Errorf("unknown reference kind %q", kind)
	}
	rows, err := q.Query(`SELECT name, source FROM components WHERE origin = 'user'`)
	if err != nil {
		return fmt.Errorf("couldn't check the references: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var by []string
	for rows.Next() {
		var name, source string
		if err := rows.Scan(&name, &source); err != nil {
			return fmt.Errorf("couldn't check the references: %w", err)
		}
		if name == target {
			continue
		}
		if pat.MatchString(source) {
			by = append(by, name)
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("couldn't check the references: %w", err)
	}
	if len(by) > 0 {
		return &ComponentReferencedError{Name: target, Kind: kind, By: by}
	}
	return nil
}

// IsBuiltinComponent reports whether name is a seeded builtin component.
func (s *Store) IsBuiltinComponent(name string) (bool, error) {
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM components WHERE name = ? AND origin = 'builtin'`, scrub(name)).Scan(&n); err != nil {
		return false, fmt.Errorf("couldn't read the builtin components: %w", err)
	}
	return n > 0, nil
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
