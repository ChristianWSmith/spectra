package store

import (
	"fmt"
	"time"
)

// Storage for the in-place edits of builtin components (owner ruling 43;
// `builtin_overrides` in the baseline schema.sql). A row is one builtin id
// and the source that replaces its shipped source wherever it is mounted.
// The writers never validate the SOURCE (the frontend save gate runs first,
// as for user components); they refuse an empty id or source only.

// builtinOverrideCols is the builtin_overrides column list in scan order,
// pinned to the DDL by TestColumnListConstsMatchSchema.
const builtinOverrideCols = `id, source, created_at, updated_at`

// BuiltinOverrideRow is one stored override.
type BuiltinOverrideRow struct {
	ID        string
	Source    string
	CreatedAt time.Time
	UpdatedAt time.Time
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
		var r BuiltinOverrideRow
		if err := rows.Scan(&r.ID, &r.Source, &r.CreatedAt, &r.UpdatedAt); err != nil {
			return nil, fmt.Errorf("couldn't load the edited builtins: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("couldn't load the edited builtins: %w", err)
	}
	return out, nil
}

// SaveBuiltinOverride writes (or replaces) the override of one builtin id.
func (s *Store) SaveBuiltinOverride(id, source string) (BuiltinOverrideRow, error) {
	id, source = scrub(id), scrub(source)
	if id == "" {
		return BuiltinOverrideRow{}, fmt.Errorf("an edited builtin needs an id")
	}
	if source == "" {
		return BuiltinOverrideRow{}, fmt.Errorf("an edited builtin needs source")
	}
	now := time.Now()
	if _, err := s.db.Exec(
		`INSERT INTO builtin_overrides (`+builtinOverrideCols+`) VALUES (?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET source = excluded.source, updated_at = excluded.updated_at`,
		id, source, now, now,
	); err != nil {
		return BuiltinOverrideRow{}, fmt.Errorf("couldn't save the edited builtin: %w", err)
	}
	var r BuiltinOverrideRow
	err := s.db.QueryRow(`SELECT `+builtinOverrideCols+` FROM builtin_overrides WHERE id = ?`, id).
		Scan(&r.ID, &r.Source, &r.CreatedAt, &r.UpdatedAt)
	if err != nil {
		return BuiltinOverrideRow{}, fmt.Errorf("couldn't save the edited builtin: %w", err)
	}
	return r, nil
}

// DeleteBuiltinOverride removes one builtin's override (restore to default).
// Deleting an id with no override is not an error: the builtin already
// renders its shipped source.
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
