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
// the expanded text, so the stored expr is the complete formula). Every piece
// lands inside a seed literal, so each is quote-doubled on the way in.
var schemaFragments = []struct {
	placeholder string
	sql         string
}{
	{clutchPlaceholder, clutchCTE},
	{killsPlaceholder, killsCountedCTE},
	{killsEKPlaceholder, killsCountedEKCTE},
	{killsAKPlaceholder, killsCountedAKCTE},
	{killsEKRPlaceholder, killsCountedEKRCTE},
	{killsRoundPlaceholder, killsRoundCTE},
	{damageRoundPlaceholder, damageRoundCTE},
	{blindPlaceholder, blindCTE},
	{damagePlaceholder, damageCountedCTE},
	{playerStatsColsPlaceholder, playerStatsColsSQL},
	{rollupOpenPlaceholder, rollupOpenSQL},
	{rollupClosePlaceholder, rollupCloseSQL},
	{rollupMatchOpenPlaceholder, rollupMatchOpenSQL},
	{playerStatsHumansPlaceholder, playerStatsHumansSQL},
	{careerHeadPlaceholder, careerHeadSQL},
	{playerFoldJoinPlaceholder, playerFoldJoinSQL},
	{playerRoundColsPlaceholder, playerRoundColsSQL},
	{playerRoundFoldJoinPlaceholder, playerRoundFoldJoinSQL},
	{playerRoundRosterJoinPlaceholder, playerRoundRosterJoinSQL},
	{sideDomainPlaceholder, sideDomainSQL},
	{disconnectJoinPlaceholder, disconnectJoinSQL},
}

// spliceFragments replaces every fragment placeholder in a seed text with the
// fragment's SQL, quote-doubled. applySchema and the macro expanders both splice
// through it, so a fragment is spliced the same way wherever it appears.
func spliceFragments(seed string) string {
	for _, f := range schemaFragments {
		seed = strings.ReplaceAll(seed, f.placeholder, sqlLiteral(f.sql))
	}
	return seed
}

// sqlLiteral is sql as it sits inside a single-quoted seed literal.
func sqlLiteral(sql string) string { return strings.ReplaceAll(sql, "'", "''") }

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
	seed := expandSeedMacros(spliceFragments(schemaSQL))
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
