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

// Compile parses + validates (grammar, sources, join keys, columns,
// groupBy, scope, denominator, percentile, population rules) and emits
// parameterized SQL. Any validation failure is a *ParseError carrying
// Message/Pos (the ExprError contract).
func Compile(expr, groupBy, denominator, scope string) (Plan, *ParseError) {
	spec, perr := Parse(expr)
	if perr != nil {
		return Plan{}, perr
	}
	srcs := spec.Sources
	for _, s := range srcs {
		if !knownSource(s.Name) {
			return Plan{}, errf(s.Pos, "unknown source table %q (valid: %s)", s.Name, knownSourcesMsg())
		}
	}
	primary := srcs[0].Name

	// Engine-derived joins (design (c)): every secondary pairs with the
	// PRIMARY (star join) on a key joinKey derives from the declared
	// dimensions/uniqueness keys — user text never reaches an ON clause,
	// and a secondary that is not unique on its key is rejected (the
	// fan-out guard). The join type is engine-chosen LEFT so a sparse
	// secondary's missing rows surface as NULL ⇒ Value 0 beside N, never
	// deleted primary rows. The FROM clause contributes no binds, and the
	// scope below binds on the PRIMARY only (a scope predicate landing on
	// a LEFT-joined secondary would silently convert the join to INNER).
	from := primary
	oneToOne := map[string]bool{}
	for _, s := range srcs[1:] {
		key, ok := joinKey(primary, s.Name)
		if !ok {
			return Plan{}, errf(s.Pos,
				"cannot join source %q to %q: secondary %q is not unique on the shared dimensions (its primary key/unique key must consist entirely of join dimensions: match, round, player, side)",
				s.Name, primary, s.Name)
		}
		from += " LEFT JOIN " + s.Name + " ON "
		for i, d := range key {
			if i > 0 {
				from += " AND "
			}
			from += primary + "." + d.PrimaryCol + " = " + s.Name + "." + d.SecondaryCol
		}
		oneToOne[s.Name] = joinIsOneToOne(primary, key)
	}
	res := resolveColumns(srcs, oneToOne)

	gexpr, perr := groupExpr(primary, groupBy)
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
			return Plan{}, errf(0, "unknown denominator %q (valid: rounds, matches)", denominator)
		}
		denomTable = t
	}
	for i := range spec.Aggs {
		a := &spec.Aggs[i]
		if a.Op == "percentile" && gexpr != "" {
			return Plan{}, errf(a.Pos, "percentile() requires groupBy \"\" (computed in Go over all rows; grouped percentiles are not supported)")
		}
		if perr := validateAggIdents(a, res); perr != nil {
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
	// The humans-only condition (store.HumanOnlyBySteamID over the
	// primary's player column) fires in two cases:
	//
	//   - Population alignment (owner ruling): a MULTI-source expression
	//     whose source set MIXES populations (all-players vs
	//     humans-only) applies it to the primary's player column
	//     REGARDLESS of grouping — bot rows survive the LEFT join with
	//     NULL secondary values, so this condition is what drops them
	//     (grouped) / keeps the numerator human-only (ungrouped), aligning
	//     populations on both sides. Accepted mixed pairs always carry the
	//     primary's player dimension (the humans-only member's key is
	//     (match, player), so joinKey forces it) — the anchor is never
	//     empty. Pinned by TestJoinedPopulationAlignment.
	//   - A `player`-grouped metric is a player LISTING (the preview
	//     labels each group with a roster name), so it inherits the app's
	//     humans-only rule: bot groups are dropped through the SAME
	//     condition the roster reads use (store.HumanOnly), match-scoped
	//     so the lookup rides the players PK. Grouping by anything else is
	//     not a listing and stays untouched; a PLAIN (ungrouped)
	//     single-source aggregate over event rows also stays untouched —
	//     those record what happened, bots included. Both boundaries are
	//     pinned by TestPlayerGroupExcludesBots.
	//
	// Note: phase2 (the percentile fetch) never groups — Compile rejects
	// percentile+groupBy — so only the mixed-population case can put the
	// condition there; phase1 and phase2 emit it identically (uniform
	// qualification path, no second spelling).
	humanGroup := ""
	if mixedPopulations(srcs) {
		humanGroup = groupColumns[primary]["player"]
	} else if gnorm == "player" {
		if col := groupColumns[primary]["player"]; col != "" && gexpr == col {
			humanGroup = col
		}
	}
	plan := Plan{
		Source:   primary,
		GroupBy:  gnorm,
		AggCount: len(spec.Aggs),
		SQLAggs:  len(sqlAggs),
		HasDenom: denomTable != "",
	}
	grouped := gexpr != ""
	newEmitter := func() *emitter {
		return &emitter{res: res, from: from, matchID: matchID, denom: denomTable, humanGroup: humanGroup}
	}

	if firstPctl != nil {
		plan.Mode = ModePercentile
		plan.PercentileP = firstPctl.P
		raw := newEmitter()
		raw.phase2(firstPctl, denomTable != "")
		plan.SQL, plan.Args = raw.sb.String(), raw.args
		if len(sqlAggs) > 0 {
			comp := newEmitter()
			comp.phase1(sqlAggs, gexpr, grouped, false)
			plan.Secondary = comp.sb.String()
		}
		return plan, nil
	}

	plan.Mode = ModePlain
	if grouped {
		plan.Mode = ModeGrouped
	}
	agg := newEmitter()
	agg.phase1(sqlAggs, gexpr, grouped, denomTable != "")
	plan.SQL, plan.Args = agg.sb.String(), agg.args
	if hasPctl {
		var pctl *Agg
		for i := range spec.Aggs {
			if spec.Aggs[i].Op == "percentile" {
				pctl = &spec.Aggs[i]
				break
			}
		}
		raw := newEmitter()
		raw.phase2(pctl, false)
		plan.Secondary = raw.sb.String()
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

// colResolution maps unqualified column references onto the expression's
// source set: an identifier resolves iff exactly ONE source owns it
// (columns owned by 0 or ≥2 sources are ABSENT — referencing them is a
// positioned ExprError; the grammar has no qualified-identifier syntax),
// and emission qualifies with that owner when the statement joins.
// Single-source expressions never qualify (byte-stable emission).
type colResolution struct {
	primary  string
	joined   bool
	names    []string          // source names (error text)
	owners   map[string]string // column → owning source (exactly-one-owner only)
	multi    map[string]bool   // columns owned by ≥2 sources (ambiguous)
	oneToOne map[string]bool   // secondary → join with the primary is 1:1
}

// resolveColumns builds the resolution for a source list (oneToOne comes
// from the derived join keys — see joinKey/joinIsOneToOne).
func resolveColumns(srcs []SourceRef, oneToOne map[string]bool) *colResolution {
	r := &colResolution{
		primary:  srcs[0].Name,
		joined:   len(srcs) > 1,
		oneToOne: oneToOne,
	}
	count := map[string]int{}
	first := map[string]string{}
	for _, s := range srcs {
		r.names = append(r.names, s.Name)
		for c := range sourceColumns[s.Name] {
			if _, ok := first[c]; !ok {
				first[c] = s.Name
			}
			count[c]++
		}
	}
	r.owners = make(map[string]string, len(first))
	for c, n := range count {
		if n == 1 {
			r.owners[c] = first[c]
		} else {
			if r.multi == nil {
				r.multi = map[string]bool{}
			}
			r.multi[c] = true
		}
	}
	return r
}

// resolveCond checks a condition/filter column. Filters never multiply
// rows, so any owned source's column may be used (a NULL secondary in a
// filter simply does not satisfy the condition).
func (r *colResolution) resolveCond(col string, pos int) *ParseError {
	if _, ok := r.owners[col]; ok {
		return nil
	}
	return r.unresolved(col, pos)
}

// resolveValue checks a VALUE column (sum/avg/min/max/stddev/percentile
// argument): besides ownership it enforces the value-column rule — a
// secondary's value column requires a 1:1 join, so a coarse secondary
// value can never repeat at a finer grain (owner ruling; mechanically
// decidable, positioned error).
func (r *colResolution) resolveValue(col string, pos int) *ParseError {
	owner, ok := r.owners[col]
	if !ok {
		return r.unresolved(col, pos)
	}
	if owner != r.primary && !r.oneToOne[owner] {
		return errf(pos,
			"value column %q comes from secondary source %q, but the join is not 1:1 — value columns must come from the primary (or from a 1:1 join)",
			col, owner)
	}
	return nil
}

// unresolved renders the not-owned error (single-source keeps the legacy
// wording byte-for-byte).
func (r *colResolution) unresolved(col string, pos int) *ParseError {
	if !r.joined {
		return errf(pos, "unknown column %q for source %s", col, r.primary)
	}
	if r.multi[col] {
		return errf(pos, "ambiguous column %q (owned by multiple sources — the grammar has no qualified-identifier syntax)", col)
	}
	return errf(pos, "unknown column %q (sources: %s)", col, strings.Join(r.names, ", "))
}

// qualify prefixes a column with its owning source when the statement
// joins (the aliases are the table names — engine-chosen, no user text).
func (r *colResolution) qualify(col string) string {
	if !r.joined {
		return col
	}
	if owner, ok := r.owners[col]; ok {
		return owner + "." + col
	}
	return col // unreachable: every emitted column resolved at validation
}

// validateAggIdents walks one aggregation's condition/column identifiers —
// every identifier must resolve against the expression's source set
// (parser output carries identifier nodes; this is where they are
// checked and where the value-column rule fires).
func validateAggIdents(a *Agg, res *colResolution) *ParseError {
	var checkCond func(c *condNode) *ParseError
	checkCond = func(c *condNode) *ParseError {
		if c == nil {
			return nil
		}
		for _, o := range []*operand{c.x, c.y} {
			if o != nil && o.kind == opColumn {
				if perr := res.resolveCond(o.col, o.pos); perr != nil {
					return perr
				}
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
	if a.Col != "" {
		if perr := res.resolveValue(a.Col, a.ColPos); perr != nil {
			return perr
		}
	}
	if a.Num != nil {
		if p := validateAggIdents(a.Num, res); p != nil {
			return p
		}
	}
	if a.Den != nil {
		if p := validateAggIdents(a.Den, res); p != nil {
			return p
		}
	}
	return nil
}

// emitter builds one statement: text into sb, positional binds into args,
// strictly in textual order (mixing both in one pass is what keeps the
// ?-order honest). Joins contribute NO binds (the ON is column = column,
// engine-derived); literals still bind through bind/emitOperand.
type emitter struct {
	sb   strings.Builder
	args []any
	// res resolves/qualifies every column reference: joined statements
	// prefix each column with its owning source (the aliases are the
	// table names), single-source statements stay unqualified.
	res *colResolution
	// from is the FROM clause — the primary, plus the engine LEFT JOINs
	// when the expression lists secondaries.
	from    string
	matchID int64  // 0 = whole library (bound on the PRIMARY only)
	denom   string // denominator table ("" = none)
	// humanGroup is the primary's player column when — and only when —
	// the statement must apply the humans-only condition (a player group,
	// or ANY grouping under a mixed-population source list): emitted
	// next to the scope WHERE as store.HumanOnlyBySteamID over the
	// primary's match_id.
	humanGroup string
}

func (e *emitter) bind(v any) string {
	e.args = append(e.args, v)
	return "?"
}

// matchIDExpr is the scope column: side-qualified when the statement
// joins (an unqualified match_id would be ambiguous across the sources),
// bare for the single-source base form (byte-stable emission).
func (e *emitter) matchIDExpr() string {
	if e.res.joined {
		return e.res.primary + ".match_id"
	}
	return "match_id"
}

// qualifyGroup anchors the group expression on the primary when joined.
// The `map` subquery is emitted unqualified but self-anchored
// (mapGroupExpr names its source, which equals the engine alias), so it
// passes through untouched.
func (e *emitter) qualifyGroup(gexpr string) string {
	if !e.res.joined || strings.Contains(gexpr, "(") {
		return gexpr
	}
	return e.res.primary + "." + gexpr
}

// writeHumanOnly writes the humans-only condition with the right WHERE
// connector (phase1 and phase2 share this — one spelling, both sides).
func (e *emitter) writeHumanOnly(wroteWhere bool) {
	if wroteWhere {
		e.sb.WriteString(" AND ")
	} else {
		e.sb.WriteString(" WHERE ")
	}
	e.sb.WriteString(store.HumanOnlyBySteamID(e.res.primary+"."+e.humanGroup, e.res.primary+".match_id"))
}

// phase1 emits the aggregate statement: every SQL aggregation as a value
// column (first = previewed value, wrapped by the denominator when set),
// trailing COUNT(*) sample size, FROM (+ engine LEFT JOINs), scope WHERE
// on the primary (+ the humans-only condition), GROUP/ORDER.
func (e *emitter) phase1(aggs []*Agg, gexpr string, grouped, wrapDenom bool) {
	e.sb.WriteString("SELECT ")
	if grouped {
		e.sb.WriteString(e.qualifyGroup(gexpr))
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
	e.sb.WriteString(e.from)
	wroteWhere := false
	if e.matchID > 0 {
		e.sb.WriteString(" WHERE ")
		e.sb.WriteString(e.matchIDExpr())
		e.sb.WriteString(" = ")
		e.sb.WriteString(e.bind(e.matchID))
		wroteWhere = true
	}
	// Ungrouped mixed-population expressions apply the condition too
	// (owner ruling: regardless of grouping) — the `grouped &&` guard is
	// gone; single-source humanGroup is only ever set for a player group
	// (grouped), so the base form's emission is unchanged.
	if e.humanGroup != "" {
		e.writeHumanOnly(wroteWhere)
	}
	if grouped {
		e.sb.WriteString(" GROUP BY grp ORDER BY grp")
	}
}

// phase2 emits the raw-value statement for a percentile value: the
// column (plus the scalar denominator when the metric has one), the SAME
// FROM/join as the aggregate statement (uniform qualification path — the
// phase-2 fetch carries the join/qualification day one), scope WHERE on
// the primary (+ humans-only when the source list mixes populations) and
// the optional per-agg filter. The row cap comes from RunReadOnly — no
// SQL LIMIT, so truncation is detectable.
func (e *emitter) phase2(a *Agg, withDenom bool) {
	e.sb.WriteString("SELECT ")
	e.sb.WriteString(e.res.qualify(a.Col))
	e.sb.WriteString(" AS x")
	if withDenom {
		e.sb.WriteString(", ")
		e.emitDenom()
	}
	e.sb.WriteString(" FROM ")
	e.sb.WriteString(e.from)
	wroteWhere := false
	if e.matchID > 0 {
		e.sb.WriteString(" WHERE ")
		e.sb.WriteString(e.matchIDExpr())
		e.sb.WriteString(" = ")
		e.sb.WriteString(e.bind(e.matchID))
		wroteWhere = true
	}
	if e.humanGroup != "" {
		e.writeHumanOnly(wroteWhere)
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
			e.sb.WriteString(e.res.qualify(a.Col))
			e.sb.WriteString(")")
			return
		}
		e.sb.WriteString(fn)
		e.sb.WriteString("(CASE WHEN ")
		e.emitCond(a.Where)
		e.sb.WriteString(" THEN ")
		e.sb.WriteString(e.res.qualify(a.Col))
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
		e.sb.WriteString(e.res.qualify(a.Col))
		return
	}
	e.sb.WriteString("(CASE WHEN ")
	e.emitCond(a.Where)
	e.sb.WriteString(" THEN ")
	e.sb.WriteString(e.res.qualify(a.Col))
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

// emitOperand writes a whitelisted column verbatim (side-qualified when
// the statement joins) or binds a literal.
func (e *emitter) emitOperand(o *operand) {
	if o.kind == opColumn {
		e.sb.WriteString(e.res.qualify(o.col))
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
