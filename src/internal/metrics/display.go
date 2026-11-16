package metrics

import (
	"math"
	"strconv"
	"strings"
)

// Display-side rendering of a compiled plan. The executed statement NEVER
// changes: plans run through plan.SQL + plan.Args (RunPreview, the compute
// pass), and compile.go keeps emitting binds. What lives here is only what
// the Builder's provenance view shows the user, so the text they copy
// actually runs — a statement with `match_id = 4567` written in, not
// `match_id = ?`.

// InlineArgs writes a statement's positional values in as SQL literals —
// DISPLAY ONLY, never execution (see the file doc).
//
// Markers are replaced in order by the args. A marker with no value left
// (a companion statement appended after the primary — Plan.Secondary's
// binds are deliberately not carried on the plan) is copied through as
// `?`: honestly uninlined rather than filled with a neighbour's value.
// A value with no marker left means the two sides disagree, so the
// original statement comes back unchanged — never a half-rendered one.
// The same applies to a value of a type SQL has no faithful literal for.
//
// String literals, quoted identifiers and comments are copied verbatim,
// so a `?` inside them is never mistaken for a marker.
func InlineArgs(sql string, args []any) string {
	if len(args) == 0 || !strings.Contains(sql, "?") {
		return sql
	}
	var b strings.Builder
	b.Grow(len(sql) + 16*len(args))
	ai, i := 0, 0
	for i < len(sql) {
		c := sql[i]
		switch {
		case c == '\'' || c == '"': // string literal / quoted identifier
			j := i + 1
			for j < len(sql) {
				if sql[j] == c {
					if j+1 < len(sql) && sql[j+1] == c { // doubled quote escape
						j += 2
						continue
					}
					break
				}
				j++
			}
			if j >= len(sql) { // unterminated: the tail is text, not markers
				b.WriteString(sql[i:])
				return b.String()
			}
			b.WriteString(sql[i : j+1])
			i = j + 1
		case c == '-' && i+1 < len(sql) && sql[i+1] == '-':
			n := strings.IndexByte(sql[i:], '\n')
			if n < 0 {
				b.WriteString(sql[i:])
				return b.String()
			}
			b.WriteString(sql[i : i+n])
			i += n
		case c == '/' && i+1 < len(sql) && sql[i+1] == '*':
			n := strings.Index(sql[i+2:], "*/")
			if n < 0 {
				b.WriteString(sql[i:])
				return b.String()
			}
			end := i + 2 + n + 2
			b.WriteString(sql[i:end])
			i = end
		case c == '?':
			if ai >= len(args) { // values exhausted: the rest stays verbatim
				b.WriteString(sql[i:])
				return b.String()
			}
			lit, ok := sqlLiteral(args[ai])
			if !ok {
				return sql // no faithful literal → keep the marker
			}
			b.WriteString(lit)
			ai++
			i++
		default:
			b.WriteByte(c)
			i++
		}
	}
	if ai != len(args) {
		return sql // fewer markers than values → the original, unchanged
	}
	return b.String()
}

// sqlLiteral renders one bound value the way SQLite reads it back:
// integers bare, floats bare (exact integers without an exponent), text
// single-quoted with ” escapes, NULL for nil, 0/1 for booleans. false =
// this type has no faithful literal (NaN/Inf, an unknown type) — the
// caller keeps the placeholder rather than printing something the engine
// would not read as the same value.
func sqlLiteral(v any) (string, bool) {
	switch t := v.(type) {
	case nil:
		return "NULL", true
	case string:
		return "'" + strings.ReplaceAll(t, "'", "''") + "'", true
	case int:
		return strconv.Itoa(t), true
	case int64:
		return strconv.FormatInt(t, 10), true
	case float64:
		if math.IsNaN(t) || math.IsInf(t, 0) {
			return "", false
		}
		if t == math.Trunc(t) && math.Abs(t) < 1e15 {
			return strconv.FormatInt(int64(t), 10), true
		}
		return strconv.FormatFloat(t, 'g', -1, 64), true
	case bool:
		if t {
			return "1", true
		}
		return "0", true
	}
	return "", false
}

// DisplaySQL is the provenance text the Builder shows beside a preview:
// the primary statement with its values written in, then the companion
// statement appended RAW — its binds are not carried on the plan
// (Plan.Secondary), so its markers stay `?`. The preview path renders
// the same bytes through Preview.DisplaySQL (pinned by
// TestCompileMetricIsNoExecution, which compares the two).
func (p Plan) DisplaySQL() string {
	sql := InlineArgs(p.SQL, p.Args)
	if p.Secondary != "" {
		sql += "\n" + p.Secondary
	}
	return sql
}

// DisplaySQL is Plan.DisplaySQL over the preview's own copy: RunPreview
// already appended the companion to p.SQL, so InlineArgs walks the
// primary's markers first and leaves the companion's untouched — the
// same bytes Plan.DisplaySQL produces for the same plan.
func (p Preview) DisplaySQL() string {
	return InlineArgs(p.SQL, p.Args)
}
