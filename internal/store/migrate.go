package store

import (
	"embed"
	"fmt"
	"sort"
	"strings"
	"time"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// schemaVersionTable records which embedded migration files have been
// applied so reopening an existing database is idempotent.
const schemaVersionTable = `CREATE TABLE IF NOT EXISTS schema_version (
	name TEXT PRIMARY KEY,
	applied_at DATETIME NOT NULL
)`

// migrate applies embedded migrations/*.sql files in name order, skipping
// any already recorded in schema_version.
func (s *Store) migrate() error {
	if _, err := s.db.Exec(schemaVersionTable); err != nil {
		return fmt.Errorf("store: init schema_version: %w", err)
	}
	applied := map[string]struct{}{}
	rows, err := s.db.Query(`SELECT name FROM schema_version`)
	if err != nil {
		return fmt.Errorf("store: read schema_version: %w", err)
	}
	err = func() error {
		defer rows.Close()
		for rows.Next() {
			var name string
			if err := rows.Scan(&name); err != nil {
				return err
			}
			applied[name] = struct{}{}
		}
		return rows.Err()
	}()
	if err != nil {
		return fmt.Errorf("store: read schema_version: %w", err)
	}

	entries, err := migrationsFS.ReadDir("migrations")
	if err != nil {
		return fmt.Errorf("store: list migrations: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	for _, name := range names {
		if _, ok := applied[name]; ok {
			continue
		}
		content, err := migrationsFS.ReadFile("migrations/" + name)
		if err != nil {
			return fmt.Errorf("store: read migration %s: %w", name, err)
		}
		tx, err := s.db.Begin()
		if err != nil {
			return fmt.Errorf("store: begin migration %s: %w", name, err)
		}
		if _, err := tx.Exec(string(content)); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("store: apply migration %s: %w", name, err)
		}
		if _, err := tx.Exec(`INSERT INTO schema_version (name, applied_at) VALUES (?, ?)`, name, time.Now()); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("store: record migration %s: %w", name, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("store: commit migration %s: %w", name, err)
		}
	}
	return nil
}
