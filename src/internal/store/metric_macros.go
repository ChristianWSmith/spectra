package store

import (
	"fmt"
	"regexp"
	"strings"
)

// unexpandedMacro finds a macro the expander did not recognise.
var unexpandedMacro = regexp.MustCompile(`\{\{[^}]*\}\}`)

// ExpandMetricMacros turns a statement's macro form (what the editor shows) into its expanded
// form (the plain SQL that runs). Every macro the builtin seeds use is available to a user
// statement: the fragments ({{KILLS_CTE}} and the rest) and the parameterised ones
// ({{SIDE_JOIN:…}}, {{SUM_STORED:…}}, {{EXISTS_STORED:…}}, …). The seed expanders write their output
// for a single-quoted seed literal, so the text is quoted the same way before they run and unquoted
// after: each macro's output comes out as plain SQL, and the statement's own quotes come back as typed.
// A {{…}} the expander does not know is an error, never left in the text.
func ExpandMetricMacros(expr string) (string, error) {
	quoted := strings.ReplaceAll(expr, "'", "''")
	out := expandSeedMacros(spliceFragments(quoted))
	out = strings.ReplaceAll(out, "''", "'")
	if m := unexpandedMacro.FindString(out); m != "" {
		return "", fmt.Errorf("unknown macro %s", m)
	}
	return out, nil
}
