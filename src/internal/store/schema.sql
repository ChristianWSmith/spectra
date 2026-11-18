-- Baseline schema: the complete schema of a fresh Spectra database,
-- applied in full by store.applySchema on every Open. Every statement is
-- idempotent (CREATE ... IF NOT EXISTS, seed INSERT OR IGNORE), so a
-- database that already has this schema takes the same path and comes
-- out identical to a fresh one — there is no version tracking.
--
-- Core tables: 1:1 with internal/models structs. All child tables FK to
-- matches(id) ON DELETE CASCADE.

CREATE TABLE IF NOT EXISTS matches (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	path TEXT NOT NULL DEFAULT '',
	sha256 TEXT NOT NULL UNIQUE,
	size INTEGER NOT NULL DEFAULT 0,
	map TEXT NOT NULL DEFAULT '',
	patch_version INTEGER NOT NULL DEFAULT 0,
	tick_rate REAL NOT NULL DEFAULT 0,
	duration_ticks INTEGER NOT NULL DEFAULT 0,
	playback_time_s REAL NOT NULL DEFAULT 0,
	frames INTEGER NOT NULL DEFAULT 0,
	server_name TEXT NOT NULL DEFAULT '',
	client_name TEXT NOT NULL DEFAULT '',
	game_dir TEXT NOT NULL DEFAULT '',
	net_proto TEXT NOT NULL DEFAULT '',
	is_pov INTEGER NOT NULL DEFAULT 0,
	real_rounds INTEGER NOT NULL DEFAULT 0,
	score_ct INTEGER NOT NULL DEFAULT 0,
	score_t INTEGER NOT NULL DEFAULT 0,
	half_ct INTEGER NOT NULL DEFAULT 0,
	half_t INTEGER NOT NULL DEFAULT 0,
	side_switches INTEGER NOT NULL DEFAULT 0,
	entity_classes INTEGER NOT NULL DEFAULT 0,
	end_entity_count INTEGER NOT NULL DEFAULT 0,
	parser_version TEXT NOT NULL DEFAULT '',
	extracted_at DATETIME,
	parse_ms INTEGER NOT NULL DEFAULT 0,
	warnings_count INTEGER NOT NULL DEFAULT 0,
	status TEXT NOT NULL DEFAULT 'queued',
	error TEXT NOT NULL DEFAULT '',
	-- Position sidecar mirror (tactical replay): the sidecar's sample
	-- rate and frame count (0 = no sidecar stored).
	sample_rate INTEGER NOT NULL DEFAULT 0,
	position_frames INTEGER NOT NULL DEFAULT 0,
	-- Match header mirror: svc_EncryptedData count seen during the parse.
	enc_messages INTEGER NOT NULL DEFAULT 0,
	-- Analytics provenance: the analysis_config.rule_version the match's
	-- derived rows (round_classifications / player_round_stats / clutches /
	-- engagements / utility_events + player_stats.trade_kills) were last
	-- computed under. Written ONLY at the end of a successful
	-- analytics.Compute (store.SetMatchRuleVersion — the one writer);
	-- 0 = never analyzed / unknown (rule_version starts at 1 — 2 since
	-- the 2026-11-18 enemy-damage bump of store.DefaultConfig — so 0 is
	-- never a real version). The behind read (store.MatchListFilter.Behind)
	-- compares it against the live rule version. SaveExtracted never
	-- touches it (matchOwnedElsewhere): a reprocess keeps its old stamp
	-- until its analyze stage re-stamps it.
	analyzed_rule_version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS teams (
	match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
	side TEXT NOT NULL,
	name TEXT NOT NULL DEFAULT '',
	flag TEXT NOT NULL DEFAULT '',
	score INTEGER NOT NULL DEFAULT 0,
	money_spent INTEGER NOT NULL DEFAULT 0,
	equip_total INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (match_id, side)
);

CREATE TABLE IF NOT EXISTS players (
	match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
	steam_id TEXT NOT NULL,
	name TEXT NOT NULL DEFAULT '',
	is_bot INTEGER NOT NULL DEFAULT 0,
	side TEXT NOT NULL DEFAULT '',
	clan_tag TEXT NOT NULL DEFAULT '',
	crosshair_code TEXT NOT NULL DEFAULT '',
	rank INTEGER NOT NULL DEFAULT 0,
	rank_type INTEGER NOT NULL DEFAULT 0,
	wins INTEGER NOT NULL DEFAULT 0,
	ping INTEGER NOT NULL DEFAULT 0,
	final_alive INTEGER NOT NULL DEFAULT 0,
	final_state_present INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (match_id, steam_id)
);

CREATE TABLE IF NOT EXISTS player_stats (
	match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
	steam_id TEXT NOT NULL,
	side TEXT NOT NULL DEFAULT '',
	name TEXT NOT NULL DEFAULT '',
	kills INTEGER NOT NULL DEFAULT 0,
	deaths INTEGER NOT NULL DEFAULT 0,
	assists INTEGER NOT NULL DEFAULT 0,
	headshots INTEGER NOT NULL DEFAULT 0,
	teamkills INTEGER NOT NULL DEFAULT 0,
	suicides INTEGER NOT NULL DEFAULT 0,
	mvps INTEGER NOT NULL DEFAULT 0,
	score INTEGER NOT NULL DEFAULT 0,
	total_damage INTEGER NOT NULL DEFAULT 0,
	damage_taken INTEGER NOT NULL DEFAULT 0,
	shots INTEGER NOT NULL DEFAULT 0,
	hits INTEGER NOT NULL DEFAULT 0,
	adr REAL NOT NULL DEFAULT 0,
	hs_pct REAL NOT NULL DEFAULT 0,
	rounds_played INTEGER NOT NULL DEFAULT 0,
	entry_kills INTEGER NOT NULL DEFAULT 0,
	entry_deaths INTEGER NOT NULL DEFAULT 0,
	-- opening_kills/opening_deaths were RETIRED 2026-11-18: extract
	-- incremented them in the same first-blood branch as entry_kills/
	-- entry_deaths (identical stored columns — pinned equal on the
	-- golden demo), so entry_* is the single attribution and the twins
	-- had zero readers. Baseline-only schema: this drop rides the
	-- owner's owed wipe + re-import (make deep-clean CONFIRM=1) —
	-- there is no migration path by design (AGENTS.md no-versioning).
	trade_kills INTEGER NOT NULL DEFAULT 0,
	best_streak INTEGER NOT NULL DEFAULT 0,
	three_k INTEGER NOT NULL DEFAULT 0,
	four_k INTEGER NOT NULL DEFAULT 0,
	five_k INTEGER NOT NULL DEFAULT 0,
	utility_damage INTEGER NOT NULL DEFAULT 0,
	enemies_flashed INTEGER NOT NULL DEFAULT 0,
	flashed_times INTEGER NOT NULL DEFAULT 0,
	bomb_plants INTEGER NOT NULL DEFAULT 0,
	bomb_defuses INTEGER NOT NULL DEFAULT 0,
	money_spent_total INTEGER NOT NULL DEFAULT 0,
	-- kills_by_weapon: the retired profile Weapons table's JSON fold —
	-- extract still WRITES it, and the match scoreboard row still
	-- carries it (FilterBar unions its keys into the match's weapon
	-- filter — a live reader, 2026-11-18). It stays OUT of the metrics
	-- expression whitelist (JSON blob, internal/metrics/whitelist.go).
	-- Its twin damage_by_weapon was DROPPED 2026-11-18 by owner ruling:
	-- zero readers outside the oracle tests since the profile Weapons
	-- table migrated to the weapon_* seeds (2026-11-18, M7 gate flip —
	-- the fold-vs-seed equality proven at migration, flip commit
	-- 86300be), and the seed is now THE damage implementation. Like
	-- the opening_* twins earlier the same day, the drop rides the
	-- owner's owed wipe + re-import (baseline-only schema, no
	-- migration path — AGENTS.md no-versioning).
	kills_by_weapon TEXT NOT NULL DEFAULT '',
	-- flash_assists splits AssistedFlash assists out of the assist column
	-- (external scoreboards exclude them; the game's own m_iAssists
	-- includes them).
	flash_assists INTEGER NOT NULL DEFAULT 0,
	-- two_k: a round with EXACTLY 2 kills counts as one 2K (exclusive
	-- tier, same rule as 3K/4K/5K — see extract buildMultiKills and the
	-- CS2.md "Multi-kill columns" entry, verified against the golden
	-- demo's external scoreboard screenshot, removed from the repo).
	two_k INTEGER NOT NULL DEFAULT 0,
	-- Row stamps (metrics expansion §5, 2026-11-17): team is the
	-- player's TEAM key — the sideparity teamKeyAt vocabulary (the
	-- team's FINAL side; '' when the side is unknown, so an unknown row
	-- never joins a team-subject grouping), won the 0/1 match result
	-- stamped from models.WinFor over the stored score (tie or unknown
	-- side is not a win — the career rollup's SQL twin agrees), and map
	-- the match's map from the match row (denormalized for the
	-- map-partitioned metrics). All three are written WITH the row at
	-- ingest (store.SaveExtracted): they are match facts, not
	-- analysis-rule derived, so a rules bump never rewrites them.
	team TEXT NOT NULL DEFAULT '',
	won INTEGER NOT NULL DEFAULT 0,
	map TEXT NOT NULL DEFAULT '',
	PRIMARY KEY (match_id, steam_id)
);

-- One row per COUNTED round. Knife/warmup/post-match rounds are discarded
-- at ingest (extract.agg.roundStart never stores them), so number is the
-- dense counted-round index 1..N and no warmup/pregame flag exists.
CREATE TABLE IF NOT EXISTS rounds (
	match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
	number INTEGER NOT NULL,
	winner TEXT NOT NULL DEFAULT '',
	reason TEXT NOT NULL DEFAULT '',
	duration_s REAL NOT NULL DEFAULT 0,
	start_tick INTEGER NOT NULL DEFAULT 0,
	end_tick INTEGER NOT NULL DEFAULT 0,
	mvp TEXT NOT NULL DEFAULT '',
	mvp_reason TEXT NOT NULL DEFAULT '',
	equip_ct INTEGER NOT NULL DEFAULT 0,
	equip_t INTEGER NOT NULL DEFAULT 0,
	bomb_site TEXT NOT NULL DEFAULT '',
	freeze_end_tick INTEGER NOT NULL DEFAULT 0,
	first_kill_steam TEXT NOT NULL DEFAULT '',
	first_death_steam TEXT NOT NULL DEFAULT '',
	PRIMARY KEY (match_id, number)
);

-- Per-round freeze-end side samples: side is a per-round fact (teams
-- switch at halftime), so the final roster snapshot alone is unreliable
-- (3/10 players on the golden demo). The extractor writes one row per
-- player per round. `team` (metrics expansion §5) stamps the TEAM behind
-- that round's side through the sideparity teamKeyAt formula
-- (rules.TeamKeyAt — the team's final side; '' for an unknown side,
-- excluded from team-subject grouping rather than guessed); a round row
-- itself would carry BOTH teams and is never stamped.
CREATE TABLE IF NOT EXISTS round_player_sides (
	match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
	round INTEGER NOT NULL,
	steam_id TEXT NOT NULL,
	side TEXT NOT NULL,
	team TEXT NOT NULL DEFAULT '',
	PRIMARY KEY (match_id, round, steam_id)
);

CREATE TABLE IF NOT EXISTS round_economy (
	match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
	round INTEGER NOT NULL,
	side TEXT NOT NULL,
	equip_value INTEGER NOT NULL DEFAULT 0,
	money_sampled_sum INTEGER NOT NULL DEFAULT 0,
	money_samples INTEGER NOT NULL DEFAULT 0,
	spent INTEGER NOT NULL DEFAULT 0,
	-- Held free spawn-issued default-pistol value at this freeze end
	-- ($200 each — granted, not bought; they count inside equipment
	-- value, so net worth includes them — CS2.md "Free spawn-issued
	-- default pistol").
	free_pistol_value INTEGER NOT NULL DEFAULT 0,
	-- `team` (metrics expansion §5): the TEAM behind this round's side
	-- through the sideparity teamKeyAt formula (rules.TeamKeyAt — the
	-- team's final side; '' for an unknown side), stamped with the row
	-- at ingest (store.SaveExtracted — ingest-owned column). The
	-- Economy view's per-team rollups are the same key client-side.
	team TEXT NOT NULL DEFAULT '',
	PRIMARY KEY (match_id, round, side)
);

CREATE TABLE IF NOT EXISTS events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
	seq INTEGER NOT NULL,
	tick INTEGER NOT NULL DEFAULT 0,
	round INTEGER NOT NULL DEFAULT 0,
	kind TEXT NOT NULL DEFAULT '',
	attacker TEXT NOT NULL DEFAULT '',
	victim TEXT NOT NULL DEFAULT '',
	assister TEXT NOT NULL DEFAULT '',
	weapon TEXT NOT NULL DEFAULT '',
	headshot INTEGER NOT NULL DEFAULT 0,
	wallbang INTEGER NOT NULL DEFAULT 0,
	noscope INTEGER NOT NULL DEFAULT 0,
	through_smoke INTEGER NOT NULL DEFAULT 0,
	attacker_blind INTEGER NOT NULL DEFAULT 0,
	-- player_death's `attackerinair`: the attacker was midair. Derived
	-- from the paired raw payload at extract time (demoinfocs' typed Kill
	-- has no MidAir field) — no migration: a stale dev DB lacks the
	-- column and must be re-imported.
	attacker_inair INTEGER NOT NULL DEFAULT 0,
	assisted_flash INTEGER NOT NULL DEFAULT 0,
	distance REAL NOT NULL DEFAULT 0,
	hitgroup TEXT NOT NULL DEFAULT '',
	dmg INTEGER NOT NULL DEFAULT 0,
	-- same_side (owner ruling 2026-11-17 — damage stats differentiate
	-- enemy damage; friendly fire stays an accounting quantity inside
	-- expressions/filters, never a surfaced stat): 1 iff attacker and
	-- victim sides were BOTH known and EQUAL at the event — the exact
	-- predicate extract's "count ENEMY damage only" gate uses
	-- (internal/extract/agg.go hurt), stamped at ingest by
	-- store.SaveExtracted. 0 otherwise, so an unknown side reads as
	-- ENEMY (the same permissive rule `if enemy` applies). No
	-- migration: the baseline only CREATEs — a stale dev DB lacks the
	-- column and must be re-imported (wipe + re-import).
	same_side INTEGER NOT NULL DEFAULT 0,
	-- capped_dmg (owner ruling 2026-11-17 "fix the metric until they
	-- match"; M7 weapon-damage gate escalation, 2026-11-18): the
	-- HP-capped damage credit of THIS hit — the value extract.agg.hurt
	-- feeds player_stats.weaponDmg — with post-match (non-real) hits
	-- stamped 0. The cap replays per victim in event order
	-- (extract.agg.capDamage), so a query-time SUM(events.dmg) can
	-- never reproduce it (round 5 of the golden demo: 206 raw dmg on
	-- one victim, fold credits <=100); the fact is row-local at ingest.
	-- The enemy gate stays OFF this column: same_side + the actor
	-- columns carry it (the weapon_damage seed spells all three).
	-- No migration: the baseline only CREATEs — a stale dev DB lacks
	-- the column and must be re-imported (wipe + re-import).
	capped_dmg INTEGER NOT NULL DEFAULT 0,
	site TEXT NOT NULL DEFAULT '',
	detail_json TEXT NOT NULL DEFAULT '',
	raw_json TEXT NOT NULL DEFAULT '',
	-- World positions: pos_* is the victim/hit position the source event
	-- exposes (NULL when the source had none); apos_* is the attacker
	-- position on typed events — the kills heatmap plots where the
	-- KILLER was while pos_* keeps the victim side.
	pos_x REAL,
	pos_y REAL,
	pos_z REAL,
	apos_x REAL,
	apos_y REAL,
	apos_z REAL,
	UNIQUE (match_id, seq)
);

CREATE TABLE IF NOT EXISTS generic_events (
	match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
	name TEXT NOT NULL DEFAULT '',
	tick INTEGER NOT NULL DEFAULT 0,
	round INTEGER NOT NULL DEFAULT 0,
	payload_json TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS chat (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
	tick INTEGER NOT NULL DEFAULT 0,
	round INTEGER NOT NULL DEFAULT 0,
	steam_id TEXT NOT NULL DEFAULT '',
	name TEXT NOT NULL DEFAULT '',
	text TEXT NOT NULL DEFAULT '',
	kind TEXT NOT NULL DEFAULT '',
	-- Chat channel: 'all' ([ALL]) | 'team' (speaker's side [T]/[CT]) |
	-- '' for system rows / unknown — the channel signal demoinfocs
	-- discards from events.ChatMessage but keeps on SayText2.MsgName.
	channel TEXT NOT NULL DEFAULT '',
	-- Decryption provenance: v1 always writes decrypted=0 — the
	-- extractor cannot distinguish demoinfocs-decrypted rows from
	-- plaintext ones (decryption dispatches inner messages as ordinary
	-- chat events); presence.key_found + matches.enc_messages carry the
	-- honest state.
	decrypted INTEGER NOT NULL DEFAULT 0,
	key_source TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS warnings (
	match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
	seq INTEGER NOT NULL,
	message TEXT NOT NULL DEFAULT '',
	PRIMARY KEY (match_id, seq)
);

CREATE TABLE IF NOT EXISTS jobs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	kind TEXT NOT NULL DEFAULT '',
	path TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL DEFAULT 'queued',
	progress REAL NOT NULL DEFAULT 0,
	stage TEXT NOT NULL DEFAULT 'queued',
	error TEXT NOT NULL DEFAULT '',
	created_at DATETIME NOT NULL,
	started_at DATETIME,
	finished_at DATETIME,
	match_id INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_events_match_round ON events(match_id, round);
CREATE INDEX IF NOT EXISTS idx_events_match_kind ON events(match_id, kind);
CREATE INDEX IF NOT EXISTS idx_events_match_attacker ON events(match_id, attacker);
CREATE INDEX IF NOT EXISTS idx_events_match_victim ON events(match_id, victim);
CREATE INDEX IF NOT EXISTS idx_events_match_kind_tick ON events(match_id, kind, tick);
CREATE INDEX IF NOT EXISTS idx_generic_events_match_name ON generic_events(match_id, name);
CREATE INDEX IF NOT EXISTS idx_chat_match_tick ON chat(match_id, tick);

-- Player sound events: footsteps/lands/jumps/fall damage read from
-- CMsgSosStartSoundEvent at import (extract.sos.go) — one row per
-- ATTRIBUTED player sound; a source entity that resolves to no participant
-- never lands here (identity is never guessed). The SOS NAME carries the
-- surface data (kind/material/team_prefix/sos_name are copied from it at
-- extract time), so no material/VPK join exists — imports work without CS2
-- installed. steam_id is the participant join key (a bot keeps its
-- synthetic 0xFF-prefixed key: this is an event-shaped read, bots are not
-- dropped here — readers that want humans-only route through HumanOnly).
CREATE TABLE IF NOT EXISTS sound_events (
	match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
	tick INTEGER NOT NULL DEFAULT 0,
	round INTEGER NOT NULL DEFAULT 0,
	steam_id TEXT NOT NULL DEFAULT '',
	kind TEXT NOT NULL DEFAULT '',
	material TEXT NOT NULL DEFAULT '',
	team_prefix TEXT NOT NULL DEFAULT '',
	sos_name TEXT NOT NULL DEFAULT ''
);
-- The one access path: GetSoundEvents is always match-scoped and
-- tick-ordered (inclusive window), and the presence count is the same
-- match-bounded scan. Deliberately NO (match_id, kind) twin — every reader
-- of this table is match-bounded, so a second index would only duplicate
-- match_id's leading column without a distinct query to serve.
CREATE INDEX IF NOT EXISTS idx_sound_events_match_tick ON sound_events(match_id, tick);

-- Deep match analytics: derived per-match rows, cross-match career
-- rollups, saved filter presets and the single-row rules config.
-- Deviations from plan §3 are noted per table; every child table FKs to
-- matches(id) ON DELETE CASCADE so delete/reprocess stay one-pass.

CREATE TABLE IF NOT EXISTS round_classifications (
	match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
	round INTEGER NOT NULL,
	label TEXT NOT NULL DEFAULT '',
	confidence REAL NOT NULL DEFAULT 0,
	rule_version INTEGER NOT NULL DEFAULT 0,
	explanation TEXT NOT NULL DEFAULT '',
	PRIMARY KEY (match_id, round)
);

-- Per-side buy classes: the eco thresholds' (analysis_config.eco_full_buy
-- / eco_force) analysis-rule OUTPUT for ONE side of one counted round —
-- the per-side chips and their why tooltips (Economy tab + match report).
-- Owner ruling 2026-11-12 ("all-stored rule", AGENTS.md "Analysis-rule
-- derived values"): analytics.Compute derives them from the run's config
-- at analyze time (store.ReplaceRoundSideClasses — the ONE writer) and
-- every read (store.GetEconomy) fetches the stored row; the retired
-- read-time fill (analytics.EconomyRows, which re-classified with the
-- CURRENT config on every read) survives only as the reference oracle in
-- internal/analytics' eco equivalence test.
--
-- Keys mirror round_economy's (match_id, round, side) — the same per-round
-- per-side grain the classification reads its equip from; round_classifications
-- stays THE round-level classification home (its label feeds the round
-- chips) and this table is its side-scoped extension, written in the SAME
-- Compute pass. A match analyzed before this table existed has NO rows:
-- the Economy view renders the honest "unknown" chip (its classChip
-- fallback) and the force-buy summary counts 0 until a rules save bumps
-- rule_version → the match goes behind → RecomputeAll, or a reprocess
-- re-analyzes it. There is no backfill and no ensure/ALTER path
-- (pre-release policy: stale local data is wiped + re-imported, never
-- migrated). A NEW TABLE reaches every existing DB at Open; adding these
-- as columns on round_classifications would NOT (the baseline only
-- CREATEs), which is why the shape is a table.
-- `team` (metrics expansion §5) is stamped in the SAME Compute pass
-- through the sideparity teamKeyAt formula (rules.TeamKeyAt — the team's
-- final side; '' for an unknown side): this row is side-grained, so it
-- names one team, unlike the round-grain classification above it.
CREATE TABLE IF NOT EXISTS round_side_classes (
	match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
	round INTEGER NOT NULL,
	side TEXT NOT NULL,
	class TEXT NOT NULL DEFAULT '',
	why TEXT NOT NULL DEFAULT '',
	team TEXT NOT NULL DEFAULT '',
	PRIMARY KEY (match_id, round, side)
);

CREATE TABLE IF NOT EXISTS player_round_stats (
	match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
	round INTEGER NOT NULL,
	steam_id TEXT NOT NULL,
	name TEXT NOT NULL DEFAULT '',
	kills INTEGER NOT NULL DEFAULT 0,
	assists INTEGER NOT NULL DEFAULT 0,
	deaths INTEGER NOT NULL DEFAULT 0,
	traded INTEGER NOT NULL DEFAULT 0,
	survived INTEGER NOT NULL DEFAULT 0,
	kast INTEGER NOT NULL DEFAULT 0,
	dmg INTEGER NOT NULL DEFAULT 0,
	util_dmg INTEGER NOT NULL DEFAULT 0,
	money_start INTEGER NOT NULL DEFAULT 0,
	equip INTEGER NOT NULL DEFAULT 0,
	spent INTEGER NOT NULL DEFAULT 0,
	rule_version INTEGER NOT NULL DEFAULT 0,
	-- `side` (metrics expansion §3.2, 2026-11-17): the player's freeze-
	-- end side sample for THIS round (round_player_sides' exact value,
	-- stamped with the row by analytics.PlayerRounds — '' when the round
	-- has no sample). This is the side carrier the plan's side partition
	-- assumes for player_round_stats; without it no per-round stat (KAST,
	-- damage, kills) could be partitioned by side (§6.5).
	side TEXT NOT NULL DEFAULT '',
	-- `won` (metrics expansion §8 M5 row, 2026-11-17): 1 when the round's
	-- winner (rounds.winner) is this row's side — the per-round twin of
	-- player_stats.won, stamped with the row at analyze time so the
	-- side-partitioned win rate reads stored inputs (never a read-time
	-- join to rounds). Unknown side or undecided round ⇒ 0.
	won INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (match_id, round, steam_id)
);
CREATE INDEX IF NOT EXISTS idx_player_round_stats_player ON player_round_stats(match_id, steam_id);

-- Trade-opportunity counts: the two distance-derived per-player metrics,
-- written by analytics.Compute (store.ReplaceTradeOpps — one tx per
-- match) under the match's rule version. Owner ruling 2026-11-12: every
-- rules-derived value is STORED at analyze time (AGENTS.md
-- "Analysis-rule derived values") — the retired query-time json_extract
-- gates (the TradeOppMissed subquery formerly in GetCombatStats and
-- CountPlayerTradeOpportunities, the latter an O(library) scan per
-- profile open) survive only as reference oracles in internal/analytics'
-- equivalence test. Defined ABOVE the Tier-1 index block so its
-- steam_id-leading index can live there (library-wide convention).
--
--   opps   per player: enemy kills in counted rounds (warmup/pregame
--          out; killer and victim both have freeze-end side samples in
--          ct/t and they differ) whose VICTIM was this player's teammate
--          that round, where the player was alive at the death tick (no
--          own death at/before it in that round) and the kill's
--          detail_json.nearDist (extract-measured, config-independent)
--          falls in [0, analysis_config.trade_opp_distance] — the
--          profile Trade-rate denominator, SUMmed library-wide.
--   missed per player: this player's 'untraded' engagements whose paired
--          kill event's nearDist falls in the same range — Combat's
--          "trade opportunities missed" badge (the distance-gated subset
--          of the ungated untraded count, the `untraded_deaths` metric).
--
-- HUMANS ONLY (is_bot = 0): both read surfaces drop bots, so a bot's
-- counts are not stored. SPARSE: a player with both counts at 0 writes
-- no row — reads treat "no row" as 0 (like a missing player_stats row).
-- A trade_opp_distance change bumps rule_version (SetConfig) → the
-- match is behind → RecomputeAll rewrites these rows; there is no
-- ensure/ALTER path (pre-release policy: a DB that lacks this table is
-- wiped + re-imported, never migrated).
CREATE TABLE IF NOT EXISTS match_trade_opps (
	match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
	steam_id TEXT NOT NULL,
	opps INTEGER NOT NULL DEFAULT 0,
	missed INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (match_id, steam_id)
);

-- Stored metric VALUES (owner rulings 2026-11-13): every saved metric is
-- stored and never calculated for a saved read; a metric is always ONE
-- number addressed to a subject —
--   match scope   → one value for this subject in this match (match_id > 0)
--   profile scope → one value for this subject's career      (match_id = 0)
-- subject_key carries the subject: a player's SteamID64 (humans only — the
-- statement already applied store.HumanOnly), a team key ('ct'/'t' — the
-- sideparity teamKeyAt vocabulary), or '' for a match subject (and for the
-- career bucket, which is always player-subject). APP-LEVEL INVARIANT (no
-- schema CHECK — pre-release no-ALTER policy): a match- or team-subject
-- metric's rows always carry match_id > 0 — match_id = 0 is the career
-- bucket alone, pinned by store.InsertMetricValues' guard. dim is the
-- partition key ('' = unpartitioned; side/map/weapon arrive with the
-- partition phases) and value_key the identity slot (the identity
-- metric's value — the winner's key — '': every number-valued row). Both
-- default '' today: no writer partitions or addresses an identity yet.
-- NO HISTORY: rows exist only for the CURRENT generation; outdated rows
-- (either stamp behind) are DELETED by the compute pass, never retained.
-- Stamps are INTERNAL-ONLY: the canonical read serves only rows where both
-- stamps are live; no app surface renders a stamp. value 0 always beside n;
-- a group the statement did not produce has NO row. subject_key has no FK —
-- a career key does not FK to the per-match roster (player_career
-- precedent, schema.sql:566-584). Reaching this table's shape on an
-- existing DB is the wipe's job (pre-release: wipe + re-import, never
-- ALTER).
CREATE TABLE IF NOT EXISTS metric_values (
	metric_id       INTEGER NOT NULL REFERENCES metrics(id) ON DELETE CASCADE,
	match_id        INTEGER NOT NULL DEFAULT 0,   -- 0 = the profile (career) grain
	subject_key     TEXT    NOT NULL DEFAULT '',  -- player SteamID64 | team key ('ct'/'t') | '' (match subject)
	dim             TEXT    NOT NULL DEFAULT '',  -- partition key ('' = unpartitioned)
	value           REAL    NOT NULL DEFAULT 0,
	value_key       TEXT    NOT NULL DEFAULT '',  -- identity value (identity metrics only; '' otherwise)
	n               INTEGER NOT NULL DEFAULT 0,   -- sample size behind the value
	metric_version  INTEGER NOT NULL DEFAULT 0,   -- metrics.version these values were computed under (0 = never stamped = behind)
	rule_version    INTEGER NOT NULL DEFAULT 0,   -- analysis rule generation that fed them (provenance + rules-axis staleness)
	computed_at     DATETIME,
	PRIMARY KEY (metric_id, match_id, subject_key, dim),
	CHECK (match_id >= 0)
);

-- Metric→metric dependencies (owner ruling 6): extracted from expr at save
-- (the metric('name') ref) and stored by the referenced metric's UNIQUE
-- name — the name IS the expression's identity; ids churn on plugin replace
-- (ReplacePluginMetrics deletes + re-inserts), names do not. Re-derived
-- wholesale from the CURRENT expression on every save — no edge ever points
-- at a superseded expression (no-history model). dep_name has deliberately
-- NO FK: a system-removed upstream (plugin disable) must leave the edge so
-- the pass resolves-or-fails it honestly (missing upstream ⇒ dependent rows
-- absent — never 0). metric_id FKs CASCADE. Deleting a REFERENCED metric is
-- blocked at the API, never by the DB (plugin replace must not block).
CREATE TABLE IF NOT EXISTS metric_deps (
	metric_id INTEGER NOT NULL REFERENCES metrics(id) ON DELETE CASCADE,
	dep_name  TEXT    NOT NULL,
	PRIMARY KEY (metric_id, dep_name)
);

-- Tier 1 index pass (library-wide reads). Placed here because every table
-- they target now exists (the baseline script runs top-to-bottom).
--
-- The original three steam_id-leading indexes kill correlated full-table
-- scans on library-wide `WHERE steam_id = ?` reads: RebuildCareer's
-- per-group name subquery (player_stats p2, analytics.go) and
-- ListPlayers' HumanOnlyBySteamID bot check (players). Those are
-- O(library)-per-import and quadratic over a bulk import — measured 16-34 s
-- per RebuildCareer at 1,000 matches / 500-1,000 distinct players without
-- them (linear in the distinct-player count: minutes per import at
-- realistic overlap). Each index is a leading-column mirror of the
-- match_id-first primary key.
--
-- idx_events_kind_match turns library-wide `kind='kill'` scans into an
-- index seek. Its original consumer, CountPlayerTradeOpportunities'
-- per-row NOT EXISTS over every kill ever recorded, retired with the
-- query-time trade-opportunity derivation (2026-11-12 — the count is
-- now stored in match_trade_opps); the index stays for the other
-- library-wide kind-filtered reads (the builtin metric expressions).
--
-- idx_match_trade_opps_steam was the profile's stored trade-
-- opportunity denominator: one `SUM(opps) WHERE steam_id = ?` seek per
-- profile open. That reader (store.CountPlayerTradeOpportunities) left
-- with the profile Trade rate card's metric conversion (dogfooding W3/W4
-- — no production reader of the library-wide SUM remains), and the
-- metric expressions join match_trade_opps through its (match_id,
-- steam_id) primary key instead. The index STAYS: dropping it is DDL,
-- which the pre-release no-DDL rule forbids — it remains the
-- leading-column mirror of the match_id-first primary key above, ready
-- for the next library-wide steam_id read.
--
-- The jobs indexes cover the pending-job lookups (FindPendingJobByPath /
-- FindPendingJobByMatch — path/match_id + non-terminal status, newest
-- first). jobs grows append-forever and these run per listed demo file /
-- per reprocess, so they must not degrade into table scans as history
-- accumulates.
CREATE INDEX IF NOT EXISTS idx_players_steam ON players(steam_id);
CREATE INDEX IF NOT EXISTS idx_player_stats_steam ON player_stats(steam_id, match_id);
CREATE INDEX IF NOT EXISTS idx_player_round_stats_steam ON player_round_stats(steam_id, match_id);
CREATE INDEX IF NOT EXISTS idx_events_kind_match ON events(kind, match_id);
CREATE INDEX IF NOT EXISTS idx_jobs_path ON jobs(path);
CREATE INDEX IF NOT EXISTS idx_jobs_match ON jobs(match_id);
-- Stored metric values: match-leading serves the scoreboard/appendix read
-- AND the childTables per-match clear; the subject-leading member serves
-- the career read (subject_key equality at match_id = 0) and the series
-- read (subject_key equality with match_id > 0) — the same
-- subject_key-leading convention as player_career's consumers, now keyed
-- by the generalized subject (a team key is not a steamid); both members
-- carry the new key columns (subject_key/dim — the metric_values PK) so a
-- key-shaped probe stays an index seek as subjects and partitions land.
-- dep_name-leading serves the delete-block/dependents lookup. The PK's
-- metric_id prefix already serves per-metric invalidation deletes and the
-- sweep's per-metric outdated-row removal.
CREATE INDEX IF NOT EXISTS idx_metric_values_match ON metric_values(match_id, metric_id, subject_key, dim);
CREATE INDEX IF NOT EXISTS idx_metric_values_subject ON metric_values(subject_key, match_id, metric_id, dim);
CREATE INDEX IF NOT EXISTS idx_metric_deps_dep ON metric_deps(dep_name);
CREATE INDEX IF NOT EXISTS idx_match_trade_opps_steam ON match_trade_opps(steam_id, match_id);

CREATE TABLE IF NOT EXISTS clutches (
	match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
	round INTEGER NOT NULL,
	size INTEGER NOT NULL DEFAULT 0,
	steam_id TEXT NOT NULL,
	name TEXT NOT NULL DEFAULT '',
	start_tick INTEGER NOT NULL DEFAULT 0,
	end_tick INTEGER NOT NULL DEFAULT 0,
	bomb_state TEXT NOT NULL DEFAULT '',
	hp_left INTEGER NOT NULL DEFAULT 0,
	equip INTEGER NOT NULL DEFAULT 0,
	won INTEGER NOT NULL DEFAULT 0,
	kill_ticks TEXT NOT NULL DEFAULT '',
	replay_anchor INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (match_id, round, steam_id, start_tick)
);
CREATE INDEX IF NOT EXISTS idx_clutches_player ON clutches(steam_id);

CREATE TABLE IF NOT EXISTS engagements (
	match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
	seq INTEGER NOT NULL,
	tick INTEGER NOT NULL DEFAULT 0,
	round INTEGER NOT NULL DEFAULT 0,
	kind TEXT NOT NULL DEFAULT '',
	a_steam TEXT NOT NULL DEFAULT '',
	a_name TEXT NOT NULL DEFAULT '',
	b_steam TEXT NOT NULL DEFAULT '',
	b_name TEXT NOT NULL DEFAULT '',
	distance REAL NOT NULL DEFAULT 0,
	won_by TEXT NOT NULL DEFAULT '',
	PRIMARY KEY (match_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_engagements_match_kind ON engagements(match_id, kind);
CREATE INDEX IF NOT EXISTS idx_engagements_player ON engagements(match_id, a_steam);

-- Utility rows: one row per grenade DETONATION paired with its throw.
-- Throw-side facts are throw-based (throw_tick + throw_x/throw_y — 0/NULL
-- when no throw paired, never an interpolated throw time); det_x/det_y
-- stay the honest detonation position (stored, no longer displayed).
-- Baseline only (pre-first-release): a column added here cannot reach an
-- existing database, since the baseline only ever CREATEs — the answer
-- is wipe + re-import (make deep-clean CONFIRM=1), never an ALTER path.
CREATE TABLE IF NOT EXISTS utility_events (
	match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
	seq INTEGER NOT NULL,
	tick INTEGER NOT NULL DEFAULT 0,
	throw_tick INTEGER NOT NULL DEFAULT 0,
	round INTEGER NOT NULL DEFAULT 0,
	thrower TEXT NOT NULL DEFAULT '',
	thrower_name TEXT NOT NULL DEFAULT '',
	kind TEXT NOT NULL DEFAULT '',
	throw_x REAL,
	throw_y REAL,
	det_x REAL,
	det_y REAL,
	damage INTEGER NOT NULL DEFAULT 0,
	flash_ms INTEGER NOT NULL DEFAULT 0,
	affected TEXT NOT NULL DEFAULT '',
	site TEXT NOT NULL DEFAULT '',
	trajectory_ref TEXT NOT NULL DEFAULT '',
	PRIMARY KEY (match_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_utility_events_player ON utility_events(match_id, thrower);

-- Cross-match career rollup: NOT per-match (no match_id, no FK) — rebuilt
-- in full from player_stats ⋈ matches; raw counts only (identity, name,
-- match and win counts — every derived career number is a stored metric
-- row). steam_id (the SteamID64 string) is the stable identity key (plan
-- M1 identity notes).
CREATE TABLE IF NOT EXISTS player_career (
	steam_id TEXT PRIMARY KEY,
	name TEXT NOT NULL DEFAULT '',
	matches INTEGER NOT NULL DEFAULT 0,
	wins INTEGER NOT NULL DEFAULT 0,
	updated_at DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS saved_filters (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	scope TEXT NOT NULL DEFAULT '',
	filter_json TEXT NOT NULL DEFAULT '',
	created_at DATETIME NOT NULL,
	UNIQUE (name, scope)
);

-- Single-row rules config (plan M3 §3): id is pinned to 1 by CHECK; the
-- Go GetConfig seeds DefaultConfig on first use (trade 5s / full 20000 /
-- force 10000 / trade-opp 1000u / rule v2 — the 2026-11-18 bump of
-- store.DefaultConfig.RuleVersion 1 → 2: the enemy-damage folds in
-- analytics.rounds.go / analytics.utility.go (owner ruling
-- 2026-11-17) changed stored analysis outputs).
-- The DEFAULTs MIRROR store.DefaultConfig — the Go seed is the ONE
-- canonical source (GetConfig's explicit INSERT writes every column, so
-- these are never read in practice; the eco pair used to disagree here
-- at 4000/2000 — a dead value that made the file contradict the seed).
-- The mirror is pinned by TestAnalysisConfigDDLDefaultsMatchGoSeed, so
-- the two can never silently drift apart again.
CREATE TABLE IF NOT EXISTS analysis_config (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	trade_window_s REAL NOT NULL DEFAULT 5.0,
	eco_full_buy INTEGER NOT NULL DEFAULT 20000,
	eco_force INTEGER NOT NULL DEFAULT 10000,
	trade_opp_distance INTEGER NOT NULL DEFAULT 1000,
	rule_version INTEGER NOT NULL DEFAULT 2
);

-- Communications: the voice presence header + encrypted-chat provenance.
-- The voice CHUNK index is deliberately NOT here: it is one fixed-record
-- <steamid>.idx per player beside its Opus payloads in the match's sidecar
-- (<matchDir>/voice, internal/sidecar) — voice is ~77% of a match's rows,
-- and the index belongs with the audio it addresses. Every voice table FKs
-- to matches(id) ON DELETE CASCADE so delete/reprocess stay one-pass (they
-- join childTables).
--
-- Deliberate deviation from plan §3: there is no voice_players table —
-- per-player summaries are read-time derivations over the sidecar index.

CREATE TABLE IF NOT EXISTS voice_presence (
	match_id INTEGER PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
	chunk_count INTEGER NOT NULL DEFAULT 0,
	player_count INTEGER NOT NULL DEFAULT 0,
	caster_count INTEGER NOT NULL DEFAULT 0,
	key_found INTEGER NOT NULL DEFAULT 0,
	out_sample_rate INTEGER NOT NULL DEFAULT 16000
);

-- Custom metric engine + read-only SQL console (plan §2.1–2.2).
--
-- Coordination contract: the `metrics` table column list below is FIXED —
-- internal/store/platform_store.go embeds the identical DDL as its
-- defensive ensureMetricsTable fallback and writes plugin rows into it
-- (ON CONFLICT(name) DO UPDATE). Keep both copies byte-compatible.
-- short_name is optional user-entered display text (DEFAULT ''): it is
-- read ONLY where a metric column header is width-constrained — the
-- display criterion there is short_name || title || name (today exactly
-- one site: Match's scoreboard metric header), title || name everywhere
-- else.
--
-- Builtins (origin='builtin') are seeded below: exactly SIXTY-ONE —
-- trade_rate (owner ruling) plus the dogfooding set (design §3.0: 8
-- match / 9 profile scopes) — trade_rate + adr, entry_rate, hs_pct,
-- kast, kd, trade_rate_deaths + kda (match; kda is w13d's scoreboard
-- KDA conversion from a Go calculation, and its row sits at the end of
-- the INSERT below) and the nine career_* rows (profile, inert until
-- their surface switches) — plus the 42-row inferred set: 38
-- match-scope restatements (27 single-source rows over
-- the per-match player stats, rounds, duels, clutches, grenades and
-- drops; 10 over the stored round/side buy classifications; 1
-- victim-side duel count) and 4 profile-scope rows (career_clutches +
-- the three opening-duel rows) — plus the M3 combat-damage addendum
-- (dmg_no_kill + kill_conversion, plan §7 M3; 2026-11-17 re-pin of the
-- FIFTY-NINE count and the scope split it sanctions: the plan's §8
-- seed list names both rows as numeric match seeds) — plus the Option
-- A count addendum (22 rows: 16 match raw player_stats count rows + 6
-- profile rows — owner Option A extension, 2026-11-17, an owner
-- amendment the plan's §8 does not list) — plus the subject-axis
-- addendum (4 rows with an explicit subject in their own INSERT: 3
-- match-scope — lost_equip (match subject) + team_force_win_rate and
-- team_lost_equip (team subjects) — and 1 profile win_pct; plan §8
-- (M8/M4 rows), 2026-11-17 — the M8/M4 rows the grammar expresses;
-- pistol_hold and avg_equip_gap were reported NOT expressible in the
-- grammar at that point (no next-round window, no per-row subtraction)
-- and are no longer reported — they land in the grammar addendum
-- below) — plus the identity addendum (5
-- match rows with an explicit subject AND the identity format: the M1
-- top-card seeds top_fragger/best_adr/most_util/entry_opens/most_mvps
-- over argmax — plan §8 (M1 identity row), 2026-11-17) — plus the
-- grammar addendum (2 rows with an explicit subject in their own
-- INSERT: pistol_hold + avg_equip_gap, plan §8 (M8 rows), 2026-11-17 —
-- the two M8 rows Phase 4 deferred as inexpressible, now over the
-- next() round window and the diff() row difference — internal/metrics
-- doc.go). Scope split:
-- 76 match / 33 profile (2026-11-17: +2 match M3, then +16 match +6
-- profile Option A, then +3 match +1 profile subject-axis, then +5
-- match identity, then +10 profile partition, then +3 profile weapon;
-- 2026-11-18: +1 profile weapon-damage flip, then +2 match
-- view-aggregate relocation rows — the ME8 audit's force-card counts).
-- The profile rows land here with the match rows: one owner for one
-- statement, zero visible effect (nothing reads them until their
-- surface converts). These rows are how the set reaches a database
-- seeded before them: the INSERT OR IGNORE below ADDS missing rows at
-- every Open and never rewrites a stored one (pre-release policy: no
-- migrations, no versioned contracts — stale seed text stays as
-- written until the row is wiped).
-- internal/metrics' fixture test locks each row's name/expr/scope/
-- format/short_name/denominator/doc/count and proves every expression
-- compiles and returns the hand-computed seed values under the join
-- grammar (internal/metrics/doc.go).

-- subject/partition (metrics expansion §4, 2026-11-17): the metric's
-- addressing — WHICH subject its values are keyed by (player | match |
-- team; the seed's player default means no seed row changes) and how a
-- match/team subject's rows split ('' | side | map | weapon — the
-- partition phases write their own values; '' today). format carries no
-- SQL CHECK: its vocabulary is the app-level contract
-- (metricservice.metricFormats — which gains 'identity', the key-valued
-- format, beside this readiness change).
CREATE TABLE IF NOT EXISTS metrics (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT UNIQUE NOT NULL,
	title TEXT NOT NULL DEFAULT '',
	short_name TEXT NOT NULL DEFAULT '',
	expr TEXT NOT NULL,
	scope TEXT NOT NULL DEFAULT 'match' CHECK (scope IN ('match', 'profile')),
	subject TEXT NOT NULL DEFAULT 'player' CHECK (subject IN ('player', 'match', 'team')),
	partition TEXT NOT NULL DEFAULT '' CHECK (partition IN ('', 'side', 'map', 'weapon')),
	format TEXT NOT NULL DEFAULT '',
	doc TEXT NOT NULL DEFAULT '',
	origin TEXT NOT NULL DEFAULT 'user',
	plugin_id TEXT NOT NULL DEFAULT '',
	denominator TEXT NOT NULL DEFAULT '',
	version INTEGER NOT NULL DEFAULT 1,
	created_at DATETIME
);

-- Console run history: appended after every Run (success or error), capped
-- at the 100 newest by AppendQueryHistory. `row_count` (not `rows`, a
-- SQLite keyword) carries the returned-row count.
CREATE TABLE IF NOT EXISTS query_history (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	sql TEXT NOT NULL,
	ms INTEGER NOT NULL DEFAULT 0,
	row_count INTEGER NOT NULL DEFAULT 0,
	ok INTEGER NOT NULL DEFAULT 0,
	ran_at DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS saved_queries (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL UNIQUE,
	description TEXT NOT NULL DEFAULT '',
	sql TEXT NOT NULL,
	created_at DATETIME NOT NULL
);

-- User report templates — the Reports Builder's authored documents.
-- Document-shaped like saved_queries above (one row = one document: a
-- unique identity + the payload + a timestamp), NOT the metrics origin
-- partition: this table holds ONE origin's rows (every insert writes
-- origin = 'user'), so it needs no origin rank, no plugin_id and no
-- version counter — `origin` exists so ListReportTemplates can attribute
-- EVERY template (builtin / user / plugin) through one field, which is
-- where attribution rides (platformservice.go reportTplFromPlugin).
--
-- `id` is the template's IDENTITY as a slug, not a row number: it must
-- satisfy the plugin manifest's slug contract ^[a-z0-9-]{2,40}$
-- (internal/plugin/manifest.go slugRe) so a saved template is
-- bundle-able by a later wave without re-shaping its id — the service
-- slugifies the title on create and de-dupes against every id already
-- in play (platformservice.go SaveReportTemplate). scope/format carry
-- the same CHECK vocabulary the plugin manifest validates, so a stored
-- row can never hold a value the renderer's switch rejects.
--
-- One baseline, no versioning (AGENTS "Version nothing until the first
-- release"): this table is part of THE schema.sql applied on every Open
-- — there is no schema_version and no upgrade path; a schema-reach
-- problem is resolved by wipe + re-import, never by an ALTER.
CREATE TABLE IF NOT EXISTS report_templates (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	scope TEXT NOT NULL CHECK (scope IN ('match', 'player', 'round')),
	format TEXT NOT NULL CHECK (format IN ('md', 'html')),
	body TEXT NOT NULL,
	origin TEXT NOT NULL DEFAULT 'user',
	created_at DATETIME NOT NULL,
	updated_at DATETIME NOT NULL
);

-- THE builtins, seeded (see header): exactly one hundred and nine —
-- trade_rate
-- (the original owner ruling), the dogfooding set (seven more match-
-- scope rows and nine profile-scope rows), the inferred set (42
-- rows: 38 match / 4 profile), the M3 combat-damage addendum (2
-- match rows, dmg_no_kill + kill_conversion — plan §7 M3/§8, the
-- 2026-11-17 count re-pin), the Option A count addendum (22 rows:
-- 16 match raw-count rows + 6 profile rows — owner Option A
-- extension, 2026-11-17) and the subject-axis addendum (4 rows —
-- plan §8 (M8/M4 rows), 2026-11-17: lost_equip + win_pct restate the
-- Economy/profile cards' Formula titles, the two team rows are the
-- per-team halves of the same Economy cards; each with the
-- interpretation recorded in its doc). The identity addendum (5
-- match rows in their own INSERT below — plan §8 (M1 identity row),
-- 2026-11-17) carries format=identity, the first seeded rows whose
-- value is a KEY, the partition addendum (10 rows in their own
-- INSERT below — plan §8 (M5/M6 rows), 2026-11-17: the Sides and
-- Maps tables' stored twins, every row partition='side' or 'map') and
-- the weapon addendum (3 rows — plan §8 (M7 row), 2026-11-17:
-- kills/headshots matched the fold EXACTLY over the golden demo and
-- shipped; the damage column's structural gap escalated, then FLIPPED
-- 2026-11-18 — the capped_dmg ingest stamp closed Δ4509 (HP-cap 4330 +
-- known-side team 164 + post-match 15), the M7 gate pinned equality and
-- the column migrated — 72 match + 33 profile across the whole set) and
-- the grammar addendum (2 rows in their own
-- INSERT below — plan §8 (M8 rows), 2026-11-17: pistol_hold +
-- avg_equip_gap, the two M8 rows the Phase 4 grammar finding deferred
-- as inexpressible, over the next() round window and the diff() row
-- difference) and the view-aggregate relocation addendum (2 rows in
-- their own INSERT below — ME8 exception audit, 2026-11-18:
-- team_force_wins + team_force_rounds, the force card's per-team count
-- pairs the view still computed — the view-aggregate rule's third
-- clause, cited in that block) — 76 match + 33 profile across the
-- whole set). The eighth
-- match-scope dogfooding row (kda, w13d's
-- scoreboard KDA conversion) sits at the END of the first INSERT — row
-- order here is presentation only (ListMetrics orders builtins by
-- name), so its position changes nothing but the numbering.
-- INSERT OR IGNORE keyed on the UNIQUE name: re-applying the baseline
-- on every Open must not duplicate or reset a row — it is also the one
-- path by which rows 17…59 reach a database seeded before them.
-- short_name is written explicitly: header labels ONLY — the
-- dogfooding set's scoreboard/Combat labels and, among the inferred
-- set, the nine width-constrained scoreboard columns (A, Open K, Open
-- D, Streak, 2K, 3K, 4K, 5K, Trade); every other row ships empty ('' —
-- its header falls back to title; display criterion
-- short_name || title || name — Match's scoreboard metric header).
-- Every short_name is at most SIX characters — the same cap
-- SaveMetric enforces on user input (metricservice.go).
-- version is omitted (DEFAULT 1) on every row.
-- The exprs are the grammar shapes internal/metrics/doc.go documents;
-- trade_rate's is the join-grammar example — the engine derives
-- `LEFT JOIN match_trade_opps ON player_stats.match_id = match_trade_opps.match_id
--  AND player_stats.steam_id = match_trade_opps.steam_id` (career_trade_rate
-- recomputes the same join at profile scope: the cross-scope ref ban
-- forbids referencing the match seed from a profile metric).
INSERT OR IGNORE INTO metrics (name, title, short_name, expr, scope, format, doc, origin, denominator, created_at) VALUES
('trade_rate', 'Trade rate', '',
 'from player_stats, match_trade_opps: ratio(sum(trade_kills), sum(opps))',
 'match', 'percent',
 'Formula: sum(player_stats.trade_kills) / sum(match_trade_opps.opps) — trade successes ÷ trade opportunities, addressed per player over the joined sources — a ratio, so it may top 100%.',
 'builtin', '', CURRENT_TIMESTAMP),
-- match-scope dogfooding set (D1/D4/D5/D6/D7/D8): the four converted
-- scoreboard columns plus the Combat Entry%/Trade% pair — recompute
-- from the raw stored inputs, never a query-time calculation.
-- ADR, Entry% and career_adr carry the `rounds` DENOMINATOR (owner
-- ruling 2026-11-16): CS2 per-round statistics divide by the match's
-- rounds, never by the rounds the player personally played (100 damage
-- in 1 of 24 rounds is ADR ≈ 4.2), and career ADR is the POOLED
-- micro-average Σ damage ÷ Σ rounds of those matches — never an
-- unweighted mean of per-match ADRs (that older ruling is superseded).
-- The engine supplies the divisor from the denominator column: match
-- scope counts the match's rounds, profile scope the subject's
-- player_round_stats rows (human roster × every counted round — bots
-- carry no per-round rows, 2026-11-17).
('adr', 'ADR', 'ADR',
 'from player_stats: sum(total_damage)',
 'match', 'float1',
 'Formula: sum(player_stats.total_damage) / the match''s counted rounds (denominator: rounds) — enemy damage per round of the match, addressed per player — never the rounds that player personally played.',
 'builtin', 'rounds', CURRENT_TIMESTAMP),
('entry_rate', 'Entry%', 'Entry%',
 'from player_stats: sum(entry_kills)',
 'match', 'percent',
 'Formula: sum(player_stats.entry_kills) / the match''s rounds (denominator: rounds) — entry (first-blood) kills ÷ the match''s rounds, addressed per player — a percent; at most one first blood per round.',
 'builtin', 'rounds', CURRENT_TIMESTAMP),
('hs_pct', 'HS%', 'HS%',
 'from player_stats: ratio(sum(headshots), sum(kills))',
 'match', 'percent',
 'Formula: sum(player_stats.headshots) / sum(player_stats.kills) — headshots as a share of the player''s kills, addressed per player — a percent (matches the stored HS% on imported data).',
 'builtin', '', CURRENT_TIMESTAMP),
('kast', 'KAST%', 'KAST%',
 'from player_round_stats: avg(kast)',
 'match', 'percent',
 'Formula: avg(player_round_stats.kast) — the share of the player''s recorded rounds with a K, A, T or S, addressed per player — a percent (the scoreboard''s KAST%).',
 'builtin', '', CURRENT_TIMESTAMP),
('kd', 'K/D', 'K/D',
 'from player_stats: ratio(sum(kills), sum(deaths))',
 'match', 'float2',
 'Formula: sum(player_stats.kills) / sum(player_stats.deaths) — kills per death, addressed per player — no deaths → 0 beside N, where the scoreboard''s K/D shows the kill count.',
 'builtin', '', CURRENT_TIMESTAMP),
('trade_rate_deaths', 'Trade%', 'Trade%',
 'from player_stats: ratio(sum(trade_kills), sum(deaths))',
 'match', 'percent',
 'Formula: sum(player_stats.trade_kills) / sum(player_stats.deaths) — trade kills ÷ the player''s own deaths, addressed per player — a ratio, not a share; may top 100% (see Trade rate).',
 'builtin', '', CURRENT_TIMESTAMP),
-- profile-scope dogfooding set (D2/D3/D5/D6/D9/D10/D11/D12): inert
-- until their surface converts — nothing reads a profile-scope seed yet.
('career_adr', 'ADR', 'ADR',
 'from player_stats: sum(total_damage)',
 'profile', 'float1',
 'Formula: sum(player_stats.total_damage) / the rounds of their matches (denominator: rounds) — enemy damage per round of those matches, addressed per player — pooled, never a mean of per-match ADRs.',
 'builtin', 'rounds', CURRENT_TIMESTAMP),
('career_adr_sigma', 'ADR σ', 'ADR σ',
 'from player_stats: stddev(adr)',
 'profile', 'float1',
 'Formula: stddev(player_stats.adr) — the population standard deviation (σ) of the player''s per-match ADR over their career, addressed per player.',
 'builtin', '', CURRENT_TIMESTAMP),
('career_avg_enemies_flashed', 'Avg enemies flashed', 'Flash',
 'from player_stats: avg(enemies_flashed)',
 'profile', 'float1',
 'Formula: avg(player_stats.enemies_flashed) — the player''s mean enemies-flashed count per match over their career, addressed per player.',
 'builtin', '', CURRENT_TIMESTAMP),
('career_avg_util_damage', 'Avg util damage', 'Util',
 'from player_stats: avg(utility_damage)',
 'profile', 'float1',
 'Formula: avg(player_stats.utility_damage) — the player''s mean utility damage per match over their career, addressed per player.',
 'builtin', '', CURRENT_TIMESTAMP),
('career_clutch_win_rate', 'Clutch win %', 'CW%',
 'from clutches: avg(won)',
 'profile', 'percent',
 'Formula: avg(clutches.won) — the share of the player''s career clutches won (0/1 outcomes, shown as a percent), addressed per player — the profile''s win share.',
 'builtin', '', CURRENT_TIMESTAMP),
('career_hs_pct', 'HS%', 'HS%',
 'from player_stats: ratio(sum(headshots), sum(kills))',
 'profile', 'percent',
 'Formula: sum(player_stats.headshots) / sum(player_stats.kills) — headshots as a share of the player''s career kills, addressed per player — pooled career totals, a percent.',
 'builtin', '', CURRENT_TIMESTAMP),
('career_kast', 'KAST%', 'KAST%',
 'from player_round_stats: avg(kast)',
 'profile', 'percent',
 'Formula: avg(player_round_stats.kast) — the mean KAST flag over every stored round of the player''s career, addressed per player — a percent.',
 'builtin', '', CURRENT_TIMESTAMP),
('career_kd', 'K/D', 'K/D',
 'from player_stats: ratio(sum(kills), sum(deaths))',
 'profile', 'float2',
 'Formula: sum(player_stats.kills) / sum(player_stats.deaths) — kills per death pooled over the player''s career, addressed per player — no deaths → 0 beside N (the scoreboard floors instead).',
 'builtin', '', CURRENT_TIMESTAMP),
('career_trade_rate', 'Trade rate', 'Trade%',
 'from player_stats, match_trade_opps: ratio(sum(trade_kills), sum(opps))',
 'profile', 'percent',
 'Formula: sum(player_stats.trade_kills) / sum(match_trade_opps.opps) over the engine-derived LEFT JOIN on (match_id, steam_id) — addressed per player over the joined sources — a ratio; may top 100%.',
 'builtin', '', CURRENT_TIMESTAMP),
-- ---- inferred set, match scope (27 rows): per-match restatements of
-- the stored player, round, duel, clutch, grenade and drop facts — one
-- metric, one number; every row LIST they count stays source data.
('assists', 'Assists', 'A',
 'from player_stats: sum(assists)',
 'match', 'int',
 'Formula: sum(player_stats.assists) — cross-team assists this player earned (not flash assists), addressed per player — the scoreboard''s A column.',
 'builtin', '', CURRENT_TIMESTAMP),
('flash_assists', 'Flash assists', '',
 'from player_stats: sum(flash_assists)',
 'match', 'int',
 'Formula: sum(player_stats.flash_assists) — assists for blinding an enemy a teammate then killed, addressed per player — the expanded player row''s Flash assists count.',
 'builtin', '', CURRENT_TIMESTAMP),
('enemies_flashed', 'Enemies flashed', '',
 'from player_stats: sum(enemies_flashed)',
 'match', 'int',
 'Formula: sum(player_stats.enemies_flashed) — enemies blinded by this player''s flashes (each counted once), addressed per player — the Enemies flashed count in the expanded player row.',
 'builtin', '', CURRENT_TIMESTAMP),
('entry_kills', 'Opening kills', 'Open K',
 'from player_stats: sum(entry_kills)',
 'match', 'int',
 'Formula: sum(player_stats.entry_kills) — round-opening first-blood kills, addressed per player — the scoreboard''s Open K column (same recording as opening kills).',
 'builtin', '', CURRENT_TIMESTAMP),
('entry_deaths', 'Opening deaths', 'Open D',
 'from player_stats: sum(entry_deaths)',
 'match', 'int',
 'Formula: sum(player_stats.entry_deaths) — round-opening first-blood victims, addressed per player — the scoreboard''s Open D column, beside Open K.',
 'builtin', '', CURRENT_TIMESTAMP),
('best_streak', 'Best streak', 'Streak',
 'from player_stats: max(best_streak)',
 'match', 'int',
 'Formula: max(player_stats.best_streak) — the longest kill streak the player reached, addressed per player — the scoreboard''s Streak column.',
 'builtin', '', CURRENT_TIMESTAMP),
('two_k', '2K', '2K',
 'from player_stats: sum(two_k)',
 'match', 'int',
 'Formula: sum(player_stats.two_k) — rounds with exactly 2 kills (one tier each), addressed per player — the scoreboard''s 2K column.',
 'builtin', '', CURRENT_TIMESTAMP),
('three_k', '3K', '3K',
 'from player_stats: sum(three_k)',
 'match', 'int',
 'Formula: sum(player_stats.three_k) — rounds with exactly 3 kills (one tier each), addressed per player — the scoreboard''s 3K column.',
 'builtin', '', CURRENT_TIMESTAMP),
('four_k', '4K', '4K',
 'from player_stats: sum(four_k)',
 'match', 'int',
 'Formula: sum(player_stats.four_k) — rounds with exactly 4 kills (one tier each), addressed per player — the scoreboard''s 4K column.',
 'builtin', '', CURRENT_TIMESTAMP),
('five_k', '5K', '5K',
 'from player_stats: sum(five_k)',
 'match', 'int',
 'Formula: sum(player_stats.five_k) — rounds with exactly 5 kills (a five-kill round counts only here), addressed per player — the scoreboard''s 5K column.',
 'builtin', '', CURRENT_TIMESTAMP),
('rounds_with_assist', 'Assist rounds', '',
 'from player_round_stats: count(where assists > 0)',
 'match', 'int',
 'Formula: count(player_round_stats rows WHERE assists > 0) — the player''s rounds with ≥1 assist: the KAST A component as a count of rounds, addressed per player.',
 'builtin', '', CURRENT_TIMESTAMP),
('rounds_traded', 'Traded rounds', '',
 'from player_round_stats: sum(traded)',
 'match', 'int',
 'Formula: sum(player_round_stats.traded) — rounds where this player''s own death was answered inside the trade window: the KAST T component, addressed per player.',
 'builtin', '', CURRENT_TIMESTAMP),
('trade_kills', 'Trade kills', 'Trade',
 'from player_stats: sum(trade_kills)',
 'match', 'int',
 'Formula: sum(player_stats.trade_kills) — kills that answered a teammate''s death inside the trade window, addressed per player — the Trade column and Trade rate''s numerator.',
 'builtin', '', CURRENT_TIMESTAMP),
('missed_trades', 'Missed trades', '',
 'from player_stats, match_trade_opps: sum(missed)',
 'match', 'int',
 'Formula: sum(match_trade_opps.missed) — teammate deaths nobody answered inside the window, addressed per player over the joined sources — zero opportunities still shows 0.',
 'builtin', '', CURRENT_TIMESTAMP),
('eng_opening', 'Opening engagements', '',
 'from engagements: count(where kind = ''opening'')',
 'match', 'int',
 'Formula: count(engagements rows WHERE kind = ''opening'') — round-opening duels with this player as killer, addressed per player — from the duel list; unknown-side rounds read lower than Entry.',
 'builtin', '', CURRENT_TIMESTAMP),
('eng_trade', 'Trade engagements', '',
 'from engagements: count(where kind = ''trade'')',
 'match', 'int',
 'Formula: count(engagements rows WHERE kind = ''trade'') — strict-window trade kills with this player as killer, addressed per player — the same number as Trade kills, from the duel list.',
 'builtin', '', CURRENT_TIMESTAMP),
('eng_traded', 'Kills traded (A-side)', '',
 'from engagements: count(where kind = ''traded'')',
 'match', 'int',
 'Formula: count(engagements rows WHERE kind = ''traded'') — this player''s kills the enemy answered inside the window (killer-side), addressed per player — own unanswered deaths are Untraded deaths.',
 'builtin', '', CURRENT_TIMESTAMP),
('eng_untraded', 'Kills untraded (A-side)', '',
 'from engagements: count(where kind = ''untraded'')',
 'match', 'int',
 'Formula: count(engagements rows WHERE kind = ''untraded'') — this player''s kills the enemy did not answer inside the window (killer-side), addressed per player — Untraded deaths counts the victim side.',
 'builtin', '', CURRENT_TIMESTAMP),
('clutches', 'Clutches', '',
 'from clutches: count()',
 'match', 'int',
 'Formula: count(clutches) — the 1vN attempts recorded for this player in the match, addressed per player — the count; the clutch list stays a match detail.',
 'builtin', '', CURRENT_TIMESTAMP),
('clutch_win_rate', 'Clutch win %', '',
 'from clutches: avg(won)',
 'match', 'percent',
 'Formula: avg(clutches.won) — the share of the player''s clutches won, shown as a percent, addressed per player — the match-scope twin of career Clutch win %.',
 'builtin', '', CURRENT_TIMESTAMP),
('clutch_avg_size', 'Avg clutch size', '',
 'from clutches: avg(size)',
 'match', 'float1',
 'Formula: avg(clutches.size) — the mean size (the N of the 1vN) of the player''s clutches, addressed per player.',
 'builtin', '', CURRENT_TIMESTAMP),
('clutch_avg_hp', 'Avg clutch HP', '',
 'from clutches: avg(hp_left)',
 'match', 'float1',
 'Formula: avg(clutches.hp_left) — the mean hit points the player ended their clutches with (0 = died alone), addressed per player.',
 'builtin', '', CURRENT_TIMESTAMP),
('clutch_avg_equip', 'Avg clutch equip', '',
 'from clutches: avg(equip)',
 'match', 'currency',
 'Formula: avg(clutches.equip) — the mean equipment value the player held in their clutches, in whole dollars, addressed per player.',
 'builtin', '', CURRENT_TIMESTAMP),
('util_nades', 'Nades thrown', '',
 'from utility_events: count()',
 'match', 'int',
 'Formula: count(utility_events) — grenade detonations credited to this player''s throws (one per detonation), addressed per player — the per-throw list stays a replay detail.',
 'builtin', '', CURRENT_TIMESTAMP),
('util_dmg', 'Util damage (paired)', '',
 'from utility_events: sum(damage)',
 'match', 'int',
 'Formula: sum(utility_events.damage) — damage this player''s grenades dealt inside their burn window, addressed per player — hits outside a grenade''s window don''t count.',
 'builtin', '', CURRENT_TIMESTAMP),
('util_flash_ms', 'Blind time (ms)', '',
 'from utility_events: sum(flash_ms)',
 'match', 'int',
 'Formula: sum(utility_events.flash_ms) — the total blind time this player''s flashes applied, addressed per player — whole milliseconds (no time format yet).',
 'builtin', '', CURRENT_TIMESTAMP),
('weapon_drops', 'Weapon drops', '',
 'from events: count(where kind = ''weapon_drop'')',
 'match', 'int',
 'Formula: count(events rows WHERE kind = ''weapon_drop'') — weapon drops recorded at this player''s deaths, addressed per player — the per-drop list stays a replay detail.',
 'builtin', '', CURRENT_TIMESTAMP),
-- ---- inferred set, profile scope (1 row).
('career_clutches', 'Clutches', '',
 'from clutches: count()',
 'profile', 'int',
 'Formula: count(clutches) over the whole library — the player''s career 1vN clutch count, addressed per player — the profile''s Clutches number; the list stays a match detail.',
 'builtin', '', CURRENT_TIMESTAMP),
-- ---- inferred set, T2 (10 rows): counts over the stored analysis-rule
-- outputs — a round label and a per-side buy class are round-grain
-- text, so a metric counts them per player and never renders them.
('round_label_eco', 'Rounds labeled eco', '',
 'from player_round_stats, round_classifications: count(where label = ''eco'')',
 'match', 'int',
 'Formula: count(player_round_stats rows joined to round_classifications ON (match_id, round) WHERE label = ''eco'') — rounds played with the label eco, addressed per player over the joined sources.',
 'builtin', '', CURRENT_TIMESTAMP),
('round_label_force', 'Rounds labeled force', '',
 'from player_round_stats, round_classifications: count(where label = ''force'')',
 'match', 'int',
 'Formula: count(player_round_stats rows joined to round_classifications ON (match_id, round) WHERE label = ''force'') — rounds played with the label force, addressed per player over the joined sources.',
 'builtin', '', CURRENT_TIMESTAMP),
('round_label_full', 'Rounds labeled full', '',
 'from player_round_stats, round_classifications: count(where label = ''full'')',
 'match', 'int',
 'Formula: count(player_round_stats rows joined to round_classifications ON (match_id, round) WHERE label = ''full'') — rounds played with the label full, addressed per player over the joined sources.',
 'builtin', '', CURRENT_TIMESTAMP),
('round_label_save', 'Rounds labeled save', '',
 'from player_round_stats, round_classifications: count(where label = ''save'')',
 'match', 'int',
 'Formula: count(player_round_stats rows joined to round_classifications ON (match_id, round) WHERE label = ''save'') — rounds played with the label save, addressed per player over the joined sources.',
 'builtin', '', CURRENT_TIMESTAMP),
('pistol_rounds', 'Pistol rounds', '',
 'from player_round_stats, round_classifications: count(where label = ''pistol'')',
 'match', 'int',
 'Formula: count(player_round_stats rows joined to round_classifications ON (match_id, round) WHERE label = ''pistol'') — rounds played with the label pistol, addressed per player over the joined sources.',
 'builtin', '', CURRENT_TIMESTAMP),
('side_class_eco', 'Rounds on eco side', '',
 'from round_player_sides, round_side_classes: count(where class = ''eco'')',
 'match', 'int',
 'Formula: count(round_player_sides rows joined to round_side_classes ON (match_id, round, side) WHERE class = ''eco'') — rounds played on an eco side, addressed per player over the joined sources.',
 'builtin', '', CURRENT_TIMESTAMP),
('side_class_force', 'Rounds on force side', '',
 'from round_player_sides, round_side_classes: count(where class = ''force'')',
 'match', 'int',
 'Formula: count(round_player_sides rows joined to round_side_classes ON (match_id, round, side) WHERE class = ''force'') — rounds played on a force side, addressed per player over the joined sources.',
 'builtin', '', CURRENT_TIMESTAMP),
('side_class_full', 'Rounds on full-buy side', '',
 'from round_player_sides, round_side_classes: count(where class = ''full'')',
 'match', 'int',
 'Formula: count(round_player_sides rows joined to round_side_classes ON (match_id, round, side) WHERE class = ''full'') — rounds played on a full-buy side, addressed per player over the joined sources.',
 'builtin', '', CURRENT_TIMESTAMP),
('side_class_save', 'Rounds on save side', '',
 'from round_player_sides, round_side_classes: count(where class = ''save'')',
 'match', 'int',
 'Formula: count(round_player_sides rows joined to round_side_classes ON (match_id, round, side) WHERE class = ''save'') — rounds played on a save side, addressed per player over the joined sources.',
 'builtin', '', CURRENT_TIMESTAMP),
('side_class_pistol', 'Rounds on pistol side', '',
 'from round_player_sides, round_side_classes: count(where class = ''pistol'')',
 'match', 'int',
 'Formula: count(round_player_sides rows joined to round_side_classes ON (match_id, round, side) WHERE class = ''pistol'') — rounds played on a pistol side, addressed per player over the joined sources.',
 'builtin', '', CURRENT_TIMESTAMP),
-- ---- addendum: the victim-side duel count (1 row) — the engagements
-- table read through its curated victim-side source (whitelist.go
-- engagements_victim).
('untraded_deaths', 'Untraded deaths', '',
 'from engagements_victim: count(where kind = ''untraded'')',
 'match', 'int',
 'Formula: count(engagements rows WHERE kind = ''untraded'') — deaths of this player nobody answered inside the window, addressed per player — the Combat tab''s Untraded deaths column.',
 'builtin', '', CURRENT_TIMESTAMP),
-- ---- addendum: the opening-duel trio (3 rows, profile scope) — the
-- additive sum(a + b) chain is what the duel total needs.
('career_opening_rate', 'Opening duels', '',
 'from player_stats: ratio(sum(entry_kills), sum(entry_kills + entry_deaths))',
 'profile', 'percent',
 'Formula: sum(player_stats.entry_kills) / sum(player_stats.entry_kills + player_stats.entry_deaths) — career opening duels won, shown as a percent, addressed per player (the Opening duels card).',
 'builtin', '', CURRENT_TIMESTAMP),
('career_openings', 'Openings', '',
 'from player_stats: sum(entry_kills + entry_deaths)',
 'profile', 'int',
 'Formula: sum(player_stats.entry_kills + player_stats.entry_deaths) — the player''s career opening duels: the opening kill plus the first-blood deaths it produced, addressed per player.',
 'builtin', '', CURRENT_TIMESTAMP),
('career_opener_wins', 'Opener wins', '',
 'from player_stats: sum(entry_kills)',
 'profile', 'int',
 'Formula: sum(player_stats.entry_kills) — opening kills across the player''s career, addressed per player — the wins half of the Opening duels percentage.',
 'builtin', '', CURRENT_TIMESTAMP),
-- ---- addendum: the M3 combat-damage conversions (2 rows, match
-- scope, 2026-11-17 — plan §7 M3 / §8): Damage-no-kill and Kill
-- conversion % left the retired store.GetCombatStats SQL for the
-- EXISTS construct (plan §6.2/D7 — same-tick, same-attacker, same-
-- victim kill detection spelled in the expression). Scale:
-- kill_conversion is a percent in the engine's
-- 0..1 convention (the retired read-DTO carried 0..100); the
-- equivalence test pins value × 100 == the retired number.
-- Enemy gate (owner ruling 2026-11-17): both rows filter
-- same_side = 0, the ingest stamp's permissive enemy rule (both
-- sides known and equal → same-side, else enemy) — the same
-- predicate as player_stats.total_damage. Same-side damage leaves
-- BOTH halves of kill_conversion (numerator and denominator); an
-- unknown side stamps 0 and still counts, in parity.
('dmg_no_kill', 'Damage no kill', '',
 'from events: sum(where kind = ''damage'' and not exists(kind = ''kill'' and tick = outer.tick and attacker = outer.attacker and victim = outer.victim) and same_side = 0, dmg)',
 'match', 'int',
 'Formula: sum(events.dmg over enemy damage events WHERE no same-tick, same-actor kill exists) — damage that did not convert into a kill, addressed per player.',
 'builtin', '', CURRENT_TIMESTAMP),
('kill_conversion', 'Kill conversion %', '',
 'from events: ratio(sum(where kind = ''damage'' and exists(kind = ''kill'' and tick = outer.tick and attacker = outer.attacker and victim = outer.victim) and same_side = 0, dmg), sum(where kind = ''damage'' and same_side = 0, dmg))',
 'match', 'percent',
 'Formula: sum(events.dmg with a same-tick, same-actor kill) / sum(events.dmg), both over enemy damage — the share of this player''s damage that converts into kills, addressed per player — a percent.',
 'builtin', '', CURRENT_TIMESTAMP),
-- ---- addendum: the Option A count addendum (22 rows — owner Option
-- A extension, 2026-11-17: the metrics system IS the gameplay-
-- statistics layer, so every raw gameplay-stat column that is sum-
-- expressible converts to a count seed; exclusions are the stated
-- (a)–(e) kinds — identity columns, JSON blobs, existing canonical
-- seeds, plan-owned wins, derived formulas). 16 match rows over the
-- raw player_stats columns (the scoreboard's K/D/MVPs/DMG/Util
-- columns among them) + 6 profile rows: the career twins of the
-- scoreboard five and the career match count. score stays UNSEEDED
-- (game-internal composite — its sum has no honest reading); the
-- opening_kills/opening_deaths twins were retired WITH their columns
-- (2026-11-18) — extract incremented them in the same first-blood
-- branch as entry_kills/entry_deaths, so the entry seeds are
-- canonical. All int, no denominator: the rounds
-- denominator machinery owns ADR/Entry%, never a raw count.
('kills', 'Kills', 'K',
 'from player_stats: sum(kills)',
 'match', 'int',
 'Formula: sum(player_stats.kills) — kills this player earned, addressed per player — the scoreboard''s K column.',
 'builtin', '', CURRENT_TIMESTAMP),
('deaths', 'Deaths', 'D',
 'from player_stats: sum(deaths)',
 'match', 'int',
 'Formula: sum(player_stats.deaths) — deaths this player suffered, addressed per player — the scoreboard''s D column.',
 'builtin', '', CURRENT_TIMESTAMP),
('mvps', 'MVPs', 'MVPs',
 'from player_stats: sum(mvps)',
 'match', 'int',
 'Formula: sum(player_stats.mvps) — rounds this player was awarded MVP, addressed per player — the scoreboard''s MVPs column.',
 'builtin', '', CURRENT_TIMESTAMP),
('total_damage', 'Damage', 'DMG',
 'from player_stats: sum(total_damage)',
 'match', 'int',
 'Formula: sum(player_stats.total_damage) — damage this player dealt, addressed per player — the scoreboard''s DMG column (ADR divides the same total by rounds).',
 'builtin', '', CURRENT_TIMESTAMP),
('utility_damage', 'Utility damage', 'Util',
 'from player_stats: sum(utility_damage)',
 'match', 'int',
 'Formula: sum(player_stats.utility_damage) — the scoreboard''s raw Util total, addressed per player — all utility damage this player dealt (Util damage (paired) counts only in-window grenade hits).',
 'builtin', '', CURRENT_TIMESTAMP),
('headshots', 'Headshots', '',
 'from player_stats: sum(headshots)',
 'match', 'int',
 'Formula: sum(player_stats.headshots) — kills that landed as headshots, addressed per player — the raw count behind HS%.',
 'builtin', '', CURRENT_TIMESTAMP),
('teamkills', 'Team kills', '',
 'from player_stats: sum(teamkills)',
 'match', 'int',
 'Formula: sum(player_stats.teamkills) — teammates this player killed, addressed per player — the raw team-kill count.',
 'builtin', '', CURRENT_TIMESTAMP),
('suicides', 'Suicides', '',
 'from player_stats: sum(suicides)',
 'match', 'int',
 'Formula: sum(player_stats.suicides) — deaths to their own hand, addressed per player — the raw suicide count.',
 'builtin', '', CURRENT_TIMESTAMP),
('damage_taken', 'Damage taken', '',
 'from player_stats: sum(damage_taken)',
 'match', 'int',
 'Formula: sum(player_stats.damage_taken) — damage this player absorbed, addressed per player — the taken-damage total.',
 'builtin', '', CURRENT_TIMESTAMP),
('shots', 'Shots', '',
 'from player_stats: sum(shots)',
 'match', 'int',
 'Formula: sum(player_stats.shots) — shots this player fired, addressed per player — the raw shot count (accuracy is a derived ratio, not this row).',
 'builtin', '', CURRENT_TIMESTAMP),
('hits', 'Hits', '',
 'from player_stats: sum(hits)',
 'match', 'int',
 'Formula: sum(player_stats.hits) — shots that connected, addressed per player — the raw hit count.',
 'builtin', '', CURRENT_TIMESTAMP),
('rounds_played', 'Rounds played', '',
 'from player_stats: sum(rounds_played)',
 'match', 'int',
 'Formula: sum(player_stats.rounds_played) — rounds this player appeared in, addressed per player — their own rounds, never the match''s (ADR divides by the match''s).',
 'builtin', '', CURRENT_TIMESTAMP),
('flashed_times', 'Times flashed', '',
 'from player_stats: sum(flashed_times)',
 'match', 'int',
 'Formula: sum(player_stats.flashed_times) — times this player was blinded, addressed per player — the raw blind count.',
 'builtin', '', CURRENT_TIMESTAMP),
('bomb_plants', 'Bomb plants', '',
 'from player_stats: sum(bomb_plants)',
 'match', 'int',
 'Formula: sum(player_stats.bomb_plants) — bombs this player planted, addressed per player — the raw plant count.',
 'builtin', '', CURRENT_TIMESTAMP),
('bomb_defuses', 'Bomb defuses', '',
 'from player_stats: sum(bomb_defuses)',
 'match', 'int',
 'Formula: sum(player_stats.bomb_defuses) — bombs this player defused, addressed per player — the raw defuse count.',
 'builtin', '', CURRENT_TIMESTAMP),
('money_spent_total', 'Money spent', '',
 'from player_stats: sum(money_spent_total)',
 'match', 'int',
 'Formula: sum(player_stats.money_spent_total) — money this player spent, addressed per player — whole dollars over the match.',
 'builtin', '', CURRENT_TIMESTAMP),
('career_kills', 'Kills', '',
 'from player_stats: sum(kills)',
 'profile', 'int',
 'Formula: sum(player_stats.kills) over the library — kills across the player''s career, addressed per player — the history row''s K column summed.',
 'builtin', '', CURRENT_TIMESTAMP),
('career_deaths', 'Deaths', '',
 'from player_stats: sum(deaths)',
 'profile', 'int',
 'Formula: sum(player_stats.deaths) over the library — deaths across the player''s career, addressed per player — the history row''s D column summed.',
 'builtin', '', CURRENT_TIMESTAMP),
('career_assists', 'Assists', '',
 'from player_stats: sum(assists)',
 'profile', 'int',
 'Formula: sum(player_stats.assists) over the library — cross-team assists across the player''s career, addressed per player — the history row''s A column summed.',
 'builtin', '', CURRENT_TIMESTAMP),
('career_mvps', 'MVPs', '',
 'from player_stats: sum(mvps)',
 'profile', 'int',
 'Formula: sum(player_stats.mvps) over the library — MVP awards across the player''s career, addressed per player — the scoreboard MVPs column summed.',
 'builtin', '', CURRENT_TIMESTAMP),
('career_total_damage', 'Damage', '',
 'from player_stats: sum(total_damage)',
 'profile', 'int',
 'Formula: sum(player_stats.total_damage) over the library — damage dealt across the player''s career, addressed per player — the DMG column summed (career ADR divides it).',
 'builtin', '', CURRENT_TIMESTAMP),
('career_matches', 'Matches played', '',
 'from player_stats: count()',
 'profile', 'int',
 'Formula: count(player_stats) over the library — matches this player appears in, addressed per player — the profile''s Matches card as a pinnable metric.',
 'builtin', '', CURRENT_TIMESTAMP),
-- ---- addendum: the KDA conversion (w13d, 1 row, match scope) — the
-- scoreboard's KDA column left the Go calculation for the metric
-- system (adoption means migration: GetScoreboard's kda alias and the
-- Go report's KDA cell died with it). The scalar max() value form
-- (w13e) spells the floored denominator the old Go spelling used, so
-- the number the scoreboard showed is the number the metric stores —
-- a deathless subject divides by 1, never NULL.
('kda', 'KDA', 'KDA',
 'from player_stats: ratio(sum(kills + assists), max(sum(deaths), 1))',
 'match', 'float2',
 'Formula: sum(player_stats.kills + player_stats.assists) / max(sum(player_stats.deaths), 1) — kills plus assists per death, addressed per player — a deathless subject divides by 1, like the scoreboard.',
 'builtin', '', CURRENT_TIMESTAMP);

-- Subject-axis addendum (metrics expansion §8 M8/M4 rows,
-- 2026-11-17): FOUR builtins whose addressing is WRITTEN explicitly —
-- the INSERT above predates the subject column's writers and keeps the
-- player default for its rows, so the non-player rows ride this second
-- statement (same INSERT OR IGNORE add-on path, keyed on the UNIQUE
-- name). Equivalence with the characterization-pinned cards:
-- lost_equip / team_force_win_rate / team_lost_equip restate the
-- Economy view's lost-equip total, per-team force rate and per-team
-- lost-equip halves (Formula titles in lib/strings/economy.js; the
-- card numbers are pinned by the economy tables DOM tests) — the seed
-- reads round_economy.equip_value, which extract.agg writes from the
-- SAME freezeEnd capture as rounds.equip_ct/equip_t the cards render
-- (internal/extract/agg.go freezeEnd); win_pct restates the profile
-- Win% card (100 * Wins / Matches over the stored won stamp —
-- profileservice.go, pinned by TestWinPctCharacterization). Every doc
-- is Formula-first and states subject + partition (AGENTS tier-2 doc
-- rule; no doc hard-codes a count).
INSERT OR IGNORE INTO metrics (name, title, short_name, expr, scope, subject, partition, format, doc, origin, denominator, created_at) VALUES
('lost_equip', 'Lost equipment', '',
 'from round_economy, rounds: sum(where winner != '''' and side != winner and team != '''', equip_value)',
 'match', 'match', '', 'currency',
 'Formula: sum(round_economy.equip_value) of the losing side over decided, team-known rounds — freeze-end money lost, addressed per match (no partition), over the joined sources — a total; N = rounds.',
 'builtin', '', CURRENT_TIMESTAMP),
('team_force_win_rate', 'Force win %', '',
 'from round_side_classes, rounds: ratio(count(where class = ''force'' and winner = side), count(where class = ''force''))',
 'match', 'team', '', 'percent',
 'Formula: force-buy rounds won ÷ that team''s own force-buy rounds — per-team force win rate, addressed per team (no partition), over the joined sources — a percent; N is the team''s classified rounds.',
 'builtin', '', CURRENT_TIMESTAMP),
('team_lost_equip', 'Team lost equipment', '',
 'from round_economy, rounds: sum(where winner != '''' and side != winner and team != '''', equip_value)',
 'match', 'team', '', 'currency',
 'Formula: sum(round_economy.equip_value) of that team''s losing rounds — freeze-end money the team lost, addressed per team (no partition), over the joined sources — a total; N counts its lost rounds.',
 'builtin', '', CURRENT_TIMESTAMP),
('win_pct', 'Win %', '',
 'from player_stats: ratio(sum(won), count())',
 'profile', 'player', '', 'percent',
 'Formula: sum(player_stats.won) / count() — match wins ÷ matches played over a career, addressed per player (no partition) — a percent; ties count as no wins; N = matches played.',
 'builtin', '', CURRENT_TIMESTAMP);

-- Identity addendum (metrics expansion §6.4/§8 M1 identity row,
-- 2026-11-17): FIVE match-subject builtins whose value is a KEY — the
-- M1 Overview top-cards' stored twins (top_fragger / best_adr /
-- most_util / entry_opens / most_mvps), each argmax over the M1 stat
-- on the player_stats lead (§7 M1's expression list). Same INSERT OR
-- IGNORE add-on path as the subject-axis block above (keyed on the
-- UNIQUE name), addressing written explicitly: subject=match,
-- format=identity, no partition, no denominator (an identity's N is
-- the pool it chose from — §3.3, stated in every doc below). Every
-- doc is Formula-first, states subject + partition + the N semantics
-- and stays inside the tier-2 doc limit (AGENTS doc rule; no doc
-- hard-codes a count).
INSERT OR IGNORE INTO metrics (name, title, short_name, expr, scope, subject, partition, format, doc, origin, denominator, created_at) VALUES
('top_fragger', 'Top fragger', '',
 'from player_stats: argmax(kills)',
 'match', 'match', '', 'identity',
 'Formula: argmax(player_stats.kills) — the player with the most kills in the match, addressed per match (no partition) — N = the pool of players considered; an empty pool shows a dash.',
 'builtin', '', CURRENT_TIMESTAMP),
('best_adr', 'Best ADR', '',
 'from player_stats: argmax(adr)',
 'match', 'match', '', 'identity',
 'Formula: argmax(player_stats.adr) — the match''s highest-ADR player, addressed per match (no partition) — N = the pool of players considered; an empty pool shows a dash.',
 'builtin', '', CURRENT_TIMESTAMP),
('most_util', 'Most util', '',
 'from player_stats: argmax(utility_damage)',
 'match', 'match', '', 'identity',
 'Formula: argmax(player_stats.utility_damage) — the match''s leading utility-damage player, addressed per match (no partition) — N = the pool of players considered; an empty pool shows a dash.',
 'builtin', '', CURRENT_TIMESTAMP),
('entry_opens', 'Entry opens', '',
 'from player_stats: argmax(entry_kills)',
 'match', 'match', '', 'identity',
 'Formula: argmax(player_stats.entry_kills) — the player with the most round-opening first bloods, addressed per match (no partition) — N = the pool of players considered; an empty pool shows a dash.',
 'builtin', '', CURRENT_TIMESTAMP),
('most_mvps', 'Most MVPs', '',
 'from player_stats: argmax(mvps)',
 'match', 'match', '', 'identity',
 'Formula: argmax(player_stats.mvps) — the match''s MVP-award leader, addressed per match (no partition) — N = the pool of players considered; an empty pool shows a dash.',
 'builtin', '', CURRENT_TIMESTAMP);

-- Partition addendum (metrics expansion §8 M5/M6 rows, 2026-11-17):
-- TEN profile-scope builtins whose addressing is WRITTEN explicitly —
-- five side-partitioned (the Sides table's stored twins) and five
-- map-partitioned (the Maps table's stored twins) — same INSERT OR
-- IGNORE add-on path as the subject-axis and identity blocks above
-- (keyed on the UNIQUE name). Equivalence with the retired reads
-- (oracle-only now, internal/metrics side/map equivalence tests):
-- side_* restate store.GetPlayerSideSplits' per-side rounds, round
-- win rate, pooled side ADR, KAST% and floored K/D over the same
-- player_round_stats rows; map_* restate the Maps card's fold
-- (matches/wins over the won stamp) and store.GetPlayerMapADR's
-- pooled micro-average (Σ damage ÷ the map's counted rounds — the
-- `rounds` denominator, dim-scoped by emitDenom). The fifth map row
-- (map_kd) and map_win_pct complete the ratio twins of the table's
-- own columns; every doc is Formula-first, states subject + partition
-- and stays inside the tier-2 doc limit (AGENTS doc rule; no doc
-- hard-codes a count).
INSERT OR IGNORE INTO metrics (name, title, short_name, expr, scope, subject, partition, format, doc, origin, denominator, created_at) VALUES
('side_rounds', 'Rounds', '',
 'from player_round_stats: count()',
 'profile', 'player', 'side', 'int',
 'Formula: count(player_round_stats) — rounds played on that side across the career, addressed per player, partitioned by side — N = the rounds counted.',
 'builtin', '', CURRENT_TIMESTAMP),
('side_win_pct', 'Round win %', '',
 'from player_round_stats: ratio(sum(won), count())',
 'profile', 'player', 'side', 'percent',
 'Formula: sum(player_round_stats.won) / count() — rounds won on that side ÷ rounds played on it, addressed per player, partitioned by side — a percent; N = rounds on the side.',
 'builtin', '', CURRENT_TIMESTAMP),
('side_adr', 'ADR', '',
 'from player_round_stats: ratio(sum(dmg), count())',
 'profile', 'player', 'side', 'float1',
 'Formula: sum(player_round_stats.dmg) / count() — damage dealt on that side ÷ rounds played on it, addressed per player, partitioned by side — damage per round; N = rounds on the side.',
 'builtin', '', CURRENT_TIMESTAMP),
('side_kast', 'KAST%', '',
 'from player_round_stats: avg(kast)',
 'profile', 'player', 'side', 'percent',
 'Formula: avg(player_round_stats.kast) — share of that side''s rounds with a K, A, T or S, addressed per player, partitioned by side — a percent; N = rounds on the side.',
 'builtin', '', CURRENT_TIMESTAMP),
('side_kd', 'K/D', '',
 'from player_round_stats: ratio(sum(kills), max(sum(deaths), 1))',
 'profile', 'player', 'side', 'float2',
 'Formula: sum(player_round_stats.kills) / max(sum(player_round_stats.deaths), 1) — kills per death, addressed per player, partitioned by side — a deathless side divides by 1; N = rounds on the side.',
 'builtin', '', CURRENT_TIMESTAMP),
('map_matches', 'Matches', '',
 'from player_stats: count()',
 'profile', 'player', 'map', 'int',
 'Formula: count(player_stats) — matches played on that map across the career, addressed per player, partitioned by map — N = the matches counted.',
 'builtin', '', CURRENT_TIMESTAMP),
('map_wins', 'Wins', '',
 'from player_stats: sum(won)',
 'profile', 'player', 'map', 'int',
 'Formula: sum(player_stats.won) — matches won on that map, addressed per player, partitioned by map — ties count as no wins; N = matches on the map.',
 'builtin', '', CURRENT_TIMESTAMP),
('map_win_pct', 'Win %', '',
 'from player_stats: ratio(sum(won), count())',
 'profile', 'player', 'map', 'percent',
 'Formula: sum(player_stats.won) / count() — matches won ÷ played on that map, addressed per player, partitioned by map — a percent; ties count as no wins; N = matches on the map.',
 'builtin', '', CURRENT_TIMESTAMP),
('map_adr', 'ADR', '',
 'from player_stats: sum(total_damage)',
 'profile', 'player', 'map', 'float1',
 'Formula: sum(player_stats.total_damage) / the map''s counted rounds (denominator: rounds) — pooled damage per round, addressed per player, partitioned by map — never a mean of per-match ADRs.',
 'builtin', 'rounds', CURRENT_TIMESTAMP),
('map_kd', 'K/D', '',
 'from player_stats: ratio(sum(kills), sum(deaths))',
 'profile', 'player', 'map', 'float2',
 'Formula: sum(player_stats.kills) / sum(player_stats.deaths) — kills per death on that map, addressed per player, partitioned by map — no deaths → 0 beside N; N = matches on the map.',
 'builtin', '', CURRENT_TIMESTAMP);

-- Weapon addendum (metrics expansion §8 M7 row, 2026-11-17; damage
-- column flipped in 2026-11-18): THREE profile-scope weapon-partitioned
-- builtins — the M7 gate (internal/integration/profile_weapons_gate_test.go)
-- proved kills/headshots EXACTLY equal to the retired JSON fold over the
-- golden demo (every human × weapon) and shipped them then; the damage
-- column diverged (candidate 21626 vs fold 17117, Δ4509 = HP-cap 4330 +
-- known-side team 164 + post-match 15 — owner ruling 2026-11-17 "fix the
-- metric until they match") until the capped_dmg ingest stamp closed all
-- three gates (2026-11-18: the cap replay + post-match real gate stamped
-- row-local at ingest, the enemy gate on same_side), the gate flipped to
-- pinned equality and the column migrated with it. The expr spells the
-- fold's enemy predicate: subject addressing carries attacker <> '',
-- `attacker != victim` the actor gate, `same_side = 0` the permissive
-- side gate; the value is the stamped capped_dmg, never raw events.dmg.
-- Same INSERT OR IGNORE add-on path; Formula-first docs, subject +
-- partition stated, tier-2 length (AGENTS doc rule). N-claim fix
-- (2026-11-18, Phase 7 doc sweep): the two COUNT seeds' docs used to
-- say "N = the kill events counted", but N is the GROUP row count —
-- that weapon's ALL-kind event rows (doc.go "N is the sample size
-- behind the value (group row count)"), so both docs now say the event
-- rows recorded for the weapon. Doc strings only — no expr, no value,
-- seed count unchanged.
INSERT OR IGNORE INTO metrics (name, title, short_name, expr, scope, subject, partition, format, doc, origin, denominator, created_at) VALUES
('weapon_kills', 'Weapon kills', '',
 'from events: count(where kind = ''kill'' and attacker != victim)',
 'profile', 'player', 'weapon', 'int',
 'Formula: count(events) of enemy kills with that weapon across the career, addressed per player, partitioned by weapon — N = the event rows recorded for that weapon.',
 'builtin', '', CURRENT_TIMESTAMP),
('weapon_damage', 'Weapon damage', '',
 'from events: sum(where kind = ''damage'' and attacker != victim and same_side = 0, capped_dmg)',
 'profile', 'player', 'weapon', 'int',
 'Formula: sum(events.capped_dmg over enemy damage events with that weapon) — HP-capped damage dealt across the career, addressed per player, partitioned by weapon — N = the event rows for that weapon.',
 'builtin', '', CURRENT_TIMESTAMP),
('weapon_headshots', 'Weapon headshots', '',
 'from events: count(where kind = ''kill'' and headshot = 1 and attacker != victim)',
 'profile', 'player', 'weapon', 'int',
 'Formula: count(events) of enemy headshot kills with that weapon across the career, addressed per player, partitioned by weapon — N = the event rows recorded for that weapon.',
 'builtin', '', CURRENT_TIMESTAMP);

-- Grammar addendum (metrics expansion §8 M8 rows, 2026-11-17): TWO
-- match-subject builtins — the two M8 rows the Phase 4 grammar finding
-- reported NOT expressible (pistol_hold needed a next-round window,
-- avg_equip_gap a per-row winner-minus-loser subtraction), now seeded
-- over the grammar constructs that landed for them (internal/metrics
-- doc.go "Round window (next())" and "Row difference (diff())").
-- Same INSERT OR IGNORE add-on path (keyed on the UNIQUE name),
-- addressing written explicitly: subject=match, no partition, no
-- denominator (the value IS the per-match aggregate). Equivalence with
-- the characterization-pinned Economy cards: pistol_hold restates the
-- card's held ÷ won (Formula title in lib/strings/economy.js; the card
-- numbers are pinned by the economy tables DOM tests) and
-- avg_equip_gap the card's average winner-minus-loser freeze-end gap —
-- exact equivalence pinned in internal/metrics' econ equivalence test
-- against the view computation's retired oracle. Every doc is
-- Formula-first, states subject + partition and stays inside the
-- tier-2 doc limit (AGENTS doc rule; no doc hard-codes a count).
INSERT OR IGNORE INTO metrics (name, title, short_name, expr, scope, subject, partition, format, doc, origin, denominator, created_at) VALUES
('pistol_hold', 'Pistol → next round', '',
 'from rounds, round_classifications: ratio(count(where label = ''pistol'' and winner != '''' and next(winner) = winner), count(where label = ''pistol'' and winner != ''''))',
 'match', 'match', '', 'percent',
 'Formula: pistol rounds won where that side also won the following round ÷ pistol rounds won — the held-pistol rate, addressed per match (no partition), over the joined sources; N = rounds.',
 'builtin', '', CURRENT_TIMESTAMP),
('avg_equip_gap', 'Winner equipment value advantage', '',
 'from rounds: avg(where winner != '''', diff(equip_ct, equip_t, winner = ''ct''))',
 'match', 'match', '', 'currency',
 'Formula: average across decided rounds of (winner equipment value − loser equipment value) at freeze time — addressed per match (no partition); N = rounds.',
 'builtin', '', CURRENT_TIMESTAMP);

-- View-aggregate relocation addendum (ME8 exception audit, 2026-11-18):
-- TWO team-subject count builtins — the force card's per-team won /
-- total pairs, the last piece of that card's numbers still computed in
-- the view (the view-aggregate rule's third clause: a value derivable
-- from a stored metric relocates; a pooled ratio seed deliberately does
-- NOT exist here — a zero denominator stores 0 beside N, which cannot
-- carry the card's "no force buys" dash, so the honest stored form of
-- the card is its counts). Same INSERT OR IGNORE add-on path (keyed on
-- the UNIQUE name), addressing written explicitly: subject=team,
-- scope=match, no partition, no denominator (a count IS the value).
-- Equivalence with the characterization-pinned Economy card: the
-- sub-line's won/rounds pairs — exact equality to the retired view
-- computation pinned in internal/metrics' econ equivalence test. Every
-- doc is Formula-first, states subject + partition and stays inside the
-- tier-2 doc limit (AGENTS doc rule; no doc hard-codes a count).
INSERT OR IGNORE INTO metrics (name, title, short_name, expr, scope, subject, partition, format, doc, origin, denominator, created_at) VALUES
('team_force_wins', 'Force rounds won', '',
 'from round_side_classes, rounds: count(where class = ''force'' and winner = side)',
 'match', 'team', '', 'int',
 'Formula: count(round_side_classes rows joined to rounds WHERE class = force AND winner = side) — force rounds that team won, addressed per team (no partition), over the joined sources.',
 'builtin', '', CURRENT_TIMESTAMP),
('team_force_rounds', 'Force rounds', '',
 'from round_side_classes: count(where class = ''force'')',
 'match', 'team', '', 'int',
 'Formula: count(round_side_classes rows WHERE class = force) — that team''s own force-buy rounds, addressed per team (no partition).',
 'builtin', '', CURRENT_TIMESTAMP);

-- Advanced platform: declarative plugin registry (plan M5 §2.7 v1). One
-- row per installed plugin; invalid/missing bundles keep their row with
-- error set (ListPlugins never silently drops).
--
-- Plugin metrics live in the `metrics` table above (origin='plugin',
-- plugin_id=<this id>) — this section only owns the registry.
-- enable=1 ⇔ the plugin's metric rows are present.

CREATE TABLE IF NOT EXISTS plugins (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL DEFAULT '',
	version TEXT NOT NULL DEFAULT '',
	path TEXT NOT NULL DEFAULT '',
	hash TEXT NOT NULL DEFAULT '',
	enabled INTEGER NOT NULL DEFAULT 1,
	error TEXT NOT NULL DEFAULT '',
	installed_at DATETIME
);
