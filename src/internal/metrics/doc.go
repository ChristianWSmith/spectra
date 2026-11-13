// Package metrics is the M5 §2.1 custom-metric engine: a whitelist-
// validating parser (identifiers never reach SQL unvalidated — no user
// SQL is ever interpolated), a SQL compiler producing parameterized
// statements, and the preview runner (compile → execute on the store's
// read-only session → group/label mapping).
//
// # Grammar
//
// An expression is a source clause followed by a comma-separated
// aggregation list, each `op(args) [AS alias]`:
//
//	expr := "from" source { "," source } ":" agg { "," agg }
//	source := table
//	agg  := op "(" [ args ] ")" [ "AS" ident ]
//
// The base form is SINGLE-SOURCE — one `from <table>:` per expression,
// byte-identical to the original grammar (there are no user table names
// outside the known list). A comma list of sources is the JOIN EXTENSION
// (owner design (c)): the first name is the PRIMARY (it owns groupBy
// resolution, scope binding and the population anchor), every further
// name is a secondary the engine LEFT JOINs to the primary on a derived
// key. User-written ON/USING/join-type/alias syntax does NOT exist — the
// join condition, join type, aliasing and column qualification are 100%
// engine-side, so no user text ever reaches a join clause:
//
//	from events: count() , sum(dmg) , avg(distance) ,
//	             ratio(count(headshot), count()) , stddev(dmg) ,
//	             percentile(0.95, dmg) , min(tick) , max(tick)
//
//	from player_stats, match_trade_opps: ratio(sum(trade_kills), sum(opps))
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
//	                               aggregations (no nested ratio/percentile).
//	                               Spelling note: the store's fixed K/D
//	                               metric floors instead (MAX(deaths, 1),
//	                               internal/store kdPerMatchSQL) — a typed
//	                               float cell with no NULL state vs this
//	                               generic compiler over user-chosen
//	                               columns; both are deliberate.
//
// Conditions (the <cond> grammar): operands are whitelisted columns,
// numbers, 'strings', true/false; operators are = != > >= < <=, AND, OR,
// NOT, and parenthesized grouping. Bare operands are SQLite-truthy
// (`count(headshot)` counts rows where headshot ≠ 0). Every literal is
// bound as a `?` parameter; every column identifier is checked against
// the source set's whitelist before compilation, unknown →
// ExprError{Message,Pos}.
//
// # Sources and the column whitelist
//
// The ten sources (columns curated from the store schema,
// internal/store/schema.sql — JSON/blob
// payload columns such as events.detail_json, events.raw_json,
// utility_events.affected, player_stats.kills_by_weapon are deliberately
// excluded): events, engagements, rounds, player_stats, player_round_stats,
// round_economy, clutches, utility_events, chat, match_trade_opps.
// See whitelist.go for the exact column sets — and for the join
// declarations (dimensions, uniqueness keys, population) the engine
// derives every ON from.
//
// # Joins (the multi-source extension)
//
// Each source declares two join properties in whitelist.go, pinned
// against the real DDL by TestJoinKeyDeclarationsMatchSchema: the
// DIMENSIONS it carries (`match` for all, `round`, `player`, `side`
// where present — the round/player/side columns are exactly the
// groupColumns mapping) and its UNIQUENESS KEY (PK/UNIQUE). The engine
// derives the key per secondary: the secondary's uniqueness key,
// accepted only when every column of it is a dimension both sides carry
// — the finest shared dimension set on which the secondary is unique as
// its grain. A secondary with no such key is REJECTED at compile time
// (positioned error): it would fan out primary rows and silently inflate
// count()/sum()/N. Worked keys: player_stats + match_trade_opps →
// (match_id, steam_id) — 1:1; engagements + rounds → (match_id, round)
// — n:1; rounds + events, player_round_stats + clutches and
// rounds + round_economy are rejected (secondary not unique on the
// shared dimensions).
//
// The join type is engine-chosen LEFT (primary LEFT JOIN secondary),
// never user syntax: a sparse secondary (match_trade_opps writes no row
// for a zero-count player) must keep every primary row — an INNER join
// would delete zero-opps players and destroy the Value-0-beside-N
// honesty row (NULL secondary ⇒ SUM NULL ⇒ NULLIF ⇒ toFloat ⇒ 0 with N).
//
// Emission qualifies every column with its owning source (the aliases
// are the table names, chosen by the engine) when the statement joins;
// the single-source base form stays unqualified (byte-stable). An
// unqualified identifier resolves iff exactly ONE source in the list
// owns it — otherwise a positioned ambiguity error (there is no
// qualified-identifier syntax for the user to fall back on). groupBy
// resolves against the PRIMARY's groupColumns only; a token unmapped
// there is the "unmapped group" error even when the secondary carries
// it. Scope binds on the PRIMARY only (`WHERE primary.match_id = ?`) —
// a scope predicate landing on a LEFT-joined secondary would silently
// convert the join to INNER.
//
// VALUE-COLUMN RULE: a value column (sum/avg/min/max/stddev/percentile
// argument) comes from the primary always, and from a secondary only
// when the join is 1:1 (both sides unique on the key) — otherwise a
// coarse secondary value would repeat at a finer grain (e.g. summing
// rounds.duration_s over an n:1 join). Enforced at compile with a
// positioned error. Condition/filter columns may come from any source:
// filters never multiply rows.
//
// POPULATION ALIGNMENT: every source carries a population flag
// (all-players vs humans-only; match_trade_opps is the first
// humans-only member — analytics.Compute never stores bot rows). A
// multi-source expression whose source set MIXES populations applies
// store.HumanOnly to the primary's player column REGARDLESS of grouping:
// bot rows survive the LEFT join with NULL secondary values, then the
// humans-only condition drops them (grouped), and ungrouped the
// condition makes the numerator human-only too, so the populations
// always align. Where ALL sources share one population, the single-source
// rule is unchanged (player-group ⇒ humans-only; else bots stay).
//
// # GroupBy
//
// GroupBy is one of "", none, player, round, team, weapon, side, map —
// validated against the PRIMARY source's fixed mapping table
// (whitelist.go). Mappings are fixed per source; anything unmapped is an
// ExprError, never an ambiguous join. Highlights: player → attacker
// (events, the killer side), a_steam (engagements — the acting player
// for every kind), steam_id (player_stats/player_round_stats/
// clutches/chat/match_trade_opps), mvp (rounds), thrower
// (utility_events); team/side → side columns only where the table
// carries one (player_stats, round_economy); weapon → events.weapon
// only; round → the round column (number on rounds, player_stats has
// none); map → a fixed correlated subquery over matches (every source is
// match-scoped). round_economy has no player column — groupBy player on
// it is an error. Because the join key includes the group column in the
// 1:1 acceptance pair, both sides group identically by construction.
//
// # Denominator
//
// models.MetricRow.Denominator (optional) is a scalar-subquery source —
// allowed values: rounds, matches (owner ruling: "match and one of round
// … are the only meaningful denominators to a CS2 player"; the
// player_rounds alias was retired — player_round_stats remains a metric
// SOURCE, only the denominator option is gone) — compiled
// as `1.0*(<value>) / NULLIF((SELECT COUNT(*) FROM <t> [WHERE match_id=?]),0)`.
// The denominator is a SCALAR over the whole scope: for rounds/matches
// that is correct for by-player rates (every player shares the round
// count).
//
// The two cross-source mechanisms are a deliberate partition (owner
// criterion — complementary, not redundant; do not "consolidate" one
// into the other): the DENOMINATOR is scope-wide coarse-grain
// normalization ("per round" / "per match" — a row count of a coarser
// table the expression's own row set cannot reach); JOINS are row-level
// and same-grain cross-source arithmetic (each expression row enriched
// by a matched row of another source at the join key's grain).
//
// # Scope
//
// "" = whole library (multi-match sources carry match_id);
// "match:<id>" injects `match_id = ?` for both the main statement and the
// denominator subquery — side-qualified on the primary when the
// expression joins. Any other scope string is an error.
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
// selects the scalar denominator). Percentiles over joined sources are
// supported from day one: the phase-2 raw fetch carries the SAME join,
// scope side and column qualification as the aggregate statement (one
// qualification path — see the emitter).
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
