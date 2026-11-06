// voiceindex.js — pure, node-testable voice metadata for the replay
// views: per-player voice colors (player-card / dot outlines) and the
// speaking-bucket index behind the live "talking" ring (data only —
// rendering belongs to the views).
//
// No DOM, no services: everything here is a plain function over the
// payloads already fetched from GetVoicePlayers / GetVoiceLanes.

// VOICE_COLORS are the five exact colors from the spec (line 21), in
// spec order: blue, yellow, purple, green, orange. Players who voice a
// match are assigned one in first-voice-tick order, cycling if there
// are more voice players than colors. UI consumers outline the player
// card and the render-area dot with this hex.
export const VOICE_COLORS = ['#84C8ED', '#ECDF41', '#A56FB2', '#009A7D', '#DF7D29'];

// assignVoiceColors maps steamId → hex for the players that actually
// have voice data ("players are assigned a color when they voice a
// match" — a roster player with no voice rows gets NO color).
//
//   players      roster (meta.players / PlayerRef[]): only used for
//                TIE-BREAKING — array index is the slot/roster order.
//   voicePlayers GetVoicePlayers rows ({steamId, firstTick, …}).
//
// Ordering: ascending firstTick (VoicePlayer.firstTick), ties broken by
// roster/slot order, then steamId (roster-absent players — casters —
// sort after every roster player, then by steamId). Deterministic for
// any input order; duplicates keep their earliest row. Colors cycle
// through VOICE_COLORS (index i → VOICE_COLORS[i % 5]).
export function assignVoiceColors(players, voicePlayers) {
  const out = {};
  const roster = Array.isArray(players) ? players : [];
  const slotOf = new Map();
  roster.forEach((p, i) => {
    const id = p && p.steamId != null ? String(p.steamId) : '';
    if (id && !slotOf.has(id)) slotOf.set(id, i);
  });
  const seen = new Set();
  const rows = [];
  for (const p of Array.isArray(voicePlayers) ? voicePlayers : []) {
    if (!p || p.steamId == null) continue;
    const id = String(p.steamId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const ft = Number(p.firstTick);
    rows.push({ id, firstTick: Number.isFinite(ft) ? ft : Number.MAX_SAFE_INTEGER });
  }
  rows.sort(
    (a, b) =>
      a.firstTick - b.firstTick ||
      slotIndex(slotOf, a.id) - slotIndex(slotOf, b.id) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  rows.forEach((r, i) => {
    out[r.id] = VOICE_COLORS[i % VOICE_COLORS.length];
  });
  return out;
}

function slotIndex(slotOf, id) {
  return slotOf.has(id) ? slotOf.get(id) : Number.MAX_SAFE_INTEGER;
}

// buildSpeakingIndex turns a GetVoiceLanes result ({fromTick, toTick,
// buckets, players:[{steamId, counts[]}]}) into a per-player bucket
// lookup — index-only, no decode.
//
// Caller guidance: fetch ~1 BUCKET PER SECOND of match time for a live
// "talking" ring (the bucket a tick lands in is the ring's granularity
// — speech shorter than a bucket still lights its whole bucket). The
// fetch is cheap: the Go side counts stored voice chunks (a whole match
// is ~10k chunks), no PCM is touched, so even a match-long index is a
// few KB.
//
// Returns {fromTick, toTick, buckets, counts} where counts is a Map of
// steamId → the player's counts array (players without voice are absent
// — GetVoiceLanes omits them).
export function buildSpeakingIndex(laneResult) {
  const from = Number(laneResult && laneResult.fromTick);
  const to = Number(laneResult && laneResult.toTick);
  const buckets = Number(laneResult && laneResult.buckets);
  const counts = new Map();
  const usable =
    laneResult &&
    Number.isFinite(from) &&
    Number.isFinite(to) &&
    Number.isFinite(buckets) &&
    buckets > 0 &&
    to > from;
  if (!usable) return { fromTick: from, toTick: to, buckets: 0, counts };
  for (const p of laneResult.players || []) {
    if (!p || p.steamId == null) continue;
    counts.set(String(p.steamId), Array.isArray(p.counts) ? p.counts : []);
  }
  return { fromTick: from, toTick: to, buckets, counts };
}

// speakingAt reports whether the player was talking in the bucket that
// contains `tick` (that bucket's chunk count > 0).
//
// Bucket mapping mirrors voiceservice.go exactly: the Go writer computes
//   b = int(float64(tick-from) / (to-from) * float64(buckets))
// (float division, truncating int() = floor for the non-negative span)
// then clamps b into [0, buckets-1] — so tick == toTick lands in the
// LAST bucket, like Go's "tick == to lands in the last bucket". Ticks
// outside [fromTick, toTick] are out of range → false; so are unknown
// steamIds, an empty/unusable index, and counts arrays too short to
// cover the bucket.
export function speakingAt(index, steamId, tick) {
  if (!index || !(index.buckets > 0)) return false;
  const t = Number(tick);
  if (!Number.isFinite(t) || t < index.fromTick || t > index.toTick) return false;
  const arr = index.counts.get(String(steamId));
  if (!arr) return false;
  const span = index.toTick - index.fromTick;
  let b = Math.floor(((t - index.fromTick) / span) * index.buckets);
  if (b < 0) b = 0;
  else if (b >= index.buckets) b = index.buckets - 1;
  return (arr[b] || 0) > 0;
}
