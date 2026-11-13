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
	// ModeGrouped: [subject, v0..vK, n] per subject — every statement is
	// subject-addressed, so the output is always one row per player the
	// statement produced (the groupBy parameter retired with W2; the
	// subject grouping IS the addressing).
	ModeGrouped PlanMode = iota
	// ModePercentile: raw value rows [[subject, x] | [subject, x, d]] —
	// percentile (and an optional denominator) computed in Go over each
	// subject partition.
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
	AggCount    int
	SQLAggs     int // value columns in the phase-1 statement (before trailing n)
	PercentileP float64
	HasDenom    bool
}

// Compile parses + validates (grammar, sources, the player anchor, join
// keys, columns, scope, denominator, percentile, population rules) and
// emits parameterized SQL. Every statement is subject-addressed: the
// PRIMARY must carry a subject column, rows without one are dropped,
// humans-only applies to the subject unconditionally, and the output is
// grouped by it. Any validation failure is a *ParseError carrying
// Message/Pos (the ExprError contract).
func Compile(expr, denominator, scope string) (Plan, *ParseError) {
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
	// Player-relativity (owner criterion: the expression's output must be
	// player-addressed; mechanically, the PRIMARY source's player mapping
	// must be a SUBJECT column). PRIMARY-OWNS — the subject comes from the
	// primary only, the same ownership as scope binding and the population
	// anchor. Checked right after knownSource so SaveMetric, ad-hoc
	// PreviewMetric and ValidateExpr all funnel through here and a
	// player-less draft errors exactly like any invalid expression.
	// Round/match-grain sources stay legal as JOIN PARTNERS of an anchored
	// primary wherever joinKey allows (engagements, rounds) — the rule
	// partitions by what the OUTPUT is, not by a source whitelist.
	subject := sourceSubject[primary]
	if subject == "" {
		return Plan{}, errf(spec.SourcePos,
			"expression is not player-anchored: primary source %q has no player subject — a metric's value must be per player (player sources: %s; round-grain sources can only join a player-anchored expression)",
			primary, playerSources)
	}

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
		if perr := validateAggIdents(&spec.Aggs[i], res); perr != nil {
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

	// Subject addressing (W2): every statement groups its output by the
	// primary's subject column and restricts its rows with `subject <> ''`
	// beside store.HumanOnly over the subject — UNCONDITIONAL, so the
	// former mixed-population special case and the player-group case both
	// collapsed into this one condition (the event-shaped "bots stay"
	// boundary retired with them: an aggregate records human-subject rows
	// only). Pinned by TestSubjectAddressingEmitted,
	// TestJoinedPopulationAlignment and TestSubjectStatementExcludesBots.
	plan := Plan{
		Source:   primary,
		AggCount: len(spec.Aggs),
		SQLAggs:  len(sqlAggs),
		HasDenom: denomTable != "",
	}
	newEmitter := func() *emitter {
		return &emitter{res: res, from: from, matchID: matchID, denom: denomTable, subject: subject}
	}

	if firstPctl != nil {
		plan.Mode = ModePercentile
		plan.PercentileP = firstPctl.P
		raw := newEmitter()
		raw.phase2(firstPctl, denomTable != "")
		plan.SQL, plan.Args = raw.sb.String(), raw.args
		if len(sqlAggs) > 0 {
			comp := newEmitter()
			comp.phase1(sqlAggs, denomTable != "")
			plan.Secondary = comp.sb.String()
		}
		return plan, nil
	}

	plan.Mode = ModeGrouped
	agg := newEmitter()
	agg.phase1(sqlAggs, denomTable != "")
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
// check). The denominator/scope defaults are the save-time validation
// shape ("" = whole library); callers with a scope compile directly.
func Validate(expr string) *ParseError {
	_, perr := Compile(expr, "", "")
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
	// subject is the primary's subject column (sourceSubject — Compile
	// rejects a primary without one). It addresses every statement: the
	// output groups by it and the WHERE carries `subject <> ''` beside
	// the humans-only condition over it (writeSubject), phase1 and
	// phase2 alike.
	subject string
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

// subjectExpr renders the subject column for the SELECT/GROUP BY: the
// PRIMARY's own column, qualified when the statement joins. Column
// resolution cannot qualify it (the subject may be owned by BOTH
// sources — steam_id on player_stats and match_trade_opps — so it is
// ambiguous through the owners map); the primary owns the anchor, so it
// qualifies it directly. The single-source base form stays unqualified
// (byte-stable emission).
func (e *emitter) subjectExpr() string {
	if e.res.joined {
		return e.res.primary + "." + e.subject
	}
	return e.subject
}

// writeSubject writes the subject-addressing condition with the right
// WHERE connector (phase1 and phase2 share this — one spelling, both
// sides): `subject <> ”` (a no-actor bucket — an event with no
// attacker — never becomes a value) beside THE humans-only condition
// (store.HumanOnlyBySteamID over the subject, match-scoped so the
// lookup rides the players PK). UNCONDITIONAL: every statement is
// subject-addressed, so the former mixed-population and player-group
// special cases collapsed into this one condition.
func (e *emitter) writeSubject(wroteWhere bool) {
	if wroteWhere {
		e.sb.WriteString(" AND ")
	} else {
		e.sb.WriteString(" WHERE ")
	}
	e.sb.WriteString(e.subjectExpr())
	e.sb.WriteString(" <> '' AND ")
	e.sb.WriteString(store.HumanOnlyBySteamID(e.res.primary+"."+e.subject, e.res.primary+".match_id"))
}

// phase1 emits the aggregate statement: the subject as the group column,
// every SQL aggregation as a value column (first = previewed value,
// wrapped by the denominator when set), trailing COUNT(*) sample size,
// FROM (+ engine LEFT JOINs), scope WHERE on the primary (+ the subject
// addressing condition), GROUP BY subject ORDER BY subject.
func (e *emitter) phase1(aggs []*Agg, wrapDenom bool) {
	e.sb.WriteString("SELECT ")
	e.sb.WriteString(e.subjectExpr())
	e.sb.WriteString(" AS grp, ")
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
	e.writeSubject(wroteWhere)
	e.sb.WriteString(" GROUP BY grp ORDER BY grp")
}

// phase2 emits the raw-value statement for a percentile value: the
// SUBJECT beside the value (the address Go partitions the fetch by) plus
// the scalar denominator when the metric has one, the SAME FROM/join as
// the aggregate statement (uniform qualification path — the phase-2
// fetch carries the join/qualification day one), scope WHERE on the
// primary (+ the subject addressing condition) and the optional per-agg
// filter. The row cap comes from RunReadOnly — no SQL LIMIT, so
// truncation is detectable.
func (e *emitter) phase2(a *Agg, withDenom bool) {
	e.sb.WriteString("SELECT ")
	e.sb.WriteString(e.subjectExpr())
	e.sb.WriteString(" AS grp, ")
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
	e.writeSubject(wroteWhere)
	wroteWhere = true
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

// emitDenom writes the denominator subquery — ONE rule, two units: the
// denominator counts the SCOPE's units for the subject.
//
//   - match scope (`match:<id>`): the match's units — the scalar
//     `SELECT COUNT(*) FROM <rounds|matches> WHERE match_id = ?`, every
//     player in the match sharing it (the emission is unchanged from the
//     pre-subject engine).
//   - library/profile scope (""): the subject's CAREER units, correlated
//     on the subject — rounds → the subject's player_round_stats rows
//     (one per player-round), matches → the subject's player_stats rows
//     (one per player-match ⇒ matches played). The career table is
//     ALIASED so the outer subject reference can never resolve to it
//     when the primary and the career table are the same table, and the
//     outer reference is always primary-qualified (inside a subquery an
//     unqualified name would resolve to the inner table).
func (e *emitter) emitDenom() {
	e.sb.WriteString("(SELECT COUNT(*) FROM ")
	if e.matchID > 0 {
		e.sb.WriteString(e.denom)
		e.sb.WriteString(" WHERE match_id = ")
		e.sb.WriteString(e.bind(e.matchID))
	} else {
		e.sb.WriteString(denominatorCareerTables[e.denom])
		e.sb.WriteString(" AS d WHERE d.steam_id = ")
		e.sb.WriteString(e.res.primary)
		e.sb.WriteString(".")
		e.sb.WriteString(e.subject)
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
