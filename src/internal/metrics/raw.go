package metrics

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// Raw SQL metrics (dogfood/PLAN.md item 1, 03-QUERIES.md §2-§5). An expr
// whose first keyword is SELECT or WITH, after whitespace and comments, is
// one raw statement; anything else stays on the sugar path until B5 retires
// it. A raw statement is gated by GateSQL (the one gate), run on the
// read-only metric connection with the reserved binds its scope supplies,
// and must return the reserved columns subject_key, dim and value (ruling
// 22). Every other column is stored as opaque JSON. A NULL value is stored
// as NULL (ruling 23).

// rawBindMatch, rawBindSteam, rawBindRound name the reserved binds.
const (
	rawBindMatch = ":match_id"
	rawBindSteam = ":steam_id"
	rawBindRound = ":round"
)

// IsRawSQL reports whether an expr is raw SQL: its first keyword, after any
// whitespace and -- or /* */ comments, is SELECT or WITH.
func IsRawSQL(expr string) bool {
	s := expr
	for {
		s = strings.TrimLeftFunc(s, unicode.IsSpace)
		switch {
		case strings.HasPrefix(s, "--"):
			i := strings.IndexByte(s, '\n')
			if i < 0 {
				return false
			}
			s = s[i+1:]
		case strings.HasPrefix(s, "/*"):
			i := strings.Index(s[2:], "*/")
			if i < 0 {
				return false
			}
			s = s[2+i+2:]
		default:
			end := 0
			for end < len(s) && (s[end] == '_' || unicode.IsLetter(rune(s[end]))) {
				end++
			}
			word := strings.ToLower(s[:end])
			return word == "select" || word == "with"
		}
	}
}

// allRawBinds is what a save gates against: every reserved bind is
// nameable, and the shape rule below decides which combinations may run.
var allRawBinds = map[string]bool{rawBindMatch: true, rawBindSteam: true, rawBindRound: true}

// checkRawShape enforces the scope shapes a raw metric may take: none
// (library-wide), :match_id, :steam_id, or :match_id with :round (round
// grain). Anything else cannot be stored under a scope.
func checkRawShape(binds []string) error {
	used := map[string]bool{}
	for _, b := range binds {
		used[b] = true
	}
	switch {
	case used[rawBindSteam] && (used[rawBindMatch] || used[rawBindRound]):
		return errors.New("a metric that reads :steam_id is career-scoped and can't also bind :match_id or :round")
	case used[rawBindRound] && !used[rawBindMatch]:
		return errors.New(":round needs :match_id (a round is one round of one match)")
	}
	return nil
}

// rawSuppliedFor is what a run with this scope supplies: the binds it
// carries. A bind outside this set is refused by GateSQL, never NULL.
func rawSuppliedFor(scope store.RawScope) map[string]bool {
	supplied := map[string]bool{}
	switch {
	case scope.SteamID != "":
		supplied[rawBindSteam] = true
	case scope.Round > 0:
		supplied[rawBindMatch] = true
		supplied[rawBindRound] = true
	case scope.MatchID > 0:
		supplied[rawBindMatch] = true
	}
	return supplied
}

// rawExists resolves a metric() reference against the stored catalog.
func rawExists(st *store.Store) RefLookup {
	return func(name string) (bool, error) {
		_, err := st.GetMetricByName(name)
		if err == nil {
			return true, nil
		}
		if errors.Is(err, store.ErrNotFound) {
			return false, nil
		}
		return false, err
	}
}

// CheckRawSave gates a raw statement at save and at the Builder's live
// check: the gate's statement rules, the scope shape, and no metric()
// references (their rewrite into joins is not built yet, so a statement
// that uses one is refused rather than stored half-working). It returns
// the gate result (touched tables and binds) on success.
func CheckRawSave(st *store.Store, expr string) (Gate, *ParseError, error) {
	g, perr, err := GateSQL(expr, rawExists(st), allRawBinds)
	if err != nil || perr != nil {
		return Gate{}, perr, err
	}
	if err := checkRawShape(g.Binds); err != nil {
		return Gate{}, errf(0, "%s", err.Error()), nil
	}
	if len(g.Refs) > 0 {
		return Gate{}, errf(g.Refs[0].Pos, "metric() references aren't available in raw SQL yet; read the tables directly"), nil
	}
	return g, nil, nil
}

// RawScopeOf reports the scope a raw statement's binds select, which is the
// metric's stored scope: profile when it reads :steam_id, match otherwise.
func RawScopeOf(binds []string) string {
	for _, b := range binds {
		if b == rawBindSteam {
			return "profile"
		}
	}
	return "match"
}

// RawScopes enumerates the runs a raw statement needs for one sweep, from
// the engine's own fact tables: one library-wide run when no bind is used,
// one per ready match for :match_id, one per human player for :steam_id,
// and one per round for :match_id with :round.
func RawScopes(st *store.Store, binds []string) ([]store.RawScope, error) {
	used := map[string]bool{}
	for _, b := range binds {
		used[b] = true
	}
	switch {
	case used[rawBindSteam]:
		ids, err := st.ReadyHumanSteamIDs()
		if err != nil {
			return nil, err
		}
		out := make([]store.RawScope, 0, len(ids))
		for _, id := range ids {
			out = append(out, store.RawScope{SteamID: id})
		}
		return out, nil
	case used[rawBindRound]:
		keys, err := st.ReadyRounds()
		if err != nil {
			return nil, err
		}
		out := make([]store.RawScope, 0, len(keys))
		for _, k := range keys {
			out = append(out, store.RawScope{MatchID: k.MatchID, Round: k.Round})
		}
		return out, nil
	case used[rawBindMatch]:
		ids, err := st.ReadyMatchIDs()
		if err != nil {
			return nil, err
		}
		out := make([]store.RawScope, 0, len(ids))
		for _, id := range ids {
			out = append(out, store.RawScope{MatchID: id})
		}
		return out, nil
	}
	return []store.RawScope{{}}, nil
}

// RunRaw executes one raw statement for one scope and replaces that scope's
// stored rows. The statement is re-gated with exactly the binds this scope
// supplies, so a bind it cannot supply is refused before anything runs. A
// cancelled ctx or any error writes nothing for this scope.
func RunRaw(ctx context.Context, st *store.Store, metricID int64, version, ruleVersion int, expr string, scope store.RawScope) error {
	supplied := rawSuppliedFor(scope)
	g, perr, err := GateSQL(expr, rawExists(st), supplied)
	if err != nil {
		return err
	}
	if perr != nil {
		return errors.New(perr.Message)
	}
	args := make([]any, 0, len(g.Binds))
	for _, b := range g.Binds {
		switch b {
		case rawBindMatch:
			args = append(args, sql.Named("match_id", scope.MatchID))
		case rawBindSteam:
			args = append(args, sql.Named("steam_id", scope.SteamID))
		case rawBindRound:
			args = append(args, sql.Named("round", int64(scope.Round)))
		}
	}
	res, err := st.QueryMetric(ctx, expr, args)
	if err != nil {
		return err
	}
	rows, err := rawResultRows(res)
	if err != nil {
		return err
	}
	return st.ReplaceRawMetricValues(metricID, version, ruleVersion, scope, rows)
}

// rawResultRows reads the reserved columns of a raw result by name and
// encodes everything else as opaque JSON.
func rawResultRows(res store.ROResult) ([]store.RawMetricRow, error) {
	idx := map[string]int{}
	for i, c := range res.Columns {
		idx[c] = i
	}
	var missing []string
	for _, c := range []string{"subject_key", "dim", "value"} {
		if _, ok := idx[c]; !ok {
			missing = append(missing, c)
		}
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("the statement must return the columns subject_key, dim and value (missing: %s)", strings.Join(missing, ", "))
	}
	seen := make(map[[2]string]bool, len(res.Rows))
	out := make([]store.RawMetricRow, 0, len(res.Rows))
	for n, r := range res.Rows {
		var row store.RawMetricRow
		row.SubjectKey = rawKeyText(r[idx["subject_key"]])
		row.Dim = rawKeyText(r[idx["dim"]])
		switch v := r[idx["value"]].(type) {
		case nil:
			// NULL stays NULL (ruling 23).
		case int64:
			x := float64(v)
			row.Value = &x
		case float64:
			row.Value = &v
		default:
			return nil, fmt.Errorf("row %d: value must be a number or NULL, not %T", n+1, v)
		}
		key := [2]string{row.SubjectKey, row.Dim}
		if seen[key] {
			return nil, fmt.Errorf("row %d repeats subject_key %q and dim %q; each subject and dim may appear once per run", n+1, row.SubjectKey, row.Dim)
		}
		seen[key] = true
		extra := map[string]any{}
		for c, i := range idx {
			if c == "subject_key" || c == "dim" || c == "value" {
				continue
			}
			extra[c] = r[i]
		}
		if len(extra) > 0 {
			b, err := json.Marshal(extra)
			if err != nil {
				return nil, fmt.Errorf("row %d: couldn't encode its extra columns: %w", n+1, err)
			}
			row.RowJSON = string(b)
		}
		out = append(out, row)
	}
	return out, nil
}

// rawKeyText is a key column's text: NULL is the empty key (” is the
// unpartitioned / match-subject key), other values are their text.
func rawKeyText(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	}
	return fmt.Sprint(v)
}

// runRawMetric is the sweep's unit for one raw metric: every scope it needs,
// in order. The caller clears the metric's rows first (phase 1), so a failure
// partway leaves none of its rows behind.
func runRawMetric(ctx context.Context, st *store.Store, m models.MetricRow, ruleVersion int) error {
	g, perr, err := GateSQL(m.Expr, rawExists(st), allRawBinds)
	if err != nil {
		return err
	}
	if perr != nil {
		return errors.New(perr.Message)
	}
	scopes, err := RawScopes(st, g.Binds)
	if err != nil {
		return err
	}
	for _, sc := range scopes {
		if err := RunRaw(ctx, st, m.ID, m.Version, ruleVersion, m.Expr, sc); err != nil {
			return err
		}
	}
	return nil
}
