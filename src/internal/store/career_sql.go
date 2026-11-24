package store

import (
	"regexp"
)

// careerHeadSQL is the output contract of a career (profile-grain) metric: one
// row for the subject :steam_id, dim ” (no partition), value. Career metrics
// write their value expression after it. schema.sql holds careerHeadPlaceholder.
const careerHeadSQL = "SELECT :steam_id AS subject_key, '' AS dim, "

// careerHeadPlaceholder marks the career header inside a schema.sql metric expr.
const careerHeadPlaceholder = "{{CAREER_HEAD}}"

// ratioStoredMacro expands `{{RATIO_STORED:num:den}}` at seed time: the ratio of
// two career sums of stored metrics (num / den, NULL when den is zero), each
// sum guarded as storedSumText defines it.
var ratioStoredMacro = regexp.MustCompile(`\{\{RATIO_STORED:(\w+):(\w+)\}\}`)

// expandRatioMacros applies the ratio macro to a schema.sql text. It runs first
// in seedMacroPasses, and writes its own guarded sums, so it needs no other pass.
func expandRatioMacros(seed string) string {
	return expandMacro(seed, ratioStoredMacro, func(g []string) string {
		return ratioExpr(storedSumText(g[1]), storedSumText(g[2]))
	})
}
