package metrics

import (
	"fmt"
	"strconv"
	"strings"
)

// ParseError describes a grammar/validation failure. Pos is a byte offset
// into the expression source (0 for failures not tied to one position —
// groupBy/scope problems). The M5 service maps this onto the frontend
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

// aggOps is THE op table — unknown ops are ExprErrors.
var aggOps = map[string]bool{
	"count": true, "sum": true, "avg": true, "min": true, "max": true,
	"stddev": true, "percentile": true, "median": true, "ratio": true,
}

// ratioNestedOps restricts ratio()'s arguments to value aggregations
// (percentile is Go-side, ratio is a single-SQL expression — no nesting).
var ratioNestedOps = map[string]bool{
	"count": true, "sum": true, "avg": true, "min": true, "max": true,
	"stddev": true,
}

// exprKeywords are case-insensitive contextual keywords (they only carry
// meaning in their positions; as column names they would be rejected — no
// whitelisted column is named any of these).
var exprKeywords = map[string]bool{
	"from": true, "as": true, "where": true, "and": true, "or": true,
	"not": true, "true": true, "false": true,
}

// cmpOps are the comparison operators (two-char forms must be adjacent:
// `a < = b` is a syntax error, not `<=`).
var cmpOps = map[string]bool{"=": true, "!=": true, ">": true, ">=": true, "<": true, "<=": true}

// SourceRef is one entry of the source clause (Name at byte Pos).
type SourceRef struct {
	Name string
	Pos  int
}

// Spec is a parsed expression: the source clause — one or more sources,
// the FIRST of which is the PRIMARY (it owns groupBy resolution, scope
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
	Op     string // count|sum|avg|min|max|stddev|percentile|ratio (median normalized to percentile)
	Alias  string // optional AS alias (reserved for metric views, unused by preview)
	Where  *condNode
	Col    string // value column (sum/avg/min/max/stddev/percentile)
	ColPos int
	Count  *condNode // count(): condition; nil = count(*)
	P      float64   // percentile fraction (median → 0.5)
	Num    *Agg      // ratio numerator
	Den    *Agg      // ratio denominator
	Pos    int       // byte offset of the op name
}

// operand kinds in conditions.
const (
	opColumn = 'i'
	opLit    = 'l'
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
}

// condition node kinds.
const (
	cTruth = 't' // bare operand, SQLite-truthy
	cCmp   = 'c' // lhs op rhs
	cAnd   = 'a'
	cOr    = 'o'
	cNot   = 'n'
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
	if exprKeywords[t.text] {
		return Agg{}, errf(t.pos, "expected aggregation name, got keyword %q", t.text)
	}
	op := strings.ToLower(t.text)
	if !aggOps[op] {
		return Agg{}, errf(t.pos, "unknown aggregation %q (valid: count, sum, avg, min, max, stddev, percentile, median, ratio)", t.text)
	}
	agg := Agg{Op: op, Pos: t.pos}
	if perr := p.expectPunct("("); perr != nil {
		return Agg{}, perr
	}
	var perr *ParseError
	switch op {
	case "count":
		agg.Count, perr = p.parseCountArgs()
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
		return p.parseColArg(agg)
	case "median":
		agg.Op = "percentile"
		agg.P = 0.5
		return p.parseColArg(agg)
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
		return p.parseColArg(agg)
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

// parseColArg reads the single whitelisted value column.
func (p *parser) parseColArg(agg Agg) (Agg, *ParseError) {
	t, ok := p.next()
	if !ok || t.kind != tIdent {
		return Agg{}, p.errHere("expected a column name")
	}
	if exprKeywords[t.text] {
		return Agg{}, errf(t.pos, "expected a column name, got keyword %q", t.text)
	}
	agg.Col, agg.ColPos = t.text, t.pos
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

func (p *parser) parseOperand() (*operand, *ParseError) {
	t, ok := p.next()
	if !ok {
		return nil, p.errHere("expected a column or literal")
	}
	switch t.kind {
	case tIdent:
		if strings.EqualFold(t.text, "true") {
			return &operand{kind: opLit, isBool: true, bval: true, pos: t.pos}, nil
		}
		if strings.EqualFold(t.text, "false") {
			return &operand{kind: opLit, isBool: true, bval: false, pos: t.pos}, nil
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
