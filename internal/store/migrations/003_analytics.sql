-- Milestone 3 (deep match analytics): derived per-match rows, cross-match
-- career rollups, saved filter presets and the single-row rules config.
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

-- Single-row rules config (plan M3 §3): id is pinned to 1 by CHECK; the Go
-- GetConfig seeds defaults on first use (trade 5s / full 4000 / force 2000 /
-- rule v1).
CREATE TABLE IF NOT EXISTS analysis_config (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	trade_window_s REAL NOT NULL DEFAULT 5.0,
	eco_full_buy INTEGER NOT NULL DEFAULT 4000,
	eco_force INTEGER NOT NULL DEFAULT 2000,
	rule_version INTEGER NOT NULL DEFAULT 1
);
