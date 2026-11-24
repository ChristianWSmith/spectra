package store

import (
	"regexp"
	"strings"
)

// playerStatsColsSQL is the column preamble every per-player fold wrapper
// projects from player_stats (`SELECT ps.match_id … ps.map,`). The wrapper's
// fold columns (`COALESCE(f.X, 0) AS X`) follow it in each metric. schema.sql
// holds playerStatsColsPlaceholder for it; applySchema splices this text in.
const playerStatsColsSQL = "SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map,"

// playerStatsColsPlaceholder marks the preamble inside a schema.sql metric expr.
const playerStatsColsPlaceholder = "{{PLAYER_STATS_COLS}}"

// playerStatsColsSeedText is the preamble as spliced into a schema.sql literal.
func playerStatsColsSeedText() string { return playerStatsColsSQL }

// playerStatsHumansSQL closes the per-player fold wrapper: the match's
// player_stats rows, humans only (the same bot predicate as HumanOnlyBySteamID),
// read back under the alias player_stats. Every fold wrapper ends with it.
const playerStatsHumansSQL = "WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '' AND NOT is_bot_key(player_stats.steam_id))"

// playerStatsHumansPlaceholder marks the humans-only tail inside a schema.sql expr.
const playerStatsHumansPlaceholder = "{{PLAYER_STATS_HUMANS}}"

// playerStatsHumansSeedText is the tail as spliced into a schema.sql literal.
func playerStatsHumansSeedText() string { return strings.ReplaceAll(playerStatsHumansSQL, "'", "''") }

// storedSumMacro expands `{{SUM_STORED:name}}` at seed time: a career sum of
// one stored metric that is NULL when any matched row is NULL (the career
// rule: a missing per-match value makes the career total no-data, never a
// partial sum). It is the expansion behind the career metrics' guarded sums.
var storedSumMacro = regexp.MustCompile(`\{\{SUM_STORED:(\w+)\}\}`)

// expandSeedMacros applies the parameterised seed macros to a schema.sql text.
// The text it writes is already SQL-literal-escaped (it lives inside a '…' seed
// literal), so it is applied after the plain fragments are spliced.
func expandSeedMacros(seed string) string {
	seed = expandRatioMacros(seed)
	seed = expandSideJoinMacros(seed)
	return storedSumMacro.ReplaceAllStringFunc(seed, func(m string) string {
		return storedSumText(storedSumMacro.FindStringSubmatch(m)[1])
	})
}

// storedSumText is the guarded career sum of one stored metric, as a seed literal.
func storedSumText(name string) string {
	return "(SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric(''" + name + "''))"
}

// playerFoldJoinSQL is the join condition every per-player fold wrapper uses to
// attach its fold row f to the player's player_stats row ps.
const playerFoldJoinSQL = "f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id"

// playerFoldJoinPlaceholder marks the fold join condition inside a schema.sql expr.
const playerFoldJoinPlaceholder = "{{PLAYER_FOLD_JOIN}}"

// playerFoldJoinSeedText is the join condition as spliced into a schema.sql literal.
func playerFoldJoinSeedText() string { return playerFoldJoinSQL }
