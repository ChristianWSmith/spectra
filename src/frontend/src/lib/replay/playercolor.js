// playercolor.js — the ONE home for CS2 teammate colors (the raw
// m_iCompTeammateColor value → hex): the player-card ring, the render
// dot's rim and any future consumer read the same palette here.
//
// Provenance: the value comes out of the demo's per-controller entity
// property (extract's RosterSink → sidecar meta.json playerColors →
// ReplayService.GetReplayMeta's meta.players[].color), so the frontend
// only ever maps an INT IT WAS GIVEN — never a name, never a guess (a
// sidecar predating the field carries no color → null → no ring). See
// CS2.md "Player scoreboard/radar colors" for the raw mapping and the
// in-game ground truth.
//
// Pure (no DOM, no services): node-tested by src/lib/playercolor.test.js.
export const PLAYER_COLORS = {
  blue: '#84C8ED',
  green: '#009A7D',
  yellow: '#ECDF41',
  orange: '#DF7D29',
  purple: '#A56FB2',
};

// The raw ints CS2 networks (m_iCompTeammateColor): 0 blue, 1 green,
// 2 yellow, 3 orange, 4 purple, -1/absent = none. Indexed by the raw
// value — demoinfocs' common.Color NAMES mislabel this (CS:GO ordering),
// so the int is the only thing ever mapped.
const BY_RAW = [
  PLAYER_COLORS.blue,
  PLAYER_COLORS.green,
  PLAYER_COLORS.yellow,
  PLAYER_COLORS.orange,
  PLAYER_COLORS.purple,
];

// RANK_BY_RAW — the CARD ORDER the owner ratified (2026-11-11): each
// team column of player cards reads top-to-bottom
//   yellow → purple → green → blue → orange
// (the in-game teammate-color order), derived from the raw int above —
// never from the hex, which is display-only. Indexed BY RAW VALUE the
// same way BY_RAW is: blue(0)→3, green(1)→2, yellow(2)→0,
// orange(3)→4, purple(4)→1. colorRankOf returns that rank for a KNOWN
// color and null otherwise — the column sorts nulls LAST in slot order
// (a missing color is never guessed into a position).
const RANK_BY_RAW = [3, 2, 0, 4, 1];

// colorRankOf — one raw m_iCompTeammateColor value → its rank in the
// card order above (0 = top), or null when the value is absent /
// non-integer / outside 0..4. Validation is colorHexOf's, so "has a
// rank" and "has a ring" can never disagree about a player.
export function colorRankOf(raw) {
  if (colorHexOf(raw) == null) return null;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return RANK_BY_RAW[n];
}

// colorHexOf maps one raw color int onto its hex, or null when the value
// is absent / not an integer / outside 0..4 (-1 = "no color", a missing
// field = a sidecar that predates it). Never falls back to a default
// color: an unknown player simply gets no ring.
export function colorHexOf(raw) {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= 0 && raw < BY_RAW.length ? BY_RAW[raw] : null;
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 && n < BY_RAW.length ? BY_RAW[n] : null;
  }
  return null;
}

// colorSlotsOf maps a roster in SLOT ORDER (meta.players / GetReplayMeta)
// onto the per-slot hex array the renderer's setVoices({colors}) payload
// and the card columns both consume. A missing roster row (or a player
// without a color) yields null at its index — the array always stays
// aligned with the slot table.
export function colorSlotsOf(players) {
  return (Array.isArray(players) ? players : []).map((p) => colorHexOf(p ? p.color : null));
}
