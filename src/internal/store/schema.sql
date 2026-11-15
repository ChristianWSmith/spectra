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
-- number addressed to a player —
--   match scope   → one value for this player in this match   (match_id > 0)
--   profile scope → one value for this player's career        (match_id = 0)
-- NO HISTORY: rows exist only for the CURRENT generation; outdated rows
-- (either stamp behind) are DELETED by the compute pass, never retained.
-- Stamps are INTERNAL-ONLY: the canonical read serves only rows where both
-- stamps are live; no app surface renders a stamp. value 0 always beside n;
-- a group the statement did not produce has NO row. steam_id has no FK — a
-- career key does not FK to the per-match roster (player_career precedent,
-- schema.sql:566-584). Reaching this table's shape on an existing DB is
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
-- AND the childTables per-match clear; the steam_id-leading member is the
-- career read (library-wide steam_id convention, like player_career's
-- consumers); dep_name-leading serves the delete-block/dependents lookup.
-- The PK's metric_id prefix already serves per-metric invalidation deletes
-- and the sweep's per-metric outdated-row removal.
CREATE INDEX IF NOT EXISTS idx_metric_values_match ON metric_values(match_id, metric_id);
CREATE INDEX IF NOT EXISTS idx_metric_values_steam ON metric_values(steam_id, metric_id);
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
-- Builtins (origin='builtin') are seeded below: exactly FIFTY-EIGHT —
-- trade_rate (owner ruling) plus the dogfooding set (design §3.0: 7
-- match / 9 profile scopes) — trade_rate + adr, entry_rate, hs_pct,
-- kast, kd, trade_rate_deaths (match) and the nine career_* rows
-- (profile, inert until their surface switches) — plus the 42-row
-- inferred set: 38 match-scope restatements (27 single-source rows over
-- the per-match player stats, rounds, duels, clutches, grenades and
-- drops; 10 over the stored round/side buy classifications; 1
-- victim-side duel count) and 4 profile-scope rows (career_clutches +
-- the three opening-duel rows). Scope split: 45 match / 13 profile.
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

CREATE TABLE IF NOT EXISTS metrics (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT UNIQUE NOT NULL,
	title TEXT NOT NULL DEFAULT '',
	short_name TEXT NOT NULL DEFAULT '',
	expr TEXT NOT NULL,
	scope TEXT NOT NULL DEFAULT 'match' CHECK (scope IN ('match', 'profile')),
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

-- THE builtins, seeded (see header): exactly fifty-eight — trade_rate
-- (the original owner ruling), the dogfooding set (six more match-scope
-- rows and nine profile-scope rows) and the inferred set (42 rows: 38
-- match / 4 profile), each with the interpretation recorded in its doc.
-- INSERT OR IGNORE keyed on the UNIQUE name: re-applying the baseline
-- on every Open must not duplicate or reset a row — it is also the one
-- path by which rows 17…58 reach a database seeded before them.
-- short_name is written explicitly: header labels ONLY — the
-- dogfooding set's scoreboard/Combat labels and, among the inferred
-- set, the eight width-constrained scoreboard columns (A, Entry,
-- Streak, 2K, 3K, 4K, 5K, Trade); every other row ships empty ('' —
-- its header falls back to title; display criterion
-- short_name || title || name — Match's scoreboard metric header).
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
 'How often a player answered a teammate death inside the trade window. Formula: sum(player_stats.trade_kills) / sum(match_trade_opps.opps) — trade successes divided by total trade opportunities, addressed per player over the joined sources (one value per player: that player''s own trade successes over that player''s own trade opportunities), so the denominator is the trade opportunities analytics recorded for that player. It is a ratio, not a share, so the value MAY EXCEED 100% when a trade lands on a death the distance gate did not count (the same note as the profile TradeRate field). N counts the player''s matches behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
-- match-scope dogfooding set (D1/D4/D5/D6/D7/D8): the four converted
-- scoreboard columns plus the Combat Entry%/Trade% pair — recompute
-- from the raw stored inputs, never a query-time calculation.
('adr', 'ADR', 'ADR',
 'from player_stats: ratio(sum(total_damage), sum(rounds_played))',
 'match', 'float1',
 'Formula: sum(player_stats.total_damage) / sum(player_stats.rounds_played) — enemy damage per round the player played, addressed per player (one value per player: that player''s own damage over that player''s own rounds). It recomputes from the raw inputs rather than reading the stored ADR; on imported data the two are identical (the importer computes ADR as total damage ÷ rounds played). A subject with no rounds behind it yields value 0 beside N — ratio''s NULLIF, the house zero-denominator rule. N counts the player''s matches behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('entry_rate', 'Entry%', 'Entry%',
 'from player_stats: ratio(sum(entry_kills), sum(rounds_played))',
 'match', 'percent',
 'Formula: sum(player_stats.entry_kills) / sum(player_stats.rounds_played) — entry (first-blood) kills as a share of the rounds the player played, addressed per player (one value per player: that player''s own entries over that player''s own rounds). A 0..1 fraction rendered as percent (×100) — the same percentage the Combat Entry% column showed before this became a metric. Bounded 0..100 by construction (at most one first blood is credited per round). A subject with no rounds yields value 0 beside N (ratio''s NULLIF). N counts the player''s matches behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('hs_pct', 'HS%', 'HS%',
 'from player_stats: ratio(sum(headshots), sum(kills))',
 'match', 'percent',
 'Formula: sum(player_stats.headshots) / sum(player_stats.kills) — headshots as a share of the player''s kills, addressed per player (one value per player: that player''s own headshots over that player''s own kills). A 0..1 fraction rendered as percent (×100) — the same percentage the stored HS% carries on imported data (the importer computes it as headshots ÷ kills). A subject with no kills yields value 0 beside N (ratio''s NULLIF). N counts the player''s matches behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('kast', 'KAST%', 'KAST%',
 'from player_round_stats: avg(kast)',
 'match', 'percent',
 'Formula: avg(player_round_stats.kast) — the share of the player''s recorded rounds in which they earned K, A, T or S (the per-round KAST flag recorded during analysis), addressed per player (one value per player: that player''s own rounds). A 0..1 fraction rendered as percent (×100) — the same percentage the scoreboard''s KAST% column shows. A subject with no stored rounds has no rows (renders —), never a fabricated 0. N counts the player''s recorded rounds behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('kd', 'K/D', 'K/D',
 'from player_stats: ratio(sum(kills), sum(deaths))',
 'match', 'float2',
 'Formula: sum(player_stats.kills) / sum(player_stats.deaths) — kills per death over the player''s matches, addressed per player (one value per player: that player''s own kills over that player''s own deaths). DIVERGENCE (deliberate — the expression grammar''s ratio note): the metric divides by NULLIF(deaths, 0), so a subject with NO deaths shows value 0 beside N (the honest no-denominator), where the scoreboard''s fixed spelling floors the denominator (MAX(deaths, 1)) and shows the kill count instead. N counts the player''s matches behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('trade_rate_deaths', 'Trade%', 'Trade%',
 'from player_stats: ratio(sum(trade_kills), sum(deaths))',
 'match', 'percent',
 'Formula: sum(player_stats.trade_kills) / sum(player_stats.deaths) — trade kills as a share of the player''s own deaths, addressed per player (one value per player: that player''s own trades over that player''s own deaths). A RATIO, not a share: it MAY EXCEED 100% (a trade can land on a death the distance gate did not count — the same note as the Trade rate metric), and it is a different stat from Trade rate, whose denominator counts the trade opportunities analytics recorded for that player. A 0..1 fraction rendered as percent (×100); a subject with no deaths yields value 0 beside N (ratio''s NULLIF). N counts the player''s matches behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
-- profile-scope dogfooding set (D2/D3/D5/D6/D9/D10/D11/D12): inert
-- until their surface converts — nothing reads a profile-scope seed yet.
('career_adr', 'ADR', 'ADR',
 'from player_stats: avg(adr)',
 'profile', 'float1',
 'Formula: avg(player_stats.adr) — the mean of the player''s per-match ADR values across their career, addressed per player (one value per player: that player''s own per-match ADR values). A MEAN OF RATIOS, deliberately not the pooled ratio(sum(total_damage), sum(rounds_played)): the mean preserves each stored per-match ADR exactly, where a pooled form over uneven rounds played would be a different number. N counts the player''s matches behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('career_adr_sigma', 'ADR σ', 'ADR σ',
 'from player_stats: stddev(adr)',
 'profile', 'float1',
 'Formula: stddev(player_stats.adr) — the population standard deviation (σ) of the player''s per-match ADR across their career, addressed per player (one value per player: that player''s own per-match adr rows). The grammar''s population idiom sqrt(max(avg(x²) − avg(x)², 0)) is the σ over those same rows (clamped at 0 for float noise). N counts the player''s matches behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('career_avg_enemies_flashed', 'Avg enemies flashed', 'Avg enemies flashed',
 'from player_stats: avg(enemies_flashed)',
 'profile', 'float1',
 'Formula: avg(player_stats.enemies_flashed) — the player''s mean enemies-flashed count per match across their career, addressed per player (one value per player: that player''s own per-match enemies-flashed counts). N counts the player''s matches behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('career_avg_util_damage', 'Avg util damage', 'Avg util damage',
 'from player_stats: avg(utility_damage)',
 'profile', 'float1',
 'Formula: avg(player_stats.utility_damage) — the player''s mean utility damage per match across their career, addressed per player (one value per player: that player''s own per-match utility damage). N counts the player''s matches behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('career_clutch_win_rate', 'Clutch win %', 'Clutch win %',
 'from clutches: avg(won)',
 'profile', 'percent',
 'Formula: avg(clutches.won) — the share of the player''s clutches they won (won is the stored 0/1 outcome), addressed per player (one value per player: that player''s own clutches). This is the WIN SHARE the profile card''s "X% won" sub-line showed; the clutch COUNT stays a stored inferred stat. A 0..1 fraction rendered as percent (×100); a subject with no recorded clutches has no rows (renders —), never a fabricated 0. N is the clutches rows behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('career_hs_pct', 'HS%', 'HS%',
 'from player_stats: ratio(sum(headshots), sum(kills))',
 'profile', 'percent',
 'Formula: sum(player_stats.headshots) / sum(player_stats.kills) — headshots as a share of the player''s kills pooled over their whole career, addressed per player (one value per player: that player''s own headshots over that player''s own kills). The pooled shape counts the career totals (SUM(headshots) / SUM(kills)) rather than averaging per-match percentages, which would over-weight short matches. A 0..1 fraction rendered as percent (×100); a subject with no kills yields value 0 beside N (ratio''s NULLIF). N counts the player''s matches behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('career_kast', 'KAST%', 'KAST%',
 'from player_round_stats: avg(kast)',
 'profile', 'percent',
 'Formula: avg(player_round_stats.kast) — the mean KAST flag over every stored round of the player''s career, addressed per player (one value per player: that player''s own rounds). The career KAST% the profile always showed: 100 × AVG over every stored round of that player; a 0..1 fraction rendered as percent (×100). A subject with no stored rounds has no rows (renders —), never a fabricated 0. N counts the player''s rounds behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('career_kd', 'K/D', 'K/D',
 'from player_stats: ratio(sum(kills), sum(deaths))',
 'profile', 'float2',
 'Formula: sum(player_stats.kills) / sum(player_stats.deaths) — kills per death pooled over the player''s whole career, addressed per player (one value per player: that player''s own kills over that player''s own deaths). Pooled across every match, never an average of per-match ratios. DIVERGENCE (deliberate — the metrics grammar''s ratio note): the metric divides by NULLIF(deaths, 0), so a player with NO deaths shows value 0 beside N (the honest no-denominator), where a floored denominator (MAX(SUM(deaths), 1)) would show the kill count instead. N counts the player''s matches behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('career_trade_rate', 'Trade rate', 'Trade rate',
 'from player_stats, match_trade_opps: ratio(sum(trade_kills), sum(opps))',
 'profile', 'percent',
 'Formula: sum(player_stats.trade_kills) / sum(match_trade_opps.opps) over the engine-derived LEFT JOIN on (match_id, steam_id) — trade successes divided by the trade opportunities analytics recorded for that player across their career, addressed per player over the joined sources (one value per player: that player''s own trade successes over that player''s own trade opportunities). It is a RATIO, not a share, so the value MAY EXCEED 100% when a trade lands on a death the distance gate did not count (the same note as the match-scope Trade rate metric and the profile TradeRate field). It recomputes from the sources because a match-scoped metric cannot be referenced inside a profile-scoped metric (the cross-scope rule). N counts the player''s matches behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
-- ---- inferred set, match scope (27 rows): per-match restatements of
-- the stored player, round, duel, clutch, grenade and drop facts — one
-- metric, one number; every row LIST they count stays source data.
('assists', 'Assists', 'A',
 'from player_stats: sum(assists)',
 'match', 'int',
 'Formula: sum(player_stats.assists) — cross-team assists this player earned (assists that are not flash assists), addressed per player (one value per player: that player''s own assists). Equals the A column on the scoreboard. N counts this player''s matches behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('flash_assists', 'Flash assists', '',
 'from player_stats: sum(flash_assists)',
 'match', 'int',
 'Formula: sum(player_stats.flash_assists) — assists credited for blinding an enemy whom a teammate then killed, addressed per player (one value per player: that player''s own flash assists). Equals the Flash assists count in the match''s expanded player row. N counts this player''s matches behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('enemies_flashed', 'Enemies flashed', '',
 'from player_stats: sum(enemies_flashed)',
 'match', 'int',
 'Formula: sum(player_stats.enemies_flashed) — enemies blinded by this player''s flashes (each blinded enemy counted once), addressed per player (one value per player: that player''s own blinded-enemy count). Equals the Enemies flashed count in the match''s expanded player row; the profile''s Avg enemies flashed is the per-match average of the same stat. N counts this player''s matches behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('entry_kills', 'Entry kills', 'Entry',
 'from player_stats: sum(entry_kills)',
 'match', 'int',
 'Formula: sum(player_stats.entry_kills) — round-opening first-blood kills, addressed per player (one value per player: that player''s own first bloods). Equals the Entry column on the scoreboard — entry kills and opening kills are recorded at the same moment, so this one number serves both. N counts this player''s matches behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('entry_deaths', 'Entry deaths', '',
 'from player_stats: sum(entry_deaths)',
 'match', 'int',
 'Formula: sum(player_stats.entry_deaths) — round-opening first-blood victims: enemies who drew first blood against this player, addressed per player (one value per player: that player''s own first-blood deaths). The second half of the Opening K/D column is this stat; it is pinnable on its own too. N counts this player''s matches behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('best_streak', 'Best streak', 'Streak',
 'from player_stats: max(best_streak)',
 'match', 'int',
 'Formula: max(player_stats.best_streak) — the longest kill streak the player reached in the match, addressed per player (one value per player: that player''s own streak). Equals the Streak column on the scoreboard. N counts this player''s matches behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('two_k', '2K', '2K',
 'from player_stats: sum(two_k)',
 'match', 'int',
 'Formula: sum(player_stats.two_k) — rounds in which the player recorded exactly 2 kills (every round counts at exactly one tier), addressed per player (one value per player: that player''s own rounds). Equals the 2K column on the scoreboard. N counts this player''s matches behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('three_k', '3K', '3K',
 'from player_stats: sum(three_k)',
 'match', 'int',
 'Formula: sum(player_stats.three_k) — rounds in which the player recorded exactly 3 kills (every round counts at exactly one tier), addressed per player (one value per player: that player''s own rounds). Equals the 3K column on the scoreboard. N counts this player''s matches behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('four_k', '4K', '4K',
 'from player_stats: sum(four_k)',
 'match', 'int',
 'Formula: sum(player_stats.four_k) — rounds in which the player recorded exactly 4 kills (every round counts at exactly one tier), addressed per player (one value per player: that player''s own rounds). Equals the 4K column on the scoreboard. N counts this player''s matches behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('five_k', '5K', '5K',
 'from player_stats: sum(five_k)',
 'match', 'int',
 'Formula: sum(player_stats.five_k) — rounds in which the player recorded exactly 5 kills (a five-kill round is counted here and in no other tier), addressed per player (one value per player: that player''s own rounds). Equals the 5K column on the scoreboard. N counts this player''s matches behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('rounds_with_assist', 'Assist rounds', '',
 'from player_round_stats: count(where assists > 0)',
 'match', 'int',
 'Formula: count(player_round_stats rows WHERE assists > 0) — the player''s rounds with at least one assist: the KAST A component as a round count, addressed per player (one value per player: that player''s own rounds). Deliberately a COUNT of rounds — summing the assists themselves would just repeat the Assists metric. N counts this player''s rounds behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('rounds_traded', 'Traded rounds', '',
 'from player_round_stats: sum(traded)',
 'match', 'int',
 'Formula: sum(player_round_stats.traded) — rounds in which this player''s own death was answered inside the trade window: the KAST T component, addressed per player (one value per player: that player''s own rounds). It counts the player''s deaths that were traded, exactly what the per-round flag records. N counts this player''s rounds behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('trade_kills', 'Trade kills', 'Trade',
 'from player_stats: sum(trade_kills)',
 'match', 'int',
 'Formula: sum(player_stats.trade_kills) — kills that answered a teammate''s death inside the trade window, addressed per player (one value per player: that player''s own trades). Equals the Trade column on the scoreboard and is the numerator of Trade rate. N counts this player''s matches behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('missed_trades', 'Missed trades', '',
 'from player_stats, match_trade_opps: sum(missed)',
 'match', 'int',
 'Formula: sum(match_trade_opps.missed) — trade opportunities the player missed: a teammate''s death nobody answered inside the window, addressed per player over the joined sources (one value per player: that player''s own missed opportunities). The opportunity counts are recorded per match, and a player recorded with zero opportunities still shows the honest 0 beside N instead of vanishing. N counts this player''s matches behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('eng_opening', 'Opening engagements', '',
 'from engagements: count(where kind = ''opening'')',
 'match', 'int',
 'Formula: count(engagements rows WHERE kind = ''opening'') — round-opening duel kills with this player as the killer, addressed per player (one value per player: that player''s own opening duels). The same idea as Entry kills, counted from the recorded duel list: rounds whose sides were never recorded at freeze time are skipped here while Entry still counts them, so this can read slightly lower. N counts this player''s recorded duels behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('eng_trade', 'Trade engagements', '',
 'from engagements: count(where kind = ''trade'')',
 'match', 'int',
 'Formula: count(engagements rows WHERE kind = ''trade'') — strict-window trade kills with this player as the killer, addressed per player (one value per player: that player''s own trades). The same number as Trade kills, counted straight from the recorded duel list so the two readings can be compared. N counts this player''s recorded duels behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('eng_traded', 'Kills traded (A-side)', '',
 'from engagements: count(where kind = ''traded'')',
 'match', 'int',
 'Formula: count(engagements rows WHERE kind = ''traded'') — this player''s kills that the enemy answered by killing this player inside the trade window (this player got traded), addressed per player (one value per player: that player''s own traded kills). Counted from the KILLER''s side — the only side this metric addresses; a player''s own unanswered deaths instead are Untraded deaths. N counts this player''s recorded duels behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('eng_untraded', 'Kills untraded (A-side)', '',
 'from engagements: count(where kind = ''untraded'')',
 'match', 'int',
 'Formula: count(engagements rows WHERE kind = ''untraded'') — this player''s kills the enemy did NOT answer inside the trade window, addressed per player (one value per player: that player''s own unanswered kills). Counted from the KILLER''s side — it is not the same as Untraded deaths, which counts from the victim''s side. N counts this player''s recorded duels behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('clutches', 'Clutches', '',
 'from clutches: count()',
 'match', 'int',
 'Formula: count(clutches) — the 1vN clutch attempts recorded for this player in the match, addressed per player (one value per player: that player''s own clutches). The clutch LIST (rounds and kill ticks) stays a match detail; this is its count. A player with no clutches has no row (renders —), never a fabricated 0. N counts this player''s clutches behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('clutch_win_rate', 'Clutch win %', '',
 'from clutches: avg(won)',
 'match', 'percent',
 'Formula: avg(clutches.won) — the share of the player''s clutches they won (a 0..1 fraction shown as a percent), addressed per player (one value per player: that player''s own clutches). The match-scope twin of the career Clutch win %. No clutches → no row (renders —), never a fabricated 0. N counts this player''s clutches behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('clutch_avg_size', 'Avg clutch size', '',
 'from clutches: avg(size)',
 'match', 'float1',
 'Formula: avg(clutches.size) — the mean size (the N of the 1vN) of the player''s clutches, addressed per player (one value per player: that player''s own clutches). No clutches → no row (renders —). N counts this player''s clutches behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('clutch_avg_hp', 'Avg clutch HP', '',
 'from clutches: avg(hp_left)',
 'match', 'float1',
 'Formula: avg(clutches.hp_left) — the mean hit points the player ended their clutches with (0 means they died alone in the attempt), addressed per player (one value per player: that player''s own clutches). No clutches → no row (renders —). N counts this player''s clutches behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('clutch_avg_equip', 'Avg clutch equip', '',
 'from clutches: avg(equip)',
 'match', 'currency',
 'Formula: avg(clutches.equip) — the mean equipment value the player held in their clutches (whole dollars), addressed per player (one value per player: that player''s own clutches). No clutches → no row (renders —). N counts this player''s clutches behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('util_nades', 'Nades thrown', '',
 'from utility_events: count()',
 'match', 'int',
 'Formula: count(utility_events) — grenade detonations credited to this player''s throws (one per detonation), addressed per player (one value per player: that player''s own throws). The per-throw rows and the round/team subtotals stay where they are — this counts the detonations only. N counts this player''s grenade detonations behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('util_dmg', 'Util damage (paired)', '',
 'from utility_events: sum(damage)',
 'match', 'int',
 'Formula: sum(utility_events.damage) — damage this player''s grenades dealt inside their burn window, addressed per player (one value per player: that player''s own grenade damage). A different count from the utility damage stat, which credits every hit the thrower landed: a hit landing outside a grenade''s window is not counted here, so the two agree only when every hit lands inside its detonation''s window. N counts this player''s grenade detonations behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('util_flash_ms', 'Blind time (ms)', '',
 'from utility_events: sum(flash_ms)',
 'match', 'int',
 'Formula: sum(utility_events.flash_ms) — the total blind time this player''s flashes applied (each flash''s duration added up), addressed per player (one value per player: that player''s own flashes). Shown as a whole number of milliseconds: metric values have no time format yet. N counts this player''s grenade detonations behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('weapon_drops', 'Weapon drops', '',
 'from events: count(where kind = ''weapon_drop'')',
 'match', 'int',
 'Formula: count(events rows WHERE kind = ''weapon_drop'') — weapon drops recorded at this player''s deaths (the dropped weapon is credited to the player who died), addressed per player (one value per player: that player''s own deaths that left a drop). The per-drop list stays a replay detail; this is its count. N counts this player''s recorded events behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
-- ---- inferred set, profile scope (1 row).
('career_clutches', 'Clutches', '',
 'from clutches: count()',
 'profile', 'int',
 'Formula: count(clutches) over the whole library — the player''s career 1vN clutch count, addressed per player (one value per player: that player''s own clutches). Equals the Clutches number on the player''s profile; the clutch list itself stays a match detail. No clutches → no row (renders —). N counts this player''s clutches across their career.',
 'builtin', '', CURRENT_TIMESTAMP),
-- ---- inferred set, T2 (10 rows): counts over the stored analysis-rule
-- outputs — a round label and a per-side buy class are round-grain
-- text, so a metric counts them per player and never renders them.
('round_label_eco', 'Rounds labeled eco', '',
 'from player_round_stats, round_classifications: count(where label = ''eco'')',
 'match', 'int',
 'Formula: count(player_round_stats rows joined to round_classifications ON (match_id, round) WHERE label = ''eco'') — the rounds this player played carrying the recorded round label eco (the buy classification the analysis stored for that round), addressed per player over the joined sources (one value per player: that player''s own rounds). Counts only: the label wording stays a per-round detail. N counts this player''s rounds behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('round_label_force', 'Rounds labeled force', '',
 'from player_round_stats, round_classifications: count(where label = ''force'')',
 'match', 'int',
 'Formula: count(player_round_stats rows joined to round_classifications ON (match_id, round) WHERE label = ''force'') — the rounds this player played carrying the recorded round label force (the buy classification the analysis stored for that round), addressed per player over the joined sources (one value per player: that player''s own rounds). Counts only: the label wording stays a per-round detail. N counts this player''s rounds behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('round_label_full', 'Rounds labeled full', '',
 'from player_round_stats, round_classifications: count(where label = ''full'')',
 'match', 'int',
 'Formula: count(player_round_stats rows joined to round_classifications ON (match_id, round) WHERE label = ''full'') — the rounds this player played carrying the recorded round label full (the buy classification the analysis stored for that round), addressed per player over the joined sources (one value per player: that player''s own rounds). Counts only: the label wording stays a per-round detail. N counts this player''s rounds behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('round_label_save', 'Rounds labeled save', '',
 'from player_round_stats, round_classifications: count(where label = ''save'')',
 'match', 'int',
 'Formula: count(player_round_stats rows joined to round_classifications ON (match_id, round) WHERE label = ''save'') — the rounds this player played carrying the recorded round label save (the buy classification the analysis stored for that round), addressed per player over the joined sources (one value per player: that player''s own rounds). Counts only: the label wording stays a per-round detail. N counts this player''s rounds behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('pistol_rounds', 'Pistol rounds', '',
 'from player_round_stats, round_classifications: count(where label = ''pistol'')',
 'match', 'int',
 'Formula: count(player_round_stats rows joined to round_classifications ON (match_id, round) WHERE label = ''pistol'') — pistol rounds this player played (the analysis''s stored half-start label), addressed per player over the joined sources (one value per player: that player''s own rounds). It counts the label the analysis already recorded — which rounds count as pistols is never re-derived here. N counts this player''s rounds behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('side_class_eco', 'Rounds on eco side', '',
 'from round_player_sides, round_side_classes: count(where class = ''eco'')',
 'match', 'int',
 'Formula: count(round_player_sides rows joined to round_side_classes ON (match_id, round, side) WHERE class = ''eco'') — rounds this player played on a side the analysis classified as an eco buy, addressed per player over the joined sources (one value per player: that player''s own rounds). The side chips stay round-by-round details; this is the per-player count of them. A player with no recorded rounds has no row (renders —). N counts this player''s rounds behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('side_class_force', 'Rounds on force side', '',
 'from round_player_sides, round_side_classes: count(where class = ''force'')',
 'match', 'int',
 'Formula: count(round_player_sides rows joined to round_side_classes ON (match_id, round, side) WHERE class = ''force'') — rounds this player played on a side the analysis classified as a force buy, addressed per player over the joined sources (one value per player: that player''s own rounds). The side chips stay round-by-round details; this is the per-player count of them. A player with no recorded rounds has no row (renders —). N counts this player''s rounds behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('side_class_full', 'Rounds on full-buy side', '',
 'from round_player_sides, round_side_classes: count(where class = ''full'')',
 'match', 'int',
 'Formula: count(round_player_sides rows joined to round_side_classes ON (match_id, round, side) WHERE class = ''full'') — rounds this player played on a side the analysis classified as a full buy, addressed per player over the joined sources (one value per player: that player''s own rounds). The side chips stay round-by-round details; this is the per-player count of them. A player with no recorded rounds has no row (renders —). N counts this player''s rounds behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('side_class_save', 'Rounds on save side', '',
 'from round_player_sides, round_side_classes: count(where class = ''save'')',
 'match', 'int',
 'Formula: count(round_player_sides rows joined to round_side_classes ON (match_id, round, side) WHERE class = ''save'') — rounds this player played on a side the analysis classified as a save, addressed per player over the joined sources (one value per player: that player''s own rounds). The side chips stay round-by-round details; this is the per-player count of them. A player with no recorded rounds has no row (renders —). N counts this player''s rounds behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('side_class_pistol', 'Rounds on pistol side', '',
 'from round_player_sides, round_side_classes: count(where class = ''pistol'')',
 'match', 'int',
 'Formula: count(round_player_sides rows joined to round_side_classes ON (match_id, round, side) WHERE class = ''pistol'') — rounds this player played on a side classified as pistol (both sides of a pistol round classify as pistol), addressed per player over the joined sources (one value per player: that player''s own rounds). The side chips stay round-by-round details; this is the per-player count of them. A player with no recorded rounds has no row (renders —). N counts this player''s rounds behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
-- ---- addendum: the victim-side duel count (1 row) — the engagements
-- table read through its curated victim-side source (whitelist.go
-- engagements_victim).
('untraded_deaths', 'Untraded deaths', '',
 'from engagements_victim: count(where kind = ''untraded'')',
 'match', 'int',
 'Formula: count(engagements rows WHERE kind = ''untraded'') — deaths of this player that nobody answered inside the trade window, addressed per player (one value per player: that player''s own unanswered deaths — every duel counted here has this player as its victim). Equals the Untraded deaths column on the Combat tab. Deaths caused by a teammate count too; only suicides and rounds with an unknown side record no duel at all. A player with no recorded duels as a victim has no row (renders —), never a fabricated 0. N counts this player''s recorded duels as a victim.',
 'builtin', '', CURRENT_TIMESTAMP),
-- ---- addendum: the opening-duel trio (3 rows, profile scope) — the
-- additive sum(a + b) chain is what the duel total needs.
('career_opening_rate', 'Opening duels', '',
 'from player_stats: ratio(sum(opening_kills), sum(opening_kills + opening_deaths))',
 'profile', 'percent',
 'Formula: sum(player_stats.opening_kills) / sum(player_stats.opening_kills + player_stats.opening_deaths) — the share of the player''s career opening duels they won (first bloods won ÷ duels), addressed per player (one value per player: that player''s own opening duels). A 0..1 fraction shown as a percent — the same percentage the Opening duels card shows. A player with no recorded duels shows 0 beside N, the same number the card showed. N counts this player''s matches behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('career_openings', 'Openings', '',
 'from player_stats: sum(opening_kills + opening_deaths)',
 'profile', 'int',
 'Formula: sum(player_stats.opening_kills + player_stats.opening_deaths) — the player''s career opening duels: the opening kill plus the first-blood deaths it produced, addressed per player (one value per player: that player''s own opening duels). The duel count behind the Opening duels percentage. N counts this player''s matches behind the value.',
 'builtin', '', CURRENT_TIMESTAMP),
('career_opener_wins', 'Opener wins', '',
 'from player_stats: sum(opening_kills)',
 'profile', 'int',
 'Formula: sum(player_stats.opening_kills) — opening kills across the player''s career, addressed per player (one value per player: that player''s own opening kills). The wins half of the Opening duels percentage. N counts this player''s matches behind the value.',
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
