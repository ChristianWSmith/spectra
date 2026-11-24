package store

// disconnectJoinSQL joins the player_disconnect events of the match to a kill row:
// a kill whose victim left the match on the same tick (the fake-kill test, a world
// kill that is the disconnect tick). dc is one row per (attacker, tick). schema.sql
// holds disconnectJoinPlaceholder where the join goes; spliceFragments writes it.
const disconnectJoinSQL = "LEFT JOIN (SELECT DISTINCT attacker, tick FROM events WHERE match_id = :match_id AND kind = 'player_disconnect') dc ON dc.attacker = e.victim AND dc.tick = e.tick"

// disconnectJoinPlaceholder marks the disconnect join inside a schema.sql metric expr.
const disconnectJoinPlaceholder = "{{DISCONNECT_JOIN}}"
