package store

import (
	_ "embed"
	"database/sql"
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
	{utilityWeaponsPlaceholder, utilityWeaponsSQL},
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
	// The seed keeps its metric statements in macro form (expr), the form the editor shows. Every
	// macro sits inside a metric statement, so nothing else in the seed needs expanding.
	if _, err := tx.Exec(schemaSQL); err != nil {
		_ = tx.Rollback()
		return fmt.Errorf("couldn't initialize the database: %w", err)
	}
	// Each builtin's run form is its expanded macro form (the same expansion a user statement gets).
	if err := fillRunExprs(tx); err != nil {
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

// fillRunExprs writes run_expr for every metric row that has none yet: the expansion of its macro
// form. Rows are read before any write (the store's one connection cannot hold a cursor across an UPDATE).
func fillRunExprs(tx *sql.Tx) error {
	rows, err := tx.Query(`SELECT id, expr FROM metrics WHERE run_expr = ''`)
	if err != nil {
		return err
	}
	type todo struct {
		id   int64
		expr string
	}
	var all []todo
	for rows.Next() {
		var t todo
		if err := rows.Scan(&t.id, &t.expr); err != nil {
			rows.Close()
			return err
		}
		all = append(all, t)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, t := range all {
		run, err := ExpandMetricMacros(t.expr)
		if err != nil {
			return fmt.Errorf("metric %d: %w", t.id, err)
		}
		if _, err := tx.Exec(`UPDATE metrics SET run_expr = ? WHERE id = ?`, run, t.id); err != nil {
			return err
		}
	}
	return nil
}
