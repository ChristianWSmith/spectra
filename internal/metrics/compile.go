package metrics

import (
	"strconv"
	"strings"

	"github.com/ChristianWSmith/spectra/internal/store"
)

// PlanMode says which statement shape Compile produced and how Preview
// turns its rows into values.
type PlanMode int

const (
	// ModePlain: one aggregate row [v0..vK, n] over the whole scope.
	ModePlain PlanMode = iota
	// ModeGrouped: [grp, v0..vK, n] per group.
	ModeGrouped
	// ModePercentile: raw value rows [[x] | [x, d]] — percentile (and an
	// optional scalar denominator) computed in Go.
	ModePercentile
)

// Plan is a compiled metric: one executable parameterized statement plus
// (when the metric mixes percentile with other aggregations) a companion
// statement kept for provenance only — SQL never contains a user literal
// or identifier outside the whitelists.
type Plan struct {
	Mode PlanMode
	SQL  string // the single statement Preview executes
	Args []any  // positional binds for SQL (every literal — incl. scope id — is here)
	// Secondary is a companion statement (phase-1 when the value comes
	// from a percentile, or the percentile fetch when it does not). It is
	// NOT executed by Preview; MetricPreview.SQL appends it for the
	// provenance view.
	Secondary   string
	Source      string
	GroupBy     string // normalized ("" = no grouping; "none" → "")
	AggCount    int
	SQLAggs     int // value columns in the phase-1 statement (before trailing n)
	PercentileP float64
	HasDenom    bool
}

// Compile parses + validates (grammar, source, columns, groupBy, scope,
// denominator, percentile rules) and emits parameterized SQL. Any
// validation failure is a *ParseError carrying Message/Pos (the ExprError
// contract).
func Compile(expr, groupBy, denominator, scope string) (Plan, *ParseError) {
	spec, perr := Parse(expr)
	if perr != nil {
		return Plan{}, perr
	}
	if !knownSource(spec.Source) {
		return Plan{}, errf(spec.SourcePos, "unknown source table %q (valid: %s)", spec.Source, knownSourcesMsg())
	}
	cols := sourceColumns[spec.Source]

	gexpr, perr := groupExpr(spec.Source, groupBy)
	if perr != nil {
		return Plan{}, perr
	}
	matchID, perr := ParseScope(scope)
	if perr != nil {
		return Plan{}, perr
	}
	denomTable := ""
	if denominator != "" {
		t, ok := denominatorTables[denominator]
		if !ok {
			return Plan{}, errf(0, "unknown denominator %q (valid: rounds, matches, player_rounds)", denominator)
		}
		denomTable = t
	}
	for i := range spec.Aggs {
		a := &spec.Aggs[i]
		if a.Op == "percentile" && gexpr != "" {
			return Plan{}, errf(a.Pos, "percentile() requires groupBy \"\" (computed in Go over all rows; grouped percentiles are not supported)")
		}
		if perr := validateAggIdents(a, spec.Source, cols); perr != nil {
			return Plan{}, perr
		}
	}

	// Split the list: SQL aggregations (one statement) vs percentile
	// (Go-side raw fetch). The FIRST aggregation is the previewed value.
	var sqlAggs []*Agg
	var firstPctl *Agg
	hasPctl := false
	for i := range spec.Aggs {
		a := &spec.Aggs[i]
		if a.Op == "percentile" {
			hasPctl = true
			if i == 0 {
				firstPctl = a
			}
			continue
		}
		sqlAggs = append(sqlAggs, a)
	}

	gnorm := strings.ToLower(strings.TrimSpace(groupBy))
	if gnorm == "none" {
		gnorm = ""
	}
	// A `player`-grouped metric is a player LISTING (the preview labels
	// each group with a roster name), so it inherits the app's humans-only
	// rule: bot groups are dropped through store.HumanOnlyBySteamID —
	// the SAME condition the roster reads use (store.HumanOnly), match-
	// scoped so the lookup rides the players PK. Grouping by anything
	// else is not a listing and stays untouched; a PLAIN (ungrouped)
	// aggregate over event rows also stays untouched — those record what
	// happened, bots included. Both boundaries are pinned by
	// TestPlayerGroupExcludesBots.
	//
	// Note: phase2 (the percentile fetch) never groups — Compile rejects
	// percentile+groupBy — so no percentile statement needs the condition.
	humanGroup := ""
	if gnorm == "player" {
		if col := groupColumns[spec.Source]["player"]; col != "" && gexpr == col {
			humanGroup = col
		}
	}
	plan := Plan{
		Source:   spec.Source,
		GroupBy:  gnorm,
		AggCount: len(spec.Aggs),
		SQLAggs:  len(sqlAggs),
		HasDenom: denomTable != "",
	}
	grouped := gexpr != ""

	if firstPctl != nil {
		plan.Mode = ModePercentile
		plan.PercentileP = firstPctl.P
		primary := &emitter{source: spec.Source, matchID: matchID, denom: denomTable, humanGroup: humanGroup}
		primary.phase2(firstPctl, denomTable != "")
		plan.SQL, plan.Args = primary.sb.String(), primary.args
		if len(sqlAggs) > 0 {
			sec := &emitter{source: spec.Source, matchID: matchID, denom: denomTable, humanGroup: humanGroup}
			sec.phase1(sqlAggs, gexpr, grouped, false)
			plan.Secondary = sec.sb.String()
		}
		return plan, nil
	}

	plan.Mode = ModePlain
	if grouped {
		plan.Mode = ModeGrouped
	}
	primary := &emitter{source: spec.Source, matchID: matchID, denom: denomTable, humanGroup: humanGroup}
	primary.phase1(sqlAggs, gexpr, grouped, denomTable != "")
	plan.SQL, plan.Args = primary.sb.String(), primary.args
	if hasPctl {
		var pctl *Agg
		for i := range spec.Aggs {
			if spec.Aggs[i].Op == "percentile" {
				pctl = &spec.Aggs[i]
				break
			}
		}
		sec := &emitter{source: spec.Source, matchID: matchID, denom: denomTable, humanGroup: humanGroup}
		sec.phase2(pctl, false)
		plan.Secondary = sec.sb.String()
	}
	return plan, nil
}

// Validate is the parse+whitelist check without execution (builder live
// check). groupBy/scope are validated too (scope default "" — callers with
// a scope compile directly).
func Validate(expr, groupBy string) *ParseError {
	_, perr := Compile(expr, groupBy, "", "")
	return perr
}

// ParseScope resolves the preview scope: "" (whole library) or
// "match:<id>". Failures surface as *ParseError (ExprError shape).
func ParseScope(scope string) (int64, *ParseError) {
	if scope == "" {
		return 0, nil
	}
	const prefix = "match:"
	bad := func() *ParseError {
		return errf(0, "invalid scope %q: expected \"match:<id>\" or \"\" (whole library)", scope)
	}
	if !strings.HasPrefix(scope, prefix) {
		return 0, bad()
	}
	id, err := strconv.ParseInt(strings.TrimPrefix(scope, prefix), 10, 64)
	if err != nil || id <= 0 {
		return 0, bad()
	}
	return id, nil
}

// validateAggIdents walks one aggregation's condition/column identifiers —
// every identifier must be on the source whitelist (parser output carries
// identifier nodes; this is where they are checked).
func validateAggIdents(a *Agg, source string, cols map[string]bool) *ParseError {
	var checkCond func(c *condNode) *ParseError
	checkCond = func(c *condNode) *ParseError {
		if c == nil {
			return nil
		}
		for _, o := range []*operand{c.x, c.y} {
			if o != nil && o.kind == opColumn && !cols[o.col] {
				return errf(o.pos, "unknown column %q for source %s", o.col, source)
			}
		}
		if p := checkCond(c.l); p != nil {
			return p
		}
		return checkCond(c.r)
	}
	if p := checkCond(a.Where); p != nil {
		return p
	}
	if p := checkCond(a.Count); p != nil {
		return p
	}
	if a.Col != "" && !cols[a.Col] {
		return errf(a.ColPos, "unknown column %q for source %s", a.Col, source)
	}
	if a.Num != nil {
		if p := validateAggIdents(a.Num, source, cols); p != nil {
			return p
		}
	}
	if a.Den != nil {
		if p := validateAggIdents(a.Den, source, cols); p != nil {
			return p
		}
	}
	return nil
}

// emitter builds one statement: text into sb, positional binds into args,
// strictly in textual order (mixing both in one pass is what keeps the
// ?-order honest).
type emitter struct {
	sb      strings.Builder
	args    []any
	source  string
	matchID int64  // 0 = whole library
	denom   string // denominator table ("" = none)
	// humanGroup is the source's player column when — and only when — the
	// statement groups by player ("" = no humans-only condition): the
	// condition is emitted by phase1 next to the scope WHERE, as
	// store.HumanOnlyBySteamID over this source's match_id.
	humanGroup string
}

func (e *emitter) bind(v any) string {
	e.args = append(e.args, v)
	return "?"
}

// phase1 emits the aggregate statement: every SQL aggregation as a value
// column (first = previewed value, wrapped by the denominator when set),
// trailing COUNT(*) sample size, scope WHERE (+ the humans-only condition
// for a player group), GROUP/ORDER.
func (e *emitter) phase1(aggs []*Agg, gexpr string, grouped, wrapDenom bool) {
	e.sb.WriteString("SELECT ")
	if grouped {
		e.sb.WriteString(gexpr)
		e.sb.WriteString(" AS grp, ")
	}
	for i, a := range aggs {
		if i > 0 {
			e.sb.WriteString(", ")
		}
		if i == 0 && wrapDenom {
			e.sb.WriteString("1.0*(")
			e.emitValue(a)
			e.sb.WriteString(") / NULLIF((")
			e.emitDenom()
			e.sb.WriteString("), 0)")
			continue
		}
		e.emitValue(a)
	}
	e.sb.WriteString(", COUNT(*) AS n FROM ")
	e.sb.WriteString(e.source)
	wroteWhere := false
	if e.matchID > 0 {
		e.sb.WriteString(" WHERE match_id = ")
		e.sb.WriteString(e.bind(e.matchID))
		wroteWhere = true
	}
	if grouped && e.humanGroup != "" {
		if wroteWhere {
			e.sb.WriteString(" AND ")
		} else {
			e.sb.WriteString(" WHERE ")
		}
		e.sb.WriteString(store.HumanOnlyBySteamID(e.source+"."+e.humanGroup, e.source+".match_id"))
	}
	if grouped {
		e.sb.WriteString(" GROUP BY grp ORDER BY grp")
	}
}

// phase2 emits the raw-value statement for a percentile value: the column
// (plus the scalar denominator when the metric has one), scope WHERE and
// the optional per-agg filter. The row cap comes from RunReadOnly — no SQL
// LIMIT, so truncation is detectable.
func (e *emitter) phase2(a *Agg, withDenom bool) {
	e.sb.WriteString("SELECT ")
	e.sb.WriteString(a.Col)
	e.sb.WriteString(" AS x")
	if withDenom {
		e.sb.WriteString(", ")
		e.emitDenom()
	}
	e.sb.WriteString(" FROM ")
	e.sb.WriteString(e.source)
	wroteWhere := false
	if e.matchID > 0 {
		e.sb.WriteString(" WHERE match_id = ")
		e.sb.WriteString(e.bind(e.matchID))
		wroteWhere = true
	}
	if a.Where != nil {
		if wroteWhere {
			e.sb.WriteString(" AND ")
		} else {
			e.sb.WriteString(" WHERE ")
		}
		e.sb.WriteString("(")
		e.emitCond(a.Where)
		e.sb.WriteString(")")
	}
}

// emitDenom writes the scalar denominator subquery.
func (e *emitter) emitDenom() {
	e.sb.WriteString("(SELECT COUNT(*) FROM ")
	e.sb.WriteString(e.denom)
	if e.matchID > 0 {
		e.sb.WriteString(" WHERE match_id = ")
		e.sb.WriteString(e.bind(e.matchID))
	}
	e.sb.WriteString(")")
}

// emitValue writes one aggregation expression.
func (e *emitter) emitValue(a *Agg) {
	switch a.Op {
	case "count":
		if a.Count == nil {
			e.sb.WriteString("COUNT(*)")
			return
		}
		e.sb.WriteString("SUM(CASE WHEN ")
		e.emitCond(a.Count)
		e.sb.WriteString(" THEN 1 ELSE 0 END)")
	case "sum", "avg", "min", "max":
		fn := strings.ToUpper(a.Op)
		if a.Where == nil {
			e.sb.WriteString(fn)
			e.sb.WriteString("(")
			e.sb.WriteString(a.Col)
			e.sb.WriteString(")")
			return
		}
		e.sb.WriteString(fn)
		e.sb.WriteString("(CASE WHEN ")
		e.emitCond(a.Where)
		e.sb.WriteString(" THEN ")
		e.sb.WriteString(a.Col)
		e.sb.WriteString(" END)")
	case "stddev":
		// sqrt(max(avg(x²) - avg(x)², 0)) — population σ, clamped so
		// float noise cannot produce NaN. The x² product stays INSIDE the
		// first AVG; x repeats textually (a conditional column's binds
		// repeat with it, in order).
		e.sb.WriteString("SQRT(MAX(AVG((")
		e.emitStddevX(a)
		e.sb.WriteString(")*(")
		e.emitStddevX(a)
		e.sb.WriteString(")) - AVG(")
		e.emitStddevX(a)
		e.sb.WriteString(")*AVG(")
		e.emitStddevX(a)
		e.sb.WriteString("), 0))")
	case "ratio":
		e.sb.WriteString("1.0*(")
		e.emitValue(a.Num)
		e.sb.WriteString(") / NULLIF((")
		e.emitValue(a.Den)
		e.sb.WriteString("), 0)")
	default:
		// percentile never reaches SQL (phase2 fetches raw values).
		e.sb.WriteString("NULL")
	}
}

// emitStddevX writes the stddev operand (repeated per textual position —
// a conditional column's binds repeat with it, in order).
func (e *emitter) emitStddevX(a *Agg) {
	if a.Where == nil {
		e.sb.WriteString(a.Col)
		return
	}
	e.sb.WriteString("(CASE WHEN ")
	e.emitCond(a.Where)
	e.sb.WriteString(" THEN ")
	e.sb.WriteString(a.Col)
	e.sb.WriteString(" END)")
}

// emitCond writes a condition (fully parenthesized).
func (e *emitter) emitCond(c *condNode) {
	switch c.kind {
	case cTruth:
		e.sb.WriteString("(")
		e.emitOperand(c.x)
		e.sb.WriteString(")")
	case cCmp:
		e.sb.WriteString("(")
		e.emitOperand(c.x)
		e.sb.WriteString(" ")
		e.sb.WriteString(c.op)
		e.sb.WriteString(" ")
		e.emitOperand(c.y)
		e.sb.WriteString(")")
	case cAnd, cOr:
		e.sb.WriteString("(")
		e.emitCond(c.l)
		if c.kind == cAnd {
			e.sb.WriteString(" AND ")
		} else {
			e.sb.WriteString(" OR ")
		}
		e.emitCond(c.r)
		e.sb.WriteString(")")
	case cNot:
		e.sb.WriteString("(NOT ")
		e.emitCond(c.l)
		e.sb.WriteString(")")
	}
}

// emitOperand writes a whitelisted column verbatim or binds a literal.
func (e *emitter) emitOperand(o *operand) {
	if o.kind == opColumn {
		e.sb.WriteString(o.col)
		return
	}
	switch {
	case o.isStr:
		e.sb.WriteString(e.bind(o.str))
	case o.isBool:
		if o.bval {
			e.sb.WriteString(e.bind(1))
		} else {
			e.sb.WriteString(e.bind(0))
		}
	default:
		e.sb.WriteString(e.bind(o.num))
	}
}
