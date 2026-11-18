package metrics

import (
	"fmt"
	"strconv"
	"strings"
)

// ParseError describes a grammar/validation failure. Pos is a byte offset
// into the expression source (0 for failures not tied to one position —
// scope/denominator problems). The M5 service maps this onto the frontend
// ExprError contract verbatim.
type ParseError struct {
	Message string `json:"message"`
	Pos     int    `json:"pos"`
}

func (e *ParseError) Error() string {
	return fmt.Sprintf("%s (at byte %d)", e.Message, e.Pos)
}

// Expression limits (DoS guards on the parse, not part of the grammar).
const (
	maxExprBytes = 8192
	maxAggs      = 16
	maxCondDepth = 64
)

// aggOps is THE op table — unknown ops are ExprErrors. `metric` is the
// value reference (design §2): a ref joins the op table so it reuses the
// tStr lexer and yields positioned ParseErrors, but it is legal in
// exactly two positions (a top-level aggregation and a ratio() operand —
// see parseMetricArg and the parseColArg/parseScalarTerm/parseOperand
// denials).
var aggOps = map[string]bool{
	"count": true, "sum": true, "avg": true, "min": true, "max": true,
	"stddev": true, "percentile": true, "median": true, "ratio": true,
	"metric": true, "argmax": true,
}

// ratioNestedOps restricts ratio()'s arguments — AND the min()/max()
// scalar value form's terms — to value aggregations (percentile is
// Go-side, ratio is a single-SQL expression — no nesting). `metric` is
// a VALUE term, so it is a legal ratio operand — one of the ref's two
// legal positions (design §2) — but it is DENIED as a scalar min/max
// term (parseScalarTerm), which keeps refs.go's two-position walk true.
var ratioNestedOps = map[string]bool{
	"count": true, "sum": true, "avg": true, "min": true, "max": true,
	"stddev": true, "metric": true,
}

// exprKeywords are case-insensitive contextual keywords (they only carry
// meaning in their positions; as column names they would be rejected — no
// whitelisted column is named any of these). `exists` and `outer` belong
// to the exists() construct (parseExists / parseOperand): as a source or
// column name outside it they are refused as the keywords they are.
// `next` belongs to the next() round-window construct (parseWindow): a
// bare `next` is refused as the keyword it is, `next(` commits to the
// window wherever the position accepts it.
var exprKeywords = map[string]bool{
	"from": true, "as": true, "where": true, "and": true, "or": true,
	"not": true, "true": true, "false": true,
	"exists": true, "outer": true, "next": true,
}

// existsValueMsg is the ONE refusal for exists() in a value position —
// top-level aggregation, ratio operand, column argument, additive chain
// term and scalar min/max term (parseAgg, parseColArg, parseScalarTerm
// all quote it verbatim): the construct is a condition, and a condition
// never becomes a value.
const existsValueMsg = "exists() is a condition, not a value — it can only appear where a condition is accepted (count()'s argument or a where filter)"

// nextValueMsg is the ONE refusal for next() in a value position —
// top-level aggregation, ratio operand, column argument, additive chain
// term and scalar min/max term (parseAgg, parseColArg, parseScalarTerm
// all quote it verbatim): the construct is a ROW WINDOW reading another
// round's row, legal exactly where a condition is (parseWindow). A row
// window never becomes this row's value.
const nextValueMsg = "next() is a round window — it can only appear where a condition is accepted (count()'s argument or a where filter); it reads another round's row, never this row's value"

// cmpOps are the comparison operators (two-char forms must be adjacent:
// `a < = b` is a syntax error, not `<=`).
var cmpOps = map[string]bool{"=": true, "!=": true, ">": true, ">=": true, "<": true, "<=": true}

// SourceRef is one entry of the source clause (Name at byte Pos).
type SourceRef struct {
	Name string
	Pos  int
}

// Spec is a parsed expression: the source clause — one or more sources,
// the FIRST of which is the PRIMARY (it owns the subject anchor, scope
// binding and the population anchor; the rest are engine-joined) — plus
// its aggregation list.
type Spec struct {
	Source    string // primary (Sources[0].Name) — kept for callers
	SourcePos int
	Sources   []SourceRef
	Aggs      []Agg
}

// Agg is one aggregation node.
type Agg struct {
	Op     string // count|sum|avg|min|max|stddev|percentile|ratio|metric (median normalized to percentile)
	Alias  string // optional AS alias (reserved for metric views, unused by preview)
	Where  *condNode
	Col    string // value column (sum/avg/min/max/stddev/percentile)
	ColPos int
	// Terms/TermPos: sum()'s ADDITIVE column expression — `sum(a + b …)`.
	// nil = the single-column form (every other op always nil; sum without
	// a `+` also stays nil, so single-column emission is byte-stable).
	// Columns only: no literals, no parens, no refs, no nested aggregates —
	// the condition grammar never sees `+`. In a chain Col/ColPos keep the
	// FIRST term (validation and emission prefer Terms when present).
	Terms   []string
	TermPos []int
	// Scalar: the min()/max() VALUE form (w13e) — a comma list of ≥2
	// value terms, each a nested value aggregation (the ratioNestedOps
	// set; metric denied, percentile/median/ratio rejected — see
	// parseScalarArgs) or a bound numeric literal. nil = the AGGREGATE
	// form over one column (every other op always nil; emission stays
	// byte-stable for it). The shape dispatch in parseOpArgs picks the
	// form before any `where` prefix: `where`/a bare non-op column ⇒
	// aggregate, a number/unary minus/aggregate-op call ⇒ scalar — the
	// ≥2 floor is load-bearing (one argument IS the aggregate, and
	// SQLite resolves min/max by argument count: MAX(SUM(x)) is
	// rejected at execution).
	Scalar []scalarTerm
	Count  *condNode // count(): condition; nil = count(*)
	P      float64   // percentile fraction (median → 0.5)
	Num    *Agg      // ratio numerator
	Den    *Agg      // ratio denominator
	Pos    int       // byte offset of the op name
	// Op == "metric": the referenced metric's name and the byte span of
	// its '...' literal (RefPos inclusive, RefEnd exclusive). The span is
	// what the rename splice rewrites in place (design §2 identity rule:
	// the name lives in the text AND in metric_deps).
	RefName string
	RefPos  int
	RefEnd  int
}

// scalarTerm is one argument of the min()/max() value form: a nested
// value aggregation (agg != nil — its Col/Terms/Where walk the normal
// validation and emission paths) or a numeric literal (num, already
// signed; always bound as a `?` parameter, never inlined). Pos is the
// term's first token (the `-` when negated).
type scalarTerm struct {
	agg *Agg
	num float64
	pos int
}

// operand kinds in conditions.
const (
	opColumn = 'i'
	opLit    = 'l'
	// opOuter: `outer.<column>` — the row being tested, referenced from
	// inside an exists() subquery (the construct's ONE qualifier; only
	// parseOperand builds one, only while p.inExists > 0).
	opOuter = 'o'
	// opWindow: `next(<column>)` — the next-round window operand
	// (parseWindow): the column's value on the NEXT round's row of the
	// expression's primary source. pos is the `next` token (shape and
	// round-grain refusals anchor there), colPos the column token (its
	// whitelist refusal anchors there).
	opWindow = 'w'
)

type operand struct {
	kind   byte
	col    string  // opColumn
	num    float64 // opLit numeric
	str    string  // opLit string
	isStr  bool    // opLit: string vs number vs bool
	isBool bool
	bval   bool
	pos    int
	colPos int // opWindow: the column token's position
}

// condition node kinds.
const (
	cTruth = 't' // bare operand, SQLite-truthy
	cCmp   = 'c' // lhs op rhs
	cAnd   = 'a'
	cOr    = 'o'
	cNot   = 'n'
	// cExists: exists(<cond>) — the correlated-existence construct
	// (plan §6.2): l is the inner condition over ANOTHER row of the
	// expression's primary source; pos is the `exists` token.
	cExists = 'e'
)

type condNode struct {
	kind byte
	op   string // cCmp operator
	x, y *operand
	l, r *condNode
	pos  int
}

// exprTok kinds.
const (
	tIdent = 'i'
	tNum   = 'n'
	tStr   = 's'
	tPunct = 'p'
)

type exprTok struct {
	kind byte
	text string // ident/number/punct as written; string WITH quotes
	val  string // string payload, quotes resolved ('' → ')
	pos  int
}

func (t exprTok) is(word string) bool {
	return t.kind == tIdent && strings.EqualFold(t.text, word)
}

// errf builds a positioned ParseError.
func errf(pos int, format string, args ...any) *ParseError {
	return &ParseError{Message: fmt.Sprintf(format, args...), Pos: pos}
}

// Parse parses a metric expression into a Spec. Grammar validation only —
// column/identifier whitelisting happens in Compile (this returns the AST
// with identifier nodes; compile validates every one against the source
// whitelist). Returns *ParseError on failure.
func Parse(expr string) (Spec, *ParseError) {
	if strings.TrimSpace(expr) == "" {
		return Spec{}, errf(0, "empty expression: expected \"from <table>: <aggregations>\"")
	}
	if len(expr) > maxExprBytes {
		return Spec{}, errf(0, "expression too long (%d bytes, max %d)", len(expr), maxExprBytes)
	}
	toks, perr := lexExpr(expr)
	if perr != nil {
		return Spec{}, perr
	}
	p := &parser{toks: toks, end: len(expr)}
	return p.parseSpec()
}

// lexExpr tokenizes the expression. Strings ('...' with ” escapes) and
// comments (--, /* */) are skipped; positions are byte offsets.
func lexExpr(src string) ([]exprTok, *ParseError) {
	var toks []exprTok
	isStart := func(c byte) bool {
		return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
	}
	isPart := func(c byte) bool { return isStart(c) || (c >= '0' && c <= '9') || c == '$' }
	i := 0
	for i < len(src) {
		c := src[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v':
			i++
		case c == '-' && i+1 < len(src) && src[i+1] == '-':
			for i < len(src) && src[i] != '\n' {
				i++
			}
		case c == '/' && i+1 < len(src) && src[i+1] == '*':
			j := strings.Index(src[i+2:], "*/")
			if j < 0 {
				return nil, errf(i, "unterminated block comment")
			}
			i += 2 + j + 2
		case c == '\'':
			j := i + 1
			var sb strings.Builder
			closed := false
			for j < len(src) {
				if src[j] == '\'' {
					if j+1 < len(src) && src[j+1] == '\'' {
						sb.WriteByte('\'')
						j += 2
						continue
					}
					closed = true
					break
				}
				sb.WriteByte(src[j])
				j++
			}
			if !closed {
				return nil, errf(i, "unterminated string literal")
			}
			toks = append(toks, exprTok{kind: tStr, text: src[i : j+1], val: sb.String(), pos: i})
			i = j + 1
		case c >= '0' && c <= '9' || (c == '.' && i+1 < len(src) && src[i+1] >= '0' && src[i+1] <= '9'):
			j := i
			for j < len(src) && src[j] >= '0' && src[j] <= '9' {
				j++
			}
			if j < len(src) && src[j] == '.' {
				j++
				for j < len(src) && src[j] >= '0' && src[j] <= '9' {
					j++
				}
			}
			if j < len(src) && (src[j] == 'e' || src[j] == 'E') {
				k := j + 1
				if k < len(src) && (src[k] == '+' || src[k] == '-') {
					k++
				}
				if k < len(src) && src[k] >= '0' && src[k] <= '9' {
					for k < len(src) && src[k] >= '0' && src[k] <= '9' {
						k++
					}
					j = k
				}
			}
			toks = append(toks, exprTok{kind: tNum, text: src[i:j], pos: i})
			i = j
		case isStart(c):
			j := i
			for j < len(src) && isPart(src[j]) {
				j++
			}
			toks = append(toks, exprTok{kind: tIdent, text: src[i:j], pos: i})
			i = j
		case c == '!' || c == '<' || c == '>' || c == '=':
			if i+1 < len(src) && src[i+1] == '=' {
				toks = append(toks, exprTok{kind: tPunct, text: src[i : i+2], pos: i})
				i += 2
			} else {
				toks = append(toks, exprTok{kind: tPunct, text: string(c), pos: i})
				i++
			}
		default:
			toks = append(toks, exprTok{kind: tPunct, text: string(c), pos: i})
			i++
		}
	}
	return toks, nil
}

type parser struct {
	toks  []exprTok
	i     int
	depth int
	end   int // byte length of the source (EOF error positions)
	// primary is the expression's PRIMARY source name (set by parseSpec
	// before any aggregation parses) — exists() uses it to recognize a
	// self-referential qualifier (the subquery already scans that
	// source, so naming it as a qualifier is refused by name).
	primary string
	// inExists counts exists() frames currently being parsed: > 0 makes
	// `outer.<column>` legal (and only `outer.` legal) in parseOperand,
	// and refuses a nested exists().
	inExists int
}

func (p *parser) peek() (exprTok, bool) {
	if p.i < len(p.toks) {
		return p.toks[p.i], true
	}
	return exprTok{}, false
}

func (p *parser) next() (exprTok, bool) {
	t, ok := p.peek()
	if ok {
		p.i++
	}
	return t, ok
}

func (p *parser) atEnd() bool { return p.i >= len(p.toks) }

func (p *parser) atPunct(s string) bool {
	t, ok := p.peek()
	return ok && t.kind == tPunct && t.text == s
}

func (p *parser) eatPunct(s string) bool {
	if p.atPunct(s) {
		p.i++
		return true
	}
	return false
}

func (p *parser) expectPunct(s string) *ParseError {
	if !p.eatPunct(s) {
		return p.errHere("expected %q", s)
	}
	return nil
}

// errHere reports an error at the current token (or end of input).
func (p *parser) errHere(format string, args ...any) *ParseError {
	if t, ok := p.peek(); ok {
		return errf(t.pos, format+" (got %q)", append(args, t.text)...)
	}
	return errf(p.end, format+" (end of input)", args...)
}

func (p *parser) parseSpec() (Spec, *ParseError) {
	t, ok := p.next()
	if !ok || !t.is("from") {
		if !ok {
			return Spec{}, errf(0, "expected \"from <table>: <aggregations>\"")
		}
		return Spec{}, errf(t.pos, "expected \"from <table>:\" (got %q)", t.text)
	}
	src, ok := p.next()
	if !ok || src.kind != tIdent {
		return Spec{}, p.errHere("expected source table name after \"from\"")
	}
	if exprKeywords[src.text] {
		return Spec{}, errf(src.pos, "expected source table name, got keyword %q", src.text)
	}
	// Comma-separated source list (design (c)): `from a, b, c:` — the
	// first name is the primary, the rest are engine-joined secondaries.
	// Only bare identifiers appear here; ON/join-type/alias syntax does
	// NOT exist, so no user text can ever reach a join clause.
	srcs := []SourceRef{{Name: src.text, Pos: src.pos}}
	for p.atPunct(",") {
		p.i++
		t2, ok := p.next()
		if !ok || t2.kind != tIdent {
			return Spec{}, p.errHere("expected source table name after \",\"")
		}
		if exprKeywords[t2.text] {
			return Spec{}, errf(t2.pos, "expected source table name, got keyword %q", t2.text)
		}
		for _, s := range srcs {
			if s.Name == t2.text {
				return Spec{}, errf(t2.pos, "duplicate source %q in source list", t2.text)
			}
		}
		srcs = append(srcs, SourceRef{Name: t2.text, Pos: t2.pos})
	}
	if perr := p.expectPunct(":"); perr != nil {
		return Spec{}, perr
	}
	spec := Spec{Source: srcs[0].Name, SourcePos: srcs[0].Pos, Sources: srcs}
	// The primary's name — exists() uses it to recognize a self-
	// referential qualifier inside its condition (the subquery scans
	// THIS source, so naming it as a qualifier is refused by name).
	p.primary = srcs[0].Name
	last := srcs[len(srcs)-1]
	for {
		if p.atEnd() {
			return Spec{}, errf(last.Pos+len(last.Name)+1, "expected aggregation after \"%s:\"", last.Name)
		}
		if p.atPunct(",") {
			return Spec{}, p.errHere("unexpected %q (expected an aggregation)", ",")
		}
		agg, perr := p.parseAgg(true)
		if perr != nil {
			return Spec{}, perr
		}
		spec.Aggs = append(spec.Aggs, agg)
		if len(spec.Aggs) > maxAggs {
			return Spec{}, errf(agg.Pos, "too many aggregations (max %d)", maxAggs)
		}
		if p.atEnd() {
			return spec, nil
		}
		if !p.eatPunct(",") {
			return Spec{}, p.errHere("expected %q or end of expression", ",")
		}
	}
}

// parseAgg parses `op(args)` plus (top-level only) an optional AS alias.
func (p *parser) parseAgg(top bool) (Agg, *ParseError) {
	t, ok := p.next()
	if !ok || t.kind != tIdent {
		return Agg{}, p.errHere("expected aggregation name")
	}
	// exists() is a condition, never a value (existsValueMsg): this
	// fires for a top-level aggregation AND for ratio()'s operands —
	// parseAgg parses both.
	if strings.EqualFold(t.text, "exists") {
		return Agg{}, errf(t.pos, existsValueMsg)
	}
	// next() is a round window, never a value (nextValueMsg): same
	// positions, same refusal path as exists().
	if strings.EqualFold(t.text, "next") {
		return Agg{}, errf(t.pos, nextValueMsg)
	}
	if exprKeywords[t.text] {
		return Agg{}, errf(t.pos, "expected aggregation name, got keyword %q", t.text)
	}
	op := strings.ToLower(t.text)
	if !aggOps[op] {
		return Agg{}, errf(t.pos, "unknown aggregation %q (valid: count, sum, avg, min, max, stddev, percentile, median, ratio, metric, argmax)", t.text)
	}
	agg := Agg{Op: op, Pos: t.pos}
	if perr := p.expectPunct("("); perr != nil {
		return Agg{}, perr
	}
	var perr *ParseError
	switch op {
	case "count":
		agg.Count, perr = p.parseCountArgs()
	case "metric":
		// The value reference — handled here (not in parseOpArgs) so it
		// never sees the `where <cond>,` filter prefix: a ref is a
		// computed value, never a row transform.
		agg, perr = p.parseMetricArg(agg)
	default:
		agg, perr = p.parseOpArgs(agg)
	}
	if perr != nil {
		return Agg{}, perr
	}
	if perr := p.expectPunct(")"); perr != nil {
		return Agg{}, perr
	}
	if top {
		if t2, ok2 := p.peek(); ok2 && t2.is("as") {
			p.i++
			al, ok3 := p.next()
			if !ok3 || al.kind != tIdent || exprKeywords[al.text] {
				return Agg{}, p.errHere("expected alias name after \"AS\"")
			}
			agg.Alias = al.text
		}
	}
	return agg, nil
}

// parseCountArgs accepts (), (<cond>) and where <cond> forms. A bare
// operand (`count(headshot)`) becomes a truthiness condition — SQLite
// COUNT(col) over NOT NULL columns would be vacuous, truthiness is the
// useful reading and what the PRD fixtures need.
func (p *parser) parseCountArgs() (*condNode, *ParseError) {
	if p.atPunct(")") {
		return nil, nil
	}
	if t, ok := p.peek(); ok && t.is("where") {
		p.i++
	}
	return p.parseCond()
}

// parseOpArgs handles the optional `where <cond>,` filter prefix plus the
// op-specific argument shape.
func (p *parser) parseOpArgs(agg Agg) (Agg, *ParseError) {
	// min()/max() SHAPE DISPATCH (w13e), BEFORE the where block — the
	// criterion that partitions the two forms: `where` or a bare
	// identifier that is NOT an aggregate op ⇒ the AGGREGATE form over
	// one column (byte-identical to the pre-w13e grammar); anything else
	// — a number, a unary `-`, or an identifier that IS an aggregate op
	// ⇒ the SCALAR value form, python-min/max least/greatest over
	// computed values and numbers (≥2 terms, see parseScalarArgs).
	if agg.Op == "min" || agg.Op == "max" {
		if p.scalarShape() {
			return p.parseScalarArgs(agg)
		}
	}
	if t, ok := p.peek(); ok && t.is("where") {
		p.i++
		c, perr := p.parseCond()
		if perr != nil {
			return Agg{}, perr
		}
		if perr := p.expectPunct(","); perr != nil {
			return Agg{}, perr
		}
		agg.Where = c
	}
	switch agg.Op {
	case "sum", "avg", "min", "max", "stddev":
		return p.parseColArg(agg, agg.Op)
	case "median":
		agg.Op = "percentile"
		agg.P = 0.5
		return p.parseColArg(agg, "median")
	case "percentile":
		t, ok := p.next()
		if !ok || t.kind != tNum {
			return Agg{}, p.errHere("expected percentile fraction (0..1)")
		}
		v, err := strconv.ParseFloat(t.text, 64)
		if err != nil || v < 0 || v > 1 {
			return Agg{}, errf(t.pos, "percentile fraction must be in [0,1] (got %q)", t.text)
		}
		agg.P = v
		if perr := p.expectPunct(","); perr != nil {
			return Agg{}, perr
		}
		return p.parseColArg(agg, "percentile")
	case "argmax":
		// The identity operator (metrics expansion §6.4): one ranking
		// column over the pool — parseColArg gives it the single-column
		// shape, the value-column rule and every denied-position copy
		// (metric()/exists()/keyword refusals) the other column ops
		// share. Compile enforces the rest of its contract (subject,
		// lead, sole aggregation — each with its own message).
		return p.parseColArg(agg, "argmax")
	case "ratio":
		num, perr := p.parseAgg(false)
		if perr != nil {
			return Agg{}, perr
		}
		if !ratioNestedOps[num.Op] {
			return Agg{}, errf(num.Pos, "%s() cannot be nested inside ratio()", num.Op)
		}
		if perr := p.expectPunct(","); perr != nil {
			return Agg{}, perr
		}
		den, perr := p.parseAgg(false)
		if perr != nil {
			return Agg{}, perr
		}
		if !ratioNestedOps[den.Op] {
			return Agg{}, errf(den.Pos, "%s() cannot be nested inside ratio()", den.Op)
		}
		agg.Num, agg.Den = &num, &den
		return agg, nil
	}
	return Agg{}, errf(agg.Pos, "internal: unhandled aggregation %q", agg.Op)
}

// scalarShape is the min()/max() dispatch predicate: true = the SCALAR
// value form, false = the AGGREGATE form over one column. The criterion
// is the shape of the first token after the paren (case-insensitive, the
// op names being contextual keywords): `where` or a bare identifier that
// is NOT an aggregate op — a plain column — takes the aggregate form
// (byte-identical to the pre-w13e grammar, the where-prefix and
// single-column productions below); a number, a unary `-` or an
// identifier that IS an aggregate op (`sum(`, `max(`, …) takes the
// scalar form. No whitelisted column is named any aggOps entry, so the
// identifier test cannot shadow a real column. End of input takes the
// scalar path, which reports its own positioned error.
func (p *parser) scalarShape() bool {
	t, ok := p.peek()
	if !ok {
		return true
	}
	if t.is("where") {
		return false
	}
	if t.kind == tIdent {
		return aggOps[strings.ToLower(t.text)]
	}
	return true
}

// parseScalarArgs reads the min()/max() VALUE form: a comma list of ≥2
// value terms — each a nested value aggregation (the ratioNestedOps set:
// count/sum/avg/min/max/stddev; metric denied, percentile/median/ratio
// rejected — same semantics as ratio()'s gate) or a numeric literal
// (unary minus allowed, mirroring parseOperand). NEVER a bare column:
// columns still reach a value only through an aggregation, so the
// closed sum-chain hole stays closed (literals live in THIS argument
// list, nowhere else). The ≥2 floor is load-bearing: one argument IS
// the aggregate (SQLite resolves min/max by argument count, and
// MAX(SUM(x)) is rejected at execution).
func (p *parser) parseScalarArgs(agg Agg) (Agg, *ParseError) {
	op := agg.Op
	for {
		term, perr := p.parseScalarTerm(op)
		if perr != nil {
			return Agg{}, perr
		}
		agg.Scalar = append(agg.Scalar, term)
		if p.eatPunct(",") {
			continue
		}
		if t, ok := p.peek(); ok && t.kind == tPunct && t.text == ")" {
			if len(agg.Scalar) < 2 {
				return Agg{}, errf(t.pos,
					"%s() takes at least two values — %s(<column>) is the aggregate over one column", op, op)
			}
			return agg, nil
		}
		return Agg{}, p.errHere("expected %q or %q", ",", ")")
	}
}

// parseScalarTerm reads one value-form argument: a nested value
// aggregation (parseAgg reuses the op table, the tStr lexer and every
// positioned error) or a signed number.
//
// Denied position (design §2, kept mechanically): `metric` is refused
// here with the SAME per-op copy the column form uses, at the nested
// token's position — so MetricRefs' walk (top-level + ratio operands)
// stays TRUE with zero migration: no ref node can ever be built inside
// a scalar argument. Allowing refs into scalar arguments later is a
// deliberate FUTURE option (a ref IS a computed value and could floor a
// ratio denominator) — not an oversight; admitting it would extend the
// refs.go walk in the same change.
func (p *parser) parseScalarTerm(op string) (scalarTerm, *ParseError) {
	t, ok := p.peek()
	if !ok {
		return scalarTerm{}, p.errHere("expected a value aggregation or a number")
	}
	if t.kind == tIdent && strings.EqualFold(t.text, "metric") {
		return scalarTerm{}, errf(t.pos, "metric() is a value reference — it cannot appear inside %s()", op)
	}
	if t.kind == tIdent && strings.EqualFold(t.text, "exists") {
		return scalarTerm{}, errf(t.pos, existsValueMsg)
	}
	if t.kind == tIdent && strings.EqualFold(t.text, "next") {
		return scalarTerm{}, errf(t.pos, nextValueMsg)
	}
	if t.kind == tIdent {
		if !aggOps[strings.ToLower(t.text)] {
			// A bare column or keyword: only whole aggregations carry
			// columns into a value.
			return scalarTerm{}, p.errHere("expected a value aggregation or a number")
		}
		nested, perr := p.parseAgg(false)
		if perr != nil {
			return scalarTerm{}, perr
		}
		// The ratioNestedOps gate (ratio()'s semantics): a nested
		// percentile/median is Go-side and would emit SQL NULL at this
		// position; a nested ratio would nest the value twice; metric is
		// denied above with its own copy.
		if !ratioNestedOps[nested.Op] {
			return scalarTerm{}, errf(nested.Pos, "%s() cannot be nested inside %s()", nested.Op, op)
		}
		return scalarTerm{agg: &nested, pos: nested.Pos}, nil
	}
	if t.kind == tNum {
		v, err := strconv.ParseFloat(t.text, 64)
		if err != nil {
			return scalarTerm{}, errf(t.pos, "invalid number %q", t.text)
		}
		p.i++
		return scalarTerm{num: v, pos: t.pos}, nil
	}
	// Unary minus — numbers only, exactly like parseOperand's `-`.
	if t.kind == tPunct && t.text == "-" {
		p.i++
		n, ok2 := p.next()
		if !ok2 || n.kind != tNum {
			return scalarTerm{}, p.errHere("expected a number after %q", "-")
		}
		v, err := strconv.ParseFloat(n.text, 64)
		if err != nil {
			return scalarTerm{}, errf(n.pos, "invalid number %q", n.text)
		}
		return scalarTerm{num: -v, pos: t.pos}, nil
	}
	return scalarTerm{}, p.errHere("expected a value aggregation or a number")
}

// parseMetricArg reads `metric('<name>')` — the value reference (design
// §2). The literal's byte span lands on the Agg (RefPos/RefEnd) so the
// rename splice can rewrite it in place; the name is checked only for
// emptiness here (existence is the SERVICE's — Compile resolves against
// the map the service fills from the catalog).
func (p *parser) parseMetricArg(agg Agg) (Agg, *ParseError) {
	t, ok := p.next()
	if !ok {
		return Agg{}, p.errHere("expected a metric name string in metric(...)")
	}
	// Denied position: a ref may not nest inside a ref (the criterion is
	// "a ref may appear only where a computed value may appear" — a
	// ref's argument is a NAME, never a value).
	if t.kind == tIdent && strings.EqualFold(t.text, "metric") {
		return Agg{}, errf(t.pos, "metric() cannot be nested inside metric()")
	}
	if t.kind != tStr {
		return Agg{}, errf(t.pos, "expected a metric name string in metric(...) (got %q)", t.text)
	}
	if t.val == "" {
		return Agg{}, errf(t.pos, "metric() reference name is empty")
	}
	// t.text is the raw literal WITH quotes — exactly the span a splice
	// replaces.
	agg.RefName, agg.RefPos, agg.RefEnd = t.val, t.pos, t.pos+len(t.text)
	return agg, nil
}

// parseColArg reads the single whitelisted value column. `op` is the op
// AS WRITTEN (median reports as median, not its normalized percentile) —
// it only ever shapes the denied-position error below.
func (p *parser) parseColArg(agg Agg, op string) (Agg, *ParseError) {
	t, ok := p.next()
	if !ok || t.kind != tIdent {
		return Agg{}, p.errHere("expected a column name")
	}
	// Denied position (design §2): a ref is a computed value, not a row
	// transform — aggregating a broadcast scalar double-aggregates it.
	// `metric` is not a whitelisted column of ANY source, so this ident
	// can only be the ref keyword. exists() is refused here with its
	// own message for the same reason it is refused at every other
	// value position: it is a condition.
	if strings.EqualFold(t.text, "metric") {
		return Agg{}, errf(t.pos, "metric() is a value reference — it cannot appear inside %s()", op)
	}
	if strings.EqualFold(t.text, "exists") {
		return Agg{}, errf(t.pos, existsValueMsg)
	}
	if strings.EqualFold(t.text, "next") {
		return Agg{}, errf(t.pos, nextValueMsg)
	}
	if exprKeywords[t.text] {
		return Agg{}, errf(t.pos, "expected a column name, got keyword %q", t.text)
	}
	agg.Col, agg.ColPos = t.text, t.pos
	// Additive column expression — sum() ONLY (the criterion: sum is the
	// one LINEAR aggregate — sum(a + b) == sum(a) + sum(b), exactly the
	// rollup shape the two-column wall (audit N1/N3, feasibility I9)
	// existed for; avg/min/max/stddev/median/percentile keep
	// single-column arguments — min(a+b) is not min(a)+min(b)).
	// NOT agg-level `sum(a) + sum(b)`, NOT ratio-operand arithmetic, NOT
	// metric()-as-addend: those positions parse whole aggregations, so a
	// `+` there never reaches this production and stays denied (the
	// accept/reject matrix in metrics_test.go pins all three shapes).
	// Columns only; the denials above repeat per term, so a ref, keyword
	// or literal inside the chain is the same positioned error as in the
	// single-column form — and the condition grammar never sees `+`
	// (`count(where a + b > 0)` remains a syntax error).
	if nx, ok := p.peek(); ok && nx.kind == tPunct && nx.text == "+" {
		if op != "sum" {
			return Agg{}, errf(nx.pos,
				"%s() takes a single column — only sum() accepts an additive column expression (sum(col + col …))", op)
		}
		agg.Terms = []string{t.text}
		agg.TermPos = []int{t.pos}
		for {
			nx, ok := p.peek()
			if !ok || nx.kind != tPunct || nx.text != "+" {
				break
			}
			p.i++
			c, ok := p.next()
			if !ok || c.kind != tIdent {
				return Agg{}, p.errHere("expected a column name after +")
			}
			if strings.EqualFold(c.text, "metric") {
				return Agg{}, errf(c.pos, "metric() is a value reference — it cannot appear inside %s()", op)
			}
			if strings.EqualFold(c.text, "exists") {
				return Agg{}, errf(c.pos, existsValueMsg)
			}
			if strings.EqualFold(c.text, "next") {
				return Agg{}, errf(c.pos, nextValueMsg)
			}
			if exprKeywords[c.text] {
				return Agg{}, errf(c.pos, "expected a column name, got keyword %q", c.text)
			}
			agg.Terms = append(agg.Terms, c.text)
			agg.TermPos = append(agg.TermPos, c.pos)
		}
	}
	return agg, nil
}

// ---- conditions: or > and > not > primary (comparison | truthiness) ----

func (p *parser) parseCond() (*condNode, *ParseError) { return p.parseOr() }

func (p *parser) parseOr() (*condNode, *ParseError) {
	l, perr := p.parseAnd()
	if perr != nil {
		return nil, perr
	}
	for {
		if t, ok := p.peek(); ok && t.is("or") {
			p.i++
			r, perr := p.parseAnd()
			if perr != nil {
				return nil, perr
			}
			l = &condNode{kind: cOr, l: l, r: r, pos: t.pos}
			continue
		}
		return l, nil
	}
}

func (p *parser) parseAnd() (*condNode, *ParseError) {
	l, perr := p.parseNot()
	if perr != nil {
		return nil, perr
	}
	for {
		if t, ok := p.peek(); ok && t.is("and") {
			p.i++
			r, perr := p.parseNot()
			if perr != nil {
				return nil, perr
			}
			l = &condNode{kind: cAnd, l: l, r: r, pos: t.pos}
			continue
		}
		return l, nil
	}
}

func (p *parser) parseNot() (*condNode, *ParseError) {
	if t, ok := p.peek(); ok && t.is("not") {
		p.i++
		n, perr := p.parseNot()
		if perr != nil {
			return nil, perr
		}
		return &condNode{kind: cNot, l: n, pos: t.pos}, nil
	}
	return p.parsePrimaryCond()
}

func (p *parser) parsePrimaryCond() (*condNode, *ParseError) {
	if p.atPunct("(") {
		p.depth++
		if p.depth > maxCondDepth {
			return nil, p.errHere("condition nesting too deep (max %d)", maxCondDepth)
		}
		p.i++ // consume '('
		inner, perr := p.parseCond()
		if perr != nil {
			return nil, perr
		}
		if perr := p.expectPunct(")"); perr != nil {
			return nil, perr
		}
		p.depth--
		return inner, nil
	}
	// exists() is a condition PRIMARY (plan §6.2): in this position an
	// ident spelled `exists` can only be the construct — no whitelisted
	// column is named `exists` — so it commits here and parseExists
	// owns its shape and refusals (missing "(", arity, nesting).
	if t, ok := p.peek(); ok && t.kind == tIdent && strings.EqualFold(t.text, "exists") {
		p.i++ // consume `exists`
		return p.parseExists(t)
	}
	x, perr := p.parseOperand()
	if perr != nil {
		return nil, perr
	}
	if t, ok := p.peek(); ok && t.kind == tPunct && cmpOps[t.text] {
		p.i++
		y, perr := p.parseOperand()
		if perr != nil {
			return nil, perr
		}
		return &condNode{kind: cCmp, op: t.text, x: x, y: y, pos: t.pos}, nil
	}
	return &condNode{kind: cTruth, x: x, pos: x.pos}, nil
}

// parseExists reads the exists() construct (plan §6.2 / D7): a condition-
// position correlated subquery over the expression's OWN primary source
// — `exists(<cond>)` holds for the row being tested when ANOTHER row of
// the lead's table matches <cond> (N2: damage rows whose kill is on the
// same tick/attacker/victim). The inner condition reads bare columns of
// that table (validated against the PRIMARY's whitelist only — a name
// absent there would silently bind the OUTER row inside the subquery)
// and `outer.<column>` for the row being tested; the engine correlates
// the two rows on match_id (emitCond), so a match-scoped predicate can
// never bleed across matches. One level only: a nested exists() is
// refused. `t` is the already-consumed `exists` token (its position
// anchors the shape errors).
func (p *parser) parseExists(t exprTok) (*condNode, *ParseError) {
	if p.inExists > 0 {
		return nil, errf(t.pos, "exists() cannot be nested inside exists()")
	}
	if !p.atPunct("(") {
		return nil, p.errHere("expected %q after %q", "(", "exists")
	}
	p.i++ // consume '('
	p.depth++
	if p.depth > maxCondDepth {
		return nil, p.errHere("condition nesting too deep (max %d)", maxCondDepth)
	}
	// Optional `where` prefix — count()'s filter form, mirrored.
	if tk, ok := p.peek(); ok && tk.is("where") {
		p.i++
	}
	if p.atPunct(")") {
		return nil, errf(p.toks[p.i].pos, "exists() takes a condition")
	}
	p.inExists++
	inner, perr := p.parseCond()
	p.inExists--
	if perr != nil {
		return nil, perr
	}
	if p.atPunct(",") {
		return nil, errf(p.toks[p.i].pos, "exists() takes exactly one condition")
	}
	if perr := p.expectPunct(")"); perr != nil {
		return nil, perr
	}
	p.depth--
	return &condNode{kind: cExists, l: inner, pos: t.pos}, nil
}

// parseWindow reads the next-round window operand `next(<column>)` — the
// condition-position construct over a round-addressable source (package
// doc): ONE column, no nesting, no qualifier (the window's correlation is
// engine-side, like exists()'s). `t` is the already-consumed `next` token
// (its position anchors the shape errors); legality per position is the
// caller's (parseOperand allows it only outside exists()).
func (p *parser) parseWindow(t exprTok) (*operand, *ParseError) {
	p.i++ // consume '('
	if p.atPunct(")") {
		return nil, errf(p.toks[p.i].pos, "next() takes a column name (next(<column>))")
	}
	c, ok := p.next()
	if !ok || c.kind != tIdent {
		return nil, p.errHere("expected a column name in next()")
	}
	if strings.EqualFold(c.text, "next") {
		return nil, errf(c.pos, "next() cannot be nested inside next()")
	}
	// Same operand denials the column argument carries: a ref is a
	// computed value (and a condition may hold no ref at all), a
	// construct is not a column, a keyword is not a name.
	if strings.EqualFold(c.text, "metric") {
		return nil, errf(c.pos, "metric() is a value reference — it cannot appear inside next()")
	}
	if strings.EqualFold(c.text, "exists") {
		return nil, errf(c.pos, existsValueMsg)
	}
	if exprKeywords[c.text] {
		return nil, errf(c.pos, "expected a column name, got keyword %q", c.text)
	}
	if p.atPunct(",") {
		return nil, errf(p.toks[p.i].pos, "next() takes exactly one column")
	}
	if perr := p.expectPunct(")"); perr != nil {
		return nil, perr
	}
	return &operand{kind: opWindow, col: c.text, pos: t.pos, colPos: c.pos}, nil
}

func (p *parser) parseOperand() (*operand, *ParseError) {
	t, ok := p.next()
	if !ok {
		return nil, p.errHere("expected a column or literal")
	}
	switch t.kind {
	case tIdent:
		// Denied position (design §2): conditions/filters are row-level
		// predicates over SOURCE columns — a computed value has no row
		// to test. `metric` is not a column of any source, so this ident
		// can only be the ref keyword.
		if strings.EqualFold(t.text, "metric") {
			return nil, errf(t.pos, "metric() is a value reference — it cannot appear in a condition or filter (they are row-level predicates over source columns)")
		}
		// next(<column>) — the round-window operand: legal in any
		// condition (count()'s argument, a where filter, diff()'s
		// orientation — a row predicate over source rows), NEVER inside
		// exists() (the subquery's row is another scan; the window
		// always correlates to the row being tested).
		if strings.EqualFold(t.text, "next") && p.atPunct("(") {
			if p.inExists > 0 {
				return nil, errf(t.pos, "next() cannot appear inside exists()")
			}
			return p.parseWindow(t)
		}
		if strings.EqualFold(t.text, "true") {
			return &operand{kind: opLit, isBool: true, bval: true, pos: t.pos}, nil
		}
		if strings.EqualFold(t.text, "false") {
			return &operand{kind: opLit, isBool: true, bval: false, pos: t.pos}, nil
		}
		// exists() constructs: `outer.<column>` names the row being
		// tested — the construct's ONE qualifier (inside exists() only;
		// outside, `outer` is a keyword like any other). It needs a
		// column after the dot.
		if p.inExists > 0 && strings.EqualFold(t.text, "outer") {
			if !p.atPunct(".") {
				return nil, p.errHere("expected a column after %q", "outer.")
			}
			p.i++ // consume '.'
			c, ok := p.next()
			if !ok || c.kind != tIdent {
				return nil, p.errHere("expected a column after %q", "outer.")
			}
			if exprKeywords[c.text] {
				return nil, errf(c.pos, "expected a column name, got keyword %q", c.text)
			}
			return &operand{kind: opOuter, col: c.text, pos: c.pos}, nil
		}
		// Inside exists(), a dot after any other identifier is a
		// qualifier attempt: the grammar has no qualified-identifier
		// syntax, and naming the expression's OWN source would be a
		// self-reference — the subquery already scans it, so the name
		// cannot pick a row. `outer.<column>` is the one spelling for
		// the row being tested.
		if p.inExists > 0 && !exprKeywords[t.text] {
			if nx, ok := p.peek(); ok && nx.kind == tPunct && nx.text == "." {
				if strings.EqualFold(t.text, p.primary) {
					return nil, errf(t.pos,
						"cannot reference %q inside exists() — the subquery scans this source; the row being tested is written outer.<column>", t.text)
				}
				return nil, errf(t.pos,
					"unknown qualifier %q inside exists() — only outer.<column> qualifies a column here", t.text)
			}
		}
		if exprKeywords[t.text] {
			return nil, errf(t.pos, "expected a column name, got keyword %q", t.text)
		}
		return &operand{kind: opColumn, col: t.text, pos: t.pos}, nil
	case tStr:
		return &operand{kind: opLit, isStr: true, str: t.val, pos: t.pos}, nil
	case tNum:
		v, err := strconv.ParseFloat(t.text, 64)
		if err != nil {
			return nil, errf(t.pos, "invalid number %q", t.text)
		}
		return &operand{kind: opLit, num: v, pos: t.pos}, nil
	case tPunct:
		if t.text == "-" {
			n, ok2 := p.next()
			if !ok2 || n.kind != tNum {
				return nil, p.errHere("expected a number after %q", "-")
			}
			v, err := strconv.ParseFloat(n.text, 64)
			if err != nil {
				return nil, errf(n.pos, "invalid number %q", n.text)
			}
			return &operand{kind: opLit, num: -v, pos: t.pos}, nil
		}
	}
	return nil, errf(t.pos, "expected a column or literal (got %q)", t.text)
}
