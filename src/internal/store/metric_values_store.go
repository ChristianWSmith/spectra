package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// This file is the stored-metrics VALUE surface (stored-metrics design
// §4): THE canonical behind predicate, the compute pass's two-phase
// per-metric writers (delete → insert), and the write-handle plan
// runner. There is NO schema here — metric_values is the W1 baseline
// table (schema.sql); this file only reads and writes it.

// MetricCoverage is one metric's answer to the behind predicate.
//
//	Behind      the metric needs a recompute (see MetricCoverage — the
//	            ONE spelling the sweep AND the read-state surface share)
//	FreshRows   rows carrying BOTH live stamps (metric_version >= the
//	            metric's live version AND rule_version >= the live
//	            analysis rule version) — the canonical read's supply
//	            (stale rows are never counted here, so a metric can
//	            report Behind with FreshRows 0 while outdated rows
//	            physically exist: present-but-invisible, design §4's
//	            crash matrix)
type MetricCoverage struct {
	MetricID  int64
	Behind    bool
	FreshRows int
	// BehindMatches is the per-unit answer for a :match_id metric: the
	// ready matches with no fresh run record. Behind is true when this is
	// non-empty (or another unit is behind). Other matches keep their fresh
	// values, so a per-match read answers from its own unit.
	BehindMatches []int64
	// BehindSteams is the per-player answer for a :steam_id metric: the
	// humans of ready matches with no fresh run record. Behind is true when
	// this is non-empty. A player not listed reads fresh for this metric.
	BehindSteams []string
}

// metricValueFreshCond is THE row-level freshness test (the behind
// predicate's row clause, negated): a row is fresh iff it was computed
// under the metric's CURRENT version and the CURRENT analysis rule
// version. Stamps are INTERNAL-ONLY (never rendered); both columns
// default 0, so any unstamped row fails and reads as behind — the
// analyzed_rule_version 0/never-behind precedent. Kept as one const so
// the sweep's selection, the canonical read and any coverage query can
// never spell the comparison differently (design §4: one spelling).
//
// The rule stamp counts only for an analysis-dependent metric (its touched
// set holds an analysis table, see analysisTables): a fact-only metric
// stays fresh across an analysis code bump, because nothing it reads was
// computed under the rules.
var metricValueFreshCond = `v.metric_version >= m.version AND (v.rule_version >= ? OR NOT ` + analysisTouchedExpr + `)`

// MetricCoverage answers THE behind predicate (stored-metrics design §4,
// "one spelling shared by sweep and read") for EVERY metric, in the
// canonical metric-list order (metricOrder — builtin → user → plugin,
// name ASC), so callers get a stable ordering without a second sort:
//
//	behind(m) ⟺ ∃ row of m failing the stamps (metric_version < m.version
//	            OR rule_version < live)                        — version axis
//	         OR ∃ match-scope unit (a ready match) with NO fresh row — source axis
//	         OR (profile) the career bucket has no fresh row WHILE the
//	            library has player data to compute it over
//
// There is no subject column (ruling 51): the match-scope
// clause answers every metric at match extent, and the career clause every
// profile-scoped one (scope is derived from the binds, see ScopeOfExpr).
//
// Partitioning is the statement's dim column (ruling 51): the coverage
// predicate does not read dims, so a new dim value does not by itself mark
// a metric behind.
//
// The unit clauses are what make the work list resumable and honest: a
// newly imported match has no rows yet (nothing to stamp), and the
// career bucket is cleared wholesale when analysis regenerates its
// inputs (RebuildCareer) — both must read as behind without any
// persisted target state. The library-empty guards (EXISTS ready match /
// EXISTS player_stats) keep an empty library from reporting permanent
// behindness for work that does not exist: not-behind + zero rows is
// the no-data state, never an infinite recompute loop.
//
// A dependency-chain clause is deliberately NOT spelled here: a save's
// cascade bump already moves every transitive dependent's own version
// (SaveMetricWithDeps), and input-regeneration deletes clear the
// DEPENDENT's rows too (childTables / RebuildCareer clear by key, all
// metrics), so the chain is covered by the two clauses above. The sweep
// additionally takes the forward closure of this set (metrics.Sweep) —
// an upstream behind forces its dependents into the work list even when
// their own stamps still look live.
// profileMetricIDsJSON is the JSON array of the ids of every metric whose
// scope derives to profile (its expr reads :steam_id). The coverage query
// tests membership through json_each, so the scope is never a column.
func (s *Store) profileMetricIDsJSON() (string, error) {
	rows, err := s.db.Query(`SELECT id, expr FROM metrics`)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	ids := []int64{}
	for rows.Next() {
		var id int64
		var expr string
		if err := rows.Scan(&id, &expr); err != nil {
			return "", err
		}
		if ScopeOfExpr(expr) == "profile" {
			ids = append(ids, id)
		}
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	b, err := json.Marshal(ids)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func (s *Store) MetricCoverage(liveRuleVersion int) ([]MetricCoverage, error) {
	profileJSON, err := s.profileMetricIDsJSON()
	if err != nil {
		return nil, fmt.Errorf("couldn't load the metric coverage: %w", err)
	}
	rows, err := s.db.Query(
		`SELECT m.id, m.expr, m.touched, m.version,
			CASE WHEN (
				EXISTS (SELECT 1 FROM metric_values v
					WHERE v.metric_id = m.id
					  AND (v.metric_version < m.version OR (v.rule_version < ? AND `+analysisTouchedExpr+`)))
				OR (m.id NOT IN (SELECT value FROM json_each(?)) AND EXISTS (
					SELECT 1 FROM matches mt WHERE mt.status = 'ready'
					  AND NOT EXISTS (SELECT 1 FROM metric_values v
						WHERE v.metric_id = m.id AND v.match_id = mt.id
						  AND `+metricValueFreshCond+`)))
				OR (m.id IN (SELECT value FROM json_each(?)) AND EXISTS (SELECT 1 FROM player_stats)
					AND NOT EXISTS (SELECT 1 FROM metric_values v
						WHERE v.metric_id = m.id AND v.match_id = 0
						  AND `+metricValueFreshCond+`))
			) THEN 1 ELSE 0 END AS behind,
			(SELECT COUNT(*) FROM metric_values v
				WHERE v.metric_id = m.id AND `+metricValueFreshCond+`) AS fresh
		FROM metrics m
		ORDER BY `+metricOrder,
		liveRuleVersion, profileJSON, liveRuleVersion, profileJSON, liveRuleVersion, liveRuleVersion,
	)
	if err != nil {
		return nil, fmt.Errorf("couldn't load the metric coverage: %w", err)
	}
	defer rows.Close()
	type pending struct {
		cov     MetricCoverage
		expr    string
		touched string
		version int
	}
	var list []pending
	for rows.Next() {
		var p pending
		var behind int
		if err := rows.Scan(&p.cov.MetricID, &p.expr, &p.touched, &p.version, &behind, &p.cov.FreshRows); err != nil {
			return nil, fmt.Errorf("couldn't load the metric coverage: %w", err)
		}
		p.cov.Behind = behind != 0
		list = append(list, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("couldn't load the metric coverage: %w", err)
	}
	// Classification runs after the cursor closes: a raw metric's coverage
	// is its own run-record predicate (rawBehind), never the sugar clauses
	// above, and a metric whose touched set is unknown ('') reads behind,
	// never fresh.
	_ = rows.Close()
	out := make([]MetricCoverage, 0, len(list))
	for _, p := range list {
		c := p.cov
		switch p.touched {
		case "":
			c.Behind = true
		default:
			behind, units, err := s.rawBehind(c.MetricID, p.version, liveRuleVersion, p.touched, p.expr)
			if err != nil {
				return nil, fmt.Errorf("couldn't load the metric coverage: %w", err)
			}
			c.Behind = behind
			c.BehindMatches = units
			steams, err := s.staleSteamUnits(c.MetricID, p.version, liveRuleVersion, p.touched, p.expr)
			if err != nil {
				return nil, fmt.Errorf("couldn't load the metric coverage: %w", err)
			}
			c.BehindSteams = steams
		}
		out = append(out, c)
	}
	return out, nil
}

// rawBehind is the raw metric's behind predicate:
// behind iff some UNIT the metric's bind shape expects has no run record
// at the current metric version and the current rule version. The units
// are the sweep's own enumeration (metrics.RawScopes): library-wide (one
// unit), :match_id (each ready match), :steam_id (each ready human) and
// match_id with :round (each ready round). A ready match with no rounds
// contributes no round unit, so it is covered (no-data, not behind). A
// statement whose binds cannot be classified is behind, never fresh.
func (s *Store) rawBehind(metricID int64, version, liveRuleVersion int, touched, expr string) (bool, []int64, error) {
	st, gerr := AnalyzeMetricSQL(expr, nil)
	if gerr != nil {
		return true, nil, nil
	}
	// Only an analysis-dependent metric answers to the rule generation: a
	// fact-only run is fresh across a rule bump (rule 0 is always met).
	if !touchesAnalysis(touched) {
		liveRuleVersion = 0
	}
	used := map[string]bool{}
	for _, b := range st.Binds {
		used[b] = true
	}
	if used[":match_id"] && !used[":steam_id"] && !used[":round"] {
		return s.staleMatchUnits(metricID, version, liveRuleVersion)
	}
	const fresh = `r.metric_version >= ? AND r.rule_version >= ?`
	var unitsMissing string
	switch {
	case used[":steam_id"] && (used[":match_id"] || used[":round"]):
		return true, nil, nil
	case used[":round"] && !used[":match_id"]:
		return true, nil, nil
	case used[":steam_id"]:
		unitsMissing = `EXISTS (SELECT 1 FROM players p JOIN matches mt ON mt.id = p.match_id
			WHERE mt.status = 'ready' AND p.is_bot = 0
			AND NOT EXISTS (SELECT 1 FROM metric_runs r WHERE r.metric_id = ? AND r.match_id = 0
				AND r.scope_steam_id = p.steam_id AND r.scope_round = 0 AND ` + fresh + `))`
	case used[":round"]:
		unitsMissing = `EXISTS (SELECT 1 FROM rounds rd JOIN matches mt ON mt.id = rd.match_id
			WHERE mt.status = 'ready'
			AND NOT EXISTS (SELECT 1 FROM metric_runs r WHERE r.metric_id = ? AND r.match_id = rd.match_id
				AND r.scope_steam_id = '' AND r.scope_round = rd.number AND ` + fresh + `))`
	default:
		// The library-wide unit exists only once a ready match does: an
		// empty library owes nothing (the same guard the profile clause
		// uses), so a failed import never leaves a builtin behind.
		unitsMissing = `EXISTS (SELECT 1 FROM matches mt WHERE mt.status = 'ready')
			AND NOT EXISTS (SELECT 1 FROM metric_runs r WHERE r.metric_id = ? AND r.match_id = 0
			AND r.scope_steam_id = '' AND r.scope_round = 0 AND ` + fresh + `)`
	}
	var missing int
	if err := s.db.QueryRow(`SELECT CASE WHEN `+unitsMissing+` THEN 1 ELSE 0 END`,
		metricID, version, liveRuleVersion).Scan(&missing); err != nil {
		return false, nil, err
	}
	return missing != 0, nil, nil
}

// staleSteamUnits lists the human players of ready matches whose unit of a
// steam_id-only metric has no fresh run record: the per-unit spelling of
// rawBehind's steam branch. Empty for any other bind shape.
func (s *Store) staleSteamUnits(metricID int64, version, liveRuleVersion int, touched, expr string) ([]string, error) {
	st, gerr := AnalyzeMetricSQL(expr, nil)
	if gerr != nil {
		return nil, nil
	}
	used := map[string]bool{}
	for _, b := range st.Binds {
		used[b] = true
	}
	if !used[":steam_id"] || used[":match_id"] || used[":round"] {
		return nil, nil
	}
	if !touchesAnalysis(touched) {
		liveRuleVersion = 0
	}
	rows, err := s.db.Query(`SELECT DISTINCT p.steam_id FROM players p JOIN matches mt ON mt.id = p.match_id
		WHERE mt.status = 'ready' AND p.is_bot = 0
		AND NOT EXISTS (SELECT 1 FROM metric_runs r WHERE r.metric_id = ? AND r.match_id = 0
			AND r.scope_steam_id = p.steam_id AND r.scope_round = 0
			AND r.metric_version >= ? AND r.rule_version >= ?)
		ORDER BY p.steam_id`, metricID, version, liveRuleVersion)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// MetricFreshForPlayer counts, per metric, the FRESH career rows (match_id 0)
// of ONE player: the per-player half of the coverage read.
func (s *Store) MetricFreshForPlayer(steamID string, liveRuleVersion int) (map[int64]int, error) {
	rows, err := s.db.Query(
		`SELECT v.metric_id, COUNT(*) FROM metric_values v JOIN metrics m ON m.id = v.metric_id
		 WHERE v.match_id = 0 AND v.subject_key = ? AND `+metricValueFreshCond+` GROUP BY v.metric_id`,
		steamID, liveRuleVersion)
	if err != nil {
		return nil, fmt.Errorf("couldn't load the player's metric rows: %w", err)
	}
	defer rows.Close()
	out := map[int64]int{}
	for rows.Next() {
		var id int64
		var n int
		if err := rows.Scan(&id, &n); err != nil {
			return nil, fmt.Errorf("couldn't load the player's metric rows: %w", err)
		}
		out[id] = n
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("couldn't load the player's metric rows: %w", err)
	}
	return out, nil
}

// staleMatchUnits lists the ready matches whose unit of a :match_id metric has
// no fresh run record (the per-unit spelling of the match clause). An empty
// list means every ready match is fresh for this metric.
func (s *Store) staleMatchUnits(metricID int64, version, liveRuleVersion int) (bool, []int64, error) {
	rows, err := s.db.Query(`SELECT mt.id FROM matches mt WHERE mt.status = 'ready'
		AND NOT EXISTS (SELECT 1 FROM metric_runs r WHERE r.metric_id = ? AND r.match_id = mt.id
			AND r.scope_steam_id = '' AND r.scope_round = 0
			AND r.metric_version >= ? AND r.rule_version >= ?)
		ORDER BY mt.id`, metricID, version, liveRuleVersion)
	if err != nil {
		return false, nil, err
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return false, nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return false, nil, err
	}
	return len(ids) > 0, ids, nil
}

// MetricFreshForMatch counts, per metric, the FRESH rows (metricValueFreshCond)
// that belong to ONE match: the per-match half of the coverage read. The match
// view's state asks only whether this match holds fresh values.
func (s *Store) MetricFreshForMatch(matchID int64, liveRuleVersion int) (map[int64]int, error) {
	rows, err := s.db.Query(
		`SELECT v.metric_id, COUNT(*) FROM metric_values v JOIN metrics m ON m.id = v.metric_id
		 WHERE v.match_id = ? AND `+metricValueFreshCond+` GROUP BY v.metric_id`,
		matchID, liveRuleVersion)
	if err != nil {
		return nil, fmt.Errorf("couldn't load the match's metric rows: %w", err)
	}
	defer rows.Close()
	out := map[int64]int{}
	for rows.Next() {
		var id int64
		var n int
		if err := rows.Scan(&id, &n); err != nil {
			return nil, fmt.Errorf("couldn't load the match's metric rows: %w", err)
		}
		out[id] = n
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("couldn't load the match's metric rows: %w", err)
	}
	return out, nil
}

// UnitFresh reports whether ONE unit (a run scope) of a metric holds a fresh
// run record: the per-unit spelling of rawBehind's fresh clause. touched is the
// metric's stored touched set; the rule axis counts only for an
// analysis-dependent metric, as in rawBehind.
func (s *Store) UnitFresh(metricID int64, version int, touched []string, liveRuleVersion int, scope RawScope) (bool, error) {
	if !touchesAnalysis(touchedColumn(touched)) {
		liveRuleVersion = 0
	}
	var n int
	if err := s.db.QueryRow(
		`SELECT COUNT(*) FROM metric_runs r
		 WHERE r.metric_id = ? AND r.match_id = ? AND r.scope_steam_id = ? AND r.scope_round = ?
		   AND r.metric_version >= ? AND r.rule_version >= ?`,
		metricID, scope.MatchID, scrub(scope.SteamID), scope.Round, version, liveRuleVersion,
	).Scan(&n); err != nil {
		return false, fmt.Errorf("couldn't read the metric's unit: %w", err)
	}
	return n > 0, nil
}

// SetMetricTouched stores a metric's derived touched set (the save gate's
// output). nil or empty stores ” — not derived (the behind predicate reads
// that as unknown).
// StoredTouched is the touched set a metric keeps. A statement that reads only
// metric() references touches no physical table (the reference adds none to the
// gate's set), but its stored set must not read as unknown (” reads behind),
// so it stores the stored-values table it reads through. hasRefs reports
// whether the statement carries any metric() reference.
func StoredTouched(touched []string, hasRefs bool) []string {
	if len(touched) == 0 && hasRefs {
		return []string{"metric_values"}
	}
	return touched
}

func (s *Store) SetMetricTouched(metricID int64, tables []string) error {
	res, err := s.db.Exec(`UPDATE metrics SET touched = ? WHERE id = ?`, touchedColumn(tables), metricID)
	if err != nil {
		return fmt.Errorf("couldn't save the metric's touched tables: %w", err)
	}
	return affectedOrNotFound(res, "saving the metric's touched tables")
}

// MetricValueRow is ONE fresh stored value the compute pass inserts
// (phase 2). MatchID 0 is the profile (career) grain; SubjectKey is the
// row's subject — a player's SteamID64 (humans only — the statement
// already applied store.HumanOnly + subject <> ”, so the pass never
// filters here), a team key, or ” for a match subject (its address IS
// MatchID); Dim is the partition value (” = unpartitioned — §6.5) and
// ValueKey the identity slot (§3.3): the argmax winner's player key on
// an identity row, ” on every number-valued row (valuesFromPlan maps
// it from the plan's idkey column).
type MetricValueRow struct {
	MatchID    int64
	SubjectKey string
	Dim        string
	Value      float64
	ValueKey   string
}

// ClearMetricValues removes ALL of one metric's stored rows in one small
// transaction and commits. The sweep no longer calls it for a metric that
// can run (its phase 1 is ClearMetricUnits, per unit, ruling 20); it is the
// whole-metric clear for a metric that cannot run at all (a gate or cycle
// failure), where no unit of it is valid.
//
// The commit IS the crash boundary (design §4's crash matrix): after
// this commits, the metric has no rows → absent → behind → retried; a
// rollback here (or a crash before it) leaves the outdated rows present
// but INVISIBLE — MetricCoverage's fresh count excludes them, so no
// reader can see them.
func (s *Store) ClearMetricValues(metricID int64) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("couldn't clear the metric values: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`DELETE FROM metric_values WHERE metric_id = ?`, metricID); err != nil {
		return fmt.Errorf("couldn't clear the metric values: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM metric_runs WHERE metric_id = ?`, metricID); err != nil {
		return fmt.Errorf("couldn't clear the metric values: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("couldn't clear the metric values: %w", err)
	}
	return nil
}

// ClearMetricUnits is the sweep's phase 1 for a raw metric (ruling 20): it
// removes the rows and run records of the given units ONLY, in one
// transaction. Every other unit of the metric keeps its rows, so a sweep of
// match M never deletes another match's values. The zero RawScope is the
// library-wide unit and clears the metric's unbound result.
func (s *Store) ClearMetricUnits(metricID int64, scopes []RawScope) error {
	if len(scopes) == 0 {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("couldn't clear the metric values: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	for _, sc := range scopes {
		if _, err := tx.Exec(`DELETE FROM metric_values WHERE metric_id = ? AND match_id = ? AND scope_steam_id = ? AND scope_round = ?`,
			metricID, sc.MatchID, scrub(sc.SteamID), sc.Round); err != nil {
			return fmt.Errorf("couldn't clear the metric values: %w", err)
		}
		if _, err := tx.Exec(`DELETE FROM metric_runs WHERE metric_id = ? AND match_id = ? AND scope_steam_id = ? AND scope_round = ?`,
			metricID, sc.MatchID, scrub(sc.SteamID), sc.Round); err != nil {
			return fmt.Errorf("couldn't clear the metric values: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("couldn't clear the metric values: %w", err)
	}
	return nil
}

// InsertMetricValues is the compute pass's PHASE 2 (design §4): the
// whole fresh set for ONE metric, stamped with both current versions +
// computed_at, written in ONE transaction. That commit is THE commit
// marker: a committed insert is fresh, anything else is not-fresh —
// a failure mid-insert rolls the transaction back (no half-written
// metric; absent → behind → the next sweep re-runs it), so the table is
// strictly fresh-or-nothing at rest.
//
// The store is the ONE write chokepoint for both phase writers. There is no
// subject column to check a match-grain rule against (ruling 51),
// so the writer stores whatever rows the statement returns.
func (s *Store) InsertMetricValues(metricID int64, metricVersion, ruleVersion int, rows []MetricValueRow) error {
	if len(rows) == 0 {
		return nil // nothing to commit — the metric simply has no rows (absent → behind)
	}
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("couldn't save the metric values: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	stmt, err := tx.Prepare(
		`INSERT INTO metric_values (metric_id, match_id, subject_key, dim, value, value_key, metric_version, rule_version, computed_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return fmt.Errorf("couldn't save the metric values: %w", err)
	}
	defer stmt.Close()
	now := time.Now()
	for _, r := range rows {
		if _, err := stmt.Exec(metricID, r.MatchID, scrub(r.SubjectKey), scrub(r.Dim), r.Value, scrub(r.ValueKey), metricVersion, ruleVersion, now); err != nil {
			return fmt.Errorf("couldn't save the metric values: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("couldn't save the metric values: %w", err)
	}
	return nil
}

// RawScope is the reserved-bind scope of one raw-SQL run (03-QUERIES.md
// §5): MatchID for :match_id (and :round), SteamID for :steam_id, Round
// for :round. The zero value is the unbound, library-wide run.
type RawScope struct {
	MatchID int64
	SteamID string
	Round   int
}

// RawMetricRow is one row of a raw statement's result after the engine has
// read its reserved columns: Value nil is SQL NULL (no data, ruling 23);
// RowJSON is the opaque JSON of every other column.
type RawMetricRow struct {
	SubjectKey string
	Dim        string
	Value      *float64
	// ValueKey is the identity slot: the winner's key on an identity row, '' otherwise.
	ValueKey string
	RowJSON  string
}

// ReplaceRawMetricValues stores one raw run's result. It replaces the rows
// carrying the run's own scope tags and nothing else: a :match_id run for
// match 5 leaves match 6's rows alone, and the unbound run replaces the
// whole unbound result. One transaction, so a failure keeps the previous
// rows (the caller clears them when the metric as a whole fails).
func (s *Store) ReplaceRawMetricValues(metricID int64, metricVersion, ruleVersion int, scope RawScope, rows []RawMetricRow) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("couldn't save the metric values: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(
		`DELETE FROM metric_values WHERE metric_id = ? AND match_id = ? AND scope_steam_id = ? AND scope_round = ?`,
		metricID, scope.MatchID, scrub(scope.SteamID), scope.Round,
	); err != nil {
		return fmt.Errorf("couldn't save the metric values: %w", err)
	}
	// The run record is replaced in the same transaction: a scope with no
	// rows still gets one, so "computed, zero rows" is distinguishable from
	// "never computed" (rawBehind).
	if _, err := tx.Exec(
		`DELETE FROM metric_runs WHERE metric_id = ? AND match_id = ? AND scope_steam_id = ? AND scope_round = ?`,
		metricID, scope.MatchID, scrub(scope.SteamID), scope.Round,
	); err != nil {
		return fmt.Errorf("couldn't save the metric values: %w", err)
	}
	if _, err := tx.Exec(
		`INSERT INTO metric_runs (metric_id, match_id, scope_steam_id, scope_round, metric_version, rule_version, computed_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		metricID, scope.MatchID, scrub(scope.SteamID), scope.Round, metricVersion, ruleVersion, time.Now(),
	); err != nil {
		return fmt.Errorf("couldn't save the metric values: %w", err)
	}
	stmt, err := tx.Prepare(
		`INSERT INTO metric_values (metric_id, match_id, subject_key, dim, value, value_key, metric_version, rule_version, computed_at, scope_steam_id, scope_round, row_json)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return fmt.Errorf("couldn't save the metric values: %w", err)
	}
	defer stmt.Close()
	now := time.Now()
	for _, r := range rows {
		var value any // nil binds SQL NULL
		if r.Value != nil {
			value = *r.Value
		}
		if _, err := stmt.Exec(metricID, scope.MatchID, scrub(r.SubjectKey), scrub(r.Dim), value, scrub(r.ValueKey),
			metricVersion, ruleVersion, now, scrub(scope.SteamID), scope.Round, scrub(r.RowJSON)); err != nil {
			return fmt.Errorf("couldn't save the metric values: %w", err)
		}
	}
	// This run's result is a change to metricID's data for its own unit:
	// the dependents bound to that unit go behind, the rest stay fresh
	// (scope-aware cascade). A library-wide run is a whole change.
	sc := changeScope{MatchID: scope.MatchID, SteamID: scope.SteamID}
	if scope.MatchID == 0 && scope.SteamID == "" {
		sc.Whole = true
	}
	if err := invalidateDependents(tx, metricID, sc); err != nil {
		return fmt.Errorf("couldn't save the metric values: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("couldn't save the metric values: %w", err)
	}
	return nil
}

// ---- The canonical READ (stored-metrics design §5) -------------------------
//
// ONE read per value surface: GetMetricValuesForMatch (the match grain —
// scoreboard pins, Reports appendix) and GetMetricValuesForPlayer (the
// career grain — PlayerProfile's panel, Builder's saved preview), plus
// GetPlayerMetricSeries. All three
// serve FRESH rows only — the SAME metricValueFreshCond the sweep's
// selection and MetricCoverage spell (design §4: one predicate, shared
// by sweep and read), so an outdated row never leaves the store and no
// caller can ever render a stale value. The DTO is exactly
// {metricId, subjectKey, dim, value, valueKey}: no stamps, no
// computed_at (they are INTERNAL-ONLY — models.MetricValue carries no
// such field, so a stamp cannot reach a view, tooltip or export by
// construction). Rows come
// back in the canonical metric order (metricOrder — builtin → user →
// plugin, name ASC) then subject_key, so a caller zips them against
// ListMetrics without a second sort.

// metricValueFreshSQL is the read's row clause: a row is fresh iff it
// was computed under the metric's CURRENT version and the CURRENT
// analysis rule version — metricValueFreshCond, prefixed with the join
// it needs (m.version). value_key rides every row (the identity slot —
// §3.3 — ” on numeric rows).
var metricValueFreshSQL = `SELECT v.metric_id, v.subject_key, v.dim, v.value, v.value_key
	FROM metric_values v
	JOIN metrics m ON m.id = v.metric_id
	WHERE ` + metricValueFreshCond

// metricIDsCond appends the optional metric filter (`AND v.metric_id IN
// (…)`) and returns its args; an empty set means "every metric" (no
// clause — the caller asked for the whole pinned/checked set it has).
func metricIDsCond(metricIDs []int64) (string, []any) {
	if len(metricIDs) == 0 {
		return "", nil
	}
	ph := make([]string, len(metricIDs))
	args := make([]any, len(metricIDs))
	for i, id := range metricIDs {
		ph[i] = "?"
		args[i] = id
	}
	return " AND v.metric_id IN (" + strings.Join(ph, ",") + ")", args
}

// scanMetricValues drains a canonical-read cursor into canonical order.
func scanMetricValues(rows *sql.Rows) ([]models.MetricValue, error) {
	var out []models.MetricValue
	for rows.Next() {
		var v models.MetricValue
		var value sql.NullFloat64
		if err := rows.Scan(&v.MetricID, &v.SubjectKey, &v.Dim, &value, &v.ValueKey); err != nil {
			return nil, err
		}
		if value.Valid {
			x := value.Float64
			v.Value = &x
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// GetMetricValuesForMatch is THE match-grain value read (design §5):
// every FRESH stored row of the requested metrics for ONE match
// (match_id = matchID; matchID must be > 0 — the career grain is
// GetMetricValuesForPlayer), in canonical metric order then subject_key.
// metricIDs narrows the read (empty = every metric). Absent rows are
// ABSENT: the read never fabricates a 0 for a player the statement did
// not produce — the view renders the state instead.
func (s *Store) GetMetricValuesForMatch(matchID int64, metricIDs []int64) ([]models.MetricValue, error) {
	if matchID <= 0 {
		return nil, errors.New("a match id is required")
	}
	cfg, err := s.GetConfig()
	if err != nil {
		return nil, fmt.Errorf("couldn't load the match metric values: %w", err)
	}
	idCond, idArgs := metricIDsCond(metricIDs)
	// scope_round = 0: round-grain rows (a :round run) are the round read's,
	// never the match read's, so a match's scoreboard cannot see them.
	q := metricValueFreshSQL + ` AND v.match_id = ? AND v.scope_round = 0` + idCond + `
		ORDER BY ` + metricOrder + `, v.subject_key`
	args := append([]any{cfg.RuleVersion, matchID}, idArgs...)
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("couldn't load the match metric values: %w", err)
	}
	defer rows.Close()
	out, err := scanMetricValues(rows)
	if err != nil {
		return nil, fmt.Errorf("couldn't load the match metric values: %w", err)
	}
	return out, nil
}

// GetMetricValuesForRound is THE round-grain value read: FRESH stored rows of one round of one
// match, in canonical metric order then subject_key then dim. metricIDs
// narrows the read (empty = every metric). Absent rows are absent: a
// player or side the statement did not produce has no row, and a NULL
// value is returned as nil (ruling 23), never as 0.
func (s *Store) GetMetricValuesForRound(matchID, round int64, metricIDs []int64) ([]models.MetricValue, error) {
	if matchID <= 0 {
		return nil, errors.New("a match id is required")
	}
	if round <= 0 {
		return nil, errors.New("a round number is required")
	}
	cfg, err := s.GetConfig()
	if err != nil {
		return nil, fmt.Errorf("couldn't load the round metric values: %w", err)
	}
	idCond, idArgs := metricIDsCond(metricIDs)
	q := metricValueFreshSQL + ` AND v.match_id = ? AND v.scope_round = ? AND v.scope_steam_id = ''` + idCond + `
		ORDER BY ` + metricOrder + `, v.subject_key, v.dim`
	args := append([]any{cfg.RuleVersion, matchID, round}, idArgs...)
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("couldn't load the round metric values: %w", err)
	}
	defer rows.Close()
	out, err := scanMetricValues(rows)
	if err != nil {
		return nil, fmt.Errorf("couldn't load the round metric values: %w", err)
	}
	return out, nil
}

// GetMetricValuesForPlayer is THE career-grain value read (design §5):
// FRESH stored rows at match_id = 0 (the profile grain), in canonical
// metric order then subject_key. steamID "" reads the WHOLE career bucket
// (every player — the coverage a value slot needs to tell "no data for
// this player" from "behind", and Builder's all-players profile
// preview); a non-empty steamID narrows to that one player's subject_key.
// metricIDs narrows the read (empty = every metric). Same honesty rule
// as the match read: a player with no stored row has NO row.
func (s *Store) GetMetricValuesForPlayer(steamID string, metricIDs []int64) ([]models.MetricValue, error) {
	cfg, err := s.GetConfig()
	if err != nil {
		return nil, fmt.Errorf("couldn't load the player metric values: %w", err)
	}
	idCond, idArgs := metricIDsCond(metricIDs)
	steamCond := ""
	var args []any
	if steamID != "" {
		steamCond = " AND v.subject_key = ?"
		args = append(args, steamID)
	}
	q := metricValueFreshSQL + ` AND v.match_id = 0` + steamCond + idCond + `
		ORDER BY ` + metricOrder + `, v.subject_key`
	args = append(append([]any{cfg.RuleVersion}, args...), idArgs...)
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("couldn't load the player metric values: %w", err)
	}
	defer rows.Close()
	out, err := scanMetricValues(rows)
	if err != nil {
		return nil, fmt.Errorf("couldn't load the player metric values: %w", err)
	}
	return out, nil
}

// MetricDisplayScale is THE format-keyed display-unit conversion for a
// stored metric value: percent metrics store a 0..1 FRACTION while every
// percent surface renders 0..100 (fmtPercent, the profile's trend and
// history DTOs, the report read-back), so a FRESH value multiplies by
// 100 on its way out; every other format stores its display number as
// it stands (scale 1). One spelling — seriesMetricFor (the trend and
// history series read) and the report package's Go read-back both derive
// from it, so a format tag can never mean two scales in two readers
// This is a unit
// conversion on a fresh stored value, never a recomputation: a subject
// with no fresh row never reaches it (the reads omit it).
func MetricDisplayScale(format string) float64 {
	if format == "percent" {
		return 100
	}
	return 1
}

// seriesMetric is one metric's series-read parameters: the definition id
// GetPlayerMetricSeries filters on, plus the display scale its format
// tag implies (MetricDisplayScale — percent metrics store a 0..1
// FRACTION while the profile's trend and history DTOs have always
// carried the 0..100 percent their consumers render).
type seriesMetric struct {
	id    int64
	scale float64
}

// seriesMetricFor resolves a metric NAME (the trend's picked definition —
// any match-scope name the catalog carries, the history's
// assists|adr|kast seeds) to its seriesMetric. ok=false when the catalog
// carries no such definition — the caller then renders the unknown-name
// error / an honest empty series instead of falling back to Go
// arithmetic.
func (s *Store) seriesMetricFor(seedName string) (seriesMetric, bool, error) {
	def, err := s.GetMetricByName(seedName)
	if errors.Is(err, ErrNotFound) {
		return seriesMetric{}, false, nil
	}
	if err != nil {
		return seriesMetric{}, false, err
	}
	return seriesMetric{id: def.ID, scale: MetricDisplayScale(def.Format)}, true, nil
}

// GetPlayerMetricSeries is THE match-grain SERIES read — the one store
// read behind the profile's trend sparkline and match-history cells
// every FRESH
// stored row of the requested metrics for ONE subject at match grain
// (match_id > 0), carrying the match's patch and import time.
//
// Same honesty rules as the two canonical reads above: FRESH rows only
// (metricValueFreshCond — the ONE spelling; an outdated row is present
// but never served), and an ABSENT row is ABSENT — a match the compute
// pass produced no fresh row for does not appear, so the caller renders
// an honest gap (the sparkline's ≥2-point requirement does the rest)
// and never a recomputed or fabricated number.
//
// The row order IS the trend's x axis (the rationale lives on GetTrend's
// doc, which used to spell this query): known CS2 patch numbers
// ascending, unknowns (patch_version = 0 — the column default, never
// "patch 0") trailing, then m.extracted_at ASC (the within-patch
// tiebreaker), m.id ASC, and finally v.metric_id ASC so a multi-metric
// request is deterministic inside one match.
//
// HUMANS ONLY (HumanOnlyBySteamID): the compute pass never writes a bot
// row, and the guard keeps a bot id from ever resolving to a series —
// the same contract GetTrend has always documented (this is the profile
// read reachable from a bare /player/<id> URL).
func (s *Store) GetPlayerMetricSeries(steamID string, metricIDs []int64) ([]models.MetricSeriesPoint, error) {
	cfg, err := s.GetConfig()
	if err != nil {
		return nil, fmt.Errorf("couldn't load the metric series: %w", err)
	}
	idCond, idArgs := metricIDsCond(metricIDs)
	q := `SELECT v.metric_id, v.match_id, v.value, mt.patch_version, mt.extracted_at
		FROM metric_values v
		JOIN metrics m ON m.id = v.metric_id
		JOIN matches mt ON mt.id = v.match_id
		WHERE ` + metricValueFreshCond + `
		  AND v.value IS NOT NULL
		  AND v.subject_key = ? AND v.match_id > 0 AND mt.extracted_at IS NOT NULL
		  AND ` + HumanOnlyBySteamID("v.subject_key", "v.match_id") + idCond + `
		ORDER BY (mt.patch_version = 0) ASC, mt.patch_version ASC,
		         mt.extracted_at ASC, mt.id ASC, v.metric_id ASC`
	args := append([]any{cfg.RuleVersion, scrub(steamID)}, idArgs...)
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("couldn't load the metric series: %w", err)
	}
	defer rows.Close()
	var out []models.MetricSeriesPoint
	for rows.Next() {
		var p models.MetricSeriesPoint
		var extracted sql.NullTime
		if err := rows.Scan(&p.MetricID, &p.MatchID, &p.Value, &p.Patch, &extracted); err != nil {
			return nil, fmt.Errorf("couldn't load the metric series: %w", err)
		}
		p.ExtractedAt = nullTime(extracted)
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("couldn't load the metric series: %w", err)
	}
	return out, nil
}

// QueryWrite executes a SELECT on the WRITE handle — a read for
// fixtures that have no file to reopen read-only (":memory:" stores)
// and for test assertions. Metric SQL never runs here: the writer is ONE
// connection, so a statement open on it parks every write behind it
// (TestQueryWriteHoldsTheWriter pins that) — the metric path is
// QueryMetric (metric_exec.go). Validation is the SAME
// ValidateReadOnlySQL gate as RunReadOnly, the row cap is the caller's,
// and ctx cancels the statement mid-flight plus every row iteration.
// Returns the shared ROResult shape (normalized JSON scalars).
func (s *Store) QueryWrite(ctx context.Context, q string, args []any, limit int) (ROResult, error) {
	if err := ValidateReadOnlySQL(q); err != nil {
		return ROResult{}, err
	}
	if limit <= 0 {
		limit = DefaultRowLimit
	}
	start := time.Now()
	elapsed := func() int64 { return time.Since(start).Milliseconds() }
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return ROResult{MS: elapsed()}, fmt.Errorf("couldn't run the query: %w", err)
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return ROResult{MS: elapsed()}, fmt.Errorf("couldn't run the query: %w", err)
	}
	out := ROResult{Columns: cols}
	for rows.Next() {
		if cerr := ctx.Err(); cerr != nil {
			return ROResult{MS: elapsed()}, cerr
		}
		if len(out.Rows) >= limit {
			out.Truncated = true // one row beyond the cap was fetched and discarded
			break
		}
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return ROResult{MS: elapsed()}, fmt.Errorf("couldn't run the query: %w", err)
		}
		for i, v := range vals {
			vals[i] = normValue(v)
		}
		out.Rows = append(out.Rows, vals)
	}
	if err := rows.Err(); err != nil {
		return ROResult{MS: elapsed()}, fmt.Errorf("couldn't run the query: %w", err)
	}
	out.MS = elapsed()
	return out, nil
}

// bumpMetricAndDependents is the cascade version bump (design §4): in
// the CALLER'S transaction it walks metric_deps forward from id — the
// edited metric plus every TRANSITIVE dependent — and adds 1 to each
// row's version. One tx = atomic: nothing is partially behind after
// commit, and the order of the UPDATEs inside it is irrelevant.
//
// The walk is by NAME (metric_deps stores the referenced metric's UNIQUE
// name — ids churn on plugin replace) and only ever moves FORWARD
// (dependents of already-bumped names), so a hand-edited cycle cannot
// loop forever: every metric is bumped exactly once. A rename's splice
// already rewrote the dependents' edges inside this same tx (the
// rewrites ran first), so the graph the walk sees is the POST-save one.
//
// The bump marks the metric behind (MetricCoverage reads the stored
// version); it writes NOTHING into metric_values — deletion of outdated
// rows is the sweep's alone (design §4: SaveMetric stays a pure bump tx,
// SetConfig a pure config bump).
func bumpMetricAndDependents(tx *sql.Tx, id int64) error {
	seen := map[int64]bool{}
	frontier := []int64{id}
	for len(frontier) > 0 {
		ids := make([]any, 0, len(frontier))
		ph := make([]string, 0, len(frontier))
		for _, f := range frontier {
			ids = append(ids, f)
			ph = append(ph, "?")
		}
		// Read the frontier's (id, name) pairs FIRST — the rows must be
		// closed before any UPDATE runs: a tx is one connection, and an
		// open cursor would block the writes below.
		type node struct {
			id   int64
			name string
		}
		var nodes []node
		rows, err := tx.Query(`SELECT id, name FROM metrics WHERE id IN (`+strings.Join(ph, ",")+`)`, ids...)
		if err != nil {
			return fmt.Errorf("couldn't update the metric versions: %w", err)
		}
		for rows.Next() {
			var n node
			if err := rows.Scan(&n.id, &n.name); err != nil {
				rows.Close()
				return fmt.Errorf("couldn't update the metric versions: %w", err)
			}
			nodes = append(nodes, n)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return fmt.Errorf("couldn't update the metric versions: %w", err)
		}
		rows.Close()
		if len(nodes) == 0 {
			break
		}
		var names []any
		var namePh []string
		for _, n := range nodes {
			if _, err := tx.Exec(`UPDATE metrics SET version = version + 1 WHERE id = ?`, n.id); err != nil {
				return fmt.Errorf("couldn't update the metric versions: %w", err)
			}
			seen[n.id] = true
			names = append(names, n.name)
			namePh = append(namePh, "?")
		}
		// Next frontier: every metric referencing a bumped name that has
		// not been bumped yet.
		next, err := tx.Query(
			`SELECT DISTINCT metric_id FROM metric_deps WHERE dep_name IN (`+strings.Join(namePh, ",")+`)`,
			names...,
		)
		if err != nil {
			return fmt.Errorf("couldn't update the metric versions: %w", err)
		}
		var f2 []int64
		for next.Next() {
			var nid int64
			if err := next.Scan(&nid); err != nil {
				next.Close()
				return fmt.Errorf("couldn't update the metric versions: %w", err)
			}
			if !seen[nid] {
				f2 = append(f2, nid)
			}
		}
		if err := next.Err(); err != nil {
			next.Close()
			return fmt.Errorf("couldn't update the metric versions: %w", err)
		}
		next.Close()
		frontier = f2
	}
	return nil
}

// RawRoundKey is one round of a ready match: the (match_id, number) pair
// the :round bind is keyed by (03-QUERIES.md §5).
type RawRoundKey struct {
	MatchID int64
	Round   int
}

// ReadyMatchIDs lists the ready matches, ascending: the units a :match_id
// raw metric runs over.
func (s *Store) ReadyMatchIDs() ([]int64, error) {
	rows, err := s.db.Query(`SELECT id FROM matches WHERE status = 'ready' ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("couldn't list the ready matches: %w", err)
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("couldn't list the ready matches: %w", err)
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// ReadyHumanSteamIDs lists the distinct human players of ready matches,
// ascending: the units a :steam_id raw metric runs over.
func (s *Store) ReadyHumanSteamIDs() ([]string, error) {
	rows, err := s.db.Query(`SELECT DISTINCT p.steam_id FROM players p
		JOIN matches m ON m.id = p.match_id
		WHERE m.status = 'ready' AND p.is_bot = 0 ORDER BY p.steam_id`)
	if err != nil {
		return nil, fmt.Errorf("couldn't list the players: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("couldn't list the players: %w", err)
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// ReadyRounds lists the rounds of ready matches in (match, number) order:
// the units a :match_id + :round raw metric runs over.
func (s *Store) ReadyRounds() ([]RawRoundKey, error) {
	rows, err := s.db.Query(`SELECT r.match_id, r.number FROM rounds r
		JOIN matches m ON m.id = r.match_id
		WHERE m.status = 'ready' ORDER BY r.match_id, r.number`)
	if err != nil {
		return nil, fmt.Errorf("couldn't list the rounds: %w", err)
	}
	defer rows.Close()
	var out []RawRoundKey
	for rows.Next() {
		var k RawRoundKey
		if err := rows.Scan(&k.MatchID, &k.Round); err != nil {
			return nil, fmt.Errorf("couldn't list the rounds: %w", err)
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// backfillTouched is the first gate pass for raw metrics whose touched set
// is unknown: the baseline schema inserts the builtins with touched ”, so
// Open derives each one's set through the statement gate (AnalyzeMetricSQL,
// the same statement half GateSQL runs at save). A statement the gate
// refuses keeps ” and reads behind. Rows are collected before any write:
// the store's one connection cannot hold a cursor across an UPDATE.
func (s *Store) backfillTouched() error {
	rows, err := s.db.Query(`SELECT id, expr FROM metrics WHERE touched = ''`)
	if err != nil {
		return fmt.Errorf("couldn't derive the touched tables: %w", err)
	}
	type todo struct {
		id   int64
		expr string
	}
	var list []todo
	for rows.Next() {
		var t todo
		if err := rows.Scan(&t.id, &t.expr); err != nil {
			rows.Close()
			return fmt.Errorf("couldn't derive the touched tables: %w", err)
		}
		list = append(list, t)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("couldn't derive the touched tables: %w", err)
	}
	rows.Close()
	for _, t := range list {
		st, gerr := AnalyzeMetricSQL(t.expr, nil)
		if gerr != nil {
			continue
		}
		if err := s.SetMetricTouched(t.id, StoredTouched(st.Touched, len(st.Refs) > 0)); err != nil {
			return err
		}
	}
	return nil
}
