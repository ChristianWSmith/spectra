// players.js — THE canonical "is this a human?" rule on the frontend.
//
// Product rule: bots are never LISTED anywhere in the app — roster
// tables, Scoreboard/stat cards, Combat/Utility/Heatmaps/Reports views,
// player pickers, Profiles, CommandPalette, Library's player facet,
// metric previews — EXCEPT as a replay substitute (a bot filling in for
// a disconnected human: lib/replay/playercard.js presentAt, which is the
// only reader that looks a bot up on purpose). Event-shaped rows (round
// MVP / first-blood names, kill-feed attacker-victim cells, chat,
// engagements) keep bot names: they record what happened.
//
// The Go twin is store.HumanOnly / store.HumanOnlyBySteamID
// (internal/store/queries.go), which filters every server-side read;
// this module is the ONE client-side spelling, for rows a view derives,
// sorts or filters itself. Never re-test `row.isBot` inline — call
// isHuman/listedPlayers here.

// isBotId reports the SYNTHETIC bot identity extract hands bots
// (extract.isBotKey: 0xFF00000000000000|entityID — bots have no
// SteamID64). Every real SteamID64 is 17 digits (7656119…, far below
// 1e17), while the synthetic key is 20 digits, so no human can ever
// spell an id this rule claims; it is the backstop for a row that did
// not carry the is_bot flag (a stale read, a sidecar slot with no
// players row).
export function isBotId(steamId) {
  return typeof steamId === 'string' && steamId.length >= 18 && /^\d+$/.test(steamId);
}

// isBot reports whether a player-shaped ROW is a bot: the stored
// players.is_bot flag when the read carried one, else the synthetic id
// shape. Rows without an identity (or a nullish row) are NOT bots —
// absence of evidence never hides anything.
export function isBot(row) {
  if (!row) return false;
  if (row.isBot === true) return true;
  const sid = row.steamId != null ? row.steamId : row.steam_id;
  return isBotId(sid);
}

// isHuman — the row a listing may show (the canonical filter's predicate).
export function isHuman(row) {
  return !isBot(row);
}

// listedPlayers — the ONE client-side roster filter: drops bot rows,
// keeps everything else in order. Returns the input untouched when it is
// not an array (fail-soft, like the reads it wraps).
export function listedPlayers(rows) {
  return Array.isArray(rows) ? rows.filter(isHuman) : rows;
}
