package store

import (
	"regexp"
	"strings"
)

// Parameterised seed macros for metric statements. Each expands into the exact text it
// replaces: at seed time for builtins (applySchema, after the plain fragments), and at every
// save for user statements (ExpandMetricMacros, metric_macros.go). The stored run form is
// therefore always the complete formula.

// sideJoinMacro expands `{{SIDE_JOIN:alias:src:col}}`: the player-side join of
// a round_player_sides row for the player named by src.col, in the round and
// match of src. alias names the joined row.
var sideJoinMacro = regexp.MustCompile(`\{\{SIDE_JOIN:(\w+):(\w+):(\w+)\}\}`)

// existsStoredMacro expands `{{EXISTS_STORED:name}}`: the career guard that a
// stored metric has at least one row for the subject.
var existsStoredMacro = regexp.MustCompile(`\{\{EXISTS_STORED:(\w+)\}\}`)

// expandSideJoinMacros applies the side-join and exists-guard macros.
func expandSideJoinMacros(seed string) string {
	seed = expandMacro(seed, sideJoinMacro, func(g []string) string {
		a, src, col := g[1], g[2], g[3]
		return "LEFT JOIN round_player_sides " + a + " ON " + a + ".match_id = " + src + ".match_id AND " +
			a + ".round = " + src + ".round AND " + a + ".steam_id = " + src + "." + col
	})
	return expandMacro(seed, existsStoredMacro, func(g []string) string {
		return "WHERE EXISTS (SELECT 1 FROM " + metricSeedRef(g[1]) + ")"
	})
}

// The parameterised macros, by the pass that expands them (see seedMacroPasses).
// Each is documented where it is defined; this is the catalogue.
//
//	expandRatioMacros (career_sql.go)
//	  {{RATIO_STORED:num:den}}     career ratio of two stored metrics' guarded sums
//	expandSideJoinMacros (this file)
//	  {{SIDE_JOIN:alias:src:col}}  the round_player_sides join for src.col
//	  {{EXISTS_STORED:name}}       career guard: the stored metric has a row
//	expandRowMacros (this file)
//	  {{DIM_SUM:name}}             per-dim sum of a stored metric (career grain)
//	  {{DIM_RATIO:num:den}}        per-dim ratio of two such sums (NULL on zero)
//	  {{ROUND_LABEL_COUNT:x}}      per-player count of counted rounds labelled x
//	  {{SIDE_CLASS_COUNT:x}}       per-player count of side rounds classed x
//	  {{FAKE_KILL}}                the fake-kill flag of a kill row
//	  {{TOP_PER_MATCH:col}}        head of a match's top subject ranked by col
//	  {{TOP_PER_MATCH_CLOSE}}      tail of that top-per-match statement
//	  {{LIVE_EVENT:alias:kind}}    a live (non-post-match) event of one kind
//	  {{FOLD_PIVOT:x}}             per-player pivot of one fold column
//	  {{ROUND_FOLD_PIVOT:x}}       per-round pivot of one fold column
//	  {{SUBJECT_RATIO:num:den}}    per-subject ratio of two stored metrics
//	  {{MATCH_ROUNDS:alias}}       the rounds count of a match alias
//	  {{CLUTCH_STAT:agg}}          a clutch aggregate, humans only
//	  {{ROLLUP_HUMAN_CLOSE:col}}   rollup close with a humans-only guard on col
//	  {{HUMAN:col[:key]}}          humans-only guard of a steam id column
//	expandStoredSumMacros (this file)
//	  {{SUM_STORED:name}}          career guarded sum of one stored metric
//	strings.ReplaceAll (expandRowMacros)
//	  {{TEAM_FREE}}                the not-a-team-kill rule
var (
	dimSumMacro       = regexp.MustCompile(`\{\{DIM_SUM:(\w+)\}\}`)
	dimRatioMacro     = regexp.MustCompile(`\{\{DIM_RATIO:(\w+):(\w+)\}\}`)
	roundLabelMacro   = regexp.MustCompile(`\{\{ROUND_LABEL_COUNT:(\w+)\}\}`)
	sideClassMacro    = regexp.MustCompile(`\{\{SIDE_CLASS_COUNT:(\w+)\}\}`)
	humanGuardMacro   = regexp.MustCompile(`\{\{HUMAN:([\w.]+)(?::([\w.]+))?\}\}`)
	clutchStatMacro   = regexp.MustCompile(`\{\{CLUTCH_STAT:([^{}]+)\}\}`)
	matchRoundsMacro  = regexp.MustCompile(`\{\{MATCH_ROUNDS:(\w+)\}\}`)
	subjectRatioMacro = regexp.MustCompile(`\{\{SUBJECT_RATIO:(\w+):(\w+)\}\}`)
	rollupHumanClose  = regexp.MustCompile(`\{\{ROLLUP_HUMAN_CLOSE:([\w.:]+)\}\}`)
	liveEventMacro    = regexp.MustCompile(`\{\{LIVE_EVENT:(\w+):(\w+)\}\}`)
	fakeKillMacro     = regexp.MustCompile(`\{\{FAKE_KILL\}\}`)
	topPerMatchMacro  = regexp.MustCompile(`\{\{TOP_PER_MATCH:(\w+)\}\}`)
	topPerMatchClose  = regexp.MustCompile(`\{\{TOP_PER_MATCH_CLOSE\}\}`)
	foldPivotMacro    = regexp.MustCompile(`\{\{FOLD_PIVOT:(\w+)\}\}`)
	roundFoldPivot    = regexp.MustCompile(`\{\{ROUND_FOLD_PIVOT:(\w+)\}\}`)
)

// roundLabelTemplate is the per-player count of counted rounds with one label
// (round_classifications.label), in the rollup. ”LABEL” is the label's value.
const roundLabelTemplate = "{{ROLLUP_OPEN}}player_round_stats.match_id AS mid, player_round_stats.steam_id AS grp, SUM(CASE WHEN (round_classifications.label = ''LABEL'') THEN 1 ELSE 0 END) AS v FROM player_round_stats LEFT JOIN round_classifications ON player_round_stats.match_id = round_classifications.match_id AND player_round_stats.round = round_classifications.round WHERE player_round_stats.match_id = :match_id AND ({{HUMAN:player_round_stats.steam_id}}) {{ROLLUP_CLOSE}}"

// sideClassTemplate is the per-player count of side rounds with one class
// (round_side_classes.class), in the rollup. ”LABEL” is the class's value.
const sideClassTemplate = "{{ROLLUP_OPEN}}round_player_sides.match_id AS mid, round_player_sides.steam_id AS grp, SUM(CASE WHEN (round_side_classes.class = ''LABEL'') THEN 1 ELSE 0 END) AS v FROM round_player_sides LEFT JOIN round_side_classes ON round_player_sides.match_id = round_side_classes.match_id AND round_player_sides.round = round_side_classes.round AND round_player_sides.side = round_side_classes.side WHERE round_player_sides.match_id = :match_id AND ({{HUMAN:round_player_sides.steam_id}}) {{ROLLUP_CLOSE}}"

// expandCountTemplate fills a count template for one value. The template is
// seed text already, so the value is written as an escaped literal.
func expandCountTemplate(tmpl, value string) string {
	t := strings.ReplaceAll(tmpl, "''LABEL''", "''"+value+"''")
	return spliceFragments(t)
}

// teamFreeText is the counted-kill and counted-damage rule that a kill or damage
// row is not a team kill (the attacker and victim are not on the same side).
const teamFreeText = "NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)"

// expandRowMacros applies the dim, count and human-guard macros to a seed text.
func expandRowMacros(seed string) string {
	seed = strings.ReplaceAll(seed, "{{TEAM_FREE}}", teamFreeText)
	seed = expandMacro(seed, dimSumMacro, func(g []string) string {
		return dimSumText(g[1])
	})
	seed = expandMacro(seed, dimRatioMacro, func(g []string) string {
		return dimRatioText(g[1], g[2])
	})
	seed = expandMacro(seed, roundLabelMacro, func(g []string) string {
		return expandCountTemplate(roundLabelTemplate, g[1])
	})
	seed = expandMacro(seed, sideClassMacro, func(g []string) string {
		return expandCountTemplate(sideClassTemplate, g[1])
	})
	seed = expandMacro(seed, fakeKillMacro, func(g []string) string {
		return "(e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake"
	})
	seed = expandMacro(seed, topPerMatchMacro, func(g []string) string {
		return "SELECT '''' AS subject_key, '''' AS dim, v AS value, idkey AS idkey FROM (SELECT mid, grp, idkey, v FROM (SELECT match_id AS mid, match_id AS grp, steam_id AS idkey, " + g[1] + " AS v, ROW_NUMBER() OVER (PARTITION BY match_id ORDER BY " + g[1] + " DESC, steam_id ASC) AS rn FROM ("
	})
	seed = expandMacro(seed, topPerMatchClose, func(g []string) string {
		return ") WHERE rn = 1 ORDER BY mid, grp) WHERE mid = :match_id"
	})
	seed = expandMacro(seed, liveEventMacro, func(g []string) string {
		return g[1] + ".kind = ''" + g[2] + "'' AND " + g[1] + ".post_match = 0"
	})
	seed = expandMacro(seed, foldPivotMacro, func(g []string) string {
		return "SELECT match_id, steam_id, SUM(CASE WHEN f = ''" + g[1] + "'' THEN n END) AS " + g[1] + " FROM fold GROUP BY match_id, steam_id"
	})
	seed = expandMacro(seed, roundFoldPivot, func(g []string) string {
		return "SELECT match_id, round, steam_id, SUM(CASE WHEN f = ''" + g[1] + "'' THEN n END) AS " + g[1] + " FROM fold GROUP BY match_id, round, steam_id"
	})
	seed = expandMacro(seed, subjectRatioMacro, func(g []string) string {
		return "SELECT k.subject_key AS subject_key, '''' AS dim, " + ratioExpr("k.value", "d.value") + " AS value FROM " + metricSeedRef(g[1]) + " k JOIN " + metricSeedRef(g[2]) + " d ON d.subject_key = k.subject_key"
	})
	seed = expandMacro(seed, matchRoundsMacro, func(g []string) string {
		return "(SELECT COUNT(*) FROM rounds r WHERE r.match_id = " + g[1] + ".match_id)"
	})
	seed = expandMacro(seed, clutchStatMacro, func(g []string) string {
		return "SELECT c.steam_id AS subject_key, '''' AS dim, " + g[1] + " AS value FROM clutch c WHERE {{HUMAN:c.steam_id}} GROUP BY c.steam_id"
	})
	seed = expandMacro(seed, rollupHumanClose, func(g []string) string {
		return "AND ({{HUMAN:" + g[1] + "}}) " + rollupCloseSQL
	})
	return expandMacro(seed, humanGuardMacro, func(g []string) string {
		col, key := g[1], g[1]
		if g[2] != "" {
			key = g[2]
		}
		return col + " <> '''' AND NOT is_bot_key(" + key + ")"
	})
}

// dimSumText is the per-dim sum of one stored metric, as a seed literal.
func dimSumText(name string) string {
	return "SELECT :steam_id AS subject_key, dim AS dim, " + guardedSumSQL + " AS value FROM " + metricSeedRef(name) + " GROUP BY dim"
}

// dimRatioText is the per-dim ratio of two stored metrics' sums, as a seed literal.
func dimRatioText(num, den string) string {
	return "SELECT :steam_id AS subject_key, n.dim AS dim, " + ratioExpr("n.s", "d.s") + " AS value FROM (SELECT dim, SUM(value) AS s FROM " + metricSeedRef(num) + " GROUP BY dim) n JOIN (SELECT dim, SUM(value) AS s FROM " + metricSeedRef(den) + " GROUP BY dim) d ON d.dim = n.dim"
}

// expandMacro replaces each match of re in seed with render of its submatches
// (g[0] is the whole match). Every seed macro expands through it.
func expandMacro(seed string, re *regexp.Regexp, render func(g []string) string) string {
	return re.ReplaceAllStringFunc(seed, func(m string) string {
		return render(re.FindStringSubmatch(m))
	})
}

// metricSeedRef is the reference to a stored metric inside a seed literal: a
// metric('name') call, with its quotes doubled.
func metricSeedRef(name string) string {
	return "metric(''" + name + "'')"
}

// storedSumMacro expands `{{SUM_STORED:name}}`: a career sum of one stored metric,
// NULL when any matched row is NULL (see storedSumText).
var storedSumMacro = regexp.MustCompile(`\{\{SUM_STORED:(\w+)\}\}`)

// expandStoredSumMacros applies the stored-sum macro.
func expandStoredSumMacros(seed string) string {
	return expandMacro(seed, storedSumMacro, func(g []string) string {
		return storedSumText(g[1])
	})
}

// seedMacroPasses are the seed-time macro expanders, in order. Each sees the text the
// earlier ones left, so one macro may expand into another's placeholder.
var seedMacroPasses = []func(string) string{
	expandRatioMacros,
	expandSideJoinMacros,
	expandRowMacros,
	expandStoredSumMacros,
}

// expandSeedMacros applies the parameterised seed macros to a schema.sql text, in
// seedMacroPasses order. The text they write is already SQL-literal-escaped (it lives
// inside a '…' seed literal), so it is applied after the plain fragments are spliced.
func expandSeedMacros(seed string) string {
	for _, pass := range seedMacroPasses {
		seed = pass(seed)
	}
	return seed
}

// ratioExpr is the ratio of two SQL values, NULL when the denominator is zero.
func ratioExpr(num, den string) string {
	return "1.0 * " + num + " / NULLIF(" + den + ", 0)"
}
