package store

import (
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// Storage for the in-place edits of builtins (owner rulings 43 and 44;
// `builtin_overrides` in the baseline schema.sql). A row is one builtin's
// key and the text that replaces its shipped text wherever it is used:
// a component's source, a report template's body, or a metric's expr (with
// the shipped expr kept in `shipped`, since the metric row itself is
// overwritten by the edit). The writers never validate the text (the save
// gates run first, as for user rows); they refuse an empty key or source only.

// builtinOverrideCols is the builtin_overrides column list in scan order,
// pinned to the DDL by TestColumnListConstsMatchSchema.
const builtinOverrideCols = `id, source, shipped, created_at, updated_at`

// Key prefixes for the override kinds. A component key is the builtin id
// itself (the `builtin-` namespace, see componentservice.go).
const (
	ReportOverridePrefix = "report:"
	MetricOverridePrefix = "metric:"
)

// BuiltinOverrideRow is one stored override.
type BuiltinOverrideRow struct {
	ID        string
	Source    string
	Shipped   string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// builtinOverrideExec is the statement surface the override writers need,
// so a metric save can write its override inside its own transaction.
type builtinOverrideExec interface {
	Exec(query string, args ...any) (sql.Result, error)
}

func scanBuiltinOverride(row interface{ Scan(...any) error }) (BuiltinOverrideRow, error) {
	var r BuiltinOverrideRow
	err := row.Scan(&r.ID, &r.Source, &r.Shipped, &r.CreatedAt, &r.UpdatedAt)
	return r, err
}

// ListBuiltinOverrides returns every override, id ASC.
func (s *Store) ListBuiltinOverrides() ([]BuiltinOverrideRow, error) {
	rows, err := s.db.Query(`SELECT ` + builtinOverrideCols + ` FROM builtin_overrides ORDER BY id ASC`)
	if err != nil {
		return nil, fmt.Errorf("couldn't load the edited builtins: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []BuiltinOverrideRow{}
	for rows.Next() {
		r, err := scanBuiltinOverride(rows)
		if err != nil {
			return nil, fmt.Errorf("couldn't load the edited builtins: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("couldn't load the edited builtins: %w", err)
	}
	return out, nil
}

// GetBuiltinOverride returns one builtin's override (ErrNotFound when the
// builtin has none, i.e. it renders its shipped text).
func (s *Store) GetBuiltinOverride(id string) (BuiltinOverrideRow, error) {
	r, err := scanBuiltinOverride(s.db.QueryRow(
		`SELECT `+builtinOverrideCols+` FROM builtin_overrides WHERE id = ?`, scrub(id)))
	if errors.Is(err, sql.ErrNoRows) {
		return BuiltinOverrideRow{}, ErrNotFound
	}
	if err != nil {
		return BuiltinOverrideRow{}, fmt.Errorf("couldn't load the edited builtin: %w", err)
	}
	return r, nil
}

// SaveBuiltinOverride writes (or replaces) the override of one builtin key
// whose shipped text lives in the app (components, reports).
func (s *Store) SaveBuiltinOverride(id, source string) (BuiltinOverrideRow, error) {
	if err := writeBuiltinOverride(s.db, id, source, ""); err != nil {
		return BuiltinOverrideRow{}, err
	}
	return s.GetBuiltinOverride(id)
}

// writeBuiltinOverride is the one upsert every override write goes through.
// shipped is written only when given: an existing row keeps the shipped
// text it was created with, so an edit never loses the default it restores to.
func writeBuiltinOverride(q builtinOverrideExec, id, source, shipped string) error {
	id, source, shipped = scrub(id), scrub(source), scrub(shipped)
	if id == "" {
		return fmt.Errorf("an edited builtin needs an id")
	}
	if source == "" {
		return fmt.Errorf("an edited builtin needs source")
	}
	now := time.Now()
	if _, err := q.Exec(
		`INSERT INTO builtin_overrides (`+builtinOverrideCols+`) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET source = excluded.source,
		   shipped = CASE WHEN excluded.shipped = '' THEN builtin_overrides.shipped ELSE excluded.shipped END,
		   updated_at = excluded.updated_at`,
		id, source, shipped, now, now,
	); err != nil {
		return fmt.Errorf("couldn't save the edited builtin: %w", err)
	}
	return nil
}

// DeleteBuiltinOverride removes one builtin's override (restore to default).
// Deleting a key with no override is not an error: the builtin already
// renders its shipped text.
func (s *Store) DeleteBuiltinOverride(id string) error {
	id = scrub(id)
	if id == "" {
		return fmt.Errorf("an edited builtin needs an id")
	}
	if _, err := s.db.Exec(`DELETE FROM builtin_overrides WHERE id = ?`, id); err != nil {
		return fmt.Errorf("couldn't restore the builtin: %w", err)
	}
	return nil
}
