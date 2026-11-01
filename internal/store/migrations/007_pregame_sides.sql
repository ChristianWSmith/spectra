-- 007: stats-correctness schema additions.
--
-- rounds.pregame marks pre-match (knife) rounds: runs with warmup=false and
-- match started, GamePhase=Pregame, score resets afterwards — excluded from
-- real_rounds/stats/analytics like warmup.
ALTER TABLE rounds ADD COLUMN pregame INTEGER NOT NULL DEFAULT 0;

-- player_stats.flash_assists splits AssistedFlash assists out of the assist
-- column (external scoreboards exclude them; the game's own m_iAssists
-- includes them).
ALTER TABLE player_stats ADD COLUMN flash_assists INTEGER NOT NULL DEFAULT 0;

-- round_player_sides persists the extractor's per-round freeze-end side
-- samples (side is a per-round fact — teams switch at halftime; the final
-- roster snapshot alone is unreliable, 3/10 players on the golden demo).
CREATE TABLE IF NOT EXISTS round_player_sides (
	match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
	round INTEGER NOT NULL,
	steam_id TEXT NOT NULL,
	side TEXT NOT NULL,
	PRIMARY KEY (match_id, round, steam_id)
);
