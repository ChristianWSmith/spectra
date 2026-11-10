// voiceindex.js — pure, node-testable voice metadata for the replay
// views: the speaking-bucket index behind the live "talking" ring (data
// only — rendering belongs to the views).
//
// The per-player COLORS are NOT voice facts and do not live here anymore:
// they are the player's CS2 teammate color, owned by
// replay/playercolor.js (the one palette home).
//
// No DOM, no services: everything here is a plain function over the
// payloads already fetched from GetVoiceLanes.

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
