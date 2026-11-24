package store

// playerStatsColsSQL is the column preamble every per-player fold wrapper
// projects from player_stats (`SELECT ps.match_id … ps.map,`). The wrapper's
// fold columns (`COALESCE(f.X, 0) AS X`) follow it in each metric. schema.sql
// holds playerStatsColsPlaceholder for it; applySchema splices this text in.
const playerStatsColsSQL = "SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map,"

// playerStatsColsPlaceholder marks the preamble inside a schema.sql metric expr.
const playerStatsColsPlaceholder = "{{PLAYER_STATS_COLS}}"

// playerStatsHumansSQL closes the per-player fold wrapper: the match's
// player_stats rows, humans only (the same bot predicate as HumanOnlyBySteamID),
// read back under the alias player_stats. Every fold wrapper ends with it.
const playerStatsHumansSQL = "WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND ({{HUMAN:steam_id:player_stats.steam_id}})"

// playerStatsHumansPlaceholder marks the humans-only tail inside a schema.sql expr.
const playerStatsHumansPlaceholder = "{{PLAYER_STATS_HUMANS}}"

// storedSumText is the guarded career sum of one stored metric, as a seed literal.
func storedSumText(name string) string {
	return "(SELECT " + guardedSumSQL + " FROM " + metricSeedRef(name) + ")"
}

// playerFoldJoinSQL is the join condition every per-player fold wrapper uses to
// attach its fold row f to the player's player_stats row ps.
const playerFoldJoinSQL = "f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id"

// playerFoldJoinPlaceholder marks the fold join condition inside a schema.sql expr.
const playerFoldJoinPlaceholder = "{{PLAYER_FOLD_JOIN}}"

// guardedSumSQL is the career no-data guard over a metric's rows: the sum, or NULL
// when any matched row is NULL (a missing per-match value makes the total no-data).
const guardedSumSQL = "CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END"

// playerRoundColsSQL is the column preamble of a per-round fold over
// player_round_stats (the prs alias): the round's identity and the per-round
// stats a fold wrapper reads back. The fold column follows it in each metric.
const playerRoundColsSQL = "SELECT prs.match_id, prs.round, prs.steam_id, prs.name, prs.traded, prs.kast, prs.money_start, prs.equip, prs.spent, prs.rule_version, prs.side,"

// playerRoundColsPlaceholder marks the preamble inside a schema.sql metric expr.
const playerRoundColsPlaceholder = "{{PLAYER_ROUND_COLS}}"

// playerRoundFoldJoinSQL is the join condition of a per-round fold wrapper: its fold
// row f attaches to the player's round row prs.
const playerRoundFoldJoinSQL = "f ON f.match_id = prs.match_id AND f.round = prs.round AND f.steam_id = prs.steam_id"

// playerRoundFoldJoinPlaceholder marks the per-round fold join inside a schema.sql expr.
const playerRoundFoldJoinPlaceholder = "{{PLAYER_ROUND_FOLD_JOIN}}"

// playerRoundRosterJoinSQL joins the round row prs to its player's roster row, for
// the humans of the match (is_bot = 0).
const playerRoundRosterJoinSQL = "JOIN players p ON p.match_id = prs.match_id AND p.steam_id = prs.steam_id AND p.is_bot = 0"

// playerRoundRosterJoinPlaceholder marks the round roster join inside a schema.sql expr.
const playerRoundRosterJoinPlaceholder = "{{PLAYER_ROUND_ROSTER_JOIN}}"

// sideDomainSQL is the two sides as a CTE (sd), for a statement that reports a value
// for each side. schema.sql holds sideDomainPlaceholder where it goes.
const sideDomainSQL = "sd AS (SELECT 'ct' AS side UNION ALL SELECT 't')"

// sideDomainPlaceholder marks the side-domain CTE inside a schema.sql metric expr.
const sideDomainPlaceholder = "{{SIDE_DOMAIN}}"
