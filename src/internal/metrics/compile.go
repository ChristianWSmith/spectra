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

// Address is a compiled statement's DECLARED addressing (metrics
// expansion §3): which subject keys its rows, how a partitioned
// statement splits them, and whether the statement serves a
// profile-scope (career) definition — the compile-time half of the
// subject × scope matrix (plan §3.1 / §6.3). The zero value is the
// pre-expansion shape: an unpartitioned player statement at match
// extent, which is what every legacy call site keeps.
type Address struct {
	// Subject is "player" | "match" | "team" ("" reads as "player"): the
	// key every emitted row is grouped and stored by (§3.4 anchor rule).
	Subject string
	// Partition is "" | "side" | "map" | "weapon" ("" = unpartitioned):
	// the dim every emitted row additionally splits by (§6.5 — every
	// source must carry the partition column).
	Partition string
	// Profile marks the career statement (the match_id = 0 bucket): the
	// profile path is PLAYER-ONLY — a match or team has no career —
	// refused at compile time with its own message (§3.1).
	Profile bool
}

// normalize validates the declared address vocabulary and applies the
// subject × scope legality rule (§3.1): profile scope admits the player
// subject alone. Failures are *ParseError (ExprError shape) at Pos 0 —
// an address problem is statement-level, never expression-positional.
func (a Address) normalize() (Address, *ParseError) {
	if a.Subject == "" {
		a.Subject = "player"
	}
	switch a.Subject {
	case "player", "match", "team":
	default:
		return Address{}, errf(0, "unknown subject %q (valid: player, match, team)", a.Subject)
	}
	if a.Partition != "" {
		if _, ok := partitionColumns[a.Partition]; !ok {
			return Address{}, errf(0, "unknown partition %q (valid: side, map, weapon, or none)", a.Partition)
		}
	}
	if a.Profile && a.Subject != "player" {
		return Address{}, errf(0,
			"profile scope is player-only: a %s-subject metric has no career — match and team values always belong to a match (metrics expansion §3.1)",
			a.Subject)
	}
	return a, nil
}

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
	// Subject is the declared subject the statement groups by (player |
	// match | team — Address.Subject): valuesFromPlan and Preview map
	// the row's subject key from it (a match subject stores subject_key
	// '', its address IS the row's match).
	Subject string
	// Partition is the declared partition ("" | side | map | weapon —
	// Address.Partition): when set, every row carries its dim beside
	// the subject key (§6.5).
	Partition string
	// MatchAddress marks rows that LEAD with their match_id column: the
	// PASS-ONLY batched mode (CompilePassMatch — the address Go
	// partitions the pass's fetch by, (match_id, subject), with a
	// match-scope denominator correlating on the row's match) and every
	// team-subject statement (a team's key is (match, team), so even a
	// preview must group its rows per match — §6.3). false = the player
	// preview shapes: a scoped run binds one match id, scope "" groups
	// by subject alone (profile/career values store at match_id = 0).
	MatchAddress bool
}

// Compile parses + validates (grammar, sources, the subject anchor per
// §3.4, join keys, columns, scope, denominator, percentile, population
// rules) and emits parameterized SQL. Every statement is
// subject-addressed: rows group by the DECLARED subject's key, rows
// without a usable key are dropped, humans-only applies to the source
// rows unconditionally, and the output is grouped by the key (+
// partition dim when the address declares one). Any validation failure
// is a *ParseError carrying Message/Pos (the ExprError contract).
//
// Compile is the REF-FREE entry point: an expression holding a
// metric() reference must compile through CompileRefs with the
// resolution the service looked up (a nil map reports the ref as
// unresolvable — this wrapper exists so every existing call site keeps
// its shape).
func Compile(expr, denominator, scope string, addr Address) (Plan, *ParseError) {
	return CompileRefs(expr, denominator, scope, addr, nil)
}

// CompileRefs is Compile plus the metric() references (design §2): refs
// maps each referenced name to its resolved RefTarget (id, grain, live
// stamps) — filled by the SERVICE from the catalog, never by this
// package (Compile stays pure: user text never reaches SQL, and neither
// does a catalog lookup).
//
// Each distinct ref compiles to ONE engine-derived INNER JOIN over
// metric_values (alias md0, md1, … in first-appearance order):
//
//	INNER JOIN metric_values md0 ON md0.metric_id = ?
//	  AND md0.match_id = <0 | primary.match_id>
//	  AND md0.subject_key = <the dependent's subject key expression>
//	  AND md0.metric_version = ? AND md0.rule_version = ?
//
// The subject_key key condition is the subject axis's ref rule (plan
// §6.8 / §3.1 key containment): the DEPENDENT's row key must contain
// the referenced metric's row key, so a dependent can only read the
// same subject or a coarser one (a player metric may ride a match-grain
// dependency on its own match; a team metric may read match or team
// values; anything else is refused HERE with the join's own message —
// the save path spells the same rule with the §3.1 copy).
//
// INNER is the designed semantics: a missing or outdated upstream DROPS
// the dependent's row — absent = unknown, never 0 (sources keep their
// Value-0-beside-N honesty row; a MISSING DEPENDENCY is not a zero).
// The join forces column qualification (metric_values shares match_id
// with every source, and its subject_key mirrors each source's subject
// column, so an unqualified reference would be ambiguous), which is why
// a single-source ref-bearing statement emits qualified columns while
// the ref-free base form stays byte-stable.
//
// metric_values is written by the W3 compute pass (metrics.Sweep); a
// ref-bearing preview over a not-yet-computed upstream honestly returns
// NO rows (upstream absent → dependent dropped). That is the INNER
// contract working, not a defect.
func CompileRefs(expr, denominator, scope string, addr Address, refs map[string]RefTarget) (Plan, *ParseError) {
	return compileRefs(expr, denominator, scope, addr, refs, false)
}

// CompilePassMatch is the PASS-ONLY address mode (stored-metrics design
// §3): the batched match-scope statement the compute pass runs ONCE per
// sweep over the whole library. It compiles like the "" library scope
// (no scope predicate) but the output groups by (match_id, subject) —
// Plan.MatchAddress marks the leading address column — and a
// match-scope denominator correlates on the ROW's match instead of
// binding one scope id, so one statement produces every match's
// per-subject values (design §3). The single-match "match:<id>" form
// stays the preview's mode; a profile-scope compute passes through
// CompileRefs at scope "" (the career statement — GROUP BY subject over
// the whole library), because a career value is stored directly at the
// career grain (design §1b: match_id = 0), not rolled up from per-match
// rows — and that path is player-only (Address.Profile: a match or team
// subject refuses it at compile time).
func CompilePassMatch(expr, denominator string, addr Address, refs map[string]RefTarget) (Plan, *ParseError) {
	return compileRefs(expr, denominator, "", addr, refs, true)
}

// tableFor (whitelist.go) resolves a source name to the physical store
// table at the FROM/JOIN position — the curated-alias design (spec
// addendum I20): a second source over the SAME table under its own
// subject (`engagements_victim` = the engagements table anchored on
// b_steam) is emitted as `<table> AS <source>`. Every source not
// declared in whitelist.go's sourceTable map resolves to itself, so
// identity sources keep byte-stable `FROM`/`JOIN` text and the `AS`
// branches below fire ONLY for a declared alias. Only the table
// position resolves through it: scope binding, subject/humans-only,
// join keys and column qualification all key off the SOURCE NAME
// (which the AS clause makes the table's alias).
//
// compileRefs is the one implementation CompileRefs and CompilePassMatch
// share (batched selects the pass-only address mode above).
func compileRefs(expr, denominator, scope string, addr Address, refs map[string]RefTarget, batched bool) (Plan, *ParseError) {
	spec, perr := Parse(expr)
	if perr != nil {
		return Plan{}, perr
	}
	// Declared addressing first (§6.3): subject/partition vocabulary,
	// then the subject × scope legality rule — a profile statement with
	// a match/team subject is refused HERE, before any source check, so
	// save, preview, sweep and validation can never disagree about it.
	addr, perr = addr.normalize()
	if perr != nil {
		return Plan{}, perr
	}
	srcs := spec.Sources
	for _, s := range srcs {
		if !knownSource(s.Name) {
			return Plan{}, errf(s.Pos, "unknown source table %q (valid: %s)", s.Name, knownSourcesMsg())
		}
	}
	// Ref name resolution, beside the source resolution it mirrors: a
	// name the caller did not resolve is the SAME friendly positioned
	// error the save path spells, so a draft, a preview and a save can
	// never disagree about a reference.
	for _, r := range MetricRefs(spec) {
		if _, ok := refs[r.Name]; !ok {
			return Plan{}, errf(r.Pos, "unknown metric reference %q", r.Name)
		}
	}
	primary := srcs[0].Name
	// Subject addressing (owner criterion, §3.4): the PRIMARY must be
	// ANCHORED FOR THE DECLARED SUBJECT — PRIMARY-OWNS, the same
	// ownership as scope binding and the population anchor. Checked
	// right after knownSource so SaveMetric, ad-hoc PreviewMetric and
	// ValidateExpr all funnel through here and a bad draft errors
	// exactly like any invalid expression:
	//
	//	player  a player column (the pre-expansion rule, byte-stable
	//	        refusal text)
	//	match   match grain — any source (every source carries match_id;
	//	        round-grain sources are legal LEADS for a match subject)
	//	team    the stamped team column (§5 — team sources)
	//
	// `subject` stays the primary's PLAYER column ("" for a round-grain
	// lead): writeSubject applies humans-only through it for every
	// subject — the population rule is about source rows, not about the
	// subject (§3.4) — while the GROUP key comes from the declared
	// subject (emitter.subjectKeyExpr).
	subject := sourceSubject[primary]
	switch addr.Subject {
	case "player":
		if subject == "" {
			return Plan{}, errf(spec.SourcePos,
				"expression is not player-anchored: primary source %q has no player subject — a metric's value must be per player (player sources: %s; round-grain sources can only join a player-anchored expression)",
				primary, playerSources)
		}
	case "match":
		if !sourceColumns[primary]["match_id"] {
			return Plan{}, errf(spec.SourcePos,
				"expression is not match-anchored: primary source %q carries no match_id column (every match-grain source does)", primary)
		}
	case "team":
		if !sourceColumns[primary]["team"] {
			return Plan{}, errf(spec.SourcePos,
				"expression is not team-anchored: primary source %q has no team column (team sources: %s)",
				primary, teamSourcesMsg())
		}
	}

	// Partition validation (§6.5): the partition column must be carried
	// by EVERY source of the expression — a source without it has no dim
	// value for the row it contributes, and the emitted GROUP BY dim
	// would silently NULL-partition those rows. Refusal names the first
	// source missing the column (positioned on its source ref).
	if addr.Partition != "" {
		col := partitionColumns[addr.Partition]
		for _, s := range srcs {
			if !sourceColumns[s.Name][col] {
				return Plan{}, errf(s.Pos,
					"partition %q needs the column %q, which source %q does not carry — every source of a partitioned expression must carry the partition column",
					addr.Partition, col, s.Name)
			}
		}
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
	if t := tableFor(primary); t != primary {
		from = t + " AS " + primary
	}
	oneToOne := map[string]bool{}
	for _, s := range srcs[1:] {
		key, ok := joinKey(primary, s.Name)
		if !ok {
			return Plan{}, errf(s.Pos,
				"cannot join source %q to %q: secondary %q is not unique on the shared dimensions (its primary key/unique key must consist entirely of join dimensions: match, round, player, side)",
				s.Name, primary, s.Name)
		}
		if t := tableFor(s.Name); t != s.Name {
			from += " LEFT JOIN " + t + " AS " + s.Name + " ON "
		} else {
			from += " LEFT JOIN " + s.Name + " ON "
		}
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

	// metric() ref joins (see CompileRefs' doc for the shape and the
	// INNER rationale). Built AFTER validateAggIdents so the single-
	// source "unknown column … for source X" wording stays byte-stable
	// for ref-free expressions — qualification only flips once a ref is
	// actually present.
	refAliases := map[string]string{}
	var refArgs []any
	if refsFound := MetricRefs(spec); len(refsFound) > 0 {
		// Force qualification: metric_values carries match_id and the
		// subject key, so every primary column reference must name its table.
		res.joined = true
		// First-occurrence position per name — the containment refusal
		// is positioned on the ref literal itself.
		posOf := map[string]int{}
		for _, r := range refsFound {
			if _, ok := posOf[r.Name]; !ok {
				posOf[r.Name] = r.Pos
			}
		}
		for _, name := range DistinctNames(refsFound) {
			t := refs[name]
			// Subject × subject rule (§6.8 / §3.1 key containment): the
			// referenced rows' key must be addressable from the
			// dependent's own rows. The md rows' subject_key shape is
			// the REFERENCE's (player → a SteamID64, match → '',
			// team → a team key), so the join's key condition follows
			// the ref's subject and the legality check below gates which
			// dependent may read it. An empty RefTarget.Subject reads as
			// the historical player default (the catalog always fills
			// it; the zero value keeps legacy call sites compiling).
			refSubject := t.Subject
			if refSubject == "" {
				refSubject = "player"
			}
			if !RefSubjectContained(addr.Subject, refSubject) {
				return Plan{}, errf(posOf[name],
					"metric '%s' is %s-subject and cannot be used inside a %s-subject metric (a reference's subject must be contained by the reading metric's subject key)",
					name, refSubject, addr.Subject)
			}
			keyCond := primary + "." + subject
			switch refSubject {
			case "match":
				keyCond = "''"
			case "team":
				keyCond = primary + ".team"
			}
			alias := "md" + strconv.Itoa(len(refAliases))
			refAliases[name] = alias
			from += " INNER JOIN metric_values " + alias + " ON " +
				alias + ".metric_id = ? AND " + alias + ".match_id = " + refMatchExpr(t, primary) +
				" AND " + alias + ".subject_key = " + keyCond +
				" AND " + alias + ".metric_version = ? AND " + alias + ".rule_version = ?"
			// Bind order follows the join's textual order: id, then the
			// two stamps (the match key is a constant/column, never a
			// bind).
			refArgs = append(refArgs, t.ID, t.Version, t.RuleVersion)
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
		Source:       primary,
		AggCount:     len(spec.Aggs),
		SQLAggs:      len(sqlAggs),
		HasDenom:     denomTable != "",
		Subject:      addr.Subject,
		Partition:    addr.Partition,
		MatchAddress: batched || addr.Subject == "team",
	}
	newEmitter := func() *emitter {
		return &emitter{
			res: res, from: from, fromArgs: refArgs, matchID: matchID,
			denom: denomTable, subject: subject, refAliases: refAliases,
			batched: batched, addr: addr,
		}
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
// An expression holding a metric() reference cannot be validated here —
// this entry point carries no catalog — and reports the ref as
// unresolvable; drafts go through the service (ValidateExpr), which
// resolves references against the saved metrics first.
func Validate(expr string) *ParseError {
	_, perr := Compile(expr, "", "", Address{})
	return perr
}

// refMatchExpr renders the ref join's match_id key: the profile grain's
// rows live at match_id = 0 (one career row per subject); a match-grain
// dependency rides the row's own match — the primary's match_id column,
// which the statement has already restricted to the scope id at
// "match:<id>" (so the correlation and the scope predicate agree).
// Only 'match'/'profile' exist (the metrics CHECK, and the store's
// omitted-scope rule normalizes to 'match'), so anything else reads as
// match-grain — the same rule CreateMetric/UpdateMetric apply.
func refMatchExpr(t RefTarget, primary string) string {
	if t.Scope == "profile" {
		return "0"
	}
	return primary + ".match_id"
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
// checked and where the value-column rule fires). Inside an exists()
// the resolution splits: bare columns name the INNER scan (the
// PRIMARY's whitelist only — a secondary's column would silently bind
// the outer row inside the subquery) and outer.<column> resolves
// through the expression's source set like any condition column.
func validateAggIdents(a *Agg, res *colResolution) *ParseError {
	var checkCond func(c *condNode, inExists bool) *ParseError
	checkCond = func(c *condNode, inExists bool) *ParseError {
		if c == nil {
			return nil
		}
		if c.kind == cExists {
			inExists = true // its subtree is the inner scan
		}
		for _, o := range []*operand{c.x, c.y} {
			if o == nil {
				continue
			}
			switch o.kind {
			case opColumn:
				if inExists {
					if !sourceColumns[res.primary][o.col] {
						return errf(o.pos, "unknown column %q for source %s", o.col, res.primary)
					}
					continue
				}
				if perr := res.resolveCond(o.col, o.pos); perr != nil {
					return perr
				}
			case opOuter:
				if perr := res.resolveCond(o.col, o.pos); perr != nil {
					return perr
				}
			}
		}
		if p := checkCond(c.l, inExists); p != nil {
			return p
		}
		return checkCond(c.r, inExists)
	}
	if p := checkCond(a.Where, false); p != nil {
		return p
	}
	if p := checkCond(a.Count, false); p != nil {
		return p
	}
	if a.Col != "" || a.Terms != nil {
		if a.Terms != nil {
			for i, tm := range a.Terms {
				if perr := res.resolveValue(tm, a.TermPos[i]); perr != nil {
					return perr
				}
			}
		} else if perr := res.resolveValue(a.Col, a.ColPos); perr != nil {
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
	// min()/max() scalar value form (w13e): nested aggregations walk
	// their own Col/Terms/Where like any other argument; literals carry
	// no identifier to resolve.
	for i := range a.Scalar {
		if a.Scalar[i].agg != nil {
			if p := validateAggIdents(a.Scalar[i].agg, res); p != nil {
				return p
			}
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
	// fromArgs are the binds the metric() ref joins carry (id + the two
	// stamps, in the FROM clause's textual order). They are appended to
	// args at the exact point the emitter writes `from`, so bind order
	// stays strictly textual: select-list binds first, ref-join binds,
	// then WHERE binds.
	fromArgs []any
	// refAliases maps each metric() reference's name to its
	// metric_values alias (md0, md1, …) — the emitter writes
	// `<alias>.value` where a ref aggregation appears.
	refAliases map[string]string
	// batched is the PASS-ONLY address mode (CompilePassMatch): the
	// statement carries match_id as a leading SELECT/GROUP BY column
	// (every row addressed by (match_id, subject)) and a match-scope
	// denominator correlates on the ROW's match instead of binding one
	// scope id. false = the preview shapes (byte-stable emission for
	// player subjects).
	batched bool
	// addr is the declared addressing (§6.3/§6.5): it selects the GROUP
	// key (subjectKeyExpr), the partition dim, and whether the row shape
	// leads with the match address (emitMid).
	addr Address
	// inExists > 0 while emitting inside an exists() subquery: bare
	// columns name the INNER scan (x0-qualified — unqualified would be
	// ambiguous the moment the outer query also owns the name, and the
	// provenance view should show which row each column reads).
	inExists int
}

func (e *emitter) bind(v any) string {
	e.args = append(e.args, v)
	return "?"
}

// writeFrom emits the FROM clause (primary + engine LEFT JOINs +
// metric() ref joins) together with the ref joins' binds, at the exact
// textual position — the binds ride along with the text they belong to,
// which is what keeps ?-order honest in a builder that interleaves text
// and args.
func (e *emitter) writeFrom() {
	e.sb.WriteString(e.from)
	e.args = append(e.args, e.fromArgs...)
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

// subjectKeyExpr renders the row's GROUP key — the DECLARED subject's
// key column (§6.3):
//
//	player  the primary's player column (subjectExpr — byte-stable)
//	match   the row's match address (matchIDExpr): a match subject's
//	        address IS its match, so the stored subject_key is ''
//	        (valuesFromPlan maps it) while preview groups read the id
//	team    the stamped team column, qualified when joined (column
//	        resolution cannot own it — both the primary and a
//	        secondary may carry `team`, so the anchor's owner qualifies
//	        it directly, like the player subject)
func (e *emitter) subjectKeyExpr() string {
	switch e.addr.Subject {
	case "match":
		return e.matchIDExpr()
	case "team":
		if e.res.joined {
			return e.res.primary + ".team"
		}
		return "team"
	default:
		return e.subjectExpr()
	}
}

// emitMid reports whether the row shape LEADS with its match_id column
// (Plan.MatchAddress): the batched pass always (the (match_id, subject)
// address), and every team-subject statement — a team's key is
// (match, team), so even a library-scope preview keeps its rows per
// match instead of pooling identical team keys across matches (§6.3).
func (e *emitter) emitMid() bool {
	return e.batched || e.addr.Subject == "team"
}

// partitionKeyExpr renders the dim column for SELECT/GROUP BY (§6.5):
// the PRIMARY's partition column, qualified when joined (compile
// validated that EVERY source carries it, so direct qualification — the
// subject keys' rule — is the unambiguous spelling).
func (e *emitter) partitionKeyExpr() string {
	col := partitionColumns[e.addr.Partition]
	if e.res.joined {
		return e.res.primary + "." + col
	}
	return col
}

// subjectConds is THE source-row addressing condition set (one spelling,
// phase1 and phase2 share it). The humans-only rule is about SOURCE
// ROWS — every subject alike (§3.4: a team/match value still counts
// humans only) — while the "no empty key" clause keys off the declared
// subject:
//
//	player  `subject <> ''` (a no-actor bucket never becomes a value)
//	        beside THE humans-only condition over the subject column
//	        (store.HumanOnlyBySteamID, match-scoped so the lookup rides
//	        the players PK) — byte-stable pre-expansion emission.
//	team    `team <> ''` first (an unknown-side row never joins a
//	        team-subject grouping — schema.sql metric_values) beside
//	        humans-only over the primary's PLAYER column when it has
//	        one (a side-grained lead like round_economy records sides,
//	        not players — no player column, no humans-only clause).
//	match   humans-only over the primary's player column when it has
//	        one; a round-grain lead (rounds, round_economy) carries no
//	        player column, so NO condition — every row IS the match's
//	        own record and there is no human/bot axis on it.
//
// UNCONDITIONAL (every statement sets it), so the former
// mixed-population and player-group special cases collapsed into these
// conditions. Pinned by TestSubjectAddressingEmitted,
// TestJoinedPopulationAlignment, TestSubjectStatementExcludesBots
// (player) and the subject-axis emission/refusal tests (match/team).
func (e *emitter) subjectConds() []string {
	humansOnly := func() string {
		return store.HumanOnlyBySteamID(e.res.primary+"."+e.subject, e.res.primary+".match_id")
	}
	switch e.addr.Subject {
	case "player":
		return []string{e.subjectExpr() + " <> ''", humansOnly()}
	case "team":
		conds := []string{e.subjectKeyExpr() + " <> ''"}
		if e.subject != "" {
			conds = append(conds, humansOnly())
		}
		return conds
	default: // match
		if e.subject == "" {
			return nil
		}
		return []string{humansOnly()}
	}
}

// writeSubject writes the subject-addressing condition with the right
// WHERE connector (phase1 and phase2 share this — one spelling, both
// sides) and returns whether a WHERE keyword now stands in the
// statement (a match-subject round-grain lead has NO condition — the
// caller must not assume one was written).
func (e *emitter) writeSubject(wroteWhere bool) bool {
	for _, c := range e.subjectConds() {
		if wroteWhere {
			e.sb.WriteString(" AND ")
		} else {
			e.sb.WriteString(" WHERE ")
		}
		e.sb.WriteString(c)
		wroteWhere = true
	}
	return wroteWhere
}

// phase1 emits the aggregate statement: the row shape's address columns
// (match_id when emitMid, the declared subject's key as grp, the
// partition dim when declared), every SQL aggregation as a value column
// (first = previewed value, wrapped by the denominator when set),
// trailing COUNT(*) sample size, FROM (+ engine LEFT JOINs), scope WHERE
// on the primary (+ the subject addressing condition), GROUP BY the row
// shape ORDER BY the same. In the pass-only batched mode
// (CompilePassMatch) the row's match_id leads both the SELECT and the
// GROUP BY — one statement, every match's per-subject values (design
// §3).
func (e *emitter) phase1(aggs []*Agg, wrapDenom bool) {
	e.sb.WriteString("SELECT ")
	if e.emitMid() {
		e.sb.WriteString(e.matchIDExpr())
		e.sb.WriteString(" AS mid, ")
	}
	e.sb.WriteString(e.subjectKeyExpr())
	e.sb.WriteString(" AS grp, ")
	if e.addr.Partition != "" {
		e.sb.WriteString(e.partitionKeyExpr())
		e.sb.WriteString(" AS dim, ")
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
	e.writeFrom()
	wroteWhere := false
	if e.matchID > 0 {
		e.sb.WriteString(" WHERE ")
		e.sb.WriteString(e.matchIDExpr())
		e.sb.WriteString(" = ")
		e.sb.WriteString(e.bind(e.matchID))
		wroteWhere = true
	}
	e.writeSubject(wroteWhere) // may add no condition (match-subject round-grain lead)
	group := e.groupCols()
	e.sb.WriteString(" GROUP BY " + strings.Join(group, ", ") + " ORDER BY " + strings.Join(group, ", "))
}

// groupCols is THE row-shape group list (phase1's GROUP BY and ORDER
// BY — one spelling so the two can never diverge): the match address
// when the shape leads with it, the declared subject's key, the
// partition dim when declared.
func (e *emitter) groupCols() []string {
	var cols []string
	if e.emitMid() {
		cols = append(cols, "mid")
	}
	cols = append(cols, "grp")
	if e.addr.Partition != "" {
		cols = append(cols, "dim")
	}
	return cols
}

// phase2 emits the raw-value statement for a percentile value: the
// SUBJECT beside the value (the address Go partitions the fetch by) plus
// the scalar denominator when the metric has one, the SAME FROM/join as
// the aggregate statement (uniform qualification path — the phase-2
// fetch carries the join/qualification day one), scope WHERE on the
// primary (+ the subject addressing condition) and the optional per-agg
// filter. The row cap comes from RunReadOnly — no SQL LIMIT, so
// truncation is detectable. Batched mode (CompilePassMatch) leads with
// the row's match_id — the pass partitions (match_id, subject).
func (e *emitter) phase2(a *Agg, withDenom bool) {
	e.sb.WriteString("SELECT ")
	if e.emitMid() {
		e.sb.WriteString(e.matchIDExpr())
		e.sb.WriteString(" AS mid, ")
	}
	e.sb.WriteString(e.subjectKeyExpr())
	e.sb.WriteString(" AS grp, ")
	if e.addr.Partition != "" {
		e.sb.WriteString(e.partitionKeyExpr())
		e.sb.WriteString(" AS dim, ")
	}
	e.sb.WriteString(e.res.qualify(a.Col))
	e.sb.WriteString(" AS x")
	if withDenom {
		e.sb.WriteString(", ")
		e.emitDenom()
	}
	e.sb.WriteString(" FROM ")
	e.writeFrom()
	wroteWhere := false
	if e.matchID > 0 {
		e.sb.WriteString(" WHERE ")
		e.sb.WriteString(e.matchIDExpr())
		e.sb.WriteString(" = ")
		e.sb.WriteString(e.bind(e.matchID))
		wroteWhere = true
	}
	wroteWhere = e.writeSubject(wroteWhere)
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

// emitDenom writes the denominator subquery — ONE rule, per subject
// (metrics expansion §6.6): the denominator counts the SCOPE's units
// FOR THE SUBJECT.
//
//   - player subject (every branch below — unchanged emission):
//     match scope (`match:<id>`): the match's units — the scalar
//     `SELECT COUNT(*) FROM <rounds|matches> WHERE match_id = ?`, every
//     player in the match sharing it; pass-only batched mode: the SAME
//     match-scope count, correlated on the ROW's match instead of a
//     bound scope id — one statement computes every match's rate
//     (design §3); library/profile scope (""): the subject's CAREER
//     units, correlated on the subject — rounds → the subject's
//     player_round_stats rows, matches → its player_stats rows. The
//     career table is ALIASED so the outer subject reference can never
//     resolve to it when the primary and the career table are the same
//     table, and the outer reference is always primary-qualified.
//
//   - match subject: THAT match's units — the same scalar at bound
//     match scope (the existing rule), correlated on the row's match
//     otherwise (batched pass and library preview alike; a match value
//     has no career divisor). The inner table is ALIASED (`d`): a
//     round-grain lead may BE the denominator table, and an inner table
//     in scope would swallow the outer qualification.
//
//   - team subject: that TEAM's rounds in the row's match — the §5 team
//     stamp on round_player_sides: COUNT(DISTINCT round) over the
//     team's freeze-end side samples (the rows are per player, so the
//     distinct count restores the round unit; unknown-side rows carry
//     team ” and drop out rather than guess); the `matches`
//     denominator counts the row's own match — a team value spans
//     exactly one match. Always correlated (both teams share a match).
func (e *emitter) emitDenom() {
	matchRide := e.res.primary + ".match_id"
	switch e.addr.Subject {
	case "team":
		if e.denom == "rounds" {
			e.sb.WriteString("(SELECT COUNT(DISTINCT d.round) FROM round_player_sides AS d WHERE d.match_id = ")
			e.sb.WriteString(matchRide)
			e.sb.WriteString(" AND d.team = ")
			e.sb.WriteString(e.res.primary + ".team)")
			return
		}
		e.sb.WriteString("(SELECT COUNT(*) FROM matches AS d WHERE d.match_id = ")
		e.sb.WriteString(matchRide)
		e.sb.WriteString(")")
		return
	case "match":
		if e.matchID == 0 {
			e.sb.WriteString("(SELECT COUNT(*) FROM ")
			e.sb.WriteString(e.denom)
			e.sb.WriteString(" AS d WHERE d.match_id = ")
			e.sb.WriteString(matchRide)
			e.sb.WriteString(")")
			return
		}
		// bound match scope: the same scalar as the player rule below
	}
	e.sb.WriteString("(SELECT COUNT(*) FROM ")
	switch {
	case e.batched:
		// Pass-only batch: count the ROW's match's units. The outer
		// reference is ALWAYS primary-qualified (an unqualified match_id
		// inside the subquery would resolve to the inner table's column
		// — `match_id = match_id` — and count the whole table).
		e.sb.WriteString(e.denom)
		e.sb.WriteString(" WHERE match_id = ")
		e.sb.WriteString(e.res.primary)
		e.sb.WriteString(".match_id")
	case e.matchID > 0:
		e.sb.WriteString(e.denom)
		e.sb.WriteString(" WHERE match_id = ")
		e.sb.WriteString(e.bind(e.matchID))
	default:
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
		if a.Scalar != nil {
			// The min()/max() VALUE form (w13e): SQLite's scalar
			// two-or-more-argument MIN/MAX over computed values and
			// bound numbers — args in strict textual order, each
			// literal bound as it is written (parameterization holds:
			// no literal reaches the statement text).
			e.sb.WriteString(fn)
			e.sb.WriteString("(")
			for i, term := range a.Scalar {
				if i > 0 {
					e.sb.WriteString(", ")
				}
				if term.agg != nil {
					e.emitValue(term.agg)
					continue
				}
				e.sb.WriteString(e.bind(term.num))
			}
			e.sb.WriteString(")")
			return
		}
		if a.Where == nil {
			e.sb.WriteString(fn)
			e.sb.WriteString("(")
			e.emitTerms(a)
			e.sb.WriteString(")")
			return
		}
		e.sb.WriteString(fn)
		e.sb.WriteString("(CASE WHEN ")
		e.emitCond(a.Where)
		e.sb.WriteString(" THEN ")
		e.emitTerms(a)
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
	case "metric":
		// The ref's INNER-JOINed upstream value — the alias is engine-
		// chosen (md0, md1, …), never user text.
		e.sb.WriteString(e.refAliases[a.RefName])
		e.sb.WriteString(".value")
	default:
		// percentile never reaches SQL (phase2 fetches raw values).
		e.sb.WriteString("NULL")
	}
}

// emitTerms writes the value term(s): the single qualified column (the
// byte-stable form — Terms == nil, which every pre-chain expression
// parses with) or sum()'s additive column chain `q1 + q2 + …`.
func (e *emitter) emitTerms(a *Agg) {
	if a.Terms == nil {
		e.sb.WriteString(e.res.qualify(a.Col))
		return
	}
	for i, tm := range a.Terms {
		if i > 0 {
			e.sb.WriteString(" + ")
		}
		e.sb.WriteString(e.res.qualify(tm))
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
	case cExists:
		// The correlated-existence subquery (plan §6.2): the inner
		// scan is the PRIMARY's table — aliased x0 so an outer
		// reference can never resolve to it (emitDenom's rule for a
		// subquery over the same table the outer query reads) —
		// engine-correlated on the row's match with NO user text (the
		// join-ON discipline: a match-scoped predicate can never bleed
		// across matches), and the inner condition reads bare columns
		// as x0.<col> while outer.<column> resolves through the outer
		// row's owners. The current row is a candidate like any other
		// (SQL EXISTS semantics); N2's kind predicate distinguishes it.
		e.sb.WriteString("EXISTS (SELECT 1 FROM ")
		e.sb.WriteString(tableFor(e.res.primary))
		e.sb.WriteString(" AS x0 WHERE x0.match_id = ")
		e.sb.WriteString(e.res.primary)
		e.sb.WriteString(".match_id AND ")
		e.inExists++
		e.emitCond(c.l)
		e.inExists--
		e.sb.WriteString(")")
	}
}

// emitOperand writes a whitelisted column verbatim (side-qualified when
// the statement joins) or binds a literal. Inside an exists() subquery
// the two operand kinds take the qualified paths: outer.<column> is
// ALWAYS owner-qualified (unqualified would resolve to the inner scan),
// bare columns are x0-qualified (the inner scan).
func (e *emitter) emitOperand(o *operand) {
	if o.kind == opOuter {
		e.sb.WriteString(e.res.owners[o.col])
		e.sb.WriteString(".")
		e.sb.WriteString(o.col)
		return
	}
	if o.kind == opColumn {
		if e.inExists > 0 {
			e.sb.WriteString("x0.")
			e.sb.WriteString(o.col)
			return
		}
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
