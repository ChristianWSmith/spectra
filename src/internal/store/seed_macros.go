package store

import "regexp"

// Parameterised seed macros for builtin metric exprs. Each expands at seed time
// (applySchema, after the plain fragments) into the exact text it replaces, so a
// stored expr is the complete formula. They are for builtin seeds only; user
// metric SQL has no macros.

// sideJoinMacro expands `{{SIDE_JOIN:alias:src:col}}`: the player-side join of
// a round_player_sides row for the player named by src.col, in the round and
// match of src. alias names the joined row.
var sideJoinMacro = regexp.MustCompile(`\{\{SIDE_JOIN:(\w+):(\w+):(\w+)\}\}`)

// existsStoredMacro expands `{{EXISTS_STORED:name}}`: the career guard that a
// stored metric has at least one row for the subject.
var existsStoredMacro = regexp.MustCompile(`\{\{EXISTS_STORED:(\w+)\}\}`)

// expandSideJoinMacros applies the side-join and exists-guard macros.
func expandSideJoinMacros(seed string) string {
	seed = sideJoinMacro.ReplaceAllStringFunc(seed, func(m string) string {
		g := sideJoinMacro.FindStringSubmatch(m)
		a, src, col := g[1], g[2], g[3]
		return "LEFT JOIN round_player_sides " + a + " ON " + a + ".match_id = " + src + ".match_id AND " +
			a + ".round = " + src + ".round AND " + a + ".steam_id = " + src + "." + col
	})
	return existsStoredMacro.ReplaceAllStringFunc(seed, func(m string) string {
		return "WHERE EXISTS (SELECT 1 FROM metric(''" + existsStoredMacro.FindStringSubmatch(m)[1] + "''))"
	})
}
