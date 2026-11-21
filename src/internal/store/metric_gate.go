package store

import (
	"fmt"
	"sort"
	"strings"
)

// The metric gate's statement half: what a metric statement may be, which
// tables it reads, and which binds it carries. It sits beside the
// console's lexer so both share one tokenizer; the gate itself (statement
// + table + bind + metric() resolution) is internal/metrics.GateSQL, and
// every metric path reaches it through there. Nothing here executes SQL.
//
// The checks, in order:
//
//  1. ValidateReadOnlySQL — the console's layer 1, reused as-is: one
//     statement, no write verb anywhere (CREATE — and so CREATE VIEW — is
//     a write verb), no non-read PRAGMA.
//  2. The leading keyword is SELECT or WITH. The metric path needs no
//     more: EXPLAIN, PRAGMA and VALUES are refused here although the
//     console admits them.
//  3. Table resolution, fail-closed: every FROM item (comma-joined items
//     included), every JOIN target, every `IN <table>` operand — inside
//     subqueries and CTE bodies too — must resolve to a physical table on
//     the metric-readable allowlist, a CTE name, a metric('…') reference,
//     a pure table-valued function (json_each/json_tree) or a subquery.
//     Anything else refuses the statement, so the touched set is never
//     silently short.
//  4. Binds are collected (see MetricStatement.Binds); the metrics gate
//     decides which are accepted.

// metricReadable is THE metric-readable allowlist, ONE explicit classification of every schema table: readable
// (true) or denied (false). The readable tables are the fact tables and
// the engine-read tables: `players` (the humans-only lookup), `matches`
// and `metric_values` (the ref join,
// reached only through metric('…') — see AnalyzeMetricSQL's refAliases).
// generic_events is readable by decision (03 §2). Everything else is denied,
// including sqlite_* and the app tables.
//
// TestMetricReadableClassifiesEverySchemaTable fails when a schema table
// is missing here, so a new table can never become readable by accident.
var metricReadable = map[string]bool{
	// Source tables.
	"events":                true,
	"engagements":           true,
	"rounds":                true,
	"player_stats":          true,
	"player_round_stats":    true,
	"round_economy":         true,
	"clutches":              true,
	"utility_events":        true,
	"chat":                  true,
	"match_trade_opps":      true,
	"round_classifications": true,
	"round_side_classes":    true,
	"round_player_sides":    true,
	// Engine-read tables.
	"matches": true,
	"players": true,
	// The raw payload escape hatch (owner, 2026-11-20; 03 §2).
	"generic_events": true,

	// Denied. metric_values is classified denied for AUTHOR reads: a stored
	// value is reached only through metric('…'), which the compiler joins
	// under its own alias (AnalyzeMetricSQL's refAliases). generic_events
	// is the raw-payload table; the rest are fact tables
	// outside the source list, app state, the engine's own tables and
	// voice (sidecar-only).
	"metric_values":      false,
	"metric_runs":        false,
	"teams":              true,
	"round_player_money": true,
	"sound_events":       true,
	"player_ticks":       true,
	"components":         false,
	"layout_placements":  false,
	"builtin_overrides":  false,
	"warnings":           false,
	"jobs":               false,
	"query_history":      false,
	"saved_queries":      false,
	"saved_filters":      false,
	"report_templates":   false,
	"plugins":            false,
	"analysis_config":    false,
	"metrics":            false,
	"metric_deps":        false,
	"voice_presence":     false,
	"player_career":      false,
}

// metricReadableTable reports whether a metric may read the named physical
// table. Names are case-insensitive (SQLite identifiers are); sqlite_* and
// any unclassified name are denied.
func metricReadableTable(name string) bool {
	name = strings.ToLower(name)
	if strings.HasPrefix(name, "sqlite_") {
		return false
	}
	return metricReadable[name]
}

// knownTableName reports whether name is a classified schema table or a
// sqlite_* table — the names a CTE may not shadow.
func knownTableName(name string) bool {
	name = strings.ToLower(name)
	if strings.HasPrefix(name, "sqlite_") {
		return true
	}
	_, ok := metricReadable[name]
	return ok
}

// UnclassifiedTables returns the names (sorted, as given) that the
// allowlist does not classify. The schema pin uses it: a new table
// appears here until someone classifies it.
func UnclassifiedTables(names []string) []string {
	var out []string
	for _, n := range names {
		if _, ok := metricReadable[strings.ToLower(n)]; !ok && !strings.HasPrefix(strings.ToLower(n), "sqlite_") {
			out = append(out, n)
		}
	}
	sort.Strings(out)
	return out
}

// pureTableFunctions are the table-valued functions a statement may read
// FROM: they expand their arguments (a payload column, a literal) and
// read no table, so they add nothing to the touched set. Every other
// table-valued function (pragma_*, …) is refused.
var pureTableFunctions = map[string]bool{"json_each": true, "json_tree": true}

// GateError is a metric-gate refusal: a user-facing message plus the byte
// offset it points at (0 = the statement as a whole).
type GateError struct {
	Message string
	Pos     int
}

func (e *GateError) Error() string { return e.Message }

// MetricSQLRef is one metric('name') construct in a statement: the
// referenced name, the byte offset of its quoted literal (Pos) and the
// half-open byte span of the whole construct (Start up to End, the
// `metric` keyword through the closing parenthesis), which the run uses
// to rewrite it.
type MetricSQLRef struct {
	Name  string
	Pos   int
	Start int
	End   int
}

// MetricStatement is what the gate's statement half derives from an
// accepted statement.
type MetricStatement struct {
	// Touched is every physical table the statement reads, lower-case,
	// sorted and distinct (empty when it reads none — still determined).
	Touched []string
	// Refs is every metric('name') construct, in textual order.
	Refs []MetricSQLRef
	// Binds is every bind marker, in textual order, spelled as written:
	// ":name", "@name", "$name" or "?" (positional).
	Binds []string
}

// AnalyzeMetricSQL runs the gate's statement and table checks over one
// statement (see the file doc) and derives its touched tables, its
// metric() references and its binds. refAliases names the aliases under
// which the statement reads stored values ON BEHALF OF metric() references
// the caller has already resolved (the expression compiler's own ref
// joins); a read of the stored values under any other alias — or with
// refAliases nil — is refused like every denied table.
func AnalyzeMetricSQL(q string, refAliases map[string]bool) (MetricStatement, *GateError) {
	if err := ValidateReadOnlySQL(q); err != nil {
		// A statement that is not a read at all (sugar text, a bare
		// keyword the read-only layer does not know) gets the metric's
		// own clear message; the write verbs keep their specific copy.
		if strings.HasPrefix(err.Error(), "expected SELECT/WITH") {
			return MetricStatement{}, &GateError{Message: "a metric is one SELECT or WITH statement"}
		}
		return MetricStatement{}, &GateError{Message: err.Error()}
	}
	toks, err := lexSQL(q) // cannot fail: ValidateReadOnlySQL lexed it
	if err != nil {
		return MetricStatement{}, &GateError{Message: err.Error()}
	}
	if toks[len(toks)-1].text == ";" {
		toks = toks[:len(toks)-1]
	}
	if len(toks) == 0 {
		return MetricStatement{}, &GateError{Message: "a metric is one SELECT or WITH statement"}
	}
	// The read-only layer admits EXPLAIN, PRAGMA and VALUES; a metric is
	// one SELECT or WITH and nothing else (the file doc's rule 2).
	if lead := strings.ToLower(toks[0].text); toks[0].kind != 'i' || (lead != "select" && lead != "with") {
		return MetricStatement{}, &GateError{Message: "a metric is one SELECT or WITH statement", Pos: toks[0].pos}
	}
	r := &tableResolver{toks: toks, refAliases: refAliases, touched: map[string]bool{}, ctes: map[string]bool{}}
	if gerr := r.run(); gerr != nil {
		return MetricStatement{}, gerr
	}
	out := MetricStatement{Touched: make([]string, 0, len(r.touched)), Refs: r.refs, Binds: r.binds()}
	for t := range r.touched {
		out.Touched = append(out.Touched, t)
	}
	sort.Strings(out.Touched)
	return out, nil
}

// tableResolver walks one statement's tokens.
type tableResolver struct {
	toks       []sqlTok
	match      []int // index of the matching ')' for every '('
	refAliases map[string]bool
	touched    map[string]bool
	ctes       map[string]bool
	refs       []MetricSQLRef
}

// binds collects the bind markers of the statement, in textual order. A
// marker is `?` (positional), or a sigil (`:`, `@`, `$`) immediately
// followed by a name — the same rule HasParameters applies.
func (r *tableResolver) binds() []string {
	var out []string
	for i, t := range r.toks {
		if t.kind != 'p' {
			continue
		}
		switch t.text {
		case "?":
			out = append(out, "?")
		case ":", "@", "$":
			if i+1 < len(r.toks) && (r.toks[i+1].kind == 'i' || r.toks[i+1].kind == 'n') {
				out = append(out, t.text+r.toks[i+1].text)
			}
		}
	}
	return out
}

// fromEnd are the keywords that close a FROM clause at its own depth.
var fromEnd = map[string]bool{
	"where": true, "group": true, "having": true, "window": true, "order": true,
	"limit": true, "union": true, "intersect": true, "except": true,
	"select": true, "values": true, "returning": true,
}

// notAlias are keywords that may follow a FROM/JOIN item and are never
// its bare alias.
var notAlias = map[string]bool{
	"where": true, "group": true, "having": true, "window": true, "order": true,
	"limit": true, "union": true, "intersect": true, "except": true, "join": true,
	"left": true, "right": true, "full": true, "inner": true, "cross": true,
	"natural": true, "outer": true, "on": true, "using": true, "indexed": true,
	"not": true, "select": true, "values": true,
}

func (r *tableResolver) word(i int) string {
	if i < 0 || i >= len(r.toks) || r.toks[i].kind != 'i' {
		return ""
	}
	return strings.ToLower(r.toks[i].text)
}

func (r *tableResolver) text(i int) string {
	if i < 0 || i >= len(r.toks) {
		return ""
	}
	return r.toks[i].text
}

func (r *tableResolver) pos(i int) int {
	if i >= len(r.toks) {
		if len(r.toks) == 0 {
			return 0
		}
		return r.toks[len(r.toks)-1].pos
	}
	return r.toks[i].pos
}

// name returns the identifier at i, unquoting a "double-quoted" name
// (doubled quotes unescaped) and lower-casing it; ok is false when the
// token is not an identifier.
func (r *tableResolver) name(i int) (string, bool) {
	if i >= len(r.toks) || r.toks[i].kind != 'i' {
		return "", false
	}
	t := r.toks[i].text
	if strings.HasPrefix(t, `"`) {
		t = strings.ReplaceAll(t[1:len(t)-1], `""`, `"`)
	}
	return strings.ToLower(t), true
}

func (r *tableResolver) run() *GateError {
	// Parenthesis matching first: every later step skips balanced groups.
	r.match = make([]int, len(r.toks))
	var stack []int
	for i, t := range r.toks {
		switch t.text {
		case "(":
			stack = append(stack, i)
		case ")":
			if len(stack) == 0 {
				return &GateError{Message: "unbalanced parentheses", Pos: t.pos}
			}
			r.match[stack[len(stack)-1]] = i
			stack = stack[:len(stack)-1]
		}
	}
	if len(stack) > 0 {
		return &GateError{Message: "unbalanced parentheses", Pos: r.toks[stack[0]].pos}
	}
	// CTE names before any FROM is resolved (a body may read an earlier
	// CTE, a recursive one itself).
	for i := range r.toks {
		if r.word(i) == "with" {
			if gerr := r.collectCTEs(i + 1); gerr != nil {
				return gerr
			}
		}
	}
	for i := range r.toks {
		switch r.word(i) {
		case "metric":
			if r.text(i+1) == "(" {
				if gerr := r.metricRef(i); gerr != nil {
					return gerr
				}
			}
		case "from":
			// `a IS [NOT] DISTINCT FROM b` compares values; it reads nothing.
			if r.word(i-1) == "distinct" {
				continue
			}
			if gerr := r.fromList(i + 1); gerr != nil {
				return gerr
			}
		case "join":
			if _, gerr := r.item(i+1, "JOIN"); gerr != nil {
				return gerr
			}
		case "in":
			// `x IN tbl` reads the table; `x IN (…)` is a list or a
			// subquery (its own FROM is resolved where it stands).
			if i+1 < len(r.toks) && r.toks[i+1].kind == 'i' {
				if _, gerr := r.item(i+1, "IN"); gerr != nil {
					return gerr
				}
			}
		}
	}
	return nil
}

// collectCTEs records the names of one WITH clause starting at i.
func (r *tableResolver) collectCTEs(i int) *GateError {
	if r.word(i) == "recursive" {
		i++
	}
	for {
		name, ok := r.name(i)
		if !ok {
			return &GateError{Message: "expected a name after WITH", Pos: r.pos(i)}
		}
		if knownTableName(name) {
			return &GateError{Message: fmt.Sprintf("the WITH name %q is already a table name; pick another", name), Pos: r.pos(i)}
		}
		r.ctes[name] = true
		i++
		if r.text(i) == "(" {
			i = r.match[i] + 1
		}
		if r.word(i) != "as" {
			return &GateError{Message: fmt.Sprintf("expected AS after the WITH name %q", name), Pos: r.pos(i)}
		}
		i++
		if r.word(i) == "not" {
			i++
		}
		if r.word(i) == "materialized" {
			i++
		}
		if r.text(i) != "(" {
			return &GateError{Message: fmt.Sprintf("expected a parenthesized query for the WITH name %q", name), Pos: r.pos(i)}
		}
		i = r.match[i] + 1
		if r.text(i) != "," {
			return nil
		}
		i++
	}
}

// metricRef records one metric('name') construct at i (the `metric`
// token); any other argument shape is refused.
func (r *tableResolver) metricRef(i int) *GateError {
	if i+3 >= len(r.toks) || r.toks[i+2].kind != 's' || r.text(i+3) != ")" {
		return &GateError{Message: "metric() takes one quoted metric name, like metric('kills')", Pos: r.pos(i)}
	}
	lit := r.toks[i+2].text
	r.refs = append(r.refs, MetricSQLRef{
		Name:  strings.ReplaceAll(lit[1:len(lit)-1], "''", "'"),
		Pos:   r.toks[i+2].pos,
		Start: r.toks[i].pos,
		End:   r.toks[i+3].pos + len(")"),
	})
	return nil
}

// fromList resolves a FROM clause starting at i: its first item, then
// every comma-separated item at the same depth until the clause ends.
// JOIN targets inside it are resolved by run's own JOIN case.
func (r *tableResolver) fromList(i int) *GateError {
	j, gerr := r.item(i, "FROM")
	if gerr != nil {
		return gerr
	}
	for j < len(r.toks) {
		t := r.toks[j]
		switch {
		case t.text == "(":
			j = r.match[j] + 1
		case t.text == ")":
			return nil // the enclosing subquery ends the clause
		case t.text == ",":
			if j, gerr = r.item(j+1, "a comma join"); gerr != nil {
				return gerr
			}
		case fromEnd[r.word(j)]:
			return nil
		default:
			j++
		}
	}
	return nil
}

// item resolves ONE source item at i (after FROM, JOIN, a comma or IN)
// and returns the index just past it (name, optional alias). where is the
// position's name for the refusal copy.
func (r *tableResolver) item(i int, where string) (int, *GateError) {
	if i >= len(r.toks) {
		return i, &GateError{Message: fmt.Sprintf("expected a table after %s", where), Pos: r.pos(i)}
	}
	if r.text(i) == "(" {
		// A subquery: its own FROM is resolved where it stands. A
		// parenthesized join list is refused (fail-closed).
		switch r.word(i + 1) {
		case "select", "with", "values":
			return r.match[i] + 1, nil
		}
		return i, &GateError{Message: "parenthesized join lists aren't supported; join the tables directly", Pos: r.pos(i)}
	}
	name, ok := r.name(i)
	if !ok {
		return i, &GateError{Message: fmt.Sprintf("can't tell which table %s reads (%s); name tables plainly or in double quotes", where, r.text(i)), Pos: r.pos(i)}
	}
	start := i
	i++
	if r.text(i) == "." {
		if name != "main" {
			return i, &GateError{Message: fmt.Sprintf("only the library's own tables can be read (got %q)", name), Pos: r.pos(start)}
		}
		if name, ok = r.name(i + 1); !ok {
			return i, &GateError{Message: fmt.Sprintf("can't tell which table %s reads", where), Pos: r.pos(i + 1)}
		}
		i += 2
	}
	if r.text(i) == "(" {
		// A table-valued function (or the metric() construct, recorded by run).
		end := r.match[i] + 1
		switch {
		case name == "metric":
		case pureTableFunctions[name]:
		default:
			return i, &GateError{Message: fmt.Sprintf("%s() can't be read in a metric", name), Pos: r.pos(start)}
		}
		return r.skipAlias(end), nil
	}
	alias := ""
	next := r.skipAlias(i)
	if next > i {
		alias, _ = r.name(next - 1)
	}
	switch {
	case r.ctes[name]:
	case name == "metric_values" && r.refAliases[alias]:
		// The compiler's own join for a metric() it has already resolved.
	case !metricReadableTable(name):
		return i, &GateError{Message: fmt.Sprintf("metrics can't read %q; only match data is readable", name), Pos: r.pos(start)}
	default:
		r.touched[name] = true
	}
	return next, nil
}

// skipAlias returns the index past an optional `[AS] alias` at i.
func (r *tableResolver) skipAlias(i int) int {
	if r.word(i) == "as" {
		return i + 2
	}
	if w := r.word(i); w != "" && !notAlias[w] {
		return i + 1 // a bare or "quoted" alias
	}
	return i
}
