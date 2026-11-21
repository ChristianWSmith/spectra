package store

import (
	"database/sql"
	"fmt"
	"strings"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// Scope-aware freshness (03-QUERIES.md §4-§6, dogfood/PLAN.md B4). A metric's
// touched set decides WHICH data it reads; its binds decide WHICH units of
// that data a change reaches. This file holds the analysis classification the
// rule axis gates on, the rule-value edit's affected tables, and the scoped
// cascade a dependency's change walks through metric_deps.

// analysisTables are the analysis-owned tables: the rows analytics writes from
// the rule values (round classes, engagements, trade opportunities, clutches,
// utility, the trade-kill column of player_stats). player_stats counts as
// analysis even though extract writes its base columns (03 §4, conservative).
var analysisTables = []string{
	"clutches", "engagements", "match_trade_opps", "player_round_stats",
	"player_stats", "round_classifications", "round_side_classes", "utility_events",
}

// analysisTouchedExpr is the SQL test "m.touched holds an analysis table",
// spelled over the metrics alias m. instr over the delimited list is exact
// (no LIKE wildcard in a table name).
var analysisTouchedExpr = func() string {
	parts := make([]string, 0, len(analysisTables))
	for _, t := range analysisTables {
		parts = append(parts, "instr(',' || m.touched || ',', ',"+t+",') > 0")
	}
	return "(" + strings.Join(parts, " OR ") + ")"
}()

// touchesAnalysis is the Go spelling of analysisTouchedExpr for one encoded
// touched set. An unknown set (”) is not analysis here; the caller reads it
// behind by the unknown-set rule before this matters.
func touchesAnalysis(touched string) bool {
	for _, t := range parseTouched(touched) {
		for _, a := range analysisTables {
			if t == a {
				return true
			}
		}
	}
	return false
}

// affectedRuleTables names the analysis tables an analysis-rule edit reaches
// (ruling 26: the rule's analysis table, nothing else). Each rule's stored
// outputs are listed on AnalysisConfig: the trade window reaches the trade
// kills in player_stats and the engagements, the trade-opportunity distance
// reaches match_trade_opps, and the eco thresholds reach the round classes.
func affectedRuleTables(old, cur models.AnalysisConfig) []string {
	var out []string
	if old.TradeWindowS != cur.TradeWindowS {
		out = append(out, "engagements", "player_stats")
	}
	if old.TradeOppDistance != cur.TradeOppDistance {
		out = append(out, "match_trade_opps")
	}
	if old.EcoFullBuy != cur.EcoFullBuy || old.EcoForce != cur.EcoForce {
		out = append(out, "round_classifications", "round_side_classes")
	}
	return out
}

// changeScope is the unit a dependency's data changed for. Whole means every
// unit (a library-wide change); otherwise MatchID and/or SteamID name the
// changed match and player (zero / empty means that key did not change).
type changeScope struct {
	Whole   bool
	MatchID int64
	SteamID string
}

// invalidateDependents walks the metric_deps edges forward from rootID (by
// name, transitively) and marks behind the dependents a change to rootID's
// data reaches. The rules, per dependent D (03-QUERIES §5):
//
//   - D with no binds is downstream of the whole change: its version bumps,
//     so every one of its rows reads behind.
//   - D bound to a match or a player is marked only for the units the change
//     carries: a match-bound D for a match change, a player-bound D for a
//     player change, a dual-bound D for whichever of its keys the change
//     carries. Its rows and run records for those units are stamped behind
//     (metric_version 0 reads behind, the unstamped-row precedent), and every
//     other unit stays fresh.
//   - A D the change does not reach is skipped, and so is everything only
//     reachable through it.
//
// Runs inside the caller's transaction.
func invalidateDependents(tx *sql.Tx, rootID int64, sc changeScope) error {
	var rootName string
	if err := tx.QueryRow(`SELECT name FROM metrics WHERE id = ?`, rootID).Scan(&rootName); err != nil {
		return fmt.Errorf("couldn't update the dependent metrics: %w", err)
	}
	type node struct {
		id   int64
		name string
	}
	seen := map[int64]bool{rootID: true}
	frontier := []node{{rootID, rootName}}
	for len(frontier) > 0 {
		var next []node
		for _, f := range frontier {
			deps, err := dependentsOfName(tx, f.name)
			if err != nil {
				return err
			}
			for _, d := range deps {
				if seen[d.ID] {
					continue
				}
				seen[d.ID] = true
				reached, err := invalidateDependent(tx, d, sc)
				if err != nil {
					return err
				}
				if reached {
					next = append(next, node{d.ID, d.Name})
				}
			}
		}
		frontier = next
	}
	return nil
}

// dependentRow is one metric that references a name in metric_deps.
type dependentRow struct {
	ID   int64
	Name string
	Expr string
}

// dependentsOfName reads the metrics that reference name. It closes the cursor
// before returning, so the caller may write in the same transaction.
func dependentsOfName(tx *sql.Tx, name string) ([]dependentRow, error) {
	rows, err := tx.Query(
		`SELECT DISTINCT m.id, m.name, m.expr FROM metric_deps d
		 JOIN metrics m ON m.id = d.metric_id WHERE d.dep_name = ?`, name)
	if err != nil {
		return nil, fmt.Errorf("couldn't update the dependent metrics: %w", err)
	}
	defer rows.Close()
	var out []dependentRow
	for rows.Next() {
		var d dependentRow
		if err := rows.Scan(&d.ID, &d.Name, &d.Expr); err != nil {
			return nil, fmt.Errorf("couldn't update the dependent metrics: %w", err)
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("couldn't update the dependent metrics: %w", err)
	}
	return out, nil
}

// invalidateDependent applies the scoped rule to one dependent and reports
// whether the change reached it (so its own dependents are walked).
func invalidateDependent(tx *sql.Tx, d dependentRow, sc changeScope) (bool, error) {
	var bindsMatch, bindsSteam bool
	if st, gerr := AnalyzeMetricSQL(d.Expr, nil); gerr == nil {
		for _, b := range st.Binds {
			switch b {
			case ":match_id", ":round":
				bindsMatch = true
			case ":steam_id":
				bindsSteam = true
			}
		}
	}
	if sc.Whole || (!bindsMatch && !bindsSteam) {
		if _, err := tx.Exec(`UPDATE metrics SET version = version + 1 WHERE id = ?`, d.ID); err != nil {
			return false, fmt.Errorf("couldn't update the dependent metrics: %w", err)
		}
		return true, nil
	}
	matchKey := bindsMatch && sc.MatchID > 0
	steamKey := bindsSteam && sc.SteamID != ""
	if !matchKey && !steamKey {
		return false, nil
	}
	valueConds, valueArgs := []string{"metric_id = ?"}, []any{d.ID}
	runConds, runArgs := []string{"metric_id = ?"}, []any{d.ID}
	if matchKey {
		valueConds, valueArgs = append(valueConds, "match_id = ?"), append(valueArgs, sc.MatchID)
		runConds, runArgs = append(runConds, "match_id = ?"), append(runArgs, sc.MatchID)
	}
	if steamKey {
		valueConds = append(valueConds, "(subject_key = ? OR scope_steam_id = ?)")
		valueArgs = append(valueArgs, scrub(sc.SteamID), scrub(sc.SteamID))
		runConds, runArgs = append(runConds, "scope_steam_id = ?"), append(runArgs, scrub(sc.SteamID))
	}
	if _, err := tx.Exec(`UPDATE metric_values SET metric_version = 0 WHERE `+strings.Join(valueConds, " AND "), valueArgs...); err != nil {
		return false, fmt.Errorf("couldn't update the dependent metrics: %w", err)
	}
	if _, err := tx.Exec(`UPDATE metric_runs SET metric_version = 0 WHERE `+strings.Join(runConds, " AND "), runArgs...); err != nil {
		return false, fmt.Errorf("couldn't update the dependent metrics: %w", err)
	}
	return true, nil
}

// bumpRuleAffectedMetrics bumps every metric whose touched set holds one of
// the given analysis tables, with its transitive dependents (the whole-metric
// cascade of bumpMetricAndDependents). It reads the ids before any write, so
// the cursor is closed first.
func bumpRuleAffectedMetrics(tx *sql.Tx, tables []string) error {
	rows, err := tx.Query(`SELECT id, touched FROM metrics`)
	if err != nil {
		return fmt.Errorf("couldn't update the metric versions: %w", err)
	}
	var roots []int64
	for rows.Next() {
		var id int64
		var touched string
		if err := rows.Scan(&id, &touched); err != nil {
			rows.Close()
			return fmt.Errorf("couldn't update the metric versions: %w", err)
		}
		for _, t := range parseTouched(touched) {
			hit := false
			for _, want := range tables {
				if t == want {
					hit = true
					break
				}
			}
			if hit {
				roots = append(roots, id)
				break
			}
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("couldn't update the metric versions: %w", err)
	}
	rows.Close()
	for _, id := range roots {
		if err := bumpMetricAndDependents(tx, id); err != nil {
			return err
		}
	}
	return nil
}

// rowQuerier is the read surface shared by *sql.DB and *sql.Tx.
type rowQuerier interface {
	Query(query string, args ...any) (*sql.Rows, error)
}

// playerIDsOf lists the distinct players of the given matches.
func playerIDsOf(q rowQuerier, matchIDs []int64) ([]string, error) {
	if len(matchIDs) == 0 {
		return nil, nil
	}
	ph := make([]string, len(matchIDs))
	args := make([]any, len(matchIDs))
	for i, id := range matchIDs {
		ph[i] = "?"
		args[i] = id
	}
	rows, err := q.Query(`SELECT DISTINCT steam_id FROM players WHERE match_id IN (`+strings.Join(ph, ",")+`)`, args...)
	if err != nil {
		return nil, fmt.Errorf("couldn't rebuild the career: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("couldn't rebuild the career: %w", err)
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// RebuildCareerForMatches rebuilds the career rollup after a change to the
// given matches' analysis: only their players' career values are invalidated.
func (s *Store) RebuildCareerForMatches(matchIDs []int64) error {
	steamIDs, err := playerIDsOf(s.db, matchIDs)
	if err != nil {
		return err
	}
	return s.RebuildCareerFor(steamIDs)
}
