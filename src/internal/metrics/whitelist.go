package metrics

import "strings"

// This file IS the whitelist: sources, per-source columns curated from
// the store's schema (internal/store/schema.sql), the GroupBy mapping
// table, the Denominator subquery sources, and the JOIN declarations
// (dimensions, uniqueness keys, population — joinKey derives the engine
// ON from them; no user text ever reaches an ON clause). Compile
// validates every identifier an expression mentions against these
// structures — unknown → ExprError{Message,Pos}. Nothing here is derived
// at runtime from user input; the maps are the single place a schema
// change must be mirrored.

// Sources are the grammar's source-clause tables (package doc). One
// source = the base form; a comma list joins them engine-side (design
// (c)) — the first name is the PRIMARY.
var sources = []string{
	"events", "engagements", "rounds", "player_stats", "player_round_stats",
	"round_economy", "clutches", "utility_events", "chat", "match_trade_opps",
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
		"end_tick", "mvp", "mvp_reason", "equip_ct",
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
		"money_samples", "spent", "free_pistol_value",
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
		"id", "match_id", "tick", "round", "steam_id", "name", "text", "kind", "channel",
		"decrypted", "key_source",
	),
	// match_trade_opps is SPARSE and HUMANS-ONLY (analytics.Compute
	// writes no row for a zero-count player and never writes bots —
	// reads treat "no row" as 0, like a missing player_stats row).
	"match_trade_opps": colSet(
		"match_id", "steam_id", "opps", "missed",
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

// mapGroupExpr is the fixed `map` group for every source (all sources
// carry match_id; the correlated subquery is emitted by us — the user
// never writes a table name). The anchor is the source's own name, which
// is also its engine alias when the expression joins (aliases are the
// table names — design (c)), so the subquery stays side-correct by
// construction.
func mapGroupExpr(source string) string {
	return "(SELECT m2.map FROM matches m2 WHERE m2.id = " + source + ".match_id)"
}

// groupColumns maps source → group token → the fixed column expression.
// Anything unmapped is an ExprError (no ambiguous joins — the
// engagements player ambiguity is resolved by fixing engagements.player to
// the A-side actor; victim-side rates use player_round_stats.traded
// instead). The round/player/side entries double as the source's JOIN
// dimensions (sourceDimsOf): the owner ruling defines the player
// dimension as exactly this groupColumns[…]["player"] column.
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
	"match_trade_opps": {
		"player": "steam_id",
		"map":    mapGroupExpr("match_trade_opps"),
	},
}

// denominatorTables whitelists models.MetricRow.Denominator (scalar
// subquery sources). Owner ruling: exactly TWO values survive — rounds
// and matches ("match and one of round … are the only meaningful
// denominators to a CS2 player"); the player_rounds alias was retired
// (player_round_stats remains a metric SOURCE — only the denominator
// option is gone). The criterion separating the two cross-source
// mechanisms lives in doc.go's Denominator section.
var denominatorTables = map[string]string{
	"rounds":  "rounds",
	"matches": "matches",
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
		return "", errf(0, "groupBy %q is not supported for source %s (fixed mapping table)", g, source)
	}
	return col, nil
}

// ---- join declarations (design (c): engine-derived ON, no user text) ----
//
// Every source declares its join properties here, pinned against the real
// DDL by TestJoinKeyDeclarationsMatchSchema (the TestSchemaConsistency
// pattern):
//
//   - dimensions (sourceDimsOf): `match` (every source's match_id) plus
//     `round`/`player`/`side` where the source carries them — the
//     round/player/side columns are exactly the groupColumns mapping;
//   - uniqueness key (sourceUniqueKeys): the PK/UNIQUE column set that
//     identifies one row of that table;
//   - population (sourcePopulation): all-players vs humans-only.
//
// Grain table (from internal/store/schema.sql DDL — row identity /
// dimensions):
//
//	events             (match_id, seq)        match round player(attacker)
//	engagements        (match_id, seq)        match round player(a_steam)
//	rounds             (match_id, number)     match round player(mvp)
//	player_stats       (match_id, steam_id)   match player side
//	player_round_stats (match_id, round, steam_id)  match round player
//	round_economy      (match_id, round, side)      match round side
//	clutches           (match_id, round, steam_id, start_tick)  match round player
//	utility_events     (match_id, seq)        match round player(thrower)
//	chat               (id)                   match round player(steam_id)
//	match_trade_opps   (match_id, steam_id)   match player

// population is the row population a source's rows represent — the
// bot-exclusion dimension of the source list (owner ruling: a
// multi-source expression whose source set MIXES populations applies
// store.HumanOnly to the primary's player column regardless of grouping).
type population int

const (
	// popAllPlayers: rows record what happened — bots included (the
	// event-shaped side of the bot-exclusion rule).
	popAllPlayers population = iota
	// popHumansOnly: bot rows are never stored (analytics.Compute's
	// match_trade_opps is the first member).
	popHumansOnly
)

// sourcePopulation maps every source to its population.
var sourcePopulation = map[string]population{
	"events":             popAllPlayers,
	"engagements":        popAllPlayers,
	"rounds":             popAllPlayers,
	"player_stats":       popAllPlayers,
	"player_round_stats": popAllPlayers,
	"round_economy":      popAllPlayers,
	"clutches":           popAllPlayers,
	"utility_events":     popAllPlayers,
	"chat":               popAllPlayers,
	"match_trade_opps":   popHumansOnly,
}

// sourceUniqueKeys maps every source to its join-relevant uniqueness key
// (the natural PK/UNIQUE of the table in schema.sql; events' surrogate
// id PK is not join-shaped, so its UNIQUE(match_id, seq) is declared).
// The join criterion and the 1:1 value-column rule read ONLY this table.
var sourceUniqueKeys = map[string][]string{
	"events":             {"match_id", "seq"},
	"engagements":        {"match_id", "seq"},
	"rounds":             {"match_id", "number"},
	"player_stats":       {"match_id", "steam_id"},
	"player_round_stats": {"match_id", "round", "steam_id"},
	"round_economy":      {"match_id", "round", "side"},
	"clutches":           {"match_id", "round", "steam_id", "start_tick"},
	"utility_events":     {"match_id", "seq"},
	"chat":               {"id"},
	"match_trade_opps":   {"match_id", "steam_id"},
}

// sourceDimsOf returns the join dimensions a source carries: `match`
// (every source's match_id) plus round/player/side — derived from the
// groupColumns mapping so the two can never drift (the owner ruling
// defines the player dimension as the source's groupColumns[…]["player"]
// column; the side dimension is the side column behind both the `side`
// and `team` tokens).
func sourceDimsOf(src string) map[string]string {
	d := make(map[string]string, 4)
	if sourceColumns[src]["match_id"] {
		d["match"] = "match_id"
	}
	for _, dim := range []string{"round", "player", "side"} {
		if col := groupColumns[src][dim]; col != "" {
			d[dim] = col
		}
	}
	return d
}

// joinDim is one equated dimension of an engine-derived ON.
type joinDim struct {
	Dim          string // match | round | player | side
	PrimaryCol   string // the primary's column for the dimension
	SecondaryCol string // the secondary's column for the dimension
}

// joinKey derives the ON for primary → secondary. Criterion (the
// principle, not a pairwise whitelist): the key is the secondary's
// declared uniqueness key, accepted only when EVERY column of it is a
// dimension both sides carry — i.e. the finest shared dimension set on
// which the secondary is unique AS ITS GRAIN. Rejecting anything else is
// the mechanical fan-out guard: a secondary that is not unique on the
// key would multiply primary rows and silently inflate count()/sum()/N.
//
// A looser "superkey" reading (any shared set the key is a subset of)
// would drag non-grain dimensions into the ON — rounds.mvp under
// (engagements, rounds) — and silently match nothing; the worked pair
// (engagements, rounds) → (match_id, round) is exactly what the grain
// reading yields. Returns ok=false when the secondary has no such key.
func joinKey(primary, secondary string) ([]joinDim, bool) {
	pdims := sourceDimsOf(primary)
	sdims := sourceDimsOf(secondary)
	key := sourceUniqueKeys[secondary]
	out := make([]joinDim, 0, len(key))
	for _, col := range key {
		dim := ""
		for d, c := range sdims {
			if c == col {
				dim = d
				break
			}
		}
		if dim == "" {
			return nil, false // key column is not a join dimension (seq/id/start_tick/…)
		}
		pcol, ok := pdims[dim]
		if !ok {
			return nil, false // primary does not carry the dimension
		}
		out = append(out, joinDim{Dim: dim, PrimaryCol: pcol, SecondaryCol: col})
	}
	return out, true
}

// joinIsOneToOne reports whether the PRIMARY is also unique on the
// derived key (the secondary is unique by construction). 1:1 is what
// admits secondary VALUE columns — under n:1 a coarse secondary value
// would repeat at a finer grain (e.g. summing rounds.duration_s over an
// n:1 join). Mechanically decidable; enforced at compile with a
// positioned error.
func joinIsOneToOne(primary string, key []joinDim) bool {
	keyCols := make(map[string]bool, len(key))
	for _, d := range key {
		keyCols[d.PrimaryCol] = true
	}
	for _, col := range sourceUniqueKeys[primary] {
		if !keyCols[col] {
			return false
		}
	}
	return true
}

// mixedPopulations reports whether the source list spans BOTH
// populations (owner ruling: such an expression aligns populations via
// the primary's player column regardless of grouping; a list whose
// sources all share one population keeps the single-source rule).
func mixedPopulations(srcs []SourceRef) bool {
	if len(srcs) < 2 {
		return false
	}
	first := sourcePopulation[srcs[0].Name]
	for _, s := range srcs[1:] {
		if sourcePopulation[s.Name] != first {
			return true
		}
	}
	return false
}
