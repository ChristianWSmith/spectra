// Server-exact sparse voice-window map — the JS half of the skip
// contract for replay/audio.js.
//
// The Go side computes, per player, the start tick of every
// `windowTicks`-wide window that holds at least one chunk
// (VoiceService.GetVoiceIndex → windows), with windowTicks PASSED IN by
// the caller so the window math lives in exactly one place per side.
// The engine skips scheduling every window absent from that map (~90% of
// requested windows are pure silence) — but ONLY against a map it proved
// consistent: membership is NEVER re-derived client-side (float bucket
// math over lanes could drop real speech = an audible dropout), and any
// doubt — no map, no entry for the player, an empty entry, a
// windowTicks mismatch — fails OPEN to fetching.

import { normTickRate } from '../fmt.js';

// VOICE_WIN_SEC is the fetch window length in replay seconds (≤2 s
// contract — the Go route caps any window at 60 s). THE window-size
// home: audio.js's scheduler and the GetVoiceIndex request both derive
// windowTicks from it through voiceWindowTicks, so the windows the map
// describes are exactly the windows the engine schedules.
export const VOICE_WIN_SEC = 1.0;

// voiceWindowTicks is the ONE window-size formula: how many ticks wide a
// fetch window is at this tick rate (unnormalized/absent rates fall
// through normTickRate's 64 fallback). Idempotent, so the engine can
// apply it to an already-normalized rate.
export function voiceWindowTicks(tickRate) {
  return Math.max(1, Math.round(VOICE_WIN_SEC * normTickRate(tickRate)));
}

// buildVoiceWindowIndex folds GetVoiceIndex's windows payload into
// steamId → Set(window start), or returns null when the map cannot be
// trusted: absent payload, a windowTicks mismatch (the request was
// computed for another window size — a stale or mis-keyed map would skip
// real speech), no rows, or only EMPTY rows (a player with no starts is
// unknown, never "provably silent"). Null → the engine fetches instead
// of skipping (fail-open).
export function buildVoiceWindowIndex(result, windowTicks) {
  if (!result || result.windowTicks !== windowTicks) return null;
  const rows = result.players;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const out = new Map();
  for (const row of rows) {
    if (!row || !row.steamId) continue;
    const starts = row.starts;
    if (!Array.isArray(starts) || starts.length === 0) continue;
    out.set(String(row.steamId), new Set(starts));
  }
  return out.size > 0 ? out : null;
}

// windowHasVoice reports whether the engine must FETCH window `from` for
// sid: true for every unknown (no index at all, or no entry for this
// player — fail-open), false only when the server's exact map proves the
// window chunk-less.
export function windowHasVoice(index, sid, from) {
  if (!index) return true;
  const set = index.get(String(sid));
  if (!set || set.size === 0) return true;
  return set.has(from);
}
