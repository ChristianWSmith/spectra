-- Milestone 5 (custom metric engine + read-only SQL console, plan §2.1–2.2).
--
-- Coordination contract: the `metrics` table column list below is FIXED —
-- internal/store/platform_store.go embeds the identical DDL as its defensive
-- ensureMetricsTable fallback and writes plugin rows into it
-- (ON CONFLICT(name) DO UPDATE). Keep both copies byte-compatible.
--
-- Builtins (origin='builtin', ids 1..7) are the PRD §5.16 example queries —
-- each maps to the closest expressible v1 definition with the interpretation
-- recorded in doc (plan §5 acceptance: "demonstrably expressible";
-- internal/metrics fixture tests assert they compile and return the
-- hand-computed seed values).

CREATE TABLE IF NOT EXISTS metrics (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT UNIQUE NOT NULL,
	title TEXT NOT NULL DEFAULT '',
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
	sql TEXT NOT NULL,
	created_at DATETIME NOT NULL
);

-- PRD §5.16 acceptance fixtures, seeded as builtins (see header).
INSERT INTO metrics (name, title, expr, group_by, format, doc, origin, denominator, created_at) VALUES
('untraded_deaths', 'Untraded deaths per round',
 'from player_round_stats: count(where deaths=1 and traded=0)',
 'player', '',
 'PRD 5.16: how many deaths a player suffered without being traded. Formula: count(player_round_stats rows where deaths=1 and traded=0) divided by count(rounds) — a per-round rate in scope; multiply by 10 for the per-10-rounds display form (v1 has no scale factor, documented deviation). traded is set by the M3 analytics pass when a teammate answered the death inside the trade window.',
 'builtin', 'rounds', CURRENT_TIMESTAMP),

('successful_trades', 'Successful trades',
 'from player_stats: sum(trade_kills)',
 'player', '',
 'PRD 5.16: how often a player successfully traded within a configurable time window. Formula: sum(player_stats.trade_kills) grouped by player. A trade kill answers a teammate death inside the configured trade window (M1/M3 rule; the window lives in analysis_config).',
 'builtin', '', CURRENT_TIMESTAMP),

('flash_assisted_kills', 'Flash-assisted kills',
 'from events: count(where kind=''kill'' and assisted_flash)',
 'player', '',
 'PRD 5.16: how many kills followed a teammates flash. Formula: count(events rows where kind=kill and assisted_flash) grouped by player (attacker side). v1 approximation: it uses the kill-assisted-by-flash flag; the specific teammate throw is not linked per kill (cross-event join deferred to v2).',
 'builtin', '', CURRENT_TIMESTAMP),

('utility_value_per_round', 'Utility value per round',
 'from round_economy: sum(equip_value)',
 '', 'int',
 'PRD 5.16: how much utility value was spent per round. Formula: sum(round_economy.equip_value) divided by count(rounds) — the average both-sides buy value per round in scope. round_economy.equip_value is the per-side equipment buy including utility; itemized utility-only spend is not extracted (documented proxy).',
 'builtin', 'rounds', CURRENT_TIMESTAMP),

('round_win_rate', 'Round win rate (CT, man-advantage proxy)',
 'from rounds: ratio(count(where winner=''ct''), count())',
 '', 'percent',
 'PRD 5.16: how often a team converts a man advantage. v1 stores no per-tick alive counts, so true man-advantage conversion is not computable in SQL yet; this is the closest expressible definition (CT round win share = rounds won by CT / total rounds). It is a documented placeholder until per-round advantage tagging lands.',
 'builtin', '', CURRENT_TIMESTAMP),

('isolated_deaths', 'Isolated deaths share',
 'from player_round_stats: ratio(count(where deaths=1 and traded=0), count(where deaths=1))',
 'player', 'percent',
 'PRD 5.16: how frequently a player dies while isolated from teammates. Spatial isolation lives in the position sidecars, so v1 uses the SQL proxy: the share of a player deaths that went untraded (no teammate answered inside the trade window). Formula: count(deaths=1 and traded=0) / count(deaths=1) per player.',
 'builtin', '', CURRENT_TIMESTAMP),

('opening_kill_round_win_pct', 'Opening-kill round win share (CT proxy)',
 'from engagements: ratio(count(where kind=''opening'' and won_by=''ct''), count(where kind=''opening''))',
 '', 'percent',
 'PRD 5.16: what percentage of opening kills resulted in round wins. v1 cannot join the opener side to the round winner inside a single source (rounds.first_kill_steam carries no side), so the expressible definition is the share of opening engagements won by CT. Documented proxy; the exact form needs the cross-source join (v2).',
 'builtin', '', CURRENT_TIMESTAMP);
