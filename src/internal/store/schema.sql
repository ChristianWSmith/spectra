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
	-- 0 = never analyzed / unknown (rule_version starts at 1, so 0 is
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
	opening_kills INTEGER NOT NULL DEFAULT 0,
	opening_deaths INTEGER NOT NULL DEFAULT 0,
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
	kills_by_weapon TEXT NOT NULL DEFAULT '',
	damage_by_weapon TEXT NOT NULL DEFAULT '',
	-- flash_assists splits AssistedFlash assists out of the assist column
	-- (external scoreboards exclude them; the game's own m_iAssists
	-- includes them).
	flash_assists INTEGER NOT NULL DEFAULT 0,
	-- two_k: a round with EXACTLY 2 kills counts as one 2K (exclusive
	-- tier, same rule as 3K/4K/5K — see extract buildMultiKills and the
	-- CS2.md "Multi-kill columns" entry, verified against the golden
	-- demo's external scoreboard screenshot, removed from the repo).
	two_k INTEGER NOT NULL DEFAULT 0,
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
-- player per round.
CREATE TABLE IF NOT EXISTS round_player_sides (
	match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
	round INTEGER NOT NULL,
	steam_id TEXT NOT NULL,
	side TEXT NOT NULL,
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
CREATE TABLE IF NOT EXISTS round_side_classes (
	match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
	round INTEGER NOT NULL,
	side TEXT NOT NULL,
	class TEXT NOT NULL DEFAULT '',
	why TEXT NOT NULL DEFAULT '',
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
	PRIMARY KEY (match_id, round, steam_id)
);
CREATE INDEX IF NOT EXISTS idx_player_round_stats_player ON player_round_stats(match_id, steam_id);

-- Trade-opportunity counts: the two distance-derived per-player metrics,
-- written by analytics.Compute (store.ReplaceTradeOpps — one tx per
-- match) under the match's rule version. Owner ruling 2026-11-12: every
-- rules-derived value is STORED at analyze time (AGENTS.md
-- "Analysis-rule derived values") — the retired query-time json_extract
-- gates (GetCombatStats' TradeOppMissed subquery and
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
--          of the read-time untraded count, which stays ungated).
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
-- number addressed to a player —
--   match scope   → one value for this player in this match   (match_id > 0)
--   profile scope → one value for this player's career        (match_id = 0)
-- NO HISTORY: rows exist only for the CURRENT generation; outdated rows
-- (either stamp behind) are DELETED by the compute pass, never retained.
-- Stamps are INTERNAL-ONLY: the canonical read serves only rows where both
-- stamps are live; no app surface renders a stamp. value 0 always beside n;
-- a group the statement did not produce has NO row. steam_id has no FK — a
-- career key does not FK to the per-match roster (player_career precedent,
-- schema.sql:515-533). Reaching this table's shape on an existing DB is
-- the wipe's job (pre-release: wipe + re-import, never ALTER).
CREATE TABLE IF NOT EXISTS metric_values (
	metric_id       INTEGER NOT NULL REFERENCES metrics(id) ON DELETE CASCADE,
	match_id        INTEGER NOT NULL DEFAULT 0,   -- 0 = the profile (career) grain
	steam_id        TEXT    NOT NULL,             -- the subject player (SteamID64, humans only)
	value           REAL    NOT NULL DEFAULT 0,
	n               INTEGER NOT NULL DEFAULT 0,   -- sample size behind the value
	metric_version  INTEGER NOT NULL DEFAULT 0,   -- metrics.version these values were computed under (0 = never stamped = behind)
	rule_version    INTEGER NOT NULL DEFAULT 0,   -- analysis rule generation that fed them (provenance + rules-axis staleness)
	computed_at     DATETIME,
	PRIMARY KEY (metric_id, match_id, steam_id),
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
-- per-group subqueries (player_stats p2 / clutches c in RebuildCareer,
-- analytics.go) and ListPlayers' HumanOnlyBySteamID bot check (players).
-- Those are
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
-- idx_match_trade_opps_steam serves the profile's stored trade-
-- opportunity denominator: CountPlayerTradeOpportunities is now one
-- `SUM(opps) WHERE steam_id = ?` seek per profile open (the O(library)
-- query it replaces is deleted, so no events victim index is added for
-- it). Leading-column mirror of the match_id-first primary key, like
-- the three above.
--
-- The jobs indexes cover the pending-job lookups (FindPendingJobByPath /
-- FindPendingJobByMatch — path/match_id + non-terminal status, newest
-- first). jobs grows append-forever and these run per listed demo file /
-- per reprocess, so they must not degrade into table scans as history
-- accumulates.
--
-- Stored metric values: match-leading serves the scoreboard/appendix read
-- AND the childTables per-match clear; the steam_id-leading member is the
-- career read (library-wide steam_id convention, like player_career's
-- consumers); dep_name-leading serves the delete-block/dependents lookup.
-- The PK's metric_id prefix already serves per-metric invalidation deletes
-- and the sweep's per-metric outdated-row removal.
CREATE INDEX IF NOT EXISTS idx_players_steam ON players(steam_id);
CREATE INDEX IF NOT EXISTS idx_player_stats_steam ON player_stats(steam_id, match_id);
CREATE INDEX IF NOT EXISTS idx_player_round_stats_steam ON player_round_stats(steam_id, match_id);
CREATE INDEX IF NOT EXISTS idx_events_kind_match ON events(kind, match_id);
CREATE INDEX IF NOT EXISTS idx_jobs_path ON jobs(path);
CREATE INDEX IF NOT EXISTS idx_jobs_match ON jobs(match_id);
CREATE INDEX IF NOT EXISTS idx_match_trade_opps_steam ON match_trade_opps(steam_id, match_id);
CREATE INDEX IF NOT EXISTS idx_metric_values_match ON metric_values(match_id, metric_id);
CREATE INDEX IF NOT EXISTS idx_metric_values_steam ON metric_values(steam_id, metric_id);
CREATE INDEX IF NOT EXISTS idx_metric_deps_dep ON metric_deps(dep_name);

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

CREATE TABLE IF NOT EXISTS utility_events (
	match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
	seq INTEGER NOT NULL,
	tick INTEGER NOT NULL DEFAULT 0,
	round INTEGER NOT NULL DEFAULT 0,
	thrower TEXT NOT NULL DEFAULT '',
	thrower_name TEXT NOT NULL DEFAULT '',
	kind TEXT NOT NULL DEFAULT '',
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
-- in full from player_stats/player_round_stats/clutches; steam_id (the
-- SteamID64 string) is the stable identity key (plan M1 identity notes).
CREATE TABLE IF NOT EXISTS player_career (
	steam_id TEXT PRIMARY KEY,
	name TEXT NOT NULL DEFAULT '',
	matches INTEGER NOT NULL DEFAULT 0,
	wins INTEGER NOT NULL DEFAULT 0,
	adr_avg REAL NOT NULL DEFAULT 0,
	adr_std REAL NOT NULL DEFAULT 0,
	kd REAL NOT NULL DEFAULT 0,
	hs_pct REAL NOT NULL DEFAULT 0,
	kast_pct REAL NOT NULL DEFAULT 0,
	openings INTEGER NOT NULL DEFAULT 0,
	opener_wins INTEGER NOT NULL DEFAULT 0,
	trades INTEGER NOT NULL DEFAULT 0,
	clutches INTEGER NOT NULL DEFAULT 0,
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
-- force 10000 / trade-opp 1000u / rule v1).
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
	rule_version INTEGER NOT NULL DEFAULT 1
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
-- Builtins (origin='builtin') are seeded below: exactly ONE — trade_rate
-- (owner ruling) — with the interpretation recorded in doc.
-- internal/metrics' fixture test locks its name/expr/group_by/denominator/
-- doc/count and proves it compiles and returns the hand-computed seed
-- values under the join grammar (internal/metrics/doc.go).

CREATE TABLE IF NOT EXISTS metrics (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT UNIQUE NOT NULL,
	title TEXT NOT NULL DEFAULT '',
	short_name TEXT NOT NULL DEFAULT '',
	expr TEXT NOT NULL,
	group_by TEXT NOT NULL DEFAULT '',
	format TEXT NOT NULL DEFAULT '',
	doc TEXT NOT NULL DEFAULT '',
	origin TEXT NOT NULL DEFAULT 'user',
	plugin_id TEXT NOT NULL DEFAULT '',
	denominator TEXT NOT NULL DEFAULT '',
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

-- THE builtin, seeded (see header): trade rate — trade successes ÷ total
-- trade opportunities. INSERT OR IGNORE keyed on the UNIQUE name:
-- re-applying the baseline on every Open must not duplicate or reset it.
-- short_name is omitted on purpose (DEFAULT ''): the builtin ships with
-- no short name, so its scoreboard header falls back to title.
-- The expr is the join-grammar shape internal/metrics/doc.go documents:
-- the engine derives
-- `LEFT JOIN match_trade_opps ON player_stats.match_id = match_trade_opps.match_id
--  AND player_stats.steam_id = match_trade_opps.steam_id`.
INSERT OR IGNORE INTO metrics (name, title, expr, group_by, format, doc, origin, denominator, created_at) VALUES
('trade_rate', 'Trade rate',
 'from player_stats, match_trade_opps: ratio(sum(trade_kills), sum(opps))',
 'player', 'percent',
 'How often a player answered a teammate death inside the trade window. Formula: trade successes divided by total trade opportunities — sum(player_stats.trade_kills) / sum(match_trade_opps.opps) grouped by player over the joined sources, so the denominator is the trade opportunities analytics recorded for that player. It is a ratio, not a share, so the value MAY EXCEED 100% when a trade lands on a death the distance gate did not count (the same note as the profile TradeRate field). N is the player_stats rows behind the value.',
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
