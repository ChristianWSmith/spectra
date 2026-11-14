package store

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"
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
}

// metricValueFreshCond is THE row-level freshness test (the behind
// predicate's row clause, negated): a row is fresh iff it was computed
// under the metric's CURRENT version and the CURRENT analysis rule
// version. Stamps are INTERNAL-ONLY (never rendered); both columns
// default 0, so any unstamped row fails and reads as behind — the
// analyzed_rule_version 0/never-behind precedent. Kept as one const so
// the sweep's selection, the canonical read and any coverage query can
// never spell the comparison differently (design §4: one spelling).
const metricValueFreshCond = `v.metric_version >= m.version AND v.rule_version >= ?`

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
func (s *Store) MetricCoverage(liveRuleVersion int) ([]MetricCoverage, error) {
	rows, err := s.db.Query(
		`SELECT m.id,
			CASE WHEN (
				EXISTS (SELECT 1 FROM metric_values v
					WHERE v.metric_id = m.id
					  AND (v.metric_version < m.version OR v.rule_version < ?))
				OR (m.scope = 'match' AND EXISTS (
					SELECT 1 FROM matches mt WHERE mt.status = 'ready'
					  AND NOT EXISTS (SELECT 1 FROM metric_values v
						WHERE v.metric_id = m.id AND v.match_id = mt.id
						  AND `+metricValueFreshCond+`)))
				OR (m.scope = 'profile' AND EXISTS (SELECT 1 FROM player_stats)
					AND NOT EXISTS (SELECT 1 FROM metric_values v
						WHERE v.metric_id = m.id AND v.match_id = 0
						  AND `+metricValueFreshCond+`))
			) THEN 1 ELSE 0 END AS behind,
			(SELECT COUNT(*) FROM metric_values v
				WHERE v.metric_id = m.id AND `+metricValueFreshCond+`) AS fresh
		FROM metrics m
		ORDER BY `+metricOrder,
		liveRuleVersion, liveRuleVersion, liveRuleVersion, liveRuleVersion,
	)
	if err != nil {
		return nil, fmt.Errorf("store: metric coverage: %w", err)
	}
	defer rows.Close()
	var out []MetricCoverage
	for rows.Next() {
		var c MetricCoverage
		var behind int
		if err := rows.Scan(&c.MetricID, &behind, &c.FreshRows); err != nil {
			return nil, fmt.Errorf("store: metric coverage: %w", err)
		}
		c.Behind = behind != 0
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: metric coverage: %w", err)
	}
	return out, nil
}

// MetricValueRow is ONE fresh stored value the compute pass inserts
// (phase 2). MatchID 0 is the profile (career) grain; SteamID is the
// subject player (humans only — the statement already applied
// store.HumanOnly + subject <> ”, so the pass never filters here).
type MetricValueRow struct {
	MatchID int64
	SteamID string
	Value   float64
	N       int
}

// ClearMetricValues is the compute pass's PHASE 1 (design §4): it
// removes ALL of one metric's stored rows in one small transaction and
// commits. The delete is WHOLESALE per metric (not just the rows failing
// the predicate): the table is derived data, phase 2 recomputes the
// metric's whole set in one batched statement, and keeping live rows
// would collide with the fresh insert on the primary key
// (metric_id, match_id, steam_id). Only behind metrics reach this call
// (the sweep's work list), so "all of this metric's rows" and "the rows
// failing the predicate" are the same set in practice — and for a
// closure-added metric whose rows still looked live, removing them is
// the intent: never serve a value built on changed inputs.
//
// The commit IS the crash boundary (design §4's crash matrix): after
// this commits, the metric has no rows → absent → behind → retried; a
// rollback here (or a crash before it) leaves the outdated rows present
// but INVISIBLE — MetricCoverage's fresh count excludes them, so no
// reader can see them.
func (s *Store) ClearMetricValues(metricID int64) error {
	if _, err := s.db.Exec(`DELETE FROM metric_values WHERE metric_id = ?`, metricID); err != nil {
		return fmt.Errorf("store: clear metric values: %w", err)
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
func (s *Store) InsertMetricValues(metricID int64, metricVersion, ruleVersion int, rows []MetricValueRow) error {
	if len(rows) == 0 {
		return nil // nothing to commit — the metric simply has no rows (absent → behind)
	}
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("store: insert metric values: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	stmt, err := tx.Prepare(
		`INSERT INTO metric_values (metric_id, match_id, steam_id, value, n, metric_version, rule_version, computed_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return fmt.Errorf("store: insert metric values: %w", err)
	}
	defer stmt.Close()
	now := time.Now()
	for _, r := range rows {
		if _, err := stmt.Exec(metricID, r.MatchID, scrub(r.SteamID), r.Value, r.N, metricVersion, ruleVersion, now); err != nil {
			return fmt.Errorf("store: insert metric values: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: insert metric values: %w", err)
	}
	return nil
}

// QueryWrite executes a SELECT on the WRITE handle — the compute
// pass's plan runner (design §4: plan SQL runs on the write handle the
// pass owns under the compute lock, which avoids the read-only
// session's single-connection contention with the SQL console and its
// row caps; interactive previews keep RunReadOnly). Validation is the
// SAME ValidateReadOnlySQL gate as RunReadOnly (defense in depth: a plan
// is a SELECT — even a mis-emitted statement can never write), the row
// cap is the caller's (a truncated plan result is a FAILED compute, never
// silently partial values), and ctx cancels the statement mid-flight
// (modernc's progress-handler interrupt) plus every row iteration.
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
		return ROResult{MS: elapsed()}, fmt.Errorf("store: query (write handle): %w", err)
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return ROResult{MS: elapsed()}, fmt.Errorf("store: query (write handle): %w", err)
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
			return ROResult{MS: elapsed()}, fmt.Errorf("store: query (write handle): %w", err)
		}
		for i, v := range vals {
			vals[i] = normValue(v)
		}
		out.Rows = append(out.Rows, vals)
	}
	if err := rows.Err(); err != nil {
		return ROResult{MS: elapsed()}, fmt.Errorf("store: query (write handle): %w", err)
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
			return fmt.Errorf("store: bump metric versions: %w", err)
		}
		for rows.Next() {
			var n node
			if err := rows.Scan(&n.id, &n.name); err != nil {
				rows.Close()
				return fmt.Errorf("store: bump metric versions: %w", err)
			}
			nodes = append(nodes, n)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return fmt.Errorf("store: bump metric versions: %w", err)
		}
		rows.Close()
		if len(nodes) == 0 {
			break
		}
		var names []any
		var namePh []string
		for _, n := range nodes {
			if _, err := tx.Exec(`UPDATE metrics SET version = version + 1 WHERE id = ?`, n.id); err != nil {
				return fmt.Errorf("store: bump metric versions: %w", err)
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
			return fmt.Errorf("store: bump metric versions: %w", err)
		}
		var f2 []int64
		for next.Next() {
			var nid int64
			if err := next.Scan(&nid); err != nil {
				next.Close()
				return fmt.Errorf("store: bump metric versions: %w", err)
			}
			if !seen[nid] {
				f2 = append(f2, nid)
			}
		}
		if err := next.Err(); err != nil {
			next.Close()
			return fmt.Errorf("store: bump metric versions: %w", err)
		}
		next.Close()
		frontier = f2
	}
	return nil
}
