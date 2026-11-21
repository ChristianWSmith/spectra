package store

import (
	_ "embed"
	"fmt"
)

//go:embed schema.sql
var schemaSQL string

// applySchema runs the baseline schema (schema.sql) inside a single
// transaction. Every statement is idempotent (CREATE ... IF NOT EXISTS,
// seed INSERT OR IGNORE), so applying it to a database that already has
// the schema is a cheap no-op — fresh and existing databases take the
// same path on every Open and end up with identical schemas. There is no
// version tracking: a stale database predating the baseline is simply
// left as-is (it does not get upgraded).
func (s *Store) applySchema() error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("couldn't initialize the database: %w", err)
	}
	if _, err := tx.Exec(schemaSQL); err != nil {
		_ = tx.Rollback()
		return fmt.Errorf("couldn't initialize the database: %w", err)
	}
	if err := deriveBuiltinDeps(tx); err != nil {
		_ = tx.Rollback()
		return fmt.Errorf("couldn't initialize the database: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("couldn't initialize the database: %w", err)
	}
	return nil
}
