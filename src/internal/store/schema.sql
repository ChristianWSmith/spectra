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
	-- derived rows (round_classifications / player_round_stats /
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
	mvps INTEGER NOT NULL DEFAULT 0,
	score INTEGER NOT NULL DEFAULT 0,
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

-- Round-end per-player economy samples (ingest-owned, SaveExtracted's
-- only writer — same family as round_player_sides): the money behind
-- player_round_stats' money columns. money_start = m_iStartAccount (the
-- game's own snapshot of the account at round start, before buys — it
-- absorbs the pistol/OT money resets); equip = m_unRoundStartEquipmentValue
-- (carried gear before freeze-time buys, free spawn pistol included);
-- spent = m_iCashSpentThisRound (the game's per-round spend counter read
-- at RoundEnd, after mp_buytime has closed). Sampled only for players
-- connected at RoundEnd; a player-round without a row keeps
-- player_round_stats' absence-as-zero default.
CREATE TABLE IF NOT EXISTS round_player_money (
	match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
	round INTEGER NOT NULL,
	steam_id TEXT NOT NULL,
	money_start INTEGER NOT NULL DEFAULT 0,
	equip INTEGER NOT NULL DEFAULT 0,
	spent INTEGER NOT NULL DEFAULT 0,
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
	-- post_match: the row fell outside the real period (after the last counted
	-- round ended, or in the post-match tail). Stamped at ingest from the same
	-- gate the extractor used for its folds (Q1); the fold seeds exclude it.
	post_match INTEGER NOT NULL DEFAULT 0,
	-- player_death's `attackerinair`: the attacker was midair. Derived
	-- from the paired raw payload at extract time (demoinfocs' typed Kill
	-- has no MidAir field) — no migration: a stale dev DB lacks the
	-- column and must be re-imported. A stored game fact;
	-- the tick-join in_air on player_ticks is a separate derived feature
	-- and does not replace it.
	attacker_inair INTEGER NOT NULL DEFAULT 0,
	assisted_flash INTEGER NOT NULL DEFAULT 0,
	distance REAL NOT NULL DEFAULT 0,
	hitgroup TEXT NOT NULL DEFAULT '',
	dmg INTEGER NOT NULL DEFAULT 0,
	-- capped_dmg (owner ruling 2026-11-17 "fix the metric until they
	-- match"; M7 weapon-damage gate escalation, 2026-11-18): the
	-- HP-capped damage credit of THIS hit — the value extract.agg.hurt
	-- feeds player_stats.weaponDmg — with post-match (non-real) hits
	-- stamped 0. The cap replays per victim in event order
	-- (extract.agg.capDamage), so a query-time SUM(events.dmg) can
	-- never reproduce it (round 5 of the golden demo: 206 raw dmg on
	-- one victim, fold credits <=100); the fact is row-local at ingest.
	-- The enemy gate stays OFF this column: the tick join (player_ticks
	-- sides) and the actor columns carry it (the weapon_damage seed
	-- spells all three).
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
	traded INTEGER NOT NULL DEFAULT 0,
	kast INTEGER NOT NULL DEFAULT 0,
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
-- stamps are live; no app surface renders a stamp. A group the statement
-- did not produce has NO row. subject_key has no FK —
-- a career key does not FK to the per-match roster (player_career
-- precedent, schema.sql:566-584). Reaching this table's shape on an
-- existing DB is the wipe's job (pre-release: wipe + re-import, never
-- ALTER).
CREATE TABLE IF NOT EXISTS metric_values (
	metric_id       INTEGER NOT NULL REFERENCES metrics(id) ON DELETE CASCADE,
	match_id        INTEGER NOT NULL DEFAULT 0,   -- 0 = the profile (career) grain
	subject_key     TEXT    NOT NULL DEFAULT '',  -- player SteamID64 | team key ('ct'/'t') | '' (match subject)
	dim             TEXT    NOT NULL DEFAULT '',  -- partition key ('' = unpartitioned)
	value           REAL,                         -- NULL = the statement had no data; shown as a dash, never 0
	value_key       TEXT    NOT NULL DEFAULT '',  -- identity value (identity metrics only; '' otherwise)
	metric_version  INTEGER NOT NULL DEFAULT 0,   -- metrics.version these values were computed under (0 = never stamped = behind)
	rule_version    INTEGER NOT NULL DEFAULT 0,   -- analysis rule generation that fed them (provenance + rules-axis staleness)
	computed_at     DATETIME,
	-- Raw-SQL scope tags: the reserved binds a
	-- run was supplied. '' and 0 for the unbound (library-wide) run and for
	-- every sugar row. A run replaces the rows carrying its own tags.
	scope_steam_id  TEXT    NOT NULL DEFAULT '',
	scope_round     INTEGER NOT NULL DEFAULT 0,
	-- Raw-SQL result columns other than subject_key, dim and value, as one
	-- JSON object. Opaque to the engine. '' for every sugar row.
	row_json        TEXT    NOT NULL DEFAULT '',
	PRIMARY KEY (metric_id, match_id, subject_key, dim, scope_steam_id, scope_round),
	CHECK (match_id >= 0)
);

-- Raw-SQL run records: one row per (metric, scope) run
-- that completed, stamped with the versions it ran under. A run that returned
-- zero rows leaves no metric_values row, so this table is what proves the
-- scope was computed. Keyed like metric_values' raw scope tags; cleared with
-- the same match/career rules (childTables, RebuildCareer) and with the
-- metric's own rows (ClearMetricValues).
CREATE TABLE IF NOT EXISTS metric_runs (
	metric_id      INTEGER NOT NULL REFERENCES metrics(id) ON DELETE CASCADE,
	match_id       INTEGER NOT NULL DEFAULT 0,
	scope_steam_id TEXT    NOT NULL DEFAULT '',
	scope_round    INTEGER NOT NULL DEFAULT 0,
	metric_version INTEGER NOT NULL DEFAULT 0,
	rule_version   INTEGER NOT NULL DEFAULT 0,
	computed_at    DATETIME,
	PRIMARY KEY (metric_id, match_id, scope_steam_id, scope_round)
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

-- Per-tick player state: one row per (match, tick, present participant)
-- at the demo's full frame rate, carrying DERIVED features only — the
-- joinable projections a metric needs at an event's tick (speed and
-- in-air at a shot or kill). Raw positions, view angles and the full
-- sparse state stream stay in the per-match sidecar (internal/sidecar);
-- this table never duplicates them. Every row is a direct parser sample
-- except speed, which is derived at write time.
--
-- Population: the per-frame sidecar population (every playing
-- participant, dead included, through the takeover routing — extract's
-- appendTargets), restricted to COUNTED rounds: frames before the first
-- counted round's start tick and frames while a discarded (knife/warmup/
-- post-match) round is current are never written, exactly like every
-- other row of a discarded round. steam_id is the accumulator key (a
-- bot keeps its synthetic 0xFF key: this is an event-shaped record —
-- humans-only readers route through HumanOnly). round is the stored
-- (counted, 1..N) round number at that frame.
--
-- Honest gaps: in_air and speed are NULL when the frame carries no
-- position sample (the position stream is alive-only), never 0 — a dead
-- player's speed was not observed. speed is the HORIZONTAL (x/y)
-- movement speed in world units per second between this frame and the
-- player's previous frame (the quantity the game's movement-inaccuracy
-- rule reads — CS2.md "Player movement speed for accuracy"), computed
-- from the raw float positions; it is also NULL on the first positioned
-- frame of a stretch (no previous frame), across a round change, after a
-- frame the player was absent or unpositioned, and when the tick rate is
-- unknown. weapon is the canonical weapon name (the events.weapon
-- vocabulary), NULL when dead (not sampled); hp is forced to 0 when dead
-- (a sample, not an inference); money is the controller's account as
-- read (it survives death).
--
-- Lifecycle: the rows STREAM in during the parse (store.TickWriter, in
-- chunked transactions of at most tickChunkRows rows so no single
-- transaction holds the writer long), so the table is deliberately NOT a
-- childTables entry — SaveExtracted runs after the parse and would erase
-- the freshly streamed rows. A reprocess wipes the match's rows when its
-- writer is created, every import failure path deletes them with the
-- half-written sidecar, and DeleteMatchData clears them through
-- streamedChildTables (the FK cascade is the backstop).
CREATE TABLE IF NOT EXISTS player_ticks (
	match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
	tick     INTEGER NOT NULL,
	steam_id TEXT    NOT NULL,
	round    INTEGER NOT NULL DEFAULT 0,
	side     TEXT    NOT NULL DEFAULT '',
	alive    INTEGER NOT NULL DEFAULT 1,
	hp       INTEGER NOT NULL DEFAULT 100,
	money    INTEGER NOT NULL DEFAULT 0,
	in_air   INTEGER,
	speed    REAL,
	weapon   TEXT,
	PRIMARY KEY (match_id, tick, steam_id)
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
-- with the profile Trade rate card's metric conversion, and the
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
-- idx_player_ticks_steam serves the library-wide per-player reads of the
-- tick table (one player's frames in one match, or across the library):
-- the match_id-first primary key cannot seek on steam_id, and a scan of
-- a ~1.3M-row-per-match table is the cost this block exists to avoid
-- Same leading-column mirror of the match_id-first key as the
-- other steam_id members.
CREATE INDEX IF NOT EXISTS idx_player_ticks_steam ON player_ticks(steam_id, match_id);

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
-- held: 1 = the user cancelled this metric's stored run. Background sweeps
-- skip a held metric and its dependents; only saving the metric clears the
-- hold (metric_hold_store.go). Compute state, not definition.
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
	-- The physical tables the metric's compiled statement reads, comma-
	-- joined and sorted, derived by the save
	-- gate. '' means not derived (builtins until their port; plugin rows
	-- after an upsert until the next gate pass).
	touched TEXT NOT NULL DEFAULT '',
	version INTEGER NOT NULL DEFAULT 1,
	created_at DATETIME,
	held INTEGER NOT NULL DEFAULT 0
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

-- User components and the surfaces they are placed on (Svelte 5 source stored
-- in the database; builtin components are code, never rows). `components.name`
-- is what a placement references; a placement's `component` is either a
-- builtin id or a components.name, so it carries NO foreign key: a name that
-- resolves to neither is reported by the reader, never refused by the DDL.
-- Absence means the builtin: a surface with no placement rows renders its
-- builtin. One baseline, no versioning.
CREATE TABLE IF NOT EXISTS components (
	id INTEGER PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	source TEXT NOT NULL,
	created_at DATETIME NOT NULL,
	updated_at DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS layout_placements (
	surface TEXT NOT NULL,
	position INTEGER NOT NULL,
	component TEXT NOT NULL,
	props TEXT NOT NULL DEFAULT '{}',
	hidden INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (surface, position)
);

-- The in-place edits of builtins (owner rulings 43 and 44): one row per
-- builtin the user has edited. The key is namespaced by kind so the three
-- kinds never collide: `builtin-…` is a builtin component (its source), `report:<id>`
-- a builtin report template (its body), and `metric:<name>` a builtin metric
-- (its expr). The row overrides the shipped text wherever that builtin is used;
-- restore to default deletes the row. `shipped` holds a metric's shipped SQL
-- (its metrics.expr is overwritten by the edit, so restore reads it back here);
-- empty for the other kinds, whose shipped text is embedded in the app.
-- One baseline, no versioning.
CREATE TABLE IF NOT EXISTS builtin_overrides (
	id TEXT PRIMARY KEY,
	source TEXT NOT NULL,
	shipped TEXT NOT NULL DEFAULT '',
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
-- Every builtin expr is RAW SQL: one
-- read-only SELECT returning subject_key, dim and value. Match-scope rows
-- bind :match_id (one run per ready match, so the stored rows are per
-- match); profile rows run library-wide (match_id 0). The bot predicate
-- (store.HumanOnlyBySteamID's SQL form) is in every statement. A NULL value
-- means no data and shows as a dash (ruling 23). weapon_damage, dmg_no_kill
-- and kill_conversion read player_ticks, and shots is checked the same way:
-- all four are checked at the owner's wipe gate, not before it (ruling 24).
INSERT OR IGNORE INTO metrics (name, title, short_name, expr, scope, format, doc, origin, created_at) VALUES
('trade_rate', 'Trade rate', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT player_stats.match_id AS mid, player_stats.steam_id AS grp, 1.0*(SUM(player_stats.trade_kills)) / NULLIF((SUM(match_trade_opps.opps)), 0) AS v FROM player_stats LEFT JOIN match_trade_opps ON player_stats.match_id = match_trade_opps.match_id AND player_stats.steam_id = match_trade_opps.steam_id WHERE player_stats.match_id = :match_id AND (player_stats.steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'percent',
 'Formula: sum(trade_kills) / sum(match_trade_opps.opps) — trade successes ÷ trade opportunities, addressed per player over the joined sources — a ratio, so it may top 100%.',
 'builtin', CURRENT_TIMESTAMP),
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
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, 1.0*(SUM(total_damage)) / NULLIF(((SELECT COUNT(*) FROM rounds WHERE match_id = player_stats.match_id)), 0) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.total_damage, 0) AS total_damage, CAST(COALESCE(f.total_damage, 0) AS REAL) / NULLIF((SELECT COUNT(*) FROM rounds r WHERE r.match_id = ps.match_id), 0) AS adr
  FROM player_stats ps
  LEFT JOIN (WITH dmg AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.weapon, e.capped_dmg, e.detail_json,
         sa.side AS a_side, sv.side AS v_side
  FROM events e
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  WHERE e.match_id = :match_id AND e.kind = ''damage'' AND e.post_match = 0
),
edmg AS (
  SELECT * FROM dmg WHERE attacker <> '''' AND attacker <> victim
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
),
fold AS (
    SELECT match_id, attacker AS steam_id, ''total_damage'' AS f, SUM(capped_dmg) AS n FROM edmg GROUP BY match_id, attacker
  )
  SELECT match_id, steam_id, SUM(CASE WHEN f = ''total_damage'' THEN n END) AS total_damage FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id
  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'float1',
 'Formula: sum(total_damage) / the match''s counted rounds (denominator: rounds) — enemy damage per round of the match, addressed per player — never the rounds that player personally played.',
 'builtin', CURRENT_TIMESTAMP),
('entry_rate', 'Entry%', 'Entry%',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, 1.0*(SUM(entry_kills)) / NULLIF(((SELECT COUNT(*) FROM rounds WHERE match_id = player_stats.match_id)), 0) AS v FROM player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'percent',
 'Formula: sum(entry_kills) / the match''s rounds (denominator: rounds) — entry (first-blood) kills ÷ the match''s rounds, addressed per player — a percent; at most one first blood per round.',
 'builtin', CURRENT_TIMESTAMP),
('hs_pct', 'HS%', 'HS%',
 'WITH k AS (
  SELECT e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,
         (e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake,
         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side
  FROM events e
  LEFT JOIN (SELECT DISTINCT attacker, tick FROM events
             WHERE match_id = :match_id AND kind = ''player_disconnect'') dc
    ON dc.attacker = e.victim AND dc.tick = e.tick
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister
  WHERE e.match_id = :match_id AND e.kind = ''kill'' AND e.post_match = 0
),
ek AS (
  SELECT * FROM k WHERE attacker <> '''' AND attacker <> victim AND fake = 0
    AND NOT (COALESCE(a_side,'''') <> '''' AND a_side = v_side)
),
agg AS (
SELECT attacker AS steam_id, COUNT(*) AS n, SUM(headshot) AS hs FROM ek GROUP BY attacker
)
SELECT p.steam_id AS subject_key, '''' AS dim, CASE WHEN agg.n > 0 THEN 1.0 * agg.hs / agg.n END AS value
FROM players p
LEFT JOIN agg ON agg.steam_id = p.steam_id
WHERE p.match_id = :match_id AND p.is_bot = 0
ORDER BY p.steam_id',
 'match', 'percent',
 'Formula: headshot kills ÷ kills, addressed per player — a share (the percent format shows it as a percent), a dash when the player has no kills (no pool), never 0.',
 'builtin', CURRENT_TIMESTAMP),
('kast', 'KAST%', 'KAST%',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, AVG(kast) AS v FROM player_round_stats WHERE player_round_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_round_stats.match_id AND p.steam_id = player_round_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'percent',
 'Formula: avg(kast) — the share of the player''s recorded rounds with a K, A, T or S, addressed per player — a percent (the scoreboard''s KAST%).',
 'builtin', CURRENT_TIMESTAMP),
('kd', 'K/D', 'K/D',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, 1.0*(SUM(kills)) / NULLIF((SUM(deaths)), 0) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.kills, 0) AS kills, COALESCE(f.deaths, 0) AS deaths
  FROM player_stats ps
  LEFT JOIN (WITH k AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,
         (e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake,
         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side
  FROM events e
  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = ''player_disconnect'') dc
    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister
  WHERE e.match_id = :match_id AND e.kind = ''kill'' AND e.post_match = 0
),
ek AS (
  SELECT * FROM k WHERE attacker <> '''' AND attacker <> victim AND fake = 0
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
),
fold AS (
    SELECT match_id, attacker AS steam_id, ''kills'' AS f, COUNT(*) AS n FROM ek GROUP BY match_id, attacker
    UNION ALL SELECT match_id, victim AS steam_id, ''deaths'' AS f, COUNT(*) AS n FROM k WHERE victim <> '''' AND fake = 0 GROUP BY match_id, victim
  )
  SELECT match_id, steam_id, SUM(CASE WHEN f = ''kills'' THEN n END) AS kills, SUM(CASE WHEN f = ''deaths'' THEN n END) AS deaths FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id
  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'float2',
 'Formula: sum(kills) / sum(deaths) — kills per death, addressed per player — no deaths → 0, where the scoreboard''s K/D shows the kill count.',
 'builtin', CURRENT_TIMESTAMP),
('trade_rate_deaths', 'Trade%', 'Trade%',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, 1.0*(SUM(trade_kills)) / NULLIF((SUM(deaths)), 0) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.deaths, 0) AS deaths
  FROM player_stats ps
  LEFT JOIN (WITH k AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,
         (e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake,
         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side
  FROM events e
  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = ''player_disconnect'') dc
    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister
  WHERE e.match_id = :match_id AND e.kind = ''kill'' AND e.post_match = 0
),
ek AS (
  SELECT * FROM k WHERE attacker <> '''' AND attacker <> victim AND fake = 0
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
),
fold AS (
    SELECT match_id, victim AS steam_id, ''deaths'' AS f, COUNT(*) AS n FROM k WHERE victim <> '''' AND fake = 0 GROUP BY match_id, victim
  )
  SELECT match_id, steam_id, SUM(CASE WHEN f = ''deaths'' THEN n END) AS deaths FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id
  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'percent',
 'Formula: sum(trade_kills) / sum(deaths) — trade kills ÷ the player''s own deaths, addressed per player — a ratio, not a share; may top 100% (see Trade rate).',
 'builtin', CURRENT_TIMESTAMP),
-- profile-scope dogfooding set (D2/D3/D5/D6/D9/D10/D11/D12): inert
-- until their surface converts — nothing reads a profile-scope seed yet.
('career_adr', 'ADR', 'ADR', 'SELECT :steam_id AS subject_key, '''' AS dim, 1.0 * (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric(''total_damage'')) / NULLIF((SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric(''match_rounds'')), 0) AS value WHERE EXISTS (SELECT 1 FROM metric(''total_damage''))', 'profile', 'float1', 'Formula: sum(total_damage) / sum(rounds recorded) — enemy damage per round pooled over the player''s career, addressed per player — pooled, never a mean of per-match ADRs.', 'builtin', CURRENT_TIMESTAMP),
('career_adr_sigma', 'ADR σ', 'ADR σ',
 'SELECT :steam_id AS subject_key, '''' AS dim, (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SQRT(MAX(AVG(value * value) - AVG(value) * AVG(value), 0)) END FROM metric(''adr'')) AS value',
 'profile', 'float1',
 'Formula: stddev(adr) — the population standard deviation (σ) of the player''s per-match ADR over their career, addressed per player.',
 'builtin', CURRENT_TIMESTAMP),
('career_avg_enemies_flashed', 'Avg enemies flashed', 'Flash',
 'SELECT :steam_id AS subject_key, '''' AS dim, (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN AVG(value) END FROM metric(''enemies_flashed'')) AS value',
 'profile', 'float1',
 'Formula: avg(enemies_flashed) — the player''s mean enemies-flashed count per match over their career, addressed per player.',
 'builtin', CURRENT_TIMESTAMP),
('career_avg_util_damage', 'Avg util damage', 'Util',
 'SELECT :steam_id AS subject_key, '''' AS dim, (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN AVG(value) END FROM metric(''utility_damage'')) AS value',
 'profile', 'float1',
 'Formula: avg(utility_damage) — the player''s mean utility damage per match over their career, addressed per player.',
 'builtin', CURRENT_TIMESTAMP),
('career_clutch_win_rate', 'Clutch win %', 'CW%', 'SELECT :steam_id AS subject_key, '''' AS dim, 1.0 * (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric(''match_clutch_wins'')) / NULLIF((SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric(''clutches'')), 0) AS value WHERE EXISTS (SELECT 1 FROM metric(''clutches''))', 'profile', 'percent', 'Formula: sum(clutches won) / sum(clutches) — the share of the player''s career clutches won (shown as a percent), addressed per player — the profile''s win share.', 'builtin', CURRENT_TIMESTAMP),
('career_hs_pct', 'HS%', 'HS%',
 'SELECT :steam_id AS subject_key, '''' AS dim, 1.0 * (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric(''headshots'')) / NULLIF((SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric(''kills'')), 0) AS value',
 'profile', 'percent',
 'Formula: sum(headshots) / sum(kills) — headshots as a share of the player''s career kills, addressed per player — pooled career totals, a percent.',
 'builtin', CURRENT_TIMESTAMP),
('career_kast', 'KAST%', 'KAST%', 'SELECT :steam_id AS subject_key, '''' AS dim, 1.0 * (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric(''match_kast_flags'')) / NULLIF((SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric(''match_rounds'')), 0) AS value WHERE EXISTS (SELECT 1 FROM metric(''match_rounds''))', 'profile', 'percent', 'Formula: sum(kast flags) / sum(rounds recorded) — the mean KAST flag over every stored round of the player''s career, addressed per player — a percent.', 'builtin', CURRENT_TIMESTAMP),
('career_kd', 'K/D', 'K/D',
 'SELECT :steam_id AS subject_key, '''' AS dim, 1.0 * (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric(''kills'')) / NULLIF((SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric(''deaths'')), 0) AS value',
 'profile', 'float2',
 'Formula: sum(kills) / sum(deaths) — kills per death pooled over the player''s career, addressed per player — no deaths → 0 (the scoreboard floors instead).',
 'builtin', CURRENT_TIMESTAMP),
('career_trade_rate', 'Trade rate', 'Trade%', 'SELECT :steam_id AS subject_key, '''' AS dim, 1.0 * (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric(''trade_kills'')) / NULLIF((SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric(''match_trade_opps'')), 0) AS value WHERE EXISTS (SELECT 1 FROM metric(''trade_kills''))', 'profile', 'percent', 'Formula: sum(trade_kills) / sum(trade opportunities) — trade kills ÷ trade opportunities over the career, addressed per player — a ratio; may top 100%.', 'builtin', CURRENT_TIMESTAMP),
-- ---- inferred set, match scope (27 rows): per-match restatements of
-- the stored player, round, duel, clutch, grenade and drop facts — one
-- metric, one number; every row LIST they count stays source data.
('assists', 'Assists', 'A',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(assists) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.assists, 0) AS assists
  FROM player_stats ps
  LEFT JOIN (WITH k AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,
         (e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake,
         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side
  FROM events e
  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = ''player_disconnect'') dc
    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister
  WHERE e.match_id = :match_id AND e.kind = ''kill'' AND e.post_match = 0
),
ek AS (
  SELECT * FROM k WHERE attacker <> '''' AND attacker <> victim AND fake = 0
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
),
ak AS (
  SELECT * FROM k WHERE assister <> '''' AND assister <> victim AND attacker <> '''' AND attacker <> victim AND fake = 0 AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side) AND NOT (COALESCE(s_side, '''') <> '''' AND s_side = v_side)
),
fold AS (
    SELECT match_id, assister AS steam_id, ''assists'' AS f, COUNT(*) AS n FROM ak WHERE assisted_flash = 0 GROUP BY match_id, assister
  )
  SELECT match_id, steam_id, SUM(CASE WHEN f = ''assists'' THEN n END) AS assists FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id
  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: sum(assists) — cross-team assists this player earned (not flash assists), addressed per player — the scoreboard''s A column.',
 'builtin', CURRENT_TIMESTAMP),
('flash_assists', 'Flash assists', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(flash_assists) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.assists, 0) AS assists, COALESCE(f.flash_assists, 0) AS flash_assists
  FROM player_stats ps
  LEFT JOIN (WITH k AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,
         (e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake,
         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side
  FROM events e
  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = ''player_disconnect'') dc
    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister
  WHERE e.match_id = :match_id AND e.kind = ''kill'' AND e.post_match = 0
),
ek AS (
  SELECT * FROM k WHERE attacker <> '''' AND attacker <> victim AND fake = 0
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
),
ak AS (
  SELECT * FROM k WHERE assister <> '''' AND assister <> victim AND attacker <> '''' AND attacker <> victim AND fake = 0 AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side) AND NOT (COALESCE(s_side, '''') <> '''' AND s_side = v_side)
),
fold AS (
    SELECT match_id, assister AS steam_id, ''assists'' AS f, COUNT(*) AS n FROM ak WHERE assisted_flash = 0 GROUP BY match_id, assister
    UNION ALL SELECT match_id, assister AS steam_id, ''flash_assists'' AS f, COUNT(*) AS n FROM ak WHERE assisted_flash = 1 GROUP BY match_id, assister
  )
  SELECT match_id, steam_id, SUM(CASE WHEN f = ''assists'' THEN n END) AS assists, SUM(CASE WHEN f = ''flash_assists'' THEN n END) AS flash_assists FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id
  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: sum(flash_assists) — assists for blinding an enemy a teammate then killed, addressed per player — the expanded player row''s Flash assists count.',
 'builtin', CURRENT_TIMESTAMP),
('enemies_flashed', 'Enemies flashed', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(enemies_flashed) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.enemies_flashed, 0) AS enemies_flashed
  FROM player_stats ps
  LEFT JOIN (WITH bl AS (
  SELECT e.match_id, e.attacker, e.victim, sa.side AS a_side, sv.side AS v_side
  FROM events e
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  WHERE e.match_id = :match_id AND e.kind = ''blind'' AND e.post_match = 0
),
fold AS (
    SELECT match_id, attacker AS steam_id, ''enemies_flashed'' AS f, COUNT(*) AS n FROM bl WHERE attacker <> '''' AND attacker <> victim AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side) GROUP BY match_id, attacker
  )
  SELECT match_id, steam_id, SUM(CASE WHEN f = ''enemies_flashed'' THEN n END) AS enemies_flashed FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id
  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: sum(enemies_flashed) — enemies blinded by this player''s flashes (each counted once), addressed per player — the Enemies flashed count in the expanded player row.',
 'builtin', CURRENT_TIMESTAMP),
('entry_kills', 'Opening kills', 'Open K',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(entry_kills) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.kills, 0) AS kills
  FROM player_stats ps
  LEFT JOIN (WITH k AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,
         (e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake,
         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side
  FROM events e
  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = ''player_disconnect'') dc
    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister
  WHERE e.match_id = :match_id AND e.kind = ''kill'' AND e.post_match = 0
),
ek AS (
  SELECT * FROM k WHERE attacker <> '''' AND attacker <> victim AND fake = 0
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
),
fold AS (
    SELECT match_id, attacker AS steam_id, ''kills'' AS f, COUNT(*) AS n FROM ek GROUP BY match_id, attacker
  )
  SELECT match_id, steam_id, SUM(CASE WHEN f = ''kills'' THEN n END) AS kills FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id
  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: sum(entry_kills) — round-opening first-blood kills, addressed per player — the scoreboard''s Open K column (same recording as opening kills).',
 'builtin', CURRENT_TIMESTAMP),
('entry_deaths', 'Opening deaths', 'Open D',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(entry_deaths) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.deaths, 0) AS deaths
  FROM player_stats ps
  LEFT JOIN (WITH k AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,
         (e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake,
         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side
  FROM events e
  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = ''player_disconnect'') dc
    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister
  WHERE e.match_id = :match_id AND e.kind = ''kill'' AND e.post_match = 0
),
ek AS (
  SELECT * FROM k WHERE attacker <> '''' AND attacker <> victim AND fake = 0
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
),
fold AS (
    SELECT match_id, victim AS steam_id, ''deaths'' AS f, COUNT(*) AS n FROM k WHERE victim <> '''' AND fake = 0 GROUP BY match_id, victim
  )
  SELECT match_id, steam_id, SUM(CASE WHEN f = ''deaths'' THEN n END) AS deaths FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id
  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: sum(entry_deaths) — round-opening first-blood victims, addressed per player — the scoreboard''s Open D column, beside Open K.',
 'builtin', CURRENT_TIMESTAMP),
('best_streak', 'Best streak', 'Streak',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, MAX(best_streak) AS v FROM player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: max(best_streak) — the longest kill streak the player reached, addressed per player — the scoreboard''s Streak column.',
 'builtin', CURRENT_TIMESTAMP),
('two_k', '2K', '2K',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(two_k) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.two_k, 0) AS two_k
  FROM player_stats ps
  LEFT JOIN (WITH k AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,
         (e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake,
         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side
  FROM events e
  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = ''player_disconnect'') dc
    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister
  WHERE e.match_id = :match_id AND e.kind = ''kill'' AND e.post_match = 0
),
ek AS (
  SELECT * FROM k WHERE attacker <> '''' AND attacker <> victim AND fake = 0
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
),
ekr AS (
  SELECT match_id, round, attacker, COUNT(*) AS c FROM ek GROUP BY match_id, round, attacker
),
fold AS (
    SELECT match_id, attacker AS steam_id, ''two_k'' AS f, SUM(CASE WHEN c = 2 THEN 1 ELSE 0 END) AS n FROM ekr GROUP BY match_id, attacker
  )
  SELECT match_id, steam_id, SUM(CASE WHEN f = ''two_k'' THEN n END) AS two_k FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id
  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: sum(two_k) — rounds with exactly 2 kills (one tier each), addressed per player — the scoreboard''s 2K column.',
 'builtin', CURRENT_TIMESTAMP),
('three_k', '3K', '3K',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(three_k) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.three_k, 0) AS three_k
  FROM player_stats ps
  LEFT JOIN (WITH k AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,
         (e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake,
         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side
  FROM events e
  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = ''player_disconnect'') dc
    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister
  WHERE e.match_id = :match_id AND e.kind = ''kill'' AND e.post_match = 0
),
ek AS (
  SELECT * FROM k WHERE attacker <> '''' AND attacker <> victim AND fake = 0
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
),
ekr AS (
  SELECT match_id, round, attacker, COUNT(*) AS c FROM ek GROUP BY match_id, round, attacker
),
fold AS (
    SELECT match_id, attacker AS steam_id, ''three_k'' AS f, SUM(CASE WHEN c = 3 THEN 1 ELSE 0 END) AS n FROM ekr GROUP BY match_id, attacker
  )
  SELECT match_id, steam_id, SUM(CASE WHEN f = ''three_k'' THEN n END) AS three_k FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id
  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: sum(three_k) — rounds with exactly 3 kills (one tier each), addressed per player — the scoreboard''s 3K column.',
 'builtin', CURRENT_TIMESTAMP),
('four_k', '4K', '4K',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(four_k) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.four_k, 0) AS four_k
  FROM player_stats ps
  LEFT JOIN (WITH k AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,
         (e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake,
         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side
  FROM events e
  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = ''player_disconnect'') dc
    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister
  WHERE e.match_id = :match_id AND e.kind = ''kill'' AND e.post_match = 0
),
ek AS (
  SELECT * FROM k WHERE attacker <> '''' AND attacker <> victim AND fake = 0
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
),
ekr AS (
  SELECT match_id, round, attacker, COUNT(*) AS c FROM ek GROUP BY match_id, round, attacker
),
fold AS (
    SELECT match_id, attacker AS steam_id, ''four_k'' AS f, SUM(CASE WHEN c = 4 THEN 1 ELSE 0 END) AS n FROM ekr GROUP BY match_id, attacker
  )
  SELECT match_id, steam_id, SUM(CASE WHEN f = ''four_k'' THEN n END) AS four_k FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id
  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: sum(four_k) — rounds with exactly 4 kills (one tier each), addressed per player — the scoreboard''s 4K column.',
 'builtin', CURRENT_TIMESTAMP),
('five_k', '5K', '5K',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(five_k) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.five_k, 0) AS five_k
  FROM player_stats ps
  LEFT JOIN (WITH k AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,
         (e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake,
         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side
  FROM events e
  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = ''player_disconnect'') dc
    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister
  WHERE e.match_id = :match_id AND e.kind = ''kill'' AND e.post_match = 0
),
ek AS (
  SELECT * FROM k WHERE attacker <> '''' AND attacker <> victim AND fake = 0
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
),
ekr AS (
  SELECT match_id, round, attacker, COUNT(*) AS c FROM ek GROUP BY match_id, round, attacker
),
fold AS (
    SELECT match_id, attacker AS steam_id, ''five_k'' AS f, SUM(CASE WHEN c >= 5 THEN 1 ELSE 0 END) AS n FROM ekr GROUP BY match_id, attacker
  )
  SELECT match_id, steam_id, SUM(CASE WHEN f = ''five_k'' THEN n END) AS five_k FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id
  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: sum(five_k) — rounds with exactly 5 kills (a five-kill round counts only here), addressed per player — the scoreboard''s 5K column.',
 'builtin', CURRENT_TIMESTAMP),
('rounds_with_assist', 'Assist rounds', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(CASE WHEN (assists > 0) THEN 1 ELSE 0 END) AS v FROM (SELECT prs.match_id, prs.round, prs.steam_id, prs.name, prs.traded, prs.kast, prs.money_start, prs.equip, prs.spent, prs.rule_version, prs.side, COALESCE(f.assists, 0) AS assists
  FROM player_round_stats prs
  LEFT JOIN (WITH k AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.assisted_flash,
         (e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake,
         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side
  FROM events e
  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = ''player_disconnect'') dc
    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister
  WHERE e.match_id = :match_id AND e.kind = ''kill'' AND e.post_match = 0
),
ek AS (
  SELECT * FROM k WHERE attacker <> '''' AND attacker <> victim AND fake = 0
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
),
ak AS (
  SELECT * FROM k WHERE assister <> '''' AND assister <> victim AND attacker <> '''' AND attacker <> victim
    AND fake = 0 AND assisted_flash = 0
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
    AND NOT (COALESCE(s_side, '''') <> '''' AND s_side = v_side)
),
fold AS (
    SELECT match_id, round, assister AS steam_id, ''assists'' AS f, COUNT(*) AS n FROM ak GROUP BY match_id, round, assister
  )
  SELECT match_id, round, steam_id, SUM(CASE WHEN f = ''assists'' THEN n END) AS assists FROM fold GROUP BY match_id, round, steam_id) f ON f.match_id = prs.match_id AND f.round = prs.round AND f.steam_id = prs.steam_id
  WHERE prs.match_id = :match_id) player_round_stats WHERE player_round_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_round_stats.match_id AND p.steam_id = player_round_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: count(player_round_stats rows WHERE assists > 0) — the player''s rounds with ≥1 assist: the KAST A component as a count of rounds, addressed per player.',
 'builtin', CURRENT_TIMESTAMP),
('rounds_traded', 'Traded rounds', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(traded) AS v FROM player_round_stats WHERE player_round_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_round_stats.match_id AND p.steam_id = player_round_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: sum(traded) — rounds where this player''s own death was answered inside the trade window: the KAST T component, addressed per player.',
 'builtin', CURRENT_TIMESTAMP),
('trade_kills', 'Trade kills', 'Trade',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(trade_kills) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.kills, 0) AS kills
  FROM player_stats ps
  LEFT JOIN (WITH k AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,
         (e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake,
         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side
  FROM events e
  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = ''player_disconnect'') dc
    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister
  WHERE e.match_id = :match_id AND e.kind = ''kill'' AND e.post_match = 0
),
ek AS (
  SELECT * FROM k WHERE attacker <> '''' AND attacker <> victim AND fake = 0
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
),
fold AS (
    SELECT match_id, attacker AS steam_id, ''kills'' AS f, COUNT(*) AS n FROM ek GROUP BY match_id, attacker
  )
  SELECT match_id, steam_id, SUM(CASE WHEN f = ''kills'' THEN n END) AS kills FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id
  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: sum(trade_kills) — kills that answered a teammate''s death inside the trade window, addressed per player — the Trade column and Trade rate''s numerator.',
 'builtin', CURRENT_TIMESTAMP),
('missed_trades', 'Missed trades', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT player_stats.match_id AS mid, player_stats.steam_id AS grp, SUM(match_trade_opps.missed) AS v FROM player_stats LEFT JOIN match_trade_opps ON player_stats.match_id = match_trade_opps.match_id AND player_stats.steam_id = match_trade_opps.steam_id WHERE player_stats.match_id = :match_id AND (player_stats.steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: sum(match_trade_opps.missed) — teammate deaths nobody answered inside the window, addressed per player over the joined sources — zero opportunities still shows 0.',
 'builtin', CURRENT_TIMESTAMP),
('eng_opening', 'Opening kill tags', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, a_steam AS grp, SUM(CASE WHEN (kind = ''opening'') THEN 1 ELSE 0 END) AS v FROM engagements WHERE engagements.match_id = :match_id AND (a_steam <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = engagements.match_id AND p.steam_id = engagements.a_steam AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: count(engagements rows WHERE kind = ''opening'') — round-opening kill tags with this player as killer, addressed per player — from the kill tag list; unknown-side rounds read lower than Entry.',
 'builtin', CURRENT_TIMESTAMP),
('eng_trade', 'Trade kill tags', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, a_steam AS grp, SUM(CASE WHEN (kind = ''trade'') THEN 1 ELSE 0 END) AS v FROM engagements WHERE engagements.match_id = :match_id AND (a_steam <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = engagements.match_id AND p.steam_id = engagements.a_steam AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: count(engagements rows WHERE kind = ''trade'') — strict-window trade kills with this player as killer, addressed per player — the same number as Trade kills, from the kill tag list.',
 'builtin', CURRENT_TIMESTAMP),
('eng_traded', 'Kills traded (A-side)', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, a_steam AS grp, SUM(CASE WHEN (kind = ''traded'') THEN 1 ELSE 0 END) AS v FROM engagements WHERE engagements.match_id = :match_id AND (a_steam <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = engagements.match_id AND p.steam_id = engagements.a_steam AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: count(engagements rows WHERE kind = ''traded'') — this player''s kills the enemy answered inside the window (killer-side), addressed per player — own unanswered deaths are Untraded deaths.',
 'builtin', CURRENT_TIMESTAMP),
('eng_untraded', 'Kills untraded (A-side)', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, a_steam AS grp, SUM(CASE WHEN (kind = ''untraded'') THEN 1 ELSE 0 END) AS v FROM engagements WHERE engagements.match_id = :match_id AND (a_steam <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = engagements.match_id AND p.steam_id = engagements.a_steam AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: count(engagements rows WHERE kind = ''untraded'') — this player''s kills the enemy did not answer inside the window (killer-side), addressed per player — Untraded deaths counts the victim side.',
 'builtin', CURRENT_TIMESTAMP),
('clutches', 'Clutches', '',
 '{{CLUTCH_CTE}} SELECT c.steam_id AS subject_key, '''' AS dim, COUNT(*) AS value FROM clutch c WHERE c.steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = :match_id AND p.steam_id = c.steam_id AND p.is_bot = 1) GROUP BY c.steam_id',
 'match', 'int',
 'Formula: count(clutches) — the 1vN attempts recorded for this player in the match, addressed per player — the count; the clutch list stays a match detail.',
 'builtin', CURRENT_TIMESTAMP),
('clutch_win_rate', 'Clutch win %', '',
 '{{CLUTCH_CTE}} SELECT c.steam_id AS subject_key, '''' AS dim, AVG(c.won) AS value FROM clutch c WHERE c.steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = :match_id AND p.steam_id = c.steam_id AND p.is_bot = 1) GROUP BY c.steam_id',
 'match', 'percent',
 'Formula: avg(clutches.won) — the share of the player''s clutches won, shown as a percent, addressed per player — the match-scope twin of career Clutch win %.',
 'builtin', CURRENT_TIMESTAMP),
('clutch_avg_size', 'Avg clutch size', '',
 '{{CLUTCH_CTE}} SELECT c.steam_id AS subject_key, '''' AS dim, AVG(c.size) AS value FROM clutch c WHERE c.steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = :match_id AND p.steam_id = c.steam_id AND p.is_bot = 1) GROUP BY c.steam_id',
 'match', 'float1',
 'Formula: avg(clutches.size) — the mean size (the N of the 1vN) of the player''s clutches, addressed per player.',
 'builtin', CURRENT_TIMESTAMP),
('clutch_avg_hp', 'Avg clutch HP', '',
 '{{CLUTCH_CTE}} SELECT c.steam_id AS subject_key, '''' AS dim, AVG(c.hp_left) AS value FROM clutch c WHERE c.steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = :match_id AND p.steam_id = c.steam_id AND p.is_bot = 1) GROUP BY c.steam_id',
 'match', 'float1',
 'Formula: avg(clutches.hp_left) — the mean hit points the player ended their clutches with (0 = died alone), addressed per player.',
 'builtin', CURRENT_TIMESTAMP),
('clutch_avg_equip', 'Avg clutch equip', '',
 '{{CLUTCH_CTE}} SELECT c.steam_id AS subject_key, '''' AS dim, AVG(c.equip) AS value FROM clutch c WHERE c.steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = :match_id AND p.steam_id = c.steam_id AND p.is_bot = 1) GROUP BY c.steam_id',
 'match', 'currency',
 'Formula: avg(clutches.equip) — the mean equipment value the player held in their clutches, in whole dollars, addressed per player.',
 'builtin', CURRENT_TIMESTAMP),
('util_nades', 'Nades thrown', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, thrower AS grp, COUNT(*) AS v FROM utility_events WHERE utility_events.match_id = :match_id AND (thrower <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = utility_events.match_id AND p.steam_id = utility_events.thrower AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: count(utility_events) — grenade detonations credited to this player''s throws (one per detonation), addressed per player — the per-throw list stays a replay detail.',
 'builtin', CURRENT_TIMESTAMP),
('util_dmg', 'Util damage (paired)', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, thrower AS grp, SUM(damage) AS v FROM utility_events WHERE utility_events.match_id = :match_id AND (thrower <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = utility_events.match_id AND p.steam_id = utility_events.thrower AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: sum(utility_events.damage) — damage this player''s grenades dealt inside their burn window, addressed per player — hits outside a grenade''s window don''t count.',
 'builtin', CURRENT_TIMESTAMP),
('util_flash_ms', 'Blind time (ms)', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, thrower AS grp, SUM(flash_ms) AS v FROM utility_events WHERE utility_events.match_id = :match_id AND (thrower <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = utility_events.match_id AND p.steam_id = utility_events.thrower AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: sum(utility_events.flash_ms) — the total blind time this player''s flashes applied, addressed per player — whole milliseconds (no time format yet).',
 'builtin', CURRENT_TIMESTAMP),
('weapon_drops', 'Weapon drops', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, attacker AS grp, SUM(CASE WHEN (kind = ''weapon_drop'') THEN 1 ELSE 0 END) AS v FROM events WHERE events.match_id = :match_id AND (attacker <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = events.match_id AND p.steam_id = events.attacker AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: count(events rows WHERE kind = ''weapon_drop'') — weapon drops recorded at this player''s deaths, addressed per player — the per-drop list stays a replay detail.',
 'builtin', CURRENT_TIMESTAMP),
-- ---- inferred set, profile scope (1 row).
('career_clutches', 'Clutches', '', 'SELECT :steam_id AS subject_key, '''' AS dim, (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric(''clutches'')) AS value WHERE EXISTS (SELECT 1 FROM metric(''clutches''))', 'profile', 'int', 'Formula: sum(clutches) — the player''s career 1vN clutch count, addressed per player — the profile''s Clutches number; the list stays a match detail.', 'builtin', CURRENT_TIMESTAMP),
-- ---- inferred set, T2 (10 rows): counts over the stored analysis-rule
-- outputs — a round label and a per-side buy class are round-grain
-- text, so a metric counts them per player and never renders them.
('round_label_eco', 'Rounds labeled eco', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT player_round_stats.match_id AS mid, player_round_stats.steam_id AS grp, SUM(CASE WHEN (round_classifications.label = ''eco'') THEN 1 ELSE 0 END) AS v FROM player_round_stats LEFT JOIN round_classifications ON player_round_stats.match_id = round_classifications.match_id AND player_round_stats.round = round_classifications.round WHERE player_round_stats.match_id = :match_id AND (player_round_stats.steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_round_stats.match_id AND p.steam_id = player_round_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: count(player_round_stats rows joined to round_classifications ON (match_id, round) WHERE label = ''eco'') — rounds played with the label eco, addressed per player over the joined sources.',
 'builtin', CURRENT_TIMESTAMP),
('round_label_force', 'Rounds labeled force', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT player_round_stats.match_id AS mid, player_round_stats.steam_id AS grp, SUM(CASE WHEN (round_classifications.label = ''force'') THEN 1 ELSE 0 END) AS v FROM player_round_stats LEFT JOIN round_classifications ON player_round_stats.match_id = round_classifications.match_id AND player_round_stats.round = round_classifications.round WHERE player_round_stats.match_id = :match_id AND (player_round_stats.steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_round_stats.match_id AND p.steam_id = player_round_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: count(player_round_stats rows joined to round_classifications ON (match_id, round) WHERE label = ''force'') — rounds played with the label force, addressed per player over the joined sources.',
 'builtin', CURRENT_TIMESTAMP),
('round_label_full', 'Rounds labeled full', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT player_round_stats.match_id AS mid, player_round_stats.steam_id AS grp, SUM(CASE WHEN (round_classifications.label = ''full'') THEN 1 ELSE 0 END) AS v FROM player_round_stats LEFT JOIN round_classifications ON player_round_stats.match_id = round_classifications.match_id AND player_round_stats.round = round_classifications.round WHERE player_round_stats.match_id = :match_id AND (player_round_stats.steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_round_stats.match_id AND p.steam_id = player_round_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: count(player_round_stats rows joined to round_classifications ON (match_id, round) WHERE label = ''full'') — rounds played with the label full, addressed per player over the joined sources.',
 'builtin', CURRENT_TIMESTAMP),
('round_label_save', 'Rounds labeled save', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT player_round_stats.match_id AS mid, player_round_stats.steam_id AS grp, SUM(CASE WHEN (round_classifications.label = ''save'') THEN 1 ELSE 0 END) AS v FROM player_round_stats LEFT JOIN round_classifications ON player_round_stats.match_id = round_classifications.match_id AND player_round_stats.round = round_classifications.round WHERE player_round_stats.match_id = :match_id AND (player_round_stats.steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_round_stats.match_id AND p.steam_id = player_round_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: count(player_round_stats rows joined to round_classifications ON (match_id, round) WHERE label = ''save'') — rounds played with the label save, addressed per player over the joined sources.',
 'builtin', CURRENT_TIMESTAMP),
('pistol_rounds', 'Pistol rounds', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT player_round_stats.match_id AS mid, player_round_stats.steam_id AS grp, SUM(CASE WHEN (round_classifications.label = ''pistol'') THEN 1 ELSE 0 END) AS v FROM player_round_stats LEFT JOIN round_classifications ON player_round_stats.match_id = round_classifications.match_id AND player_round_stats.round = round_classifications.round WHERE player_round_stats.match_id = :match_id AND (player_round_stats.steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_round_stats.match_id AND p.steam_id = player_round_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: count(player_round_stats rows joined to round_classifications ON (match_id, round) WHERE label = ''pistol'') — rounds played with the label pistol, addressed per player over the joined sources.',
 'builtin', CURRENT_TIMESTAMP),
('side_class_eco', 'Rounds on eco side', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT round_player_sides.match_id AS mid, round_player_sides.steam_id AS grp, SUM(CASE WHEN (round_side_classes.class = ''eco'') THEN 1 ELSE 0 END) AS v FROM round_player_sides LEFT JOIN round_side_classes ON round_player_sides.match_id = round_side_classes.match_id AND round_player_sides.round = round_side_classes.round AND round_player_sides.side = round_side_classes.side WHERE round_player_sides.match_id = :match_id AND (round_player_sides.steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = round_player_sides.match_id AND p.steam_id = round_player_sides.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: count(round_player_sides rows joined to round_side_classes ON (match_id, round, side) WHERE class = ''eco'') — rounds played on an eco side, addressed per player over the joined sources.',
 'builtin', CURRENT_TIMESTAMP),
('side_class_force', 'Rounds on force side', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT round_player_sides.match_id AS mid, round_player_sides.steam_id AS grp, SUM(CASE WHEN (round_side_classes.class = ''force'') THEN 1 ELSE 0 END) AS v FROM round_player_sides LEFT JOIN round_side_classes ON round_player_sides.match_id = round_side_classes.match_id AND round_player_sides.round = round_side_classes.round AND round_player_sides.side = round_side_classes.side WHERE round_player_sides.match_id = :match_id AND (round_player_sides.steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = round_player_sides.match_id AND p.steam_id = round_player_sides.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: count(round_player_sides rows joined to round_side_classes ON (match_id, round, side) WHERE class = ''force'') — rounds played on a force side, addressed per player over the joined sources.',
 'builtin', CURRENT_TIMESTAMP),
('side_class_full', 'Rounds on full-buy side', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT round_player_sides.match_id AS mid, round_player_sides.steam_id AS grp, SUM(CASE WHEN (round_side_classes.class = ''full'') THEN 1 ELSE 0 END) AS v FROM round_player_sides LEFT JOIN round_side_classes ON round_player_sides.match_id = round_side_classes.match_id AND round_player_sides.round = round_side_classes.round AND round_player_sides.side = round_side_classes.side WHERE round_player_sides.match_id = :match_id AND (round_player_sides.steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = round_player_sides.match_id AND p.steam_id = round_player_sides.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: count(round_player_sides rows joined to round_side_classes ON (match_id, round, side) WHERE class = ''full'') — rounds played on a full-buy side, addressed per player over the joined sources.',
 'builtin', CURRENT_TIMESTAMP),
('side_class_save', 'Rounds on save side', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT round_player_sides.match_id AS mid, round_player_sides.steam_id AS grp, SUM(CASE WHEN (round_side_classes.class = ''save'') THEN 1 ELSE 0 END) AS v FROM round_player_sides LEFT JOIN round_side_classes ON round_player_sides.match_id = round_side_classes.match_id AND round_player_sides.round = round_side_classes.round AND round_player_sides.side = round_side_classes.side WHERE round_player_sides.match_id = :match_id AND (round_player_sides.steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = round_player_sides.match_id AND p.steam_id = round_player_sides.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: count(round_player_sides rows joined to round_side_classes ON (match_id, round, side) WHERE class = ''save'') — rounds played on a save side, addressed per player over the joined sources.',
 'builtin', CURRENT_TIMESTAMP),
('side_class_pistol', 'Rounds on pistol side', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT round_player_sides.match_id AS mid, round_player_sides.steam_id AS grp, SUM(CASE WHEN (round_side_classes.class = ''pistol'') THEN 1 ELSE 0 END) AS v FROM round_player_sides LEFT JOIN round_side_classes ON round_player_sides.match_id = round_side_classes.match_id AND round_player_sides.round = round_side_classes.round AND round_player_sides.side = round_side_classes.side WHERE round_player_sides.match_id = :match_id AND (round_player_sides.steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = round_player_sides.match_id AND p.steam_id = round_player_sides.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: count(round_player_sides rows joined to round_side_classes ON (match_id, round, side) WHERE class = ''pistol'') — rounds played on a pistol side, addressed per player over the joined sources.',
 'builtin', CURRENT_TIMESTAMP),
-- ---- addendum: the victim-side duel count (1 row) — the engagements
-- table read through its curated victim-side source (whitelist.go
-- engagements_victim).
('untraded_deaths', 'Untraded deaths', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, b_steam AS grp, SUM(CASE WHEN (kind = ''untraded'') THEN 1 ELSE 0 END) AS v FROM engagements AS engagements_victim WHERE engagements_victim.match_id = :match_id AND (b_steam <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = engagements_victim.match_id AND p.steam_id = engagements_victim.b_steam AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: count(engagements rows WHERE kind = ''untraded'') — deaths of this player nobody answered inside the window, addressed per player — the Combat tab''s Untraded deaths column.',
 'builtin', CURRENT_TIMESTAMP),
-- ---- addendum: the opening-duel trio (3 rows, profile scope) — the
-- additive sum(a + b) chain is what the duel total needs.
('career_opening_rate', 'Opening kill tags', '', 'SELECT :steam_id AS subject_key, '''' AS dim, 1.0 * (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric(''entry_kills'')) / NULLIF((SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric(''entry_kills'')) + (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric(''entry_deaths'')), 0) AS value WHERE EXISTS (SELECT 1 FROM metric(''entry_kills''))', 'profile', 'percent', 'Formula: sum(entry_kills) / sum(entry_kills + entry_deaths) — career opening kill tags won, shown as a percent, addressed per player (the Opening kill tags card).', 'builtin', CURRENT_TIMESTAMP),
('career_openings', 'Openings', '', 'SELECT :steam_id AS subject_key, '''' AS dim, (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric(''entry_kills'')) + (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric(''entry_deaths'')) AS value WHERE EXISTS (SELECT 1 FROM metric(''entry_kills''))', 'profile', 'int', 'Formula: sum(entry_kills + entry_deaths) — the player''s career opening kill tags: the opening kill plus the first-blood deaths it produced, addressed per player.', 'builtin', CURRENT_TIMESTAMP),
('career_opener_wins', 'Opener wins', '', 'SELECT :steam_id AS subject_key, '''' AS dim, (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric(''entry_kills'')) AS value WHERE EXISTS (SELECT 1 FROM metric(''entry_kills''))', 'profile', 'int', 'Formula: sum(entry_kills) — opening kills across the player''s career, addressed per player — the wins half of the Opening kill tags percentage.', 'builtin', CURRENT_TIMESTAMP),
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
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT events.match_id AS mid, events.attacker AS grp, SUM(CASE WHEN ((events.kind = ''damage'' AND events.post_match = 0) AND (NOT EXISTS (SELECT 1 FROM events AS x0 WHERE x0.match_id = events.match_id AND x0.kind = ''kill'' AND x0.post_match = 0 AND x0.tick = events.tick AND x0.attacker = events.attacker AND x0.victim = events.victim)) AND (NOT (COALESCE(pa.side, '''') <> '''' AND COALESCE(pa.side, '''') = COALESCE(pv.side, '''')))) THEN events.dmg END) AS v FROM events LEFT JOIN player_ticks AS pa ON pa.match_id = events.match_id AND pa.tick = events.tick AND pa.steam_id = events.attacker LEFT JOIN player_ticks AS pv ON pv.match_id = events.match_id AND pv.tick = events.tick AND pv.steam_id = events.victim WHERE events.match_id = :match_id AND (events.attacker <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = events.match_id AND p.steam_id = events.attacker AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: sum(events.dmg over enemy damage events WHERE no same-tick, same-actor kill exists) — damage that did not convert into a kill, addressed per player.',
 'builtin', CURRENT_TIMESTAMP),
('kill_conversion', 'Kill conversion %', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT events.match_id AS mid, events.attacker AS grp, 1.0*(SUM(CASE WHEN ((events.kind = ''damage'' AND events.post_match = 0) AND EXISTS (SELECT 1 FROM events AS x0 WHERE x0.match_id = events.match_id AND x0.kind = ''kill'' AND x0.post_match = 0 AND x0.tick = events.tick AND x0.attacker = events.attacker AND x0.victim = events.victim) AND (NOT (COALESCE(pa.side, '''') <> '''' AND COALESCE(pa.side, '''') = COALESCE(pv.side, '''')))) THEN events.dmg END)) / NULLIF((SUM(CASE WHEN ((events.kind = ''damage'' AND events.post_match = 0) AND (NOT (COALESCE(pa.side, '''') <> '''' AND COALESCE(pa.side, '''') = COALESCE(pv.side, '''')))) THEN events.dmg END)), 0) AS v FROM events LEFT JOIN player_ticks AS pa ON pa.match_id = events.match_id AND pa.tick = events.tick AND pa.steam_id = events.attacker LEFT JOIN player_ticks AS pv ON pv.match_id = events.match_id AND pv.tick = events.tick AND pv.steam_id = events.victim WHERE events.match_id = :match_id AND (events.attacker <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = events.match_id AND p.steam_id = events.attacker AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'percent',
 'Formula: sum(events.dmg with a same-tick, same-actor kill) / sum(events.dmg), both over enemy damage — the share of this player''s damage that converts into kills, addressed per player — a percent.',
 'builtin', CURRENT_TIMESTAMP),
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
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(kills) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.kills, 0) AS kills
  FROM player_stats ps
  LEFT JOIN (WITH k AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,
         (e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake,
         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side
  FROM events e
  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = ''player_disconnect'') dc
    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister
  WHERE e.match_id = :match_id AND e.kind = ''kill'' AND e.post_match = 0
),
ek AS (
  SELECT * FROM k WHERE attacker <> '''' AND attacker <> victim AND fake = 0
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
),
fold AS (
    SELECT match_id, attacker AS steam_id, ''kills'' AS f, COUNT(*) AS n FROM ek GROUP BY match_id, attacker
  )
  SELECT match_id, steam_id, SUM(CASE WHEN f = ''kills'' THEN n END) AS kills FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id
  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: sum(kills) — kills this player earned, addressed per player — the scoreboard''s K column.',
 'builtin', CURRENT_TIMESTAMP),
('deaths', 'Deaths', 'D',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(deaths) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.deaths, 0) AS deaths
  FROM player_stats ps
  LEFT JOIN (WITH k AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,
         (e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake,
         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side
  FROM events e
  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = ''player_disconnect'') dc
    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister
  WHERE e.match_id = :match_id AND e.kind = ''kill'' AND e.post_match = 0
),
ek AS (
  SELECT * FROM k WHERE attacker <> '''' AND attacker <> victim AND fake = 0
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
),
fold AS (
    SELECT match_id, victim AS steam_id, ''deaths'' AS f, COUNT(*) AS n FROM k WHERE victim <> '''' AND fake = 0 GROUP BY match_id, victim
  )
  SELECT match_id, steam_id, SUM(CASE WHEN f = ''deaths'' THEN n END) AS deaths FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id
  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: sum(deaths) — deaths this player suffered, addressed per player — the scoreboard''s D column.',
 'builtin', CURRENT_TIMESTAMP),
('mvps', 'MVPs', 'MVPs',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(mvps) AS v FROM player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: sum(mvps) — rounds this player was awarded MVP, addressed per player — the scoreboard''s MVPs column.',
 'builtin', CURRENT_TIMESTAMP),
('total_damage', 'Damage', 'DMG',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(total_damage) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.total_damage, 0) AS total_damage
  FROM player_stats ps
  LEFT JOIN (WITH dmg AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.weapon, e.capped_dmg, e.detail_json,
         sa.side AS a_side, sv.side AS v_side
  FROM events e
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  WHERE e.match_id = :match_id AND e.kind = ''damage'' AND e.post_match = 0
),
edmg AS (
  SELECT * FROM dmg WHERE attacker <> '''' AND attacker <> victim
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
),
fold AS (
    SELECT match_id, attacker AS steam_id, ''total_damage'' AS f, SUM(capped_dmg) AS n FROM edmg GROUP BY match_id, attacker
  )
  SELECT match_id, steam_id, SUM(CASE WHEN f = ''total_damage'' THEN n END) AS total_damage FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id
  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: sum(total_damage) — damage this player dealt, addressed per player — the scoreboard''s DMG column (ADR divides the same total by rounds).',
 'builtin', CURRENT_TIMESTAMP),
('utility_damage', 'Utility damage', 'Util',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(utility_damage) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.utility_damage, 0) AS utility_damage
  FROM player_stats ps
  LEFT JOIN (WITH dmg AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.weapon, e.capped_dmg, e.detail_json,
         sa.side AS a_side, sv.side AS v_side
  FROM events e
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  WHERE e.match_id = :match_id AND e.kind = ''damage'' AND e.post_match = 0
),
edmg AS (
  SELECT * FROM dmg WHERE attacker <> '''' AND attacker <> victim
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
),
fold AS (
    SELECT match_id, attacker AS steam_id, ''utility_damage'' AS f, SUM(CASE WHEN weapon IN (''HE Grenade'', ''Flashbang'', ''Smoke Grenade'', ''Molotov'', ''Incendiary Grenade'', ''Decoy Grenade'') THEN capped_dmg ELSE 0 END) AS n FROM edmg GROUP BY match_id, attacker
  )
  SELECT match_id, steam_id, SUM(CASE WHEN f = ''utility_damage'' THEN n END) AS utility_damage FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id
  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: sum(utility_damage) — the scoreboard''s raw Util total, addressed per player — all utility damage this player dealt (Util damage (paired) counts only in-window grenade hits).',
 'builtin', CURRENT_TIMESTAMP),
('headshots', 'Headshots', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(headshots) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.headshots, 0) AS headshots
  FROM player_stats ps
  LEFT JOIN (WITH k AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,
         (e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake,
         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side
  FROM events e
  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = ''player_disconnect'') dc
    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister
  WHERE e.match_id = :match_id AND e.kind = ''kill'' AND e.post_match = 0
),
ek AS (
  SELECT * FROM k WHERE attacker <> '''' AND attacker <> victim AND fake = 0
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
),
fold AS (
    SELECT match_id, attacker AS steam_id, ''headshots'' AS f, SUM(headshot) AS n FROM ek GROUP BY match_id, attacker
  )
  SELECT match_id, steam_id, SUM(CASE WHEN f = ''headshots'' THEN n END) AS headshots FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id
  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: sum(headshots) — kills that landed as headshots, addressed per player — the raw count behind HS%.',
 'builtin', CURRENT_TIMESTAMP),
('teamkills', 'Team kills', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(teamkills) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.kills, 0) AS kills, COALESCE(f.teamkills, 0) AS teamkills
  FROM player_stats ps
  LEFT JOIN (WITH k AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,
         (e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake,
         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side
  FROM events e
  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = ''player_disconnect'') dc
    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister
  WHERE e.match_id = :match_id AND e.kind = ''kill'' AND e.post_match = 0
),
ek AS (
  SELECT * FROM k WHERE attacker <> '''' AND attacker <> victim AND fake = 0
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
),
fold AS (
    SELECT match_id, attacker AS steam_id, ''kills'' AS f, COUNT(*) AS n FROM ek GROUP BY match_id, attacker
    UNION ALL SELECT match_id, attacker AS steam_id, ''teamkills'' AS f, COUNT(*) AS n FROM k WHERE attacker <> '''' AND attacker <> victim AND fake = 0 AND COALESCE(a_side, '''') <> '''' AND a_side = v_side GROUP BY match_id, attacker
  )
  SELECT match_id, steam_id, SUM(CASE WHEN f = ''kills'' THEN n END) AS kills, SUM(CASE WHEN f = ''teamkills'' THEN n END) AS teamkills FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id
  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: sum(teamkills) — teammates this player killed, addressed per player — the raw team-kill count.',
 'builtin', CURRENT_TIMESTAMP),
('suicides', 'Suicides', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(suicides) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.suicides, 0) AS suicides
  FROM player_stats ps
  LEFT JOIN (WITH k AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,
         (e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake,
         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side
  FROM events e
  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = ''player_disconnect'') dc
    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister
  WHERE e.match_id = :match_id AND e.kind = ''kill'' AND e.post_match = 0
),
ek AS (
  SELECT * FROM k WHERE attacker <> '''' AND attacker <> victim AND fake = 0
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
),
fold AS (
    SELECT match_id, victim AS steam_id, ''suicides'' AS f, COUNT(*) AS n FROM k WHERE victim <> '''' AND attacker = victim AND fake = 0 GROUP BY match_id, victim
  )
  SELECT match_id, steam_id, SUM(CASE WHEN f = ''suicides'' THEN n END) AS suicides FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id
  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: sum(suicides) — deaths to their own hand, addressed per player — the raw suicide count.',
 'builtin', CURRENT_TIMESTAMP),
('damage_taken', 'Damage taken', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(damage_taken) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.damage_taken, 0) AS damage_taken
  FROM player_stats ps
  LEFT JOIN (WITH dmg AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.weapon, e.capped_dmg, e.detail_json,
         sa.side AS a_side, sv.side AS v_side
  FROM events e
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  WHERE e.match_id = :match_id AND e.kind = ''damage'' AND e.post_match = 0
),
edmg AS (
  SELECT * FROM dmg WHERE attacker <> '''' AND attacker <> victim
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
),
fold AS (
    SELECT match_id, victim AS steam_id, ''damage_taken'' AS f, SUM(CASE WHEN json_valid(detail_json) THEN CAST(json_extract(detail_json, ''$.damageTaken'') AS INTEGER) END) AS n FROM dmg WHERE victim <> '''' GROUP BY match_id, victim
  )
  SELECT match_id, steam_id, SUM(CASE WHEN f = ''damage_taken'' THEN n END) AS damage_taken FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id
  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: sum(damage_taken) — damage this player absorbed, addressed per player — the taken-damage total.',
 'builtin', CURRENT_TIMESTAMP),
('shots', 'Shots', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(shots) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.shots, 0) AS shots
  FROM player_stats ps
  LEFT JOIN (WITH fold AS (
    SELECT match_id, attacker AS steam_id, ''shots'' AS f, COUNT(*) AS n FROM events e WHERE e.match_id = :match_id AND e.kind = ''weapon_fire'' AND e.post_match = 0 GROUP BY match_id, attacker
  )
  SELECT match_id, steam_id, SUM(CASE WHEN f = ''shots'' THEN n END) AS shots FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id
  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: sum(shots) — shots this player fired, addressed per player — the raw shot count (accuracy is a derived ratio, not this row).',
 'builtin', CURRENT_TIMESTAMP),
('hits', 'Hits', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(hits) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.hits, 0) AS hits
  FROM player_stats ps
  LEFT JOIN (WITH dmg AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.weapon, e.capped_dmg, e.detail_json,
         sa.side AS a_side, sv.side AS v_side
  FROM events e
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  WHERE e.match_id = :match_id AND e.kind = ''damage'' AND e.post_match = 0
),
edmg AS (
  SELECT * FROM dmg WHERE attacker <> '''' AND attacker <> victim
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
),
fold AS (
    SELECT match_id, attacker AS steam_id, ''hits'' AS f, COUNT(*) AS n FROM edmg GROUP BY match_id, attacker
  )
  SELECT match_id, steam_id, SUM(CASE WHEN f = ''hits'' THEN n END) AS hits FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id
  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: sum(hits) — shots that connected, addressed per player — the raw hit count.',
 'builtin', CURRENT_TIMESTAMP),
('rounds_played', 'Rounds played', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(rounds_played) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.rounds_played, 0) AS rounds_played
  FROM player_stats ps
  LEFT JOIN (WITH fold AS (
    SELECT match_id, steam_id, ''rounds_played'' AS f, COUNT(*) AS n FROM round_player_sides WHERE match_id = :match_id GROUP BY match_id, steam_id
  )
  SELECT match_id, steam_id, SUM(CASE WHEN f = ''rounds_played'' THEN n END) AS rounds_played FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id
  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: sum(rounds_played) — rounds this player appeared in, addressed per player — their own rounds, never the match''s (ADR divides by the match''s).',
 'builtin', CURRENT_TIMESTAMP),
('flashed_times', 'Times flashed', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(flashed_times) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.flashed_times, 0) AS flashed_times
  FROM player_stats ps
  LEFT JOIN (WITH bl AS (
  SELECT e.match_id, e.attacker, e.victim, sa.side AS a_side, sv.side AS v_side
  FROM events e
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  WHERE e.match_id = :match_id AND e.kind = ''blind'' AND e.post_match = 0
),
fold AS (
    SELECT match_id, victim AS steam_id, ''flashed_times'' AS f, COUNT(*) AS n FROM bl WHERE victim <> '''' GROUP BY match_id, victim
  )
  SELECT match_id, steam_id, SUM(CASE WHEN f = ''flashed_times'' THEN n END) AS flashed_times FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id
  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: sum(flashed_times) — times this player was blinded, addressed per player — the raw blind count.',
 'builtin', CURRENT_TIMESTAMP),
('bomb_plants', 'Bomb plants', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(bomb_plants) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.bomb_plants, 0) AS bomb_plants
  FROM player_stats ps
  LEFT JOIN (WITH fold AS (
    SELECT match_id, attacker AS steam_id, ''bomb_plants'' AS f, COUNT(*) AS n FROM events e WHERE e.match_id = :match_id AND e.kind = ''bomb_plant'' AND e.post_match = 0 GROUP BY match_id, attacker
  )
  SELECT match_id, steam_id, SUM(CASE WHEN f = ''bomb_plants'' THEN n END) AS bomb_plants FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id
  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: sum(bomb_plants) — bombs this player planted, addressed per player — the raw plant count.',
 'builtin', CURRENT_TIMESTAMP),
('bomb_defuses', 'Bomb defuses', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(bomb_defuses) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.bomb_defuses, 0) AS bomb_defuses
  FROM player_stats ps
  LEFT JOIN (WITH fold AS (
    SELECT match_id, attacker AS steam_id, ''bomb_defuses'' AS f, COUNT(*) AS n FROM events e WHERE e.match_id = :match_id AND e.kind = ''bomb_defuse'' AND e.post_match = 0 GROUP BY match_id, attacker
  )
  SELECT match_id, steam_id, SUM(CASE WHEN f = ''bomb_defuses'' THEN n END) AS bomb_defuses FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id
  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: sum(bomb_defuses) — bombs this player defused, addressed per player — the raw defuse count.',
 'builtin', CURRENT_TIMESTAMP),
('money_spent_total', 'Money spent', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(money_spent_total) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.money_spent_total, 0) AS money_spent_total
  FROM player_stats ps
  LEFT JOIN (WITH fold AS (
    SELECT match_id, steam_id, ''money_spent_total'' AS f, SUM(spent) AS n FROM round_player_money WHERE match_id = :match_id GROUP BY match_id, steam_id
  )
  SELECT match_id, steam_id, SUM(CASE WHEN f = ''money_spent_total'' THEN n END) AS money_spent_total FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id
  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'int',
 'Formula: sum(money_spent_total) — money this player spent, addressed per player — whole dollars over the match.',
 'builtin', CURRENT_TIMESTAMP),
('career_kills', 'Kills', '',
 'SELECT :steam_id AS subject_key, '''' AS dim, (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric(''kills'')) AS value',
 'profile', 'int',
 'Formula: sum(kills) over the library — kills across the player''s career, addressed per player — the history row''s K column summed.',
 'builtin', CURRENT_TIMESTAMP),
('career_deaths', 'Deaths', '',
 'SELECT :steam_id AS subject_key, '''' AS dim, (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric(''deaths'')) AS value',
 'profile', 'int',
 'Formula: sum(deaths) over the library — deaths across the player''s career, addressed per player — the history row''s D column summed.',
 'builtin', CURRENT_TIMESTAMP),
('career_assists', 'Assists', '',
 'SELECT :steam_id AS subject_key, '''' AS dim, (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric(''assists'')) AS value',
 'profile', 'int',
 'Formula: sum(assists) over the library — cross-team assists across the player''s career, addressed per player — the history row''s A column summed.',
 'builtin', CURRENT_TIMESTAMP),
('career_mvps', 'MVPs', '', 'SELECT :steam_id AS subject_key, '''' AS dim, (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric(''mvps'')) AS value WHERE EXISTS (SELECT 1 FROM metric(''mvps''))', 'profile', 'int', 'Formula: sum(mvps) — MVP awards across the player''s career, addressed per player — the scoreboard MVPs column summed.', 'builtin', CURRENT_TIMESTAMP),
('career_total_damage', 'Damage', '',
 'SELECT :steam_id AS subject_key, '''' AS dim, (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric(''total_damage'')) AS value',
 'profile', 'int',
 'Formula: sum(total_damage) over the library — damage dealt across the player''s career, addressed per player — the DMG column summed (career ADR divides it).',
 'builtin', CURRENT_TIMESTAMP),
('career_matches', 'Matches played', '', 'SELECT :steam_id AS subject_key, '''' AS dim, (SELECT COUNT(*) FROM metric(''match_won'')) AS value WHERE EXISTS (SELECT 1 FROM metric(''match_won''))', 'profile', 'int', 'Formula: count(matches) — matches this player appears in, addressed per player — the profile''s Matches card as a pinnable metric.', 'builtin', CURRENT_TIMESTAMP),
-- ---- addendum: the KDA conversion (w13d, 1 row, match scope) — the
-- scoreboard's KDA column left the Go calculation for the metric
-- system (adoption means migration: GetScoreboard's kda alias and the
-- Go report's KDA cell died with it). The scalar max() value form
-- (w13e) spells the floored denominator the old Go spelling used, so
-- the number the scoreboard showed is the number the metric stores —
-- a deathless subject divides by 1, never NULL.
('kda', 'KDA', 'KDA',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, 1.0*(SUM(kills + assists)) / NULLIF((MAX(SUM(deaths), 1)), 0) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.kills, 0) AS kills, COALESCE(f.deaths, 0) AS deaths, COALESCE(f.assists, 0) AS assists
  FROM player_stats ps
  LEFT JOIN (WITH k AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,
         (e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake,
         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side
  FROM events e
  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = ''player_disconnect'') dc
    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister
  WHERE e.match_id = :match_id AND e.kind = ''kill'' AND e.post_match = 0
),
ek AS (
  SELECT * FROM k WHERE attacker <> '''' AND attacker <> victim AND fake = 0
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
),
ak AS (
  SELECT * FROM k WHERE assister <> '''' AND assister <> victim AND attacker <> '''' AND attacker <> victim AND fake = 0 AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side) AND NOT (COALESCE(s_side, '''') <> '''' AND s_side = v_side)
),
fold AS (
    SELECT match_id, attacker AS steam_id, ''kills'' AS f, COUNT(*) AS n FROM ek GROUP BY match_id, attacker
    UNION ALL SELECT match_id, victim AS steam_id, ''deaths'' AS f, COUNT(*) AS n FROM k WHERE victim <> '''' AND fake = 0 GROUP BY match_id, victim
    UNION ALL SELECT match_id, assister AS steam_id, ''assists'' AS f, COUNT(*) AS n FROM ak WHERE assisted_flash = 0 GROUP BY match_id, assister
  )
  SELECT match_id, steam_id, SUM(CASE WHEN f = ''kills'' THEN n END) AS kills, SUM(CASE WHEN f = ''deaths'' THEN n END) AS deaths, SUM(CASE WHEN f = ''assists'' THEN n END) AS assists FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id
  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'float2',
 'Formula: sum(kills + assists) / max(sum(deaths), 1) — kills plus assists per death, addressed per player — a deathless subject divides by 1, like the scoreboard.',
 'builtin', CURRENT_TIMESTAMP);

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
INSERT OR IGNORE INTO metrics (name, title, short_name, expr, scope, subject, partition, format, doc, origin, created_at) VALUES
('lost_equip', 'Lost equipment', '',
 'SELECT '''' AS subject_key, '''' AS dim, v AS value FROM (SELECT round_economy.match_id AS mid, round_economy.match_id AS grp, SUM(CASE WHEN (((rounds.winner != '''') AND (round_economy.side != rounds.winner)) AND (round_economy.team != '''')) THEN round_economy.equip_value END) AS v FROM round_economy LEFT JOIN rounds ON round_economy.match_id = rounds.match_id AND round_economy.round = rounds.number WHERE round_economy.match_id = :match_id GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'match', '', 'currency',
 'Formula: sum(round_economy.equip_value) of the losing side over decided, team-known rounds — freeze-end money lost, addressed per match (no partition), over the joined sources — a total.',
 'builtin', CURRENT_TIMESTAMP),
('team_force_win_rate', 'Force win %', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT round_side_classes.match_id AS mid, round_side_classes.team AS grp, 1.0*(SUM(CASE WHEN ((round_side_classes.class = ''force'') AND (rounds.winner = round_side_classes.side)) THEN 1 ELSE 0 END)) / NULLIF((SUM(CASE WHEN (round_side_classes.class = ''force'') THEN 1 ELSE 0 END)), 0) AS v FROM round_side_classes LEFT JOIN rounds ON round_side_classes.match_id = rounds.match_id AND round_side_classes.round = rounds.number WHERE round_side_classes.match_id = :match_id AND (round_side_classes.team <> '''') GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'team', '', 'percent',
 'Formula: force-buy rounds won ÷ that team''s own force-buy rounds — per-team force win rate, addressed per team (no partition), over the joined sources — a percent.',
 'builtin', CURRENT_TIMESTAMP),
('team_lost_equip', 'Team lost equipment', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT round_economy.match_id AS mid, round_economy.team AS grp, SUM(CASE WHEN (((rounds.winner != '''') AND (round_economy.side != rounds.winner)) AND (round_economy.team != '''')) THEN round_economy.equip_value END) AS v FROM round_economy LEFT JOIN rounds ON round_economy.match_id = rounds.match_id AND round_economy.round = rounds.number WHERE round_economy.match_id = :match_id AND (round_economy.team <> '''') GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'team', '', 'currency',
 'Formula: sum(round_economy.equip_value) of that team''s losing rounds — freeze-end money the team lost, addressed per team (no partition), over the joined sources — a total.',
 'builtin', CURRENT_TIMESTAMP),
('win_pct', 'Win %', '', 'SELECT :steam_id AS subject_key, '''' AS dim, 1.0 * (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric(''match_won'')) / NULLIF((SELECT COUNT(*) FROM metric(''match_won'')), 0) AS value WHERE EXISTS (SELECT 1 FROM metric(''match_won''))', 'profile', 'player', '', 'percent', 'Formula: sum(won) / count(matches) — match wins ÷ matches played over a career, addressed per player (no partition) — a percent; ties count as no wins.', 'builtin', CURRENT_TIMESTAMP);

-- Identity addendum (metrics expansion §6.4/§8 M1 identity row,
-- 2026-11-17): FIVE match-subject builtins whose value is a KEY — the
-- M1 Overview top-cards' stored twins (top_fragger / best_adr /
-- most_util / entry_opens / most_mvps), each argmax over the M1 stat
-- on the player_stats lead (§7 M1's expression list). Same INSERT OR
-- IGNORE add-on path as the subject-axis block above (keyed on the
-- UNIQUE name), addressing written explicitly: subject=match,
-- format=identity, no partition, no denominator (an identity's N is
-- the pool it chose from — §3.3, stated in every doc below). Every
-- doc is Formula-first, states subject + partition + the value's semantics
-- and stays inside the tier-2 doc limit (AGENTS doc rule; no doc
-- hard-codes a count).
INSERT OR IGNORE INTO metrics (name, title, short_name, expr, scope, subject, partition, format, doc, origin, created_at) VALUES
('top_fragger', 'Top fragger', '',
 'SELECT '''' AS subject_key, '''' AS dim, v AS value, idkey AS idkey FROM (SELECT mid, grp, idkey, v FROM (SELECT match_id AS mid, match_id AS grp, steam_id AS idkey, kills AS v, ROW_NUMBER() OVER (PARTITION BY match_id ORDER BY kills DESC, steam_id ASC) AS rn FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.kills, 0) AS kills
  FROM player_stats ps
  LEFT JOIN (WITH k AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,
         (e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake,
         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side
  FROM events e
  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = ''player_disconnect'') dc
    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister
  WHERE e.match_id = :match_id AND e.kind = ''kill'' AND e.post_match = 0
),
ek AS (
  SELECT * FROM k WHERE attacker <> '''' AND attacker <> victim AND fake = 0
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
),
fold AS (
    SELECT match_id, attacker AS steam_id, ''kills'' AS f, COUNT(*) AS n FROM ek GROUP BY match_id, attacker
  )
  SELECT match_id, steam_id, SUM(CASE WHEN f = ''kills'' THEN n END) AS kills FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id
  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1) AND steam_id <> '''')) WHERE rn = 1 ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'match', '', 'identity',
 'Formula: argmax(kills) — the player with the most kills in the match, addressed per match (no partition) — an empty pool shows a dash.',
 'builtin', CURRENT_TIMESTAMP),
('best_adr', 'Best ADR', '',
 'SELECT '''' AS subject_key, '''' AS dim, v AS value, idkey AS idkey FROM (SELECT mid, grp, idkey, v FROM (SELECT match_id AS mid, match_id AS grp, steam_id AS idkey, adr AS v, ROW_NUMBER() OVER (PARTITION BY match_id ORDER BY adr DESC, steam_id ASC) AS rn FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, CAST(COALESCE(f.total_damage, 0) AS REAL) / NULLIF((SELECT COUNT(*) FROM rounds r WHERE r.match_id = ps.match_id), 0) AS adr
  FROM player_stats ps
  LEFT JOIN (WITH dmg AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.weapon, e.capped_dmg, e.detail_json,
         sa.side AS a_side, sv.side AS v_side
  FROM events e
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  WHERE e.match_id = :match_id AND e.kind = ''damage'' AND e.post_match = 0
),
edmg AS (
  SELECT * FROM dmg WHERE attacker <> '''' AND attacker <> victim
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
),
fold AS (
    SELECT match_id, attacker AS steam_id, ''total_damage'' AS f, SUM(capped_dmg) AS n FROM edmg GROUP BY match_id, attacker
  )
  SELECT match_id, steam_id, SUM(CASE WHEN f = ''total_damage'' THEN n END) AS total_damage FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id
  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1) AND steam_id <> '''')) WHERE rn = 1 ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'match', '', 'identity',
 'Formula: argmax(adr) — the match''s highest-ADR player, addressed per match (no partition) — an empty pool shows a dash.',
 'builtin', CURRENT_TIMESTAMP),
('most_util', 'Most util', '',
 'SELECT '''' AS subject_key, '''' AS dim, v AS value, idkey AS idkey FROM (SELECT mid, grp, idkey, v FROM (SELECT match_id AS mid, match_id AS grp, steam_id AS idkey, utility_damage AS v, ROW_NUMBER() OVER (PARTITION BY match_id ORDER BY utility_damage DESC, steam_id ASC) AS rn FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.utility_damage, 0) AS utility_damage
  FROM player_stats ps
  LEFT JOIN (WITH dmg AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.weapon, e.capped_dmg, e.detail_json,
         sa.side AS a_side, sv.side AS v_side
  FROM events e
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  WHERE e.match_id = :match_id AND e.kind = ''damage'' AND e.post_match = 0
),
edmg AS (
  SELECT * FROM dmg WHERE attacker <> '''' AND attacker <> victim
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
),
fold AS (
    SELECT match_id, attacker AS steam_id, ''utility_damage'' AS f, SUM(CASE WHEN weapon IN (''HE Grenade'', ''Flashbang'', ''Smoke Grenade'', ''Molotov'', ''Incendiary Grenade'', ''Decoy Grenade'') THEN capped_dmg ELSE 0 END) AS n FROM edmg GROUP BY match_id, attacker
  )
  SELECT match_id, steam_id, SUM(CASE WHEN f = ''utility_damage'' THEN n END) AS utility_damage FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id
  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1) AND steam_id <> '''')) WHERE rn = 1 ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'match', '', 'identity',
 'Formula: argmax(utility_damage) — the match''s leading utility-damage player, addressed per match (no partition) — an empty pool shows a dash.',
 'builtin', CURRENT_TIMESTAMP),
('entry_opens', 'Entry opens', '',
 'SELECT '''' AS subject_key, '''' AS dim, v AS value, idkey AS idkey FROM (SELECT mid, grp, idkey, v FROM (SELECT match_id AS mid, match_id AS grp, steam_id AS idkey, entry_kills AS v, ROW_NUMBER() OVER (PARTITION BY match_id ORDER BY entry_kills DESC, steam_id ASC) AS rn FROM player_stats WHERE player_stats.match_id = :match_id AND (NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1) AND steam_id <> '''')) WHERE rn = 1 ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'match', '', 'identity',
 'Formula: argmax(entry_kills) — the player with the most round-opening first bloods, addressed per match (no partition) — an empty pool shows a dash.',
 'builtin', CURRENT_TIMESTAMP),
('most_mvps', 'Most MVPs', '',
 'SELECT '''' AS subject_key, '''' AS dim, v AS value, idkey AS idkey FROM (SELECT mid, grp, idkey, v FROM (SELECT match_id AS mid, match_id AS grp, steam_id AS idkey, mvps AS v, ROW_NUMBER() OVER (PARTITION BY match_id ORDER BY mvps DESC, steam_id ASC) AS rn FROM player_stats WHERE player_stats.match_id = :match_id AND (NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1) AND steam_id <> '''')) WHERE rn = 1 ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'match', '', 'identity',
 'Formula: argmax(mvps) — the match''s MVP-award leader, addressed per match (no partition) — an empty pool shows a dash.',
 'builtin', CURRENT_TIMESTAMP);

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
INSERT OR IGNORE INTO metrics (name, title, short_name, expr, scope, subject, partition, format, doc, origin, created_at) VALUES
('side_rounds', 'Rounds', '', 'SELECT :steam_id AS subject_key, dim AS dim, CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END AS value FROM metric(''match_side_rounds'') GROUP BY dim', 'profile', 'player', 'side', 'int', 'Formula: count(rounds) — rounds played on that side across the career, addressed per player, partitioned by side.', 'builtin', CURRENT_TIMESTAMP),
('side_win_pct', 'Round win %', '', 'SELECT :steam_id AS subject_key, n.dim AS dim, 1.0 * n.s / NULLIF(d.s, 0) AS value FROM (SELECT dim, SUM(value) AS s FROM metric(''match_side_won'') GROUP BY dim) n JOIN (SELECT dim, SUM(value) AS s FROM metric(''match_side_rounds'') GROUP BY dim) d ON d.dim = n.dim', 'profile', 'player', 'side', 'percent', 'Formula: sum(won) / count() — rounds won on that side ÷ rounds played on it, addressed per player, partitioned by side — a percent.', 'builtin', CURRENT_TIMESTAMP),
('side_adr', 'ADR', '', 'SELECT :steam_id AS subject_key, n.dim AS dim, 1.0 * n.s / NULLIF(d.s, 0) AS value FROM (SELECT dim, SUM(value) AS s FROM metric(''match_side_dmg'') GROUP BY dim) n JOIN (SELECT dim, SUM(value) AS s FROM metric(''match_side_rounds'') GROUP BY dim) d ON d.dim = n.dim', 'profile', 'player', 'side', 'float1', 'Formula: sum(capped_dmg) / count() — capped damage dealt on that side ÷ rounds played on it, addressed per player, partitioned by side — damage per round.', 'builtin', CURRENT_TIMESTAMP),
('side_kast', 'KAST%', '', 'SELECT :steam_id AS subject_key, n.dim AS dim, 1.0 * n.s / NULLIF(d.s, 0) AS value FROM (SELECT dim, SUM(value) AS s FROM metric(''match_side_kast'') GROUP BY dim) n JOIN (SELECT dim, SUM(value) AS s FROM metric(''match_side_rounds'') GROUP BY dim) d ON d.dim = n.dim', 'profile', 'player', 'side', 'percent', 'Formula: sum(kast) / count() — share of that side''s rounds with a K, A, T or S, addressed per player, partitioned by side — a percent.', 'builtin', CURRENT_TIMESTAMP),
('side_kd', 'K/D', '', 'SELECT :steam_id AS subject_key, k.dim AS dim, 1.0 * k.s / NULLIF(MAX(d.s, 1), 0) AS value FROM (SELECT dim, SUM(value) AS s FROM metric(''match_side_kills'') GROUP BY dim) k JOIN (SELECT dim, SUM(value) AS s FROM metric(''match_side_deaths'') GROUP BY dim) d ON d.dim = k.dim', 'profile', 'player', 'side', 'float2', 'Formula: sum(kills) / max(sum(deaths), 1) — kills per death on that side, addressed per player, partitioned by side — a deathless side divides by 1.', 'builtin', CURRENT_TIMESTAMP),
('map_matches', 'Matches', '', 'SELECT :steam_id AS subject_key, dim AS dim, COUNT(*) AS value FROM metric(''match_map_won'') GROUP BY dim', 'profile', 'player', 'map', 'int', 'Formula: count(matches) — matches played on that map across the career, addressed per player, partitioned by map.', 'builtin', CURRENT_TIMESTAMP),
('map_wins', 'Wins', '', 'SELECT :steam_id AS subject_key, dim AS dim, CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END AS value FROM metric(''match_map_won'') GROUP BY dim', 'profile', 'player', 'map', 'int', 'Formula: sum(won) — matches won on that map, addressed per player, partitioned by map — ties count as no wins.', 'builtin', CURRENT_TIMESTAMP),
('map_win_pct', 'Win %', '', 'SELECT :steam_id AS subject_key, dim AS dim, 1.0 * SUM(value) / NULLIF(COUNT(*), 0) AS value FROM metric(''match_map_won'') GROUP BY dim', 'profile', 'player', 'map', 'percent', 'Formula: sum(won) / count() — matches won ÷ played on that map, addressed per player, partitioned by map — a percent; ties count as no wins.', 'builtin', CURRENT_TIMESTAMP),
('map_adr', 'ADR', '', 'SELECT :steam_id AS subject_key, n.dim AS dim, 1.0 * n.s / NULLIF(d.s, 0) AS value FROM (SELECT dim, SUM(value) AS s FROM metric(''match_map_damage'') GROUP BY dim) n JOIN (SELECT dim, SUM(value) AS s FROM metric(''match_map_rounds'') GROUP BY dim) d ON d.dim = n.dim', 'profile', 'player', 'map', 'float1', 'Formula: sum(total_damage) / sum(rounds recorded) on that map — pooled damage per round, addressed per player, partitioned by map — never a mean of per-match ADRs.', 'builtin', CURRENT_TIMESTAMP),
('map_kd', 'K/D', '', 'SELECT :steam_id AS subject_key, n.dim AS dim, 1.0 * n.s / NULLIF(d.s, 0) AS value FROM (SELECT dim, SUM(value) AS s FROM metric(''match_map_kills'') GROUP BY dim) n JOIN (SELECT dim, SUM(value) AS s FROM metric(''match_map_deaths'') GROUP BY dim) d ON d.dim = n.dim', 'profile', 'player', 'map', 'float2', 'Formula: sum(kills) / sum(deaths) — kills per death on that map, addressed per player, partitioned by map — no deaths → 0.', 'builtin', CURRENT_TIMESTAMP);

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
INSERT OR IGNORE INTO metrics (name, title, short_name, expr, scope, subject, partition, format, doc, origin, created_at) VALUES
('weapon_kills', 'Weapon kills', '', 'SELECT :steam_id AS subject_key, dim AS dim, CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END AS value FROM metric(''match_weapon_kills'') GROUP BY dim', 'profile', 'player', 'weapon', 'int', 'Formula: sum(kills) — enemy kills with that weapon across the career, addressed per player, partitioned by weapon.', 'builtin', CURRENT_TIMESTAMP),
('weapon_damage', 'Weapon damage', '', 'SELECT :steam_id AS subject_key, dim AS dim, SUM(value) AS value FROM metric(''match_weapon_damage'') GROUP BY dim', 'profile', 'player', 'weapon', 'int', 'Formula: sum(capped_dmg) — HP-capped enemy damage with that weapon across the career, addressed per player, partitioned by weapon; NULL where no such damage exists.', 'builtin', CURRENT_TIMESTAMP),
('weapon_headshots', 'Weapon headshots', '', 'SELECT :steam_id AS subject_key, dim AS dim, CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END AS value FROM metric(''match_weapon_headshots'') GROUP BY dim', 'profile', 'player', 'weapon', 'int', 'Formula: sum(headshot kills) — enemy headshot kills with that weapon across the career, addressed per player, partitioned by weapon.', 'builtin', CURRENT_TIMESTAMP);

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
INSERT OR IGNORE INTO metrics (name, title, short_name, expr, scope, subject, partition, format, doc, origin, created_at) VALUES
('pistol_hold', 'Pistol → next round', '',
 'SELECT '''' AS subject_key, '''' AS dim, v AS value FROM (SELECT rounds.match_id AS mid, rounds.match_id AS grp, 1.0*(SUM(CASE WHEN (((round_classifications.label = ''pistol'') AND (rounds.winner != '''')) AND ((SELECT nx0.winner FROM rounds AS nx0 WHERE nx0.match_id = rounds.match_id AND nx0.number > rounds.number ORDER BY nx0.number LIMIT 1) = rounds.winner)) THEN 1 ELSE 0 END)) / NULLIF((SUM(CASE WHEN ((round_classifications.label = ''pistol'') AND (rounds.winner != '''')) THEN 1 ELSE 0 END)), 0) AS v FROM rounds LEFT JOIN round_classifications ON rounds.match_id = round_classifications.match_id AND rounds.number = round_classifications.round WHERE rounds.match_id = :match_id GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'match', '', 'percent',
 'Formula: pistol rounds won where that side also won the following round ÷ pistol rounds won — the held-pistol rate, addressed per match (no partition), over the joined sources.',
 'builtin', CURRENT_TIMESTAMP),
('avg_equip_gap', 'Winner equipment value advantage', '',
 'SELECT '''' AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, match_id AS grp, AVG(CASE WHEN (winner != '''') THEN (CASE WHEN (winner = ''ct'') THEN (equip_ct - equip_t) ELSE (equip_t - equip_ct) END) END) AS v FROM rounds WHERE rounds.match_id = :match_id GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'match', '', 'currency',
 'Formula: average across decided rounds of (winner equipment value − loser equipment value) at freeze time — addressed per match (no partition).',
 'builtin', CURRENT_TIMESTAMP);

-- View-aggregate relocation addendum (ME8 exception audit, 2026-11-18):
-- TWO team-subject count builtins — the force card's per-team won /
-- total pairs, the last piece of that card's numbers still computed in
-- the view (the view-aggregate rule's third clause: a value derivable
-- from a stored metric relocates; a pooled ratio seed deliberately does
-- NOT exist here — a zero denominator stores 0, which cannot
-- carry the card's "no force buys" dash, so the honest stored form of
-- the card is its counts). Same INSERT OR IGNORE add-on path (keyed on
-- the UNIQUE name), addressing written explicitly: subject=team,
-- scope=match, no partition, no denominator (a count IS the value).
-- Equivalence with the characterization-pinned Economy card: the
-- sub-line's won/rounds pairs — exact equality to the retired view
-- computation pinned in internal/metrics' econ equivalence test. Every
-- doc is Formula-first, states subject + partition and stays inside the
-- tier-2 doc limit (AGENTS doc rule; no doc hard-codes a count).
INSERT OR IGNORE INTO metrics (name, title, short_name, expr, scope, subject, partition, format, doc, origin, created_at) VALUES
('team_force_wins', 'Force rounds won', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT round_side_classes.match_id AS mid, round_side_classes.team AS grp, SUM(CASE WHEN ((round_side_classes.class = ''force'') AND (rounds.winner = round_side_classes.side)) THEN 1 ELSE 0 END) AS v FROM round_side_classes LEFT JOIN rounds ON round_side_classes.match_id = rounds.match_id AND round_side_classes.round = rounds.number WHERE round_side_classes.match_id = :match_id AND (round_side_classes.team <> '''') GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'team', '', 'int',
 'Formula: count(round_side_classes rows joined to rounds WHERE class = force AND winner = side) — force rounds that team won, addressed per team (no partition), over the joined sources.',
 'builtin', CURRENT_TIMESTAMP),
('team_force_rounds', 'Force rounds', '',
 'SELECT grp AS subject_key, '''' AS dim, v AS value FROM (SELECT match_id AS mid, team AS grp, SUM(CASE WHEN (class = ''force'') THEN 1 ELSE 0 END) AS v FROM round_side_classes WHERE round_side_classes.match_id = :match_id AND (team <> '''') GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id',
 'match', 'team', '', 'int',
 'Formula: count(round_side_classes rows WHERE class = force) — that team''s own force-buy rounds, addressed per team (no partition).',
 'builtin', CURRENT_TIMESTAMP);

-- Raw-SQL fold metrics: one raw
-- statement per fold column that the snapshot stores. Each statement
-- returns subject_key, dim and value; NULL is no data (ruling 23).
-- Humans only (ruling Q10), match grain binds :match_id and round grain
-- binds :match_id and :round. Entry kills, entry deaths, best streak and
-- the first kill/death columns are detectors (item 21) and are not here.
-- The two capped-damage folds and money_spent_total differ from the snapshot
-- by ruling (Q3, Q7); shots is verified at the wipe (ruling 24).
INSERT OR IGNORE INTO metrics (name, title, short_name, expr, scope, subject, partition, format, doc, origin, created_at) VALUES
('raw_rounds_played', 'Rounds played (raw SQL)', '',
 'WITH agg AS (
SELECT steam_id AS steam_id, COUNT(*) AS n FROM round_player_sides WHERE match_id = :match_id GROUP BY steam_id
)
SELECT p.steam_id AS subject_key, '''' AS dim, COALESCE(agg.n, 0) AS value
FROM players p
LEFT JOIN agg ON agg.steam_id = p.steam_id
WHERE p.match_id = :match_id AND p.is_bot = 0
ORDER BY p.steam_id',
 'match', 'player', '', 'int',
 'Formula: count(round_player_sides rows) — rounds this player appears in, addressed per player — a count.',
 'builtin', CURRENT_TIMESTAMP),
('raw_kills_by_weapon', 'Kills by weapon (raw SQL)', '',
 'WITH k AS (
  SELECT e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,
         (e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake,
         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side
  FROM events e
  LEFT JOIN (SELECT DISTINCT attacker, tick FROM events
             WHERE match_id = :match_id AND kind = ''player_disconnect'') dc
    ON dc.attacker = e.victim AND dc.tick = e.tick
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister
  WHERE e.match_id = :match_id AND e.kind = ''kill'' AND e.post_match = 0
),
ek AS (
  SELECT * FROM k WHERE attacker <> '''' AND attacker <> victim AND fake = 0
    AND NOT (COALESCE(a_side,'''') <> '''' AND a_side = v_side)
)
SELECT ek.attacker AS subject_key, ek.weapon AS dim, COUNT(*) AS value
FROM ek
WHERE ek.attacker IN (SELECT steam_id FROM players WHERE match_id = :match_id AND is_bot = 0)
GROUP BY ek.attacker, ek.weapon
ORDER BY ek.attacker, ek.weapon',
 'match', 'player', '', 'int',
 'Formula: count(enemy kill events by attacker and weapon) — one row per weapon the player killed with, dim = weapon, addressed per player — a count per weapon.',
 'builtin', CURRENT_TIMESTAMP),
('raw_round_kills', 'Round kills (raw SQL)', '',
 'WITH k AS (
  SELECT e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,
         (e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake,
         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side
  FROM events e
  LEFT JOIN (SELECT DISTINCT attacker, tick FROM events
             WHERE match_id = :match_id AND kind = ''player_disconnect'') dc
    ON dc.attacker = e.victim AND dc.tick = e.tick
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister
  WHERE e.match_id = :match_id AND e.kind = ''kill'' AND e.post_match = 0 AND e.round = :round
),
ek AS (
  SELECT * FROM k WHERE attacker <> '''' AND attacker <> victim AND fake = 0
    AND NOT (COALESCE(a_side,'''') <> '''' AND a_side = v_side)
),
agg AS (
SELECT round, attacker AS steam_id, COUNT(*) AS n FROM ek WHERE round = :round GROUP BY round, steam_id
)
SELECT prs.steam_id AS subject_key, '''' AS dim, COALESCE(agg.n, 0) AS value
FROM (SELECT prs.match_id, prs.round, prs.steam_id, prs.name, prs.traded, prs.kast, prs.money_start, prs.equip, prs.spent, prs.rule_version, prs.side, COALESCE(f.kills, 0) AS kills
  FROM player_round_stats prs
  LEFT JOIN (WITH k AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.assisted_flash,
         (e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake,
         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side
  FROM events e
  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = ''player_disconnect'') dc
    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister
  WHERE e.match_id = :match_id AND e.kind = ''kill'' AND e.post_match = 0
),
ek AS (
  SELECT * FROM k WHERE attacker <> '''' AND attacker <> victim AND fake = 0
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
),
fold AS (
    SELECT match_id, round, attacker AS steam_id, ''kills'' AS f, COUNT(*) AS n FROM ek GROUP BY match_id, round, attacker
  )
  SELECT match_id, round, steam_id, SUM(CASE WHEN f = ''kills'' THEN n END) AS kills FROM fold GROUP BY match_id, round, steam_id) f ON f.match_id = prs.match_id AND f.round = prs.round AND f.steam_id = prs.steam_id
  WHERE prs.match_id = :match_id) prs
JOIN players p ON p.match_id = prs.match_id AND p.steam_id = prs.steam_id AND p.is_bot = 0
LEFT JOIN agg ON agg.round = prs.round AND agg.steam_id = prs.steam_id
WHERE prs.match_id = :match_id AND prs.round = :round
ORDER BY prs.steam_id',
 'match', 'player', '', 'int',
 'Formula: count(enemy kill events by attacker in the round) — kills this player earned in one round, addressed per player per round — a count.',
 'builtin', CURRENT_TIMESTAMP),
('raw_round_assists', 'Round assists (raw SQL)', '',
 'WITH k AS (
  SELECT e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,
         (e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake,
         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side
  FROM events e
  LEFT JOIN (SELECT DISTINCT attacker, tick FROM events
             WHERE match_id = :match_id AND kind = ''player_disconnect'') dc
    ON dc.attacker = e.victim AND dc.tick = e.tick
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister
  WHERE e.match_id = :match_id AND e.kind = ''kill'' AND e.post_match = 0 AND e.round = :round
),
rak AS (
  SELECT * FROM k WHERE assister <> '''' AND assister <> victim AND assisted_flash = 0 AND fake = 0
    AND NOT (COALESCE(s_side,'''') <> '''' AND s_side = v_side)
),
agg AS (
SELECT round, assister AS steam_id, COUNT(*) AS n FROM rak WHERE round = :round GROUP BY round, steam_id
)
SELECT prs.steam_id AS subject_key, '''' AS dim, COALESCE(agg.n, 0) AS value
FROM (SELECT prs.match_id, prs.round, prs.steam_id, prs.name, prs.traded, prs.kast, prs.money_start, prs.equip, prs.spent, prs.rule_version, prs.side, COALESCE(f.assists, 0) AS assists
  FROM player_round_stats prs
  LEFT JOIN (WITH k AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.assisted_flash,
         (e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake,
         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side
  FROM events e
  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = ''player_disconnect'') dc
    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister
  WHERE e.match_id = :match_id AND e.kind = ''kill'' AND e.post_match = 0
),
ek AS (
  SELECT * FROM k WHERE attacker <> '''' AND attacker <> victim AND fake = 0
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
),
ak AS (
  SELECT * FROM k WHERE assister <> '''' AND assister <> victim AND attacker <> '''' AND attacker <> victim
    AND fake = 0 AND assisted_flash = 0
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
    AND NOT (COALESCE(s_side, '''') <> '''' AND s_side = v_side)
),
fold AS (
    SELECT match_id, round, assister AS steam_id, ''assists'' AS f, COUNT(*) AS n FROM ak GROUP BY match_id, round, assister
  )
  SELECT match_id, round, steam_id, SUM(CASE WHEN f = ''assists'' THEN n END) AS assists FROM fold GROUP BY match_id, round, steam_id) f ON f.match_id = prs.match_id AND f.round = prs.round AND f.steam_id = prs.steam_id
  WHERE prs.match_id = :match_id) prs
JOIN players p ON p.match_id = prs.match_id AND p.steam_id = prs.steam_id AND p.is_bot = 0
LEFT JOIN agg ON agg.round = prs.round AND agg.steam_id = prs.steam_id
WHERE prs.match_id = :match_id AND prs.round = :round
ORDER BY prs.steam_id',
 'match', 'player', '', 'int',
 'Formula: count(cross-side, non-flash assists by assister in the round) — assists this player earned in one round, addressed per player per round — a count.',
 'builtin', CURRENT_TIMESTAMP),
('raw_round_deaths', 'Round deaths (raw SQL)', '',
 'WITH k AS (
  SELECT e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,
         (e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake,
         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side
  FROM events e
  LEFT JOIN (SELECT DISTINCT attacker, tick FROM events
             WHERE match_id = :match_id AND kind = ''player_disconnect'') dc
    ON dc.attacker = e.victim AND dc.tick = e.tick
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister
  WHERE e.match_id = :match_id AND e.kind = ''kill'' AND e.post_match = 0 AND e.round = :round
),
dk AS (
  SELECT * FROM k WHERE victim <> '''' AND fake = 0
),
agg AS (
SELECT round, victim AS steam_id, COUNT(*) AS n FROM dk WHERE round = :round GROUP BY round, steam_id
)
SELECT prs.steam_id AS subject_key, '''' AS dim, COALESCE(agg.n, 0) AS value
FROM (SELECT prs.match_id, prs.round, prs.steam_id, prs.name, prs.traded, prs.kast, prs.money_start, prs.equip, prs.spent, prs.rule_version, prs.side, COALESCE(f.deaths, 0) AS deaths
  FROM player_round_stats prs
  LEFT JOIN (WITH k AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.assisted_flash,
         (e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake,
         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side
  FROM events e
  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = ''player_disconnect'') dc
    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister
  WHERE e.match_id = :match_id AND e.kind = ''kill'' AND e.post_match = 0
),
ek AS (
  SELECT * FROM k WHERE attacker <> '''' AND attacker <> victim AND fake = 0
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
),
fold AS (
    SELECT match_id, round, victim AS steam_id, ''deaths'' AS f, COUNT(*) AS n FROM k WHERE victim <> '''' AND fake = 0 GROUP BY match_id, round, victim
  )
  SELECT match_id, round, steam_id, SUM(CASE WHEN f = ''deaths'' THEN n END) AS deaths FROM fold GROUP BY match_id, round, steam_id) f ON f.match_id = prs.match_id AND f.round = prs.round AND f.steam_id = prs.steam_id
  WHERE prs.match_id = :match_id) prs
JOIN players p ON p.match_id = prs.match_id AND p.steam_id = prs.steam_id AND p.is_bot = 0
LEFT JOIN agg ON agg.round = prs.round AND agg.steam_id = prs.steam_id
WHERE prs.match_id = :match_id AND prs.round = :round
ORDER BY prs.steam_id',
 'match', 'player', '', 'int',
 'Formula: count(kill events by victim in the round, not a disconnect self-kill) — deaths this player suffered in one round, addressed per player per round — a count.',
 'builtin', CURRENT_TIMESTAMP),
('raw_round_survived', 'Round survived (raw SQL)', '',
 'WITH k AS (
  SELECT e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,
         (e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake,
         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side
  FROM events e
  LEFT JOIN (SELECT DISTINCT attacker, tick FROM events
             WHERE match_id = :match_id AND kind = ''player_disconnect'') dc
    ON dc.attacker = e.victim AND dc.tick = e.tick
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister
  WHERE e.match_id = :match_id AND e.kind = ''kill'' AND e.post_match = 0 AND e.round = :round
),
dk AS (
  SELECT * FROM k WHERE victim <> '''' AND fake = 0
),
agg AS (
SELECT round, victim AS steam_id, COUNT(*) AS n FROM dk WHERE round = :round GROUP BY round, steam_id
)
SELECT prs.steam_id AS subject_key, '''' AS dim, CASE WHEN COALESCE(agg.n, 0) = 0 THEN 1 ELSE 0 END AS value
FROM (SELECT prs.match_id, prs.round, prs.steam_id, prs.name, prs.traded, prs.kast, prs.money_start, prs.equip, prs.spent, prs.rule_version, prs.side, CASE WHEN COALESCE(f.deaths, 0) = 0 THEN 1 ELSE 0 END AS survived
  FROM player_round_stats prs
  LEFT JOIN (WITH k AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.assisted_flash,
         (e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake,
         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side
  FROM events e
  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = ''player_disconnect'') dc
    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister
  WHERE e.match_id = :match_id AND e.kind = ''kill'' AND e.post_match = 0
),
ek AS (
  SELECT * FROM k WHERE attacker <> '''' AND attacker <> victim AND fake = 0
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
),
fold AS (
    SELECT match_id, round, victim AS steam_id, ''deaths'' AS f, COUNT(*) AS n FROM k WHERE victim <> '''' AND fake = 0 GROUP BY match_id, round, victim
  )
  SELECT match_id, round, steam_id, SUM(CASE WHEN f = ''deaths'' THEN n END) AS deaths FROM fold GROUP BY match_id, round, steam_id) f ON f.match_id = prs.match_id AND f.round = prs.round AND f.steam_id = prs.steam_id
  WHERE prs.match_id = :match_id) prs
JOIN players p ON p.match_id = prs.match_id AND p.steam_id = prs.steam_id AND p.is_bot = 0
LEFT JOIN agg ON agg.round = prs.round AND agg.steam_id = prs.steam_id
WHERE prs.match_id = :match_id AND prs.round = :round
ORDER BY prs.steam_id',
 'match', 'player', '', 'int',
 'Formula: 1 when the player has no death in the round, else 0 — addressed per player per round — a flag.',
 'builtin', CURRENT_TIMESTAMP),
('raw_round_dmg', 'Round damage (raw SQL)', '',
 'WITH dmg AS (
  SELECT e.round, e.attacker, e.victim, e.weapon, e.capped_dmg, e.detail_json,
         sa.side AS a_side, sv.side AS v_side
  FROM events e
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  WHERE e.match_id = :match_id AND e.kind = ''damage'' AND e.post_match = 0 AND e.round = :round
),
edmg_r AS (
  SELECT * FROM dmg WHERE attacker <> ''''
    AND NOT (COALESCE(a_side,'''') <> '''' AND a_side = v_side)
),
agg AS (
SELECT round, attacker AS steam_id, SUM(capped_dmg) AS n FROM edmg_r WHERE round = :round GROUP BY round, steam_id
)
SELECT prs.steam_id AS subject_key, '''' AS dim, COALESCE(agg.n, 0) AS value
FROM (SELECT prs.match_id, prs.round, prs.steam_id, prs.name, prs.traded, prs.kast, prs.money_start, prs.equip, prs.spent, prs.rule_version, prs.side, COALESCE(f.dmg, 0) AS dmg
  FROM player_round_stats prs
  LEFT JOIN (WITH dmg AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.weapon, e.capped_dmg,
         sa.side AS a_side, sv.side AS v_side
  FROM events e
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  WHERE e.match_id = :match_id AND e.kind = ''damage'' AND e.post_match = 0
),
edmg AS (
  SELECT * FROM dmg WHERE attacker <> '''' AND attacker <> victim
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
),
fold AS (
    SELECT match_id, round, attacker AS steam_id, ''dmg'' AS f, SUM(capped_dmg) AS n FROM edmg GROUP BY match_id, round, attacker
  )
  SELECT match_id, round, steam_id, SUM(CASE WHEN f = ''dmg'' THEN n END) AS dmg FROM fold GROUP BY match_id, round, steam_id) f ON f.match_id = prs.match_id AND f.round = prs.round AND f.steam_id = prs.steam_id
  WHERE prs.match_id = :match_id) prs
JOIN players p ON p.match_id = prs.match_id AND p.steam_id = prs.steam_id AND p.is_bot = 0
LEFT JOIN agg ON agg.round = prs.round AND agg.steam_id = prs.steam_id
WHERE prs.match_id = :match_id AND prs.round = :round
ORDER BY prs.steam_id',
 'match', 'player', '', 'int',
 'Formula: sum(capped damage) over enemy damage events by attacker in the round — damage this player dealt in one round, addressed per player per round — the HP-capped basis.',
 'builtin', CURRENT_TIMESTAMP),
('raw_round_util_dmg', 'Round utility damage (raw SQL)', '',
 'WITH dmg AS (
  SELECT e.round, e.attacker, e.victim, e.weapon, e.capped_dmg, e.detail_json,
         sa.side AS a_side, sv.side AS v_side
  FROM events e
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  WHERE e.match_id = :match_id AND e.kind = ''damage'' AND e.post_match = 0 AND e.round = :round
),
edmg_r AS (
  SELECT * FROM dmg WHERE attacker <> ''''
    AND NOT (COALESCE(a_side,'''') <> '''' AND a_side = v_side)
),
agg AS (
SELECT round, attacker AS steam_id, SUM(CASE WHEN weapon IN (''HE Grenade'',''Flashbang'',''Smoke Grenade'',''Molotov'',''Incendiary Grenade'',''Decoy Grenade'') THEN capped_dmg ELSE 0 END) AS n FROM edmg_r WHERE round = :round GROUP BY round, steam_id
)
SELECT prs.steam_id AS subject_key, '''' AS dim, COALESCE(agg.n, 0) AS value
FROM (SELECT prs.match_id, prs.round, prs.steam_id, prs.name, prs.traded, prs.kast, prs.money_start, prs.equip, prs.spent, prs.rule_version, prs.side, COALESCE(f.dmg, 0) AS dmg
  FROM player_round_stats prs
  LEFT JOIN (WITH dmg AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.weapon, e.capped_dmg,
         sa.side AS a_side, sv.side AS v_side
  FROM events e
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  WHERE e.match_id = :match_id AND e.kind = ''damage'' AND e.post_match = 0
),
edmg AS (
  SELECT * FROM dmg WHERE attacker <> '''' AND attacker <> victim
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
),
fold AS (
    SELECT match_id, round, attacker AS steam_id, ''dmg'' AS f, SUM(capped_dmg) AS n FROM edmg GROUP BY match_id, round, attacker
  )
  SELECT match_id, round, steam_id, SUM(CASE WHEN f = ''dmg'' THEN n END) AS dmg FROM fold GROUP BY match_id, round, steam_id) f ON f.match_id = prs.match_id AND f.round = prs.round AND f.steam_id = prs.steam_id
  WHERE prs.match_id = :match_id) prs
JOIN players p ON p.match_id = prs.match_id AND p.steam_id = prs.steam_id AND p.is_bot = 0
LEFT JOIN agg ON agg.round = prs.round AND agg.steam_id = prs.steam_id
WHERE prs.match_id = :match_id AND prs.round = :round
ORDER BY prs.steam_id',
 'match', 'player', '', 'int',
 'Formula: sum(capped damage) over the six utility weapons by attacker in the round — addressed per player per round — the HP-capped basis.',
 'builtin', CURRENT_TIMESTAMP),
('raw_round_won', 'Round won (raw SQL)', '',
 'SELECT prs.steam_id AS subject_key, '''' AS dim,
       CASE WHEN rps.side <> '''' AND rps.side = ro.winner AND ro.winner <> '''' THEN 1 ELSE 0 END AS value
FROM (SELECT prs.match_id, prs.round, prs.steam_id, prs.name, prs.traded, prs.kast, prs.money_start, prs.equip, prs.spent, prs.rule_version, prs.side, CASE WHEN prs.side <> '''' AND prs.side = (SELECT r.winner FROM rounds r WHERE r.match_id = prs.match_id AND r.number = prs.round) THEN 1 ELSE 0 END AS won
  FROM player_round_stats prs
  LEFT JOIN (SELECT NULL AS match_id, NULL AS round, NULL AS steam_id WHERE 0) f ON f.match_id = prs.match_id AND f.round = prs.round AND f.steam_id = prs.steam_id
  WHERE prs.match_id = :match_id) prs
JOIN players p ON p.match_id = prs.match_id AND p.steam_id = prs.steam_id AND p.is_bot = 0
LEFT JOIN round_player_sides rps ON rps.match_id = prs.match_id AND rps.round = prs.round AND rps.steam_id = prs.steam_id
LEFT JOIN rounds ro ON ro.match_id = prs.match_id AND ro.number = prs.round
WHERE prs.match_id = :match_id AND prs.round = :round
ORDER BY prs.steam_id',
 'match', 'player', '', 'int',
 'Formula: 1 when the player''s side is the round''s winner, else 0 — addressed per player per round — a flag; ties and unknown sides count as no win.',
 'builtin', CURRENT_TIMESTAMP),
('raw_round_duration_s', 'Round duration (raw SQL)', '',
 'SELECT '''' AS subject_key, '''' AS dim,
       CAST(ro.end_tick - ro.start_tick AS REAL) / m.tick_rate AS value
FROM rounds ro
JOIN matches m ON m.id = ro.match_id
WHERE ro.match_id = :match_id AND ro.number = :round',
 'match', 'match', '', 'float2',
 'Formula: (end tick - start tick) ÷ the match''s tick rate — round length in seconds, addressed per match per round — no value when the tick rate is unknown.',
 'builtin', CURRENT_TIMESTAMP);

-- Alive-count situation family and the clutch builtin. Both are raw round-grain statements over player_ticks
-- (binds :match_id and :round). The clutch statement is the retired detector's
-- definition re-expressed as SQL; it reproduces the stored clutches rows of the detector
-- (183 of 183, every field, on the snapshot via a player_ticks proxy). The six clutch metrics
-- below compute the same logic over every round through the clutch CTE that clutch_sql.go splices in.
INSERT OR IGNORE INTO metrics (name, title, short_name, expr, scope, subject, partition, format, doc, origin, created_at) VALUES
('alive_count', 'Alive count (raw SQL)', '',
 'WITH kt AS (SELECT DISTINCT tick FROM events WHERE match_id = :match_id AND round = :round AND kind = ''kill'' AND victim <> ''''), sd AS (SELECT ''ct'' AS side UNION ALL SELECT ''t'') SELECT sd.side AS subject_key, CAST(kt.tick AS TEXT) AS dim, (SELECT COUNT(*) FROM player_ticks pt WHERE pt.match_id = :match_id AND pt.round = :round AND pt.tick = kt.tick AND pt.side = sd.side AND pt.alive = 1) AS value FROM kt CROSS JOIN sd ORDER BY kt.tick, sd.side',
 'match', 'team', '', 'int',
 'Formula: count(player_ticks.alive = 1) per side at each kill tick of the round — the alive-count situation the clutch family reads, addressed per side and kill tick.',
 'builtin', CURRENT_TIMESTAMP),
('clutch', 'Clutch (raw SQL)', '',
 'WITH kt AS (SELECT DISTINCT tick FROM events WHERE match_id = :match_id AND round = :round AND kind = ''kill'' AND victim <> ''''), sd AS (SELECT ''ct'' AS side UNION ALL SELECT ''t''), cnt AS (SELECT kt.tick AS tick, sd.side AS side, (SELECT COUNT(*) FROM player_ticks pt WHERE pt.match_id = :match_id AND pt.round = :round AND pt.tick = kt.tick AND pt.side = sd.side AND pt.alive = 1) AS n FROM kt CROSS JOIN sd), cand AS (SELECT a.tick AS tick, a.side AS side, b.n AS opp, (SELECT pt.steam_id FROM player_ticks pt WHERE pt.match_id = :match_id AND pt.round = :round AND pt.tick = a.tick AND pt.side = a.side AND pt.alive = 1) AS solo FROM cnt a JOIN cnt b ON b.tick = a.tick AND b.side <> a.side WHERE a.n = 1 AND b.n >= 1), starts AS (SELECT solo, side, MIN(tick) AS start_tick, opp AS size FROM cand GROUP BY solo, side), deaths AS (SELECT victim AS solo, MIN(tick) AS dtick FROM events WHERE match_id = :match_id AND round = :round AND kind = ''kill'' AND victim <> '''' GROUP BY victim), wont AS (SELECT s.solo AS solo, MIN(z.tick) AS wtick FROM starts s JOIN cnt z ON z.side <> s.side AND z.n = 0 AND z.tick > s.start_tick GROUP BY s.solo), ended AS (SELECT s.solo AS solo, s.side AS side, s.start_tick AS start_tick, s.size AS size, CASE WHEN d.dtick IS NOT NULL AND (w.wtick IS NULL OR d.dtick <= w.wtick) THEN ''lost'' WHEN w.wtick IS NOT NULL THEN ''won'' ELSE ''round'' END AS how, CASE WHEN d.dtick IS NOT NULL AND (w.wtick IS NULL OR d.dtick <= w.wtick) THEN d.dtick WHEN w.wtick IS NOT NULL THEN w.wtick ELSE r.end_tick END AS end_tick, r.winner AS winner, r.equip_ct AS equip_ct, r.equip_t AS equip_t FROM starts s LEFT JOIN deaths d ON d.solo = s.solo LEFT JOIN wont w ON w.solo = s.solo JOIN rounds r ON r.match_id = :match_id AND r.number = :round), clutch AS (SELECT e.solo AS steam_id, e.side AS side, e.start_tick AS start_tick, e.end_tick AS end_tick, e.size AS size, e.how AS how, CASE WHEN e.how = ''won'' THEN 1 WHEN e.how = ''lost'' THEN 0 WHEN e.winner = e.side THEN 1 ELSE 0 END AS won, CASE WHEN e.side = ''ct'' THEN e.equip_ct ELSE e.equip_t END AS equip FROM ended e) SELECT c.steam_id AS subject_key, '''' AS dim, c.size AS value, :round AS round, c.size AS size, c.start_tick AS start_tick, c.end_tick AS end_tick, c.won AS won, CASE WHEN c.how = ''lost'' THEN 0 WHEN EXISTS (SELECT 1 FROM events hv WHERE hv.match_id = :match_id AND hv.round = :round AND hv.kind = ''damage'' AND hv.victim = c.steam_id AND hv.tick <= c.end_tick AND json_extract(hv.detail_json, ''$.health'') IS NOT NULL) THEN MIN(100, MAX(1, (SELECT pt.hp FROM player_ticks pt WHERE pt.match_id = :match_id AND pt.round = :round AND pt.steam_id = c.steam_id AND pt.tick <= c.end_tick ORDER BY pt.tick DESC LIMIT 1))) ELSE MIN(100, MAX(1, 100 - COALESCE((SELECT SUM(dh.dmg) FROM events dh WHERE dh.match_id = :match_id AND dh.round = :round AND dh.kind = ''damage'' AND dh.victim = c.steam_id AND dh.tick > c.start_tick AND (c.how = ''round'' OR dh.tick <= c.end_tick)), 0))) END AS hp_left, (SELECT CASE WHEN bs.p >= 0 THEN CASE WHEN bs.en < 0 THEN ''planted'' ELSE ''none'' END WHEN bs.dr >= 0 AND bs.dr > bs.pu THEN ''dropped'' ELSE ''carried'' END FROM (SELECT COALESCE(MAX(CASE WHEN kind = ''bomb_plant'' THEN tick END), -1) AS p, COALESCE(MAX(CASE WHEN kind IN (''bomb_explode'', ''bomb_defuse'') THEN tick END), -1) AS en, COALESCE(MAX(CASE WHEN kind = ''bomb_drop'' THEN tick END), -1) AS dr, COALESCE(MAX(CASE WHEN kind = ''bomb_pickup'' THEN tick END), -1) AS pu FROM events WHERE match_id = :match_id AND round = :round AND kind IN (''bomb_plant'', ''bomb_explode'', ''bomb_defuse'', ''bomb_drop'', ''bomb_pickup'') AND tick <= c.start_tick) bs) AS bomb_state, c.equip AS equip, (SELECT CASE WHEN COUNT(*) = 0 THEN ''null'' ELSE ''['' || group_concat(k.tick, '','') || '']'' END FROM (SELECT ev.tick AS tick FROM events ev WHERE ev.match_id = :match_id AND ev.round = :round AND ev.kind = ''kill'' AND ev.attacker = c.steam_id AND ev.victim <> '''' AND ev.tick > c.start_tick AND (ev.tick < c.end_tick OR (c.how <> ''lost'' AND ev.tick <= c.end_tick)) ORDER BY ev.tick) k) AS kill_ticks, (SELECT p.name FROM players p WHERE p.match_id = :match_id AND p.steam_id = c.steam_id LIMIT 1) AS name, c.start_tick AS replay_anchor FROM clutch c ORDER BY c.start_tick',
 'match', 'player', '', 'int',
 'Formula: one row per 1vN clutch: the sole alive player on a side with an opponent alive, ending at their death, the last opponent''s death or round end — value = opponents alive at start (N).',
 'builtin', CURRENT_TIMESTAMP);

-- Round-grain statistics as metrics. Each statement binds :match_id and :round (ruling 20) and
-- returns the reserved columns subject_key, dim and value (ruling 22). An
-- absent value is NULL, shown as a dash, never a fabricated zero (ruling 23).
-- They are the M19, M22, M30, M31, M36 and M37 round-grain series of the
-- Economy, Utility, RoundDetail and CompareRounds views.
INSERT OR IGNORE INTO metrics (name, title, short_name, expr, scope, subject, partition, format, doc, origin, created_at) VALUES
('raw_round_econ_series', 'Round economy series (raw SQL)', '',
 'WITH sd AS (SELECT ''ct'' AS side UNION ALL SELECT ''t'')
SELECT sd.side AS subject_key, ''equip'' AS dim, re.equip_value AS value
FROM sd LEFT JOIN round_economy re ON re.match_id = :match_id AND re.round = :round AND re.side = sd.side
UNION ALL
SELECT sd.side AS subject_key, ''networth'' AS dim, re.equip_value + re.money_sampled_sum AS value
FROM sd LEFT JOIN round_economy re ON re.match_id = :match_id AND re.round = :round AND re.side = sd.side
ORDER BY subject_key, dim',
 'match', 'team', '', 'currency',
 'Formula: per side per round, equip = round_economy.equip_value; networth = equip_value + money_sampled_sum. Dash when the side has no round_economy row.',
 'builtin', CURRENT_TIMESTAMP),
('raw_round_side_deaths', 'Round deaths by side (raw SQL)', '',
 'WITH sd AS (SELECT ''ct'' AS side UNION ALL SELECT ''t''),
pr AS (
  SELECT rps.side AS side, prs.deaths AS deaths
  FROM (SELECT prs.match_id, prs.round, prs.steam_id, prs.name, prs.traded, prs.kast, prs.money_start, prs.equip, prs.spent, prs.rule_version, prs.side, COALESCE(f.deaths, 0) AS deaths
  FROM player_round_stats prs
  LEFT JOIN (WITH k AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.assisted_flash,
         (e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake,
         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side
  FROM events e
  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = ''player_disconnect'') dc
    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister
  WHERE e.match_id = :match_id AND e.kind = ''kill'' AND e.post_match = 0
),
ek AS (
  SELECT * FROM k WHERE attacker <> '''' AND attacker <> victim AND fake = 0
    AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side)
),
fold AS (
    SELECT match_id, round, victim AS steam_id, ''deaths'' AS f, COUNT(*) AS n FROM k WHERE victim <> '''' AND fake = 0 GROUP BY match_id, round, victim
  )
  SELECT match_id, round, steam_id, SUM(CASE WHEN f = ''deaths'' THEN n END) AS deaths FROM fold GROUP BY match_id, round, steam_id) f ON f.match_id = prs.match_id AND f.round = prs.round AND f.steam_id = prs.steam_id
  WHERE prs.match_id = :match_id) prs
  JOIN round_player_sides rps ON rps.match_id = prs.match_id AND rps.round = prs.round AND rps.steam_id = prs.steam_id
  JOIN players p ON p.match_id = prs.match_id AND p.steam_id = prs.steam_id AND p.is_bot = 0
  WHERE prs.match_id = :match_id AND prs.round = :round
)
SELECT sd.side AS subject_key, '''' AS dim, (SELECT SUM(pr.deaths) FROM pr WHERE pr.side = sd.side) AS value
FROM sd ORDER BY sd.side',
 'match', 'team', '', 'int',
 'Formula: sum(deaths) over human players sampled on the side in the round. Dash when no human of that side is sampled; 0 is a real zero.',
 'builtin', CURRENT_TIMESTAMP),
('raw_round_side_util_dmg', 'Round utility damage by side (raw SQL)', '',
 'WITH sd AS (SELECT ''ct'' AS side UNION ALL SELECT ''t''),
rp AS (
  SELECT rps.side AS side, rps.steam_id AS steam_id
  FROM round_player_sides rps
  JOIN players p ON p.match_id = rps.match_id AND p.steam_id = rps.steam_id AND p.is_bot = 0
  WHERE rps.match_id = :match_id AND rps.round = :round
),
ud AS (
  SELECT rp.side AS side, SUM(ue.damage) AS v
  FROM utility_events ue JOIN rp ON rp.steam_id = ue.thrower
  WHERE ue.match_id = :match_id AND ue.round = :round
  GROUP BY rp.side
)
SELECT sd.side AS subject_key, '''' AS dim,
  CASE WHEN EXISTS (SELECT 1 FROM rp WHERE rp.side = sd.side) THEN COALESCE((SELECT ud.v FROM ud WHERE ud.side = sd.side), 0) END AS value
FROM sd ORDER BY sd.side',
 'match', 'team', '', 'int',
 'Formula: sum(utility_events.damage) by the thrower''s round side, human throwers only. Dash when no human of that side is sampled; 0 when it threw nothing.',
 'builtin', CURRENT_TIMESTAMP),
('raw_round_side_blind_ms', 'Round blind time by side (raw SQL)', '',
 'WITH sd AS (SELECT ''ct'' AS side UNION ALL SELECT ''t''),
rp AS (
  SELECT rps.side AS side, rps.steam_id AS steam_id
  FROM round_player_sides rps
  JOIN players p ON p.match_id = rps.match_id AND p.steam_id = rps.steam_id AND p.is_bot = 0
  WHERE rps.match_id = :match_id AND rps.round = :round
),
ud AS (
  SELECT rp.side AS side, SUM(ue.flash_ms) AS v
  FROM utility_events ue JOIN rp ON rp.steam_id = ue.thrower
  WHERE ue.match_id = :match_id AND ue.round = :round
  GROUP BY rp.side
)
SELECT sd.side AS subject_key, '''' AS dim,
  CASE WHEN EXISTS (SELECT 1 FROM rp WHERE rp.side = sd.side) THEN COALESCE((SELECT ud.v FROM ud WHERE ud.side = sd.side), 0) END AS value
FROM sd ORDER BY sd.side',
 'match', 'team', '', 'int',
 'Formula: sum(utility_events.flash_ms) by the thrower''s round side, human throwers, whole ms. Not enemy-gated. Dash when no human of that side is sampled.',
 'builtin', CURRENT_TIMESTAMP),
('raw_round_side_money_mean', 'Round money mean by side (raw SQL)', '',
 'WITH sd AS (SELECT ''ct'' AS side UNION ALL SELECT ''t'')
SELECT sd.side AS subject_key, '''' AS dim,
  CASE WHEN re.money_samples > 0 THEN CAST(re.money_sampled_sum AS REAL) / re.money_samples END AS value
FROM sd LEFT JOIN round_economy re ON re.match_id = :match_id AND re.round = :round AND re.side = sd.side
ORDER BY sd.side',
 'match', 'team', '', 'currency',
 'Formula: money_sampled_sum / money_samples per side per round, the mean sampled money per player. Dash when the side has no money samples.',
 'builtin', CURRENT_TIMESTAMP),
('raw_round_util_summary', 'Round utility summary (raw SQL)', '',
 'WITH rd AS (SELECT 1 AS present FROM rounds WHERE match_id = :match_id AND number = :round),
u AS (
  SELECT COUNT(*) AS nades, COALESCE(SUM(ue.damage), 0) AS dmg, COALESCE(SUM(ue.flash_ms), 0) AS flash
  FROM utility_events ue
  WHERE ue.match_id = :match_id AND ue.round = :round AND ue.thrower <> ''''
    AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = ue.match_id AND p.steam_id = ue.thrower AND p.is_bot = 1)
)
SELECT '''' AS subject_key, ''nades'' AS dim, CASE WHEN EXISTS (SELECT 1 FROM rd) THEN u.nades END AS value FROM u
UNION ALL
SELECT '''' AS subject_key, ''dmg'' AS dim, CASE WHEN EXISTS (SELECT 1 FROM rd) THEN u.dmg END AS value FROM u
UNION ALL
SELECT '''' AS subject_key, ''flash'' AS dim, CASE WHEN EXISTS (SELECT 1 FROM rd) THEN u.flash END AS value FROM u
ORDER BY dim',
 'match', 'match', '', 'int',
 'Formula: per round, nades = count of utility_events, dmg = sum of damage, flash = sum of flash_ms, human throwers only. Dash when the round is absent.',
 'builtin', CURRENT_TIMESTAMP),
-- Round-grain deaths for the Economy view.
-- Enumerates player_round_stats, the analyzer's own per-round record
-- (one row per counted human × round, carrying that round's side sample),
-- so a player with no death in the round is a real 0, never absent. The
-- death rule is the analyzer's (analytics/rounds.go): every kill whose
-- victim is set, except a disconnect-time World self-kill. dim is the side
-- the player was sampled on that round ('' when the round has no sample).
('raw_player_round_deaths', 'Deaths per round by side (raw SQL)', '',
 'WITH k AS (
  SELECT e.victim, e.attacker, e.weapon, e.tick,
         (e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake
  FROM events e
  LEFT JOIN (SELECT DISTINCT attacker, tick FROM events
             WHERE match_id = :match_id AND kind = ''player_disconnect'') dc
    ON dc.attacker = e.victim AND dc.tick = e.tick
  WHERE e.match_id = :match_id AND e.round = :round AND e.kind = ''kill'' AND e.post_match = 0
),
dk AS (
  SELECT victim AS steam_id, COUNT(*) AS n FROM k WHERE victim <> '''' AND fake = 0 GROUP BY victim
)
SELECT prs.steam_id AS subject_key, prs.side AS dim, COALESCE(dk.n, 0) AS value
FROM player_round_stats prs
JOIN players p ON p.match_id = prs.match_id AND p.steam_id = prs.steam_id AND p.is_bot = 0
LEFT JOIN dk ON dk.steam_id = prs.steam_id
WHERE prs.match_id = :match_id AND prs.round = :round
ORDER BY prs.steam_id',
 'match', 'player', '', 'int',
 'Formula: count(kill events whose victim is the player, in the round, not a disconnect self-kill) — deaths this player suffered in one round, addressed per player and keyed by the side they were sampled on (dim = ct or t; a round with no side sample is dim ''). A count; 0 is a real zero.',
 'builtin', CURRENT_TIMESTAMP);

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

-- Per-match inputs of the per-player profile metrics. Match scope, one row per player per dim: the career metric
-- sums these through metric('...') (ratio of sums, never a mean of per-match
-- values). dim convention: the raw split value as the career row carries it
-- (ps.map = the map name, prs.side = ct/t/'', events.weapon = the weapon name).
INSERT OR IGNORE INTO metrics (name, title, short_name, expr, scope, subject, partition, format, doc, origin, created_at) VALUES
('match_won', 'Match won', '', 'SELECT ps.steam_id AS subject_key, '''' AS dim, ps.won AS value FROM player_stats ps WHERE ps.match_id = :match_id AND ps.steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = ps.match_id AND p.steam_id = ps.steam_id AND p.is_bot = 1)', 'match', 'player', '', 'int', 'Formula: won — 1 when the player won this match, 0 otherwise, addressed per player (no partition) — the per-match input of Win % and Matches.', 'builtin', CURRENT_TIMESTAMP),
('match_trade_opps', 'Trade opportunities', '', 'SELECT ps.steam_id AS subject_key, '''' AS dim, COALESCE(mto.opps, 0) AS value FROM player_stats ps LEFT JOIN match_trade_opps mto ON mto.match_id = ps.match_id AND mto.steam_id = ps.steam_id WHERE ps.match_id = :match_id AND ps.steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = ps.match_id AND p.steam_id = ps.steam_id AND p.is_bot = 1)', 'match', 'player', '', 'int', 'Formula: match_trade_opps.opps — trade opportunities this player had in this match, addressed per player (no partition); a player with no row counts 0.', 'builtin', CURRENT_TIMESTAMP),
('match_clutch_wins', 'Clutches won', '', '{{CLUTCH_CTE}} SELECT c.steam_id AS subject_key, '''' AS dim, SUM(c.won) AS value FROM clutch c WHERE c.steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = :match_id AND p.steam_id = c.steam_id AND p.is_bot = 1) GROUP BY c.steam_id', 'match', 'player', '', 'int', 'Formula: sum(clutches.won) — clutches this player won in this match, addressed per player (no partition) — the numerator of the career Clutch win %.', 'builtin', CURRENT_TIMESTAMP),
('match_kast_flags', 'KAST flags', '', 'SELECT r.steam_id AS subject_key, '''' AS dim, SUM(r.kast) AS value FROM player_round_stats r WHERE r.match_id = :match_id AND r.steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = r.match_id AND p.steam_id = r.steam_id AND p.is_bot = 1) GROUP BY r.steam_id', 'match', 'player', '', 'int', 'Formula: sum(player_round_stats.kast) — rounds with a K, A, T or S this player had in this match, addressed per player (no partition) — the numerator of career KAST%.', 'builtin', CURRENT_TIMESTAMP),
('match_rounds', 'Rounds recorded', '', 'SELECT r.steam_id AS subject_key, '''' AS dim, COUNT(*) AS value FROM player_round_stats r WHERE r.match_id = :match_id AND r.steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = r.match_id AND p.steam_id = r.steam_id AND p.is_bot = 1) GROUP BY r.steam_id', 'match', 'player', '', 'int', 'Formula: count(player_round_stats) — rounds this player has a stored round row for in this match, addressed per player (no partition) — the denominator of career ADR and KAST%.', 'builtin', CURRENT_TIMESTAMP),
('match_map_won', 'Match won by map', '', 'SELECT ps.steam_id AS subject_key, ps.map AS dim, ps.won AS value FROM player_stats ps WHERE ps.match_id = :match_id AND ps.steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = ps.match_id AND p.steam_id = ps.steam_id AND p.is_bot = 1)', 'match', 'player', 'map', 'int', 'Formula: won, partitioned by map — 1 when the player won this match on that map, 0 otherwise, addressed per player, dim = the map name (player_stats.map). Input of the career map splits.', 'builtin', CURRENT_TIMESTAMP),
('match_map_rounds', 'Rounds by map', '', 'SELECT ps.steam_id AS subject_key, ps.map AS dim, (SELECT COUNT(*) FROM player_round_stats d WHERE d.match_id = ps.match_id AND d.steam_id = ps.steam_id) AS value FROM player_stats ps WHERE ps.match_id = :match_id AND ps.steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = ps.match_id AND p.steam_id = ps.steam_id AND p.is_bot = 1)', 'match', 'player', 'map', 'int', 'Formula: count(player_round_stats) partitioned by map — stored round rows this player has in this match, addressed per player, dim = the map name. Denominator of career map ADR.', 'builtin', CURRENT_TIMESTAMP),
('match_map_damage', 'Damage by map', '', 'SELECT m.subject_key AS subject_key, ps.map AS dim, m.value AS value FROM metric(''total_damage'') m JOIN player_stats ps ON ps.match_id = :match_id AND ps.steam_id = m.subject_key WHERE ps.steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = ps.match_id AND p.steam_id = ps.steam_id AND p.is_bot = 1)', 'match', 'player', 'map', 'int', 'Formula: total_damage (read through metric) partitioned by map, dim = the map name — this match''s damage, addressed per player. Numerator of career map ADR.', 'builtin', CURRENT_TIMESTAMP),
('match_map_kills', 'Kills by map', '', 'SELECT m.subject_key AS subject_key, ps.map AS dim, m.value AS value FROM metric(''kills'') m JOIN player_stats ps ON ps.match_id = :match_id AND ps.steam_id = m.subject_key WHERE ps.steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = ps.match_id AND p.steam_id = ps.steam_id AND p.is_bot = 1)', 'match', 'player', 'map', 'int', 'Formula: kills (read through metric) partitioned by map, dim = the map name — this match''s kills, addressed per player. Numerator of career map K/D.', 'builtin', CURRENT_TIMESTAMP),
('match_map_deaths', 'Deaths by map', '', 'SELECT m.subject_key AS subject_key, ps.map AS dim, m.value AS value FROM metric(''deaths'') m JOIN player_stats ps ON ps.match_id = :match_id AND ps.steam_id = m.subject_key WHERE ps.steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = ps.match_id AND p.steam_id = ps.steam_id AND p.is_bot = 1)', 'match', 'player', 'map', 'int', 'Formula: deaths (read through metric) partitioned by map, dim = the map name — this match''s deaths, addressed per player. Denominator of career map K/D.', 'builtin', CURRENT_TIMESTAMP),
('match_side_rounds', 'Rounds by side', '', 'SELECT r.steam_id AS subject_key, r.side AS dim, COUNT(*) AS value FROM player_round_stats r WHERE r.match_id = :match_id AND r.steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = r.match_id AND p.steam_id = r.steam_id AND p.is_bot = 1) GROUP BY r.steam_id, r.side', 'match', 'player', 'side', 'int', 'Formula: count(player_round_stats) partitioned by side — rounds this player played on that side in this match, addressed per player, dim = the side (ct, t or empty).', 'builtin', CURRENT_TIMESTAMP),
('match_side_won', 'Rounds won by side', '', 'SELECT r.steam_id AS subject_key, r.side AS dim, SUM(CASE WHEN r.side <> '''' AND r.side = rd.winner THEN 1 ELSE 0 END) AS value FROM player_round_stats r LEFT JOIN rounds rd ON rd.match_id = r.match_id AND rd.number = r.round WHERE r.match_id = :match_id AND r.steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = r.match_id AND p.steam_id = r.steam_id AND p.is_bot = 1) GROUP BY r.steam_id, r.side', 'match', 'player', 'side', 'int', 'Formula: sum(won) partitioned by side — rounds this player won on that side in this match (side = the round winner), addressed per player, dim = the side.', 'builtin', CURRENT_TIMESTAMP),
('match_side_kast', 'KAST flags by side', '', 'SELECT r.steam_id AS subject_key, r.side AS dim, SUM(r.kast) AS value FROM player_round_stats r WHERE r.match_id = :match_id AND r.steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = r.match_id AND p.steam_id = r.steam_id AND p.is_bot = 1) GROUP BY r.steam_id, r.side', 'match', 'player', 'side', 'int', 'Formula: sum(kast) partitioned by side — KAST rounds this player had on that side in this match, addressed per player, dim = the side.', 'builtin', CURRENT_TIMESTAMP),
('match_side_kills', 'Kills by side', '', 'WITH k AS (SELECT e.round, e.attacker, e.victim, (e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake, sa.side AS a_side, sv.side AS v_side FROM events e LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = ''player_disconnect'') dc ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim WHERE e.match_id = :match_id AND e.kind = ''kill'' AND e.post_match = 0) SELECT r.steam_id AS subject_key, r.side AS dim, SUM(COALESCE(f.n, 0)) AS value FROM player_round_stats r LEFT JOIN (SELECT round, attacker AS steam_id, COUNT(*) AS n FROM k WHERE attacker <> '''' AND attacker <> victim AND fake = 0 AND NOT (COALESCE(a_side, '''') <> '''' AND a_side = v_side) GROUP BY round, attacker) f ON f.round = r.round AND f.steam_id = r.steam_id WHERE r.match_id = :match_id AND r.steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = r.match_id AND p.steam_id = r.steam_id AND p.is_bot = 1) GROUP BY r.steam_id, r.side', 'match', 'player', 'side', 'int', 'Formula: sum(kills) partitioned by side — enemy kills this player made in the rounds they played on that side in this match, addressed per player, dim = the side (the side-kill rule of side K/D).', 'builtin', CURRENT_TIMESTAMP),
('match_side_deaths', 'Deaths by side', '', 'WITH k AS (SELECT e.round, e.attacker, e.victim, (e.victim <> '''' AND e.attacker = e.victim AND e.weapon = ''World'' AND dc.attacker IS NOT NULL) AS fake, sa.side AS a_side, sv.side AS v_side FROM events e LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = ''player_disconnect'') dc ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim WHERE e.match_id = :match_id AND e.kind = ''kill'' AND e.post_match = 0) SELECT r.steam_id AS subject_key, r.side AS dim, SUM(COALESCE(f.n, 0)) AS value FROM player_round_stats r LEFT JOIN (SELECT round, victim AS steam_id, COUNT(*) AS n FROM k WHERE victim <> '''' AND fake = 0 GROUP BY round, victim) f ON f.round = r.round AND f.steam_id = r.steam_id WHERE r.match_id = :match_id AND r.steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = r.match_id AND p.steam_id = r.steam_id AND p.is_bot = 1) GROUP BY r.steam_id, r.side', 'match', 'player', 'side', 'int', 'Formula: sum(deaths) partitioned by side — deaths this player had in the rounds they played on that side in this match, addressed per player, dim = the side.', 'builtin', CURRENT_TIMESTAMP),
('match_side_dmg', 'Capped damage by side', '', 'WITH edmg AS (SELECT e.round, e.attacker, e.capped_dmg, sa.side AS a_side, sv.side AS v_side FROM events e LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim WHERE e.match_id = :match_id AND e.kind = ''damage'' AND e.post_match = 0 AND e.attacker <> '''' AND e.attacker <> e.victim AND NOT (COALESCE(sa.side, '''') <> '''' AND sa.side = sv.side)), f AS (SELECT round, attacker AS steam_id, SUM(capped_dmg) AS n FROM edmg GROUP BY round, attacker) SELECT r.steam_id AS subject_key, r.side AS dim, SUM(COALESCE(f.n, 0)) AS value FROM player_round_stats r LEFT JOIN f ON f.round = r.round AND f.steam_id = r.steam_id WHERE r.match_id = :match_id AND r.steam_id <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = r.match_id AND p.steam_id = r.steam_id AND p.is_bot = 1) GROUP BY r.steam_id, r.side', 'match', 'player', 'side', 'int', 'Formula: sum(events.capped_dmg) partitioned by side — HP-capped enemy damage this player dealt on that side in this match, addressed per player, dim = the side.', 'builtin', CURRENT_TIMESTAMP),
('match_weapon_kills', 'Kills by weapon', '', 'SELECT events.attacker AS subject_key, events.weapon AS dim, SUM(CASE WHEN ((events.kind = ''kill'' AND events.post_match = 0) AND (events.attacker != events.victim)) THEN 1 ELSE 0 END) AS value FROM events WHERE events.match_id = :match_id AND events.attacker <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = events.match_id AND p.steam_id = events.attacker AND p.is_bot = 1) GROUP BY events.attacker, events.weapon', 'match', 'player', 'weapon', 'int', 'Formula: count(events) of enemy kills partitioned by weapon — this match''s kills with that weapon, addressed per player, dim = the weapon name.', 'builtin', CURRENT_TIMESTAMP),
('match_weapon_headshots', 'Headshot kills by weapon', '', 'SELECT events.attacker AS subject_key, events.weapon AS dim, SUM(CASE WHEN (((events.kind = ''kill'' AND events.post_match = 0) AND (events.attacker != events.victim)) AND (events.headshot = 1)) THEN 1 ELSE 0 END) AS value FROM events WHERE events.match_id = :match_id AND events.attacker <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = events.match_id AND p.steam_id = events.attacker AND p.is_bot = 1) GROUP BY events.attacker, events.weapon', 'match', 'player', 'weapon', 'int', 'Formula: count(events) of enemy headshot kills partitioned by weapon — this match''s headshot kills with that weapon, addressed per player, dim = the weapon name.', 'builtin', CURRENT_TIMESTAMP),
('match_weapon_damage', 'Damage by weapon', '', 'SELECT events.attacker AS subject_key, events.weapon AS dim, SUM(CASE WHEN ((events.kind = ''damage'' AND events.post_match = 0) AND (events.attacker != events.victim) AND (NOT (COALESCE(pa.side, '''') <> '''' AND COALESCE(pa.side, '''') = COALESCE(pv.side, '''')))) THEN events.capped_dmg END) AS value FROM events LEFT JOIN player_ticks AS pa ON pa.match_id = events.match_id AND pa.tick = events.tick AND pa.steam_id = events.attacker LEFT JOIN player_ticks AS pv ON pv.match_id = events.match_id AND pv.tick = events.tick AND pv.steam_id = events.victim WHERE events.match_id = :match_id AND events.attacker <> '''' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = events.match_id AND p.steam_id = events.attacker AND p.is_bot = 1) GROUP BY events.attacker, events.weapon', 'match', 'player', 'weapon', 'int', 'Formula: sum(events.capped_dmg) over enemy damage partitioned by weapon — this match''s HP-capped damage with that weapon, addressed per player, dim = the weapon name; NULL if none.', 'builtin', CURRENT_TIMESTAMP);
