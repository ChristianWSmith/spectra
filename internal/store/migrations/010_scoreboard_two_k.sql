-- Scoreboard 2K column: a round with EXACTLY 2 kills counts as one 2K
-- (exclusive tier, same rule as 3K/4K/5K — see extract buildMultiKills and
-- the CS2.md "Multi-kill columns" entry, verified against the golden demo's
-- external scoreboard donk.png).

ALTER TABLE player_stats ADD COLUMN two_k INTEGER NOT NULL DEFAULT 0;

-- Best-effort backfill for rows extracted before this migration: recount
-- per-round kills from player_round_stats, which the analytics pass writes
-- with the same basis as the extractor's multi-kill tiers (enemy kills only
-- — teamkills/suicides excluded — over counted rounds only; warmup and
-- pregame rounds never get rows). Rounds with exactly 2 kills → one 2K.
--
-- Caveats (SQL cannot reach exact parity with the extractor):
--   * player_round_stats only exists for matches whose analytics pass ran
--     (M3+ imports); older/failed matches backfill to 0 until reprocessed,
--     which rewrites two_k from the extract anyway.
--   * Side attribution for the enemy-kill test uses the analytics pass's
--     round-side samples (with a final-side fallback) rather than the
--     extractor's live side observations, so a rare kill on an ambiguous
--     side could count differently.
UPDATE player_stats
   SET two_k = (
     SELECT COUNT(*)
       FROM player_round_stats prs
      WHERE prs.match_id = player_stats.match_id
        AND prs.steam_id = player_stats.steam_id
        AND prs.kills = 2
   );
