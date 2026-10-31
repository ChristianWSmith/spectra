// Package metrics is the M5 §2.1 custom-metric engine (plan §2.1): a
// frozen v1 expression grammar, a whitelist-validating parser (identifiers
// never reach SQL unvalidated — no user SQL is ever interpolated), a SQL
// compiler producing parameterized statements, and the preview runner
// (compile → execute on the store's read-only session → group/label
// mapping).
//
// # Grammar — FROZEN (v1)
//
// An expression is a source clause followed by a comma-separated
// aggregation list, each `op(args) [AS alias]`:
//
//	expr := "from" table ":" agg { "," agg }
//	agg  := op "(" [ args ] ")" [ "AS" ident ]
//
// The source prefix carries the single source table (v1 is SINGLE-SOURCE:
// one `from <table>:` per expression — there are no joins and no user table
// names outside the known list):
//
//	from events: count() , sum(dmg) , avg(distance) ,
//	             ratio(count(headshot), count()) , stddev(dmg) ,
//	             percentile(0.95, dmg) , min(tick) , max(tick)
//
// Operations (op table; anything else is an error at the op's position):
//
//	count()                        rows in scope
//	count(<cond>)                  rows where <cond> is truthy
//	count(where <cond>)            same (filter form)
//	sum|avg|min|max(<col>)         aggregate over a whitelisted column
//	[where <cond>,] as first args  optional per-agg filter on any of the above,
//	                               e.g. sum(where kind='kill', dmg) or
//	                                    count(where kind='kill' and headshot)
//	stddev(<col>)                  population σ via the sqrt(avg(x²)-avg(x)²)
//	                               idiom (clamped at 0 for float noise)
//	percentile(<p>, <col>)         p ∈ [0,1], computed in Go over ALL rows;
//	                               requires groupBy "" (see below)
//	median(<col>)                  sugar for percentile(0.5, <col>)
//	ratio(<a1>, <a2>)              1.0*a1 / NULLIF(a2, 0); a1/a2 are value
//	                               aggregations (no nested ratio/percentile)
//
// Conditions (the <cond> grammar): operands are whitelisted columns,
// numbers, 'strings', true/false; operators are = != > >= < <=, AND, OR,
// NOT, and parenthesized grouping. Bare operands are SQLite-truthy
// (`count(headshot)` counts rows where headshot ≠ 0). Every literal is
// bound as a `?` parameter; every column identifier is checked against the
// source's whitelist before compilation, unknown → ExprError{Message,Pos}.
//
// # Sources and the column whitelist
//
// The ten v1 sources (columns curated from the store migrations — JSON/blob
// payload columns such as events.detail_json, events.raw_json,
// utility_events.affected, player_stats.kills_by_weapon are deliberately
// excluded): events, engagements, rounds, player_stats, player_round_stats,
// round_economy, clutches, utility_events, chat, voice_chunks.
// See whitelist.go for the exact column sets.
//
// # GroupBy
//
// GroupBy is one of "", none, player, round, team, weapon, side, map —
// validated against the SAME source's fixed mapping table (whitelist.go).
// v1 mappings are fixed per source; anything unmapped is an ExprError, never
// an ambiguous join. Highlights: player → attacker (events, the killer
// side), a_steam (engagements — the acting player for every v1 kind),
// steam_id (player_stats/player_round_stats/clutches/chat/voice_chunks),
// mvp (rounds), thrower (utility_events); team/side → side columns only
// where the table carries one (player_stats, round_economy); weapon →
// events.weapon only; round → the round column (number on rounds,
// player_stats has none); map → a fixed correlated subquery over matches
// (every source is match-scoped). round_economy has no player column —
// groupBy player on it is an error.
//
// # Denominator
//
// MetricDef.Denominator (optional) is a scalar-subquery source — allowed
// values: rounds, matches, player_rounds (= player_round_stats) — compiled
// as `1.0*(<value>) / NULLIF((SELECT COUNT(*) FROM <t> [WHERE match_id=?]),0)`.
// The denominator is a SCALAR over the whole scope: for rounds/matches that
// is correct for by-player rates (every player shares the round count);
// player_rounds is the scope-wide player-round count, not per-group.
//
// # Scope
//
// "" = whole library (multi-match sources carry match_id);
// "match:<id>" injects `match_id = ?` for both the main statement and the
// denominator subquery. Any other scope string is an error.
//
// # Percentile rule (documented deviation surface)
//
// percentile/median are computed in Go from raw column values, so they
// require GroupBy == "" — a percentile inside a grouped expression is an
// ExprError. Percentile MAY appear in a multi-aggregation list: the first
// aggregation is what Preview surfaces as the row Value (MetricPreview has
// a single Value field; the compiled SQL carries every aggregation column
// for provenance/future metric views), and when the first aggregation is a
// percentile the preview executes the raw-value statement (cap 500 000
// rows, Truncated set past the cap); otherwise it executes the aggregate
// statement and a companion percentile statement (if any) is shown but not
// run. Denominator + percentile-first is supported (the raw statement also
// selects the scalar denominator).
//
// # Preview semantics
//
// RunPreview(st, Def, scope, limit) compiles, runs on the store's read-only
// session (row cap = limit, default 200; statement timeout 10 s) and maps
// groups: values that look like SteamID64 (17 digits, 7656119…) resolve to
// the players table name (scoped match, else library-wide latest); other
// groups fall back to their raw key. N is the sample size behind the value
// (group row count; value-row count for percentile). NULL results (empty
// sets, zero denominators) surface as Value 0 with N for the
// missing-data indicator (PRD §5.16).
package metrics
