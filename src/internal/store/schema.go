package store

import (
	_ "embed"
	"fmt"
	"strings"
)

//go:embed schema.sql
var schemaSQL string

// schemaFragments are the shared SQL pieces the builtin metric seeds splice in
// (one copy each: the seed expr holds the placeholder, and applySchema writes
// the expanded text, so the stored expr is the complete formula).
var schemaFragments = []struct {
	placeholder string
	seedText    func() string
}{
	{clutchPlaceholder, clutchSeedText},
	{killsPlaceholder, killsSeedText},
	{killsEKPlaceholder, killsEKSeedText},
	{damagePlaceholder, damageSeedText},
	{playerStatsColsPlaceholder, playerStatsColsSeedText},
	{rollupOpenPlaceholder, rollupOpenSeedText},
	{rollupClosePlaceholder, rollupCloseSeedText},
	{playerStatsHumansPlaceholder, playerStatsHumansSeedText},
	{careerHeadPlaceholder, careerHeadSeedText},
	{playerFoldJoinPlaceholder, playerFoldJoinSeedText},
}

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
	// The clutch metrics splice the shared clutch CTE in (clutch_sql.go).
	seed := schemaSQL
	for _, f := range schemaFragments {
		seed = strings.ReplaceAll(seed, f.placeholder, f.seedText())
	}
	seed = expandSeedMacros(seed)
	if _, err := tx.Exec(seed); err != nil {
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
