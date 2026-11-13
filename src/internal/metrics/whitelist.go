package metrics

import "strings"

// This file IS the whitelist: sources, per-source columns curated from
// the store's schema (internal/store/schema.sql), the subject (player
// anchor) mapping, the fixed join dimensions, the Denominator subquery
// sources, and the JOIN declarations (dimensions, uniqueness keys,
// population — joinKey derives the engine ON from them; no user text
// ever reaches an ON clause). Compile validates every identifier an
// expression mentions against these structures — unknown →
// ExprError{Message,Pos}. Nothing here is derived at runtime from user
// input; the maps are the single place a schema change must be
// mirrored.

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

// sourceSubject maps every PLAYER-ANCHORED source to its subject column:
// the column that answers "which player is this row about". It is THE
// player dimension of the join declarations (sourceDimsOf), the column
// every statement groups by, and the anchor Compile validates the
// primary against (design §3 player-relativity — criterion: the
// expression's output must be player-addressed, so the PRIMARY's player
// mapping must be a SUBJECT column; primary-owns, like scope binding
// and the population anchor). A source ABSENT from this map has no
// subject — rounds (mvp is an attribute of a won round) and
// round_economy (side-grained) — so it can never be a primary; it may
// still join an anchored primary wherever joinKey allows (the rule
// partitions by what the OUTPUT is, not by a source whitelist).
var sourceSubject = map[string]string{
	"events":             "attacker", // the acting player of the event
	"engagements":        "a_steam",  // the A-side actor (every kind)
	"utility_events":     "thrower",
	"player_stats":       "steam_id",
	"player_round_stats": "steam_id",
	"clutches":           "steam_id",
	"chat":               "steam_id",
	"match_trade_opps":   "steam_id",
}

// playerSources is the anchored-source list the anchor error renders
// VERBATIM (the design's order — deliberately not the `sources` order).
// Its set is pinned to sourceSubject's keys by TestSchemaConsistency
// (schema_consistency_test.go), so the two cannot drift.
const playerSources = "events, engagements, player_stats, player_round_stats, clutches, chat, utility_events, match_trade_opps"

// sourceDims maps source → join dimension → the fixed column that
// carries it (round and side only — `match` is every source's match_id
// and `player` is the subject column sourceSubject declares; both are
// derived in sourceDimsOf). Anything unmapped is not a dimension of that
// source (no ambiguous joins: the engagements player ambiguity is
// resolved by fixing its player dimension to the A-side actor through
// sourceSubject; victim-side rates use player_round_stats.traded
// instead). This is what remains of the groupBy token mapping after W2:
// the player token became sourceSubject's anchor, and the team/weapon/
// map tokens retired with the parameter — round/side are the entries
// joinKey still reads.
var sourceDims = map[string]map[string]string{
	"events":             {"round": "round"},
	"engagements":        {"round": "round"},
	"rounds":             {"round": "number"},
	"player_stats":       {"side": "side"},
	"player_round_stats": {"round": "round"},
	"round_economy":      {"round": "round", "side": "side"},
	"clutches":           {"round": "round"},
	"utility_events":     {"round": "round"},
	"chat":               {"round": "round"},
	// match_trade_opps carries only match + player (both derived).
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

// denominatorCareerTables maps each denominator alias to the CAREER
// grain table its PROFILE-scope ("") emission counts the subject's rows
// from (design §3 denominator rule — one rule, two units: the
// denominator counts the scope's units for the subject): rounds → the
// subject's player_round_stats rows (one per player-round), matches →
// the subject's player_stats rows (one per player-match ⇒ matches
// played). Match scope (`match:<id>`) keeps denominatorTables' scalar
// `rounds`/`matches` count over the match. Keys are pinned to
// denominatorTables' by TestSchemaConsistency.
var denominatorCareerTables = map[string]string{
	"rounds":  "player_round_stats",
	"matches": "player_stats",
}

// knownSource reports whether expr's source clause names a v1 source.
func knownSource(name string) bool {
	_, ok := sourceColumns[name]
	return ok
}

// knownSourcesMsg renders the source list for error messages.
func knownSourcesMsg() string { return strings.Join(sources, ", ") }

// ---- join declarations (design (c): engine-derived ON, no user text) ----
//
// Every source declares its join properties here, pinned against the real
// DDL by TestJoinKeyDeclarationsMatchSchema (the TestSchemaConsistency
// pattern):
//
//   - dimensions (sourceDimsOf): `match` (every source's match_id) plus
//     `round`/`player`/`side` where the source carries them — the
//     player dimension IS the subject column (sourceSubject), the
//     round/side columns are the sourceDims mapping;
//   - uniqueness key (sourceUniqueKeys): the PK/UNIQUE column set that
//     identifies one row of that table;
//   - population (sourcePopulation): all-players vs humans-only.
//
// Grain table (from internal/store/schema.sql DDL — row identity /
// dimensions):
//
//	events             (match_id, seq)        match round player(attacker)
//	engagements        (match_id, seq)        match round player(a_steam)
//	rounds             (match_id, number)     match round (no subject)
//	player_stats       (match_id, steam_id)   match player side
//	player_round_stats (match_id, round, steam_id)  match round player
//	round_economy      (match_id, round, side)      match round side (no subject)
//	clutches           (match_id, round, steam_id, start_tick)  match round player
//	utility_events     (match_id, seq)        match round player(thrower)
//	chat               (id)                   match round player(steam_id)
//	match_trade_opps   (match_id, steam_id)   match player

// population is the row population a source's rows represent — the
// bot-exclusion dimension of the source list. Declared and pinned
// against the DDL (TestJoinKeyDeclarationsMatchSchema), but compile no
// longer BRANCHES on it: since subject addressing every statement applies
// the humans-only rule to its subject, so the former mixed-population
// special case collapsed into that one unconditional condition.
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
// (every source's match_id), `player` (the subject column — the owner
// ruling defines the player dimension as exactly the subject), plus
// round/side where the source declares them in sourceDims.
func sourceDimsOf(src string) map[string]string {
	d := make(map[string]string, 4)
	if sourceColumns[src]["match_id"] {
		d["match"] = "match_id"
	}
	if col := sourceSubject[src]; col != "" {
		d["player"] = col
	}
	for _, dim := range []string{"round", "side"} {
		if col := sourceDims[src][dim]; col != "" {
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
