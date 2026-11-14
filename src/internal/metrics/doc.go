// Package metrics is the M5 §2.1 custom-metric engine: a whitelist-
// validating parser (identifiers never reach SQL unvalidated — no user
// SQL is ever interpolated), a SQL compiler producing parameterized
// statements, and the preview runner (compile → execute on the store's
// read-only session → subject/label mapping).
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
// (owner design (c)): the first name is the PRIMARY (it owns the subject
// anchor, scope binding and the population anchor), every further
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
//	percentile(<p>, <col>)         p ∈ [0,1], computed in Go over the
//	                               subject's rows in scope (see
//	                               "Percentile" below)
//	median(<col>)                  sugar for percentile(0.5, <col>)
//	ratio(<a1>, <a2>)              1.0*a1 / NULLIF(a2, 0); a1/a2 are value
//	                               aggregations (no nested ratio/percentile).
//	                               Spelling note: the store's fixed K/D
//	                               metric floors instead (MAX(deaths, 1),
//	                               internal/store kdPerMatchSQL) — a typed
//	                               float cell with no NULL state vs this
//	                               generic compiler over user-chosen
//	                               columns; both are deliberate.
//	metric('<name>')               another SAVED metric's value — see
//	                               "Metric references" below (exactly two
//	                               legal positions, never elsewhere)
//
// Conditions (the <cond> grammar): operands are whitelisted columns,
// numbers, 'strings', true/false; operators are = != > >= < <=, AND, OR,
// NOT, and parenthesized grouping. Bare operands are SQLite-truthy
// (`count(headshot)` counts rows where headshot ≠ 0). Every literal is
// bound as a `?` parameter; every column identifier is checked against
// the source set's whitelist before compilation, unknown →
// ExprError{Message,Pos}.
//
// # Metric references (metric('name'))
//
// A ref reads ANOTHER saved metric's value: `ratio(sum(dmg),
// metric('career_avg'))`. The name lives in the expression text (the
// formula stays readable — ids in formulas are unreadable, and the name
// IS the identity: metrics.name is UNIQUE across origins, so name→id
// resolution at save is total) AND in the stored metric_deps edge, which
// the save re-derives WHOLESALE from the current expression — no edge
// ever points at a superseded one (no-history model).
//
// LEGAL POSITIONS — exactly two, and the criterion that generates them:
// **a ref may appear only where a computed value may appear.** A
// top-level aggregation in the agg list, and a ratio() numerator or
// denominator operand (ratioNestedOps). DENIED, each with a targeted
// positioned error (parse.go): inside sum/avg/min/max/stddev/percentile/
// median — *"metric() is a value reference — it cannot appear inside
// sum()"* (a ref is a computed value, not a row transform; aggregating a
// broadcast scalar double-aggregates it); inside a condition or filter —
// *"... it cannot appear in a condition or filter (they are row-level
// predicates over source columns)"*; and nested inside metric() —
// *"metric() cannot be nested inside metric()"*.
//
// COMPILE: a ref becomes ONE engine-derived INNER JOIN per distinct name
// (alias md0, md1, … in first-appearance order; CompileRefs' doc has the
// exact ON):
//
//	INNER JOIN metric_values md0 ON md0.metric_id = ?
//	  AND md0.match_id = <0 | the row's match>
//	  AND md0.steam_id = <the statement's subject>
//	  AND md0.metric_version = ? AND md0.rule_version = ?
//
// The row key is the dependent's subject address — which is why a ref
// resolves iff the dependent's row key CONTAINS every key column of the
// dependency's grain (cross-scope rule): match key (match_id, steam_id)
// and profile key (steam_id). Same-scope refs and a PROFILE dependency
// inside a match metric are fine (the row's player key carries the
// career scalar); a MATCH dependency inside a profile metric is a save
// error — *"metric 'x' is match-scoped and cannot be used inside a
// profile-scoped metric (a career value cannot read a per-match value)"*.
// The INNER join is deliberate and separate from the sources' sparse-row
// rule: a missing or outdated upstream DROPS the dependent's row —
// absent = unknown, never 0 (both stamps must be live, so an outdated
// upstream reads as absent too). Compile never touches the catalog: the
// SERVICE resolves every name (existence → *"unknown metric reference
// "x""*, positioned at the literal) and passes the targets in
// (CompileRefs/Def.Refs), so SaveMetric, ad-hoc ValidateExpr and
// PreviewMetric share one resolution and one copy. A draft is always
// CALCULATED — its refs resolve against SAVED metrics.
//
// SAVE-TIME GRAPH: inside the save transaction the service resolves
// names → enforces cross-scope → walks {existing metric_deps edges} ∪
// {the new refs} for cycles (*"cyclic metric reference: a → b → a"*,
// self-reference immediate; the walk is a pure graph helper,
// graph.go) → replaces the metric's edges wholesale. A RENAMED metric
// with dependents > 0 additionally splices every dependent's
// metric('old') literals using the parse's own literal spans, re-parses,
// re-resolves and re-Compile-validates each rewrite — any failure errors
// the save with NOTHING written — and bumps nothing (a rename changes no
// semantics). Deleting a referenced metric is blocked at the API
// (*"cannot delete metric "x": referenced by y, z — edit or delete those
// first"*); system removal (plugin replace/disable) is not blockable, so
// dep_name deliberately carries NO foreign key and the edge dangles for
// the compute pass to resolve-or-fail honestly (missing upstream ⇒
// dependent rows absent, never 0), while metric_id's ON DELETE CASCADE
// removes the deleted metric's own edges.
//
// The compute pass, its cascade version bumps and the metric_values
// writers are wave 3 (design §6) — nothing here schedules or stores a
// computed value.
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
// where present — the player dimension IS the source's subject column,
// sourceSubject; round/side come from the fixed sourceDims table) and
// its UNIQUENESS KEY (PK/UNIQUE). The engine
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
// qualified-identifier syntax for the user to fall back on). Scope binds
// on the PRIMARY only (`WHERE primary.match_id = ?`) — a scope
// predicate landing on a LEFT-joined secondary would silently convert
// the join to INNER.
//
// VALUE-COLUMN RULE: a value column (sum/avg/min/max/stddev/percentile
// argument) comes from the primary always, and from a secondary only
// when the join is 1:1 (both sides unique on the key) — otherwise a
// coarse secondary value would repeat at a finer grain (e.g. summing
// rounds.duration_s over an n:1 join). Enforced at compile with a
// positioned error. Condition/filter columns may come from any source:
// filters never multiply rows.
//
// POPULATION ALIGNMENT (unconditional since subject addressing): every
// source still declares its population (all-players vs humans-only;
// match_trade_opps is the first humans-only member — analytics.Compute
// never stores bot rows), but compile no longer branches on it. Every
// statement emits `subject <> ”` beside store.HumanOnly over its
// subject, so both populations align by construction: a bot row (or an
// actor-less row) never reaches a value, whichever source list it came
// from. Pinned by TestJoinedPopulationAlignment (joined source sets) and
// TestSubjectStatementExcludesBots (the single-source and scoped
// boundaries).
//
// # Subject addressing (the anchor)
//
// A metric is always ONE number addressed to a player, so every
// statement is subject-addressed. The PRIMARY source must carry a
// SUBJECT column (whitelist.go sourceSubject): events → attacker,
// engagements → a_steam, utility_events → thrower, and player_stats /
// player_round_stats / clutches / chat / match_trade_opps → steam_id.
// rounds and round_economy have NO subject (mvp is an attribute of a
// won round; round_economy is side-grained). A primary without a
// subject is rejected right after the source check, positioned at the
// source clause:
//
//	expression is not player-anchored: primary source "rounds" has no
//	player subject — a metric's value must be per player (player
//	sources: events, engagements, player_stats, player_round_stats,
//	clutches, chat, utility_events, match_trade_opps; round-grain
//	sources can only join a player-anchored expression)
//
// The criterion is PRIMARY-OWNS (owner confirm-or-veto note 1): the
// subject comes from the primary only — the same ownership as scope
// binding and the population anchor. Round/match-grain sources stay
// legal as JOIN PARTNERS of an anchored primary wherever joinKey allows
// (engagements, rounds is the worked n:1 pair): the rule partitions by
// what the OUTPUT is, not by a source whitelist. Because the check lives
// in Compile, SaveMetric, the ad-hoc PreviewMetric and ValidateExpr
// enforce it identically — a player-less draft errors exactly like any
// invalid expression.
//
// The compiled statement GROUPS its output by the subject (the `grp`
// column) and restricts its rows with `subject <> ”` + humans-only, so
// a preview row is one player's value: "" scope = the whole library (one
// row per player the statement produced), "match:<id>" = one match's
// per-player rows. Retired with the groupBy parameter: the token set,
// the per-source group mapping table, the percentile-with-group
// constraint and every "match scalar without a player" surface (no
// match-level stat strip, no player-less pinning).
//
// # Denominator
//
// models.MetricRow.Denominator (optional) — allowed values: rounds,
// matches (owner ruling: "match and one of round … are the only
// meaningful denominators to a CS2 player"; the player_rounds alias was
// retired — player_round_stats remains a metric SOURCE, only the
// denominator option is gone). ONE rule, two units: the denominator
// counts the SCOPE's units for the subject.
//
//   - match scope (`match:<id>`): the match's units — the scalar
//     `1.0*(<value>) / NULLIF((SELECT COUNT(*) FROM <rounds|matches>
//     WHERE match_id=?),0)`, unchanged from the pre-subject engine. It
//     is a SCALAR over the match: for rounds/matches that is correct for
//     by-player rates (every player in the match shares the round count).
//   - library/profile scope (""): the subject's CAREER units —
//     correlated on the subject: rounds →
//     `COUNT(*) FROM player_round_stats WHERE steam_id = <subject>`
//     (one row per player-round), matches →
//     `COUNT(*) FROM player_stats WHERE steam_id = <subject>` (one row
//     per player-match ⇒ matches played). The career table is aliased
//     (`AS d`) so the outer subject reference can never resolve to it
//     when the primary and the career table are the same table.
//
// The emission lives in the emitter's emitDenom (whitelist.go maps both
// units: denominatorTables for the match-scope scalar,
// denominatorCareerTables for the profile-scope correlation).
//
// The two cross-source mechanisms are a deliberate partition (owner
// criterion — complementary, not redundant; do not "consolidate" one
// into the other): the DENOMINATOR is coarse-grain normalization
// ("per round" / "per match" — a row count of a coarser table the
// expression's own row set cannot reach, counted at the scope's grain
// for the subject); JOINS are row-level
// and same-grain cross-source arithmetic (each expression row enriched
// by a matched row of another source at the join key's grain).
//
// # Scope
//
// "" = whole library (multi-match sources carry match_id) — with every
// statement subject-grouped this IS the per-player career computation,
// and the denominator counts the subject's career units (see above);
// "match:<id>" injects `match_id = ?` for both the main statement and
// the match-scope denominator subquery — side-qualified on the primary
// when the expression joins. Any other scope string is an error.
//
// # Percentile rule
//
// percentile/median are computed in Go from raw column values, one
// partition per SUBJECT: the phase-2 fetch selects the subject beside
// the value (`SELECT <subject> AS grp, <col> AS x [, <denominator>]`),
// and RunPreview groups the fetched rows by that address — match scope
// sees one match, so the subject alone is the address; "" scope
// partitions the whole library by subject (the batched compute pass
// addresses (match, subject) the same way). Each partition is THE
// subject's rows in scope: the p-quantile over its own sample (linear
// interpolation between order statistics, percentileOf), N = the numeric
// values behind it, and the denominator taken from the partition's OWN
// row (career-correlated at profile scope, the shared scalar at match
// scope). A subject the statement produced no row for has no row here
// either; a subject whose rows carry no numeric value yields value 0
// with N 0 — the missing-data indicator, never a fabricated number.
// Percentile MAY appear in a multi-aggregation list: the first
// aggregation is what Preview surfaces as the row Value (MetricPreview has
// a single Value field; the compiled SQL carries every aggregation column
// for provenance/future metric views), and when the first aggregation is a
// percentile the preview executes the raw-value statement (cap 500 000
// rows, Truncated set past the cap); otherwise it executes the aggregate
// statement and a companion percentile statement (if any) is shown but not
// run. Denominator + percentile-first is supported (the raw statement also
// selects the denominator). Percentiles over joined sources are
// supported from day one: the phase-2 raw fetch carries the SAME join,
// scope side and column qualification as the aggregate statement (one
// qualification path — see the emitter).
//
// # Preview semantics
//
// RunPreview(st, Def{Expr, Denominator}, scope, limit) compiles, runs on
// the store's read-only session (row cap = limit, default 200; statement
// timeout 10 s) and maps subjects: values that look like SteamID64 (17
// digits, 7656119…) resolve to the players table name (scoped match,
// else library-wide latest); other groups fall back to their raw key. N
// is the sample size behind the value (group row count; numeric value-row
// count for percentile). NULL results (empty sets, zero denominators)
// surface as Value 0 with N for the missing-data indicator (PRD §5.16).
package metrics
