package store

// playerRoundFoldsAll is the per-round player stats with the round fold
// columns (kills, deaths, dmg) recomputed from the event rows, over every
// match: the derived table that stands in for player_round_stats where a
// profile read needs the folds. Generated from the same fold logic as the
// builtin seeds (internal/store/schema.sql); the stored columns are gone.
const playerRoundFoldsAll = `(SELECT prs.match_id, prs.round, prs.steam_id, prs.name, prs.traded, prs.kast, prs.money_start, prs.equip, prs.spent, prs.rule_version, prs.side, COALESCE(f.kills, 0) AS kills, COALESCE(f.assists, 0) AS assists, COALESCE(f.deaths, 0) AS deaths, COALESCE(f.dmg, 0) AS dmg, COALESCE(f.util_dmg, 0) AS util_dmg, CASE WHEN COALESCE(f.deaths, 0) = 0 THEN 1 ELSE 0 END AS survived
  FROM player_round_stats prs
  LEFT JOIN (WITH k AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.assisted_flash,
         (e.victim <> '' AND e.attacker = e.victim AND e.weapon = 'World' AND dc.attacker IS NOT NULL) AS fake,
         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side
  FROM events e
  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE 1 = 1 AND kind = 'player_disconnect') dc
    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister
  WHERE 1 = 1 AND e.kind = 'kill' AND e.post_match = 0
),
ek AS (
  SELECT * FROM k WHERE attacker <> '' AND attacker <> victim AND fake = 0
    AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side)
),
ak AS (
  SELECT * FROM k WHERE assister <> '' AND assister <> victim AND attacker <> '' AND attacker <> victim
    AND fake = 0 AND assisted_flash = 0
    AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side)
    AND NOT (COALESCE(s_side, '') <> '' AND s_side = v_side)
),
dmg AS (
  SELECT e.match_id, e.round, e.attacker, e.victim, e.weapon, e.capped_dmg,
         sa.side AS a_side, sv.side AS v_side
  FROM events e
  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker
  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim
  WHERE 1 = 1 AND e.kind = 'damage' AND e.post_match = 0
),
edmg AS (
  SELECT * FROM dmg WHERE attacker <> '' AND attacker <> victim
    AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side)
),
fold AS (
    SELECT match_id, round, attacker AS steam_id, 'kills' AS f, COUNT(*) AS n FROM ek GROUP BY match_id, round, attacker
    UNION ALL SELECT match_id, round, victim AS steam_id, 'deaths' AS f, COUNT(*) AS n FROM k WHERE victim <> '' AND fake = 0 GROUP BY match_id, round, victim
    UNION ALL SELECT match_id, round, assister AS steam_id, 'assists' AS f, COUNT(*) AS n FROM ak GROUP BY match_id, round, assister
    UNION ALL SELECT match_id, round, attacker AS steam_id, 'dmg' AS f, SUM(capped_dmg) AS n FROM edmg GROUP BY match_id, round, attacker
    UNION ALL SELECT match_id, round, attacker AS steam_id, 'util_dmg' AS f, SUM(CASE WHEN weapon IN ('HE Grenade', 'Flashbang', 'Smoke Grenade', 'Molotov', 'Incendiary Grenade', 'Decoy Grenade') THEN capped_dmg ELSE 0 END) AS n FROM edmg GROUP BY match_id, round, attacker
  )
  SELECT match_id, round, steam_id, SUM(CASE WHEN f = 'kills' THEN n END) AS kills, SUM(CASE WHEN f = 'assists' THEN n END) AS assists, SUM(CASE WHEN f = 'deaths' THEN n END) AS deaths, SUM(CASE WHEN f = 'dmg' THEN n END) AS dmg, SUM(CASE WHEN f = 'util_dmg' THEN n END) AS util_dmg FROM fold GROUP BY match_id, round, steam_id) f ON f.match_id = prs.match_id AND f.round = prs.round AND f.steam_id = prs.steam_id
  WHERE 1 = 1)`
