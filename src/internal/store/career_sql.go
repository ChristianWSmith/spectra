package store

import (
	"regexp"
	"strings"
)

// careerHeadSQL is the output contract of a career (profile-grain) metric: one
// row for the subject :steam_id, dim ” (no partition), value. Career metrics
// write their value expression after it. schema.sql holds careerHeadPlaceholder.
const careerHeadSQL = "SELECT :steam_id AS subject_key, '' AS dim, "

// careerHeadPlaceholder marks the career header inside a schema.sql metric expr.
const careerHeadPlaceholder = "{{CAREER_HEAD}}"

// careerHeadSeedText is the header as spliced into a schema.sql literal.
func careerHeadSeedText() string { return strings.ReplaceAll(careerHeadSQL, "'", "''") }

// ratioStoredMacro expands `{{RATIO_STORED:num:den}}` at seed time: the ratio of
// two career sums of stored metrics (num / den, NULL when den is zero), each
// sum guarded as storedSumText defines it.
var ratioStoredMacro = regexp.MustCompile(`\{\{RATIO_STORED:(\w+):(\w+)\}\}`)

// expandRatioMacros applies the ratio macro to a schema.sql text, after the
// sum macro is no longer needed by it: the ratio writes its own sums.
func expandRatioMacros(seed string) string {
	return ratioStoredMacro.ReplaceAllStringFunc(seed, func(m string) string {
		g := ratioStoredMacro.FindStringSubmatch(m)
		return "1.0 * " + storedSumText(g[1]) + " / NULLIF(" + storedSumText(g[2]) + ", 0)"
	})
}
