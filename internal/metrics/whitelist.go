package metrics

import "strings"

// This file IS the whitelist (frozen v1): sources, per-source columns
// curated from the store's schema (internal/store/schema.sql), the
// GroupBy mapping table, and the Denominator subquery sources. Compile
// validates every identifier an expression mentions against these
// structures — unknown → ExprError{Message,Pos}. Nothing here is derived
// at runtime from user input; the maps are the single place a schema
// change must be mirrored.

// Sources are the v1 single-source tables (package doc).
var sources = []string{
	"events", "engagements", "rounds", "player_stats", "player_round_stats",
	"round_economy", "clutches", "utility_events", "chat", "voice_chunks",
}

// sourceColumns is the per-source column whitelist. JSON/blob payload
// columns are deliberately excluded (events.detail_json, events.raw_json,
// utility_events.affected, utility_events.trajectory_ref,
// clutches.kill_ticks, player_stats.kills_by_weapon,
// player_stats.damage_by_weapon); chat.text stays in for exact-match
// filters.
var sourceColumns = map[string]map[string]bool{
	"events": colSet(
		"match_id", "seq", "tick", "round", "kind", "attacker", "victim",
		"assister", "weapon", "headshot", "wallbang", "noscope",
		"through_smoke", "attacker_blind", "assisted_flash", "distance",
		"hitgroup", "dmg", "site", "pos_x", "pos_y", "pos_z",
	),
	"engagements": colSet(
		"match_id", "seq", "tick", "round", "kind", "a_steam", "a_name",
		"b_steam", "b_name", "distance", "won_by",
	),
	"rounds": colSet(
		"match_id", "number", "winner", "reason", "duration_s", "start_tick",
		"end_tick", "warmup", "pregame", "mvp", "mvp_reason", "equip_ct",
		"equip_t", "bomb_site", "freeze_end_tick", "first_kill_steam",
		"first_death_steam",
	),
	"player_stats": colSet(
		"match_id", "steam_id", "side", "name", "kills", "deaths", "assists",
		"flash_assists", "headshots", "teamkills", "suicides", "mvps", "score",
		"total_damage", "damage_taken", "shots", "hits", "adr", "hs_pct",
		"rounds_played", "entry_kills", "entry_deaths", "opening_kills",
		"opening_deaths", "trade_kills", "best_streak", "two_k", "three_k",
		"four_k", "five_k", "utility_damage", "enemies_flashed", "flashed_times",
		"bomb_plants", "bomb_defuses", "money_spent_total",
	),
	"player_round_stats": colSet(
		"match_id", "round", "steam_id", "name", "kills", "assists", "deaths",
		"traded", "survived", "kast", "dmg", "util_dmg", "money_start",
		"equip", "spent", "rule_version",
	),
	"round_economy": colSet(
		"match_id", "round", "side", "equip_value", "money_sampled_sum",
		"money_samples", "spent",
	),
	"clutches": colSet(
		"match_id", "round", "size", "steam_id", "name", "start_tick",
		"end_tick", "bomb_state", "hp_left", "equip", "won", "replay_anchor",
	),
	"utility_events": colSet(
		"match_id", "seq", "tick", "round", "thrower", "thrower_name", "kind",
		"det_x", "det_y", "damage", "flash_ms", "site",
	),
	"chat": colSet(
		"id", "match_id", "tick", "round", "steam_id", "name", "text", "kind",
		"decrypted", "key_source",
	),
	"voice_chunks": colSet(
		"match_id", "seq", "steam_id", "tick", "round", "byte_off", "len",
		"caster", "section",
	),
}

func colSet(cols ...string) map[string]bool {
	m := make(map[string]bool, len(cols))
	for _, c := range cols {
		m[c] = true
	}
	return m
}

// groupTokens are the valid GroupBy values of a metric definition
// (models.MetricRow.GroupBy — frozen contract comment:
// ""|player|round|team|weapon|side|map|none).
var groupTokens = map[string]bool{
	"player": true, "round": true, "team": true, "weapon": true,
	"side": true, "map": true, "none": true,
}

// mapGroupExpr is the fixed `map` group for every source (all ten carry
// match_id; the correlated subquery is emitted by us — the user never
// writes a table name).
func mapGroupExpr(source string) string {
	return "(SELECT m2.map FROM matches m2 WHERE m2.id = " + source + ".match_id)"
}

// groupColumns maps source → group token → the fixed column expression.
// Anything unmapped is an ExprError (no ambiguous joins in v1 — the
// engagements player ambiguity is resolved by fixing engagements.player to
// the A-side actor; victim-side rates use player_round_stats.traded
// instead).
var groupColumns = map[string]map[string]string{
	"events": {
		"player": "attacker", "round": "round", "weapon": "weapon",
		"map": mapGroupExpr("events"),
	},
	"engagements": {
		"player": "a_steam", "round": "round",
		"map": mapGroupExpr("engagements"),
	},
	"rounds": {
		"player": "mvp", "round": "number",
		"map": mapGroupExpr("rounds"),
	},
	"player_stats": {
		"player": "steam_id", "team": "side", "side": "side",
		"map": mapGroupExpr("player_stats"),
	},
	"player_round_stats": {
		"player": "steam_id", "round": "round",
		"map": mapGroupExpr("player_round_stats"),
	},
	"round_economy": {
		"round": "round", "team": "side", "side": "side",
		"map": mapGroupExpr("round_economy"),
	},
	"clutches": {
		"player": "steam_id", "round": "round",
		"map": mapGroupExpr("clutches"),
	},
	"utility_events": {
		"player": "thrower", "round": "round",
		"map": mapGroupExpr("utility_events"),
	},
	"chat": {
		"player": "steam_id", "round": "round",
		"map": mapGroupExpr("chat"),
	},
	"voice_chunks": {
		"player": "steam_id", "round": "round",
		"map": mapGroupExpr("voice_chunks"),
	},
}

// denominatorTables whitelists models.MetricRow.Denominator (scalar
// subquery sources; player_rounds is the contract's name for
// player_round_stats).
var denominatorTables = map[string]string{
	"rounds":        "rounds",
	"matches":       "matches",
	"player_rounds": "player_round_stats",
}

// knownSource reports whether expr's source clause names a v1 source.
func knownSource(name string) bool {
	_, ok := sourceColumns[name]
	return ok
}

// knownSourcesMsg renders the source list for error messages.
func knownSourcesMsg() string { return strings.Join(sources, ", ") }

// groupExpr resolves groupBy against source. Returns "" for no grouping
// (""/none); an ExprError for unknown tokens, unmapped combinations and
// (in Compile) percentile-with-group violations.
func groupExpr(source, groupBy string) (string, *ParseError) {
	g := strings.ToLower(strings.TrimSpace(groupBy))
	if g == "" || g == "none" {
		return "", nil
	}
	if !groupTokens[g] {
		return "", errf(0, "unknown groupBy %q (valid: player, round, team, weapon, side, map, none)", groupBy)
	}
	m := groupColumns[source]
	col, ok := m[g]
	if !ok {
		return "", errf(0, "groupBy %q is not supported for source %s in v1 (fixed mapping table — see metrics package doc)", g, source)
	}
	return col, nil
}
