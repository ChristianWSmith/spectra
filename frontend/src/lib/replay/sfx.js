// Replay sound-effect engine (lib/replay/sfx.js) — gun fire, utility
// detonation and C4 audio locked to the M2 replay clock, the sound half
// of the voice engine's contract (lib/replay/audio.js).
//
// Sources: Go extracts the game's firing/detonation sounds from the
// user's own CS2 install (internal/mappack/sounds.go — Valve IP never
// ships) and serves them at /api/sounds/… described by
// /api/sounds/manifest.json; keys are the CANONICAL equipment names the
// replay state stream and the landmark rows already carry ("AK-47",
// "HE Grenade", "C4") plus `<name> throw` for a utility's throw group
// ("HE Grenade throw" — throwCues), the C4 beep groups the beep
// scheduler builds (`C4 beep <site>` — c4BeepGroup), the
// THREE played plant/defuse lifecycle cue groups (bombActionCues —
// "C4 plant start", "C4 defuse start", "C4 defuse complete"; the
// plant-complete device sound "C4 plant complete" is still extracted
// but its PLAYBACK is removed — owner instruction 2026-11-09, see
// bombActionCues), the five ANNOUNCER voice lines
// (roundEndCues / bombAnnouncerCues — "ctwin", "terwin", "rounddraw",
// "bombpl", "bombdef") and the match-point freeze stinger
// (matchPointCues — "matchpoint"), so a cue is one exact-match lookup.
// A logical item with several variants keeps ALL of them and picks one
// at RANDOM per play, so a spray doesn't loop one sample — the beep
// groups are single-sample on purpose (the site must never substitute
// at random), and so are the three played lifecycle cues, the five
// announcer lines and the match-point stinger (each is a distinct
// moment, not a variant).
//
// This engine owns its OWN AudioContext: it must work for matches without
// voice (the voice engine may not exist at all). Autoplay policy mirrors
// audio.js — there is NO gesture-pending UX: the context starts by itself
// wherever the platform allows it, and while it stays suspended a
// persistent document pointerdown/keydown capture listener (registered
// for as long as the context is not running, removed on running/destroy)
// retries SILENTLY — being suspended is never an error. A resume() that
// REJECTS is a device failure and surfaces through onError with the
// GStreamer hint.
//
// Contract with the clock (engine.onChange):
//   - cues fire ONLY while st.playing and the context is running;
//   - gun cues are the bullets.js rows pushed through setBullets, in
//     (prevTick, curTick] — ONE row per shot, guns-only and
//     freeze-filtered by bullets.js' own contract (a grenade equip or
//     throw and a knife swing are never bullets, so they never make a
//     gun sound here); the rows' `draw` flag is TRACER selection only —
//     sfx plays EVERY row (the real fire cadence, see bullets.js);
//   - utility cues are the landmark rows' DETONATIONS (grenadeCues) and
//     their THROWS (throwCues — the `${weapon} throw` manifest groups),
//     knife cues are their damage rows — all three in (prevTick,
//     curTick] and all freeze-gated at cue-build time (rounds.js
//     inFreezeTime — the game forbids firing/utility during freeze);
//   - the plant/defuse ATTEMPT cues (bombActionCues — bomb.js
//     ACTION_KINDS → THREE of the manifest's four lifecycle groups)
//     play in (prevTick, curTick] on the C4 bus; the abort rows are
//     silent and so is the plant-COMPLETE row (the "C4 plant complete"
//     device sound's playback is removed — owner instruction
//     2026-11-09; the announcer `bombpl` line still fires from that
//     same row);
//   - the ANNOUNCER voice lines (roundEndCues + bombAnnouncerCues +
//     matchPointCues — ctwin/terwin/rounddraw from the round_end rows
//     joined to GetRounds' winner/reason, bombpl/bombdef from the
//     canonical plant/defuse rows, matchpoint at a MATCH-POINT round's
//     freeze start derived from the scoreline) play in the same window
//     on the announcer bus, ordered by announcerOrder (a defuse line
//     precedes the round-win line by ANNOUNCER_ORDER_DELAY_S when both
//     land in one window);
//   - decoy noise cues are the decoy PLAN's fake shots (setDecoyPlan —
//     lib/replay/decoy.js), played on the GUNS channel with the mimic
//     weapon's own samples (see decoyCues);
//   - the planted C4's BEEP is the one sound that is SCHEDULED AHEAD
//     instead of played on arrival: demos carry no per-beep event, so
//     updateC4Beeps walks c4BeepTicks' synthesized cadence against an
//     AudioContext anchor (the voice engine's lookahead pattern —
//     lib/replay/audio.js), picks each sample deterministically by
//     site, re-seeds on a seek/loop wrap (cueGapJump — a scrub never
//     fast-forwards through missed beeps) and stops while paused or
//     once the bomb is defused/round's over (bombEndTick);
//   - a seek / loop wrap / paused scrub advances the compare point
//     WITHOUT playing (cueGapJump — the renderer's fireJump idea), so
//     scrubbing never machine-guns the cues it crossed.
//
// Pure cue-selection math is exported and unit-tested by
// frontend/src/lib/sfx.test.js.

import { errText } from '../services.js';
import { inFreezeTime, isCounted } from '../rounds.js';
import { DETONATION_BUCKETS } from './landmarks.js';
import { bombEndTick, ACTION_KINDS } from './bomb.js';
import { GST_AUDIO_HINT } from './audio.js';

// Default fader level for all five categories — the kvstore prefs
// voice_volume/guns_volume/utility_volume/c4_volume/announcer_volume
// (prefs.go) override
// it; the Settings tab imports this so both surfaces share one default.
export const AUDIO_VOL_DEFAULT = 0.8;

// Internal mix calibration — GUNS_GAIN_SCALE / UTILITY_GAIN_SCALE /
// C4_GAIN_SCALE / ANNOUNCER_GAIN_SCALE are applied to the fader level in
// applyGains(), so a user-facing 80% still READS 80% (AUDIO_VOL_DEFAULT,
// the sliders, prefs.go and Settings are all untouched): the reduction
// lives inside the mixer, invisible to the fader. The numbers exist
// because this is a relative-mix decision, not a default change: the raw
// extracted samples
// play far hotter than the voice/announcer bus, so the gun and utility
// buses each run at 1/12 of their fader level (spec 2026-11-08: "halve
// internal gain on guns/util one more time (should go to 1/12)" — two
// halvings of the previous 1/3, which was itself the original × 2/3 cut
// halved once for utility, spec 2026-11-07; the slider/pref/default stay
// untouched). C4 follows the same owner instruction one notch: it took
// the explosion over from the utility bus at × 1/3 (deliberately NOT
// following utility down to 1/12 — its level must not move with that
// retune, and the beeps are simply quieter samples than a grenade), and
// the 2026-11-09 instruction halved it again to × 1/6. The ANNOUNCER bus
// was added UNSCALED (its gain WAS the fader value, like the voice
// master) and the SAME 2026-11-09 instruction halves it to × 1/2 — it
// carries the game's own announcer VO, so it sits near the voice level,
// not at the 1/12 the raw weapon/utility samples run at. Voice (the
// separate voice engine, audio.js) is deliberately NOT scaled: its
// master gain stays exactly the fader value. Retune the balance here,
// never by moving the pref default.
export const GUNS_GAIN_SCALE = 1 / 12;
export const UTILITY_GAIN_SCALE = 1 / 12;
// Owner instruction 2026-11-09: HALVE the internal gain of the C4 and
// ANNOUNCER buses (1/3 → 1/6, unscaled ×1 → ×1/2).
export const C4_GAIN_SCALE = 1 / 6;
export const ANNOUNCER_GAIN_SCALE = 1 / 2;

// Live-source cap: a new AudioBufferSourceNode per play IS the Web Audio
// contract for unlimited simultaneous instances of one buffer, but a
// pathological burst (8× through a full magazine) still gets a ceiling —
// when over the cap the OLDEST still-playing source is stopped rather
// than refusing the newest cue.
const LIVE_CAP = 32;
// Bounded fetch/decode pool for the preload pass.
const PRELOAD_POOL = 6;
// A browser without a user gesture may keep ctx.resume()'s promise
// pending forever; race it against this timeout before concluding the
// context is still suspended (same window as audio.js RESUME_MS).
const RESUME_MS = 750;
// C4 beep scheduler constants — the voice engine's lookahead scale
// (audio.js LOOKAHEAD / DRIFT_S): beeps are queued this far ahead of
// the replay clock against an anchor, and the anchor is rebuilt when the
// replay and the AudioContext clocks disagree by more than the drift
// threshold (replay seconds).
const BEEP_LOOKAHEAD = 1.5; // wall seconds of queued beeps
const BEEP_DRIFT_S = 0.05; // re-anchor threshold, replay seconds
// Fan-out ceiling for the QUEUED-beep track — a whole 40 s fuse is ~110
// beeps, so this never trips in practice, and it must not: the cap drops
// the OLDEST entry, which for a queue is the beep due NEXT (at 4×/8× the
// lookahead legitimately holds dozens of them).
const BEEP_TRACK_CAP = 256;

// SOUND_DETONATION_BUCKETS — the drawable grenade buckets that MAKE a
// detonation sound: every bucket landmarks.js DETONATION_BUCKETS can
// produce. It used to exclude 'decoy' (CS2 ships no decoy detonation
// sound — see mappack soundTable); the 'decoy' bucket no longer EXISTS:
// a decoy detonation buckets 'he' (landmarks.detonationStyle — the game
// plays BaseGrenade.Explode, the HE files) and grenadeCues remaps the
// cue name to "HE Grenade", so the exclusion died with the bucket. Kept
// as the named contract the cue gate reads.
export const SOUND_DETONATION_BUCKETS = DETONATION_BUCKETS;

// prefVolume coerces a kvstore read into a 0..1 fader level: the store
// round-trips JSON (an unset key arrives as null), so anything missing,
// non-numeric or out of range falls back to the default — a corrupt pref
// must never bind a 0-fader slider. Shared by Replay's volume popover and
// Settings' Audio & voice section (one coercion, both surfaces).
export function prefVolume(v, def = AUDIO_VOL_DEFAULT) {
  if (v == null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : def;
}

// grenadeCues — landmark rows → the tick-sorted detonation cue list
// [{tick, name, bucket}]. Accepts the Replay's drawNorm rows
// (pre-bucketed by landmarks.js normalizeEvent — no second
// classification here):
//   kind 'grenade'      → the detonation bucket decides; any non-
//                         detonation bucket is skipped;
//   kind 'bomb_explode' → the C4 explosion — the ONE explosive
//                         detonation the replay renders; row.weapon is
//                         the canonical key ("C4"). It cues on the C4
//                         BUS (bucket 'c4' — the bomb's own fader/mute,
//                         sfx.js applyGains), every other detonation on
//                         'utility'.
// THROWS, equips and plants make NO detonation cue (throws have their
// own cue list — throwCues below), and a cue whose tick sits in a
// round's FREEZE time is dropped (rounds.js inFreezeTime — the freeze
// gate; `rounds` is the GetRounds rows, absent → nothing is gated).
// DECOY REMAP: a decoy detonation row (bucket 'he', weapon "Decoy
// Grenade") cues "HE Grenade" — the domain fact (spec research
// 2026-11-07, verified 5/5 demos) is that the exploding decoy plays
// BaseGrenade.Explode = the HE files, and CS2.md "Sound assets" records
// that the decoy has no detonation sound of its own; the manifest has no
// "Decoy Grenade" key, so without the remap the cue would play nothing.
// The remap happens AFTER the dedupe so an HE and a decoy detonating on
// the same tick still make two sounds (they are two grenades).
// DEDUPE by (tick, weapon): CS2.md documents that demoinfocs v6 dispatches
// events.FlashExplode TWICE (the game event AND the projectile's
// entity on-destroy) — 182 grenade rows at 91 distinct ticks in the
// golden demo — so without the dedupe every flashbang plays twice.
// Pure — unit-tested by src/lib/sfx.test.js.
export function grenadeCues(rows, rounds) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    if (!row || !Number.isFinite(row.tick)) continue;
    const kind = String(row.kind || '');
    if (kind === 'grenade') {
      if (!SOUND_DETONATION_BUCKETS.includes(String(row.bucket || ''))) continue;
    } else if (kind !== 'bomb_explode') {
      continue; // equips, throws, kills, … make no detonation sound
    }
    // The canonical key the manifest uses: the grenade's weapon for a
    // detonation, the C4 row's own weapon ("C4") for the explosion —
    // whatever the row carries, never an invented name.
    const weapon = row.weapon == null || row.weapon === '' ? null : String(row.weapon);
    if (!weapon) continue;
    if (inFreezeTime(rounds, row.tick)) continue;
    const key = `${row.tick}|${weapon}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      tick: row.tick,
      name: weapon === 'Decoy Grenade' ? 'HE Grenade' : weapon,
      // The bus the cue rides: only the C4 explosion leaves utility.
      bucket: kind === 'bomb_explode' ? 'c4' : 'utility',
    });
  }
  out.sort((a, b) => a.tick - b.tick);
  return out;
}

// throwCues — the utility THROW cue list: grenade_throw rows →
// [{tick, name: `<weapon> throw`}] in tick order. The manifest carries
// one flat `<name> throw` group per grenade (mappack soundTable — the
// per-grenade throw soundevents' files), so the cue key is built the
// same way here: the row's canonical weapon + " throw", never an
// invented name (a row without a weapon makes nothing). Equip-shaped or
// detonation-shaped rows make NOTHING from this list — only kind
// 'grenade_throw' qualifies. Freeze-gated with the same rule as
// grenadeCues (rounds.js inFreezeTime — the game forbids throwing
// during freeze; belt and braces for a mis-stamped row), deduped by
// (tick, name) like every other cue list (double dispatch — CS2.md).
// Pure — unit-tested by src/lib/sfx.test.js.
export function throwCues(rows, rounds) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    if (!row || !Number.isFinite(row.tick)) continue;
    if (String(row.kind || '') !== 'grenade_throw') continue;
    const weapon = row.weapon == null || row.weapon === '' ? null : String(row.weapon);
    if (!weapon) continue;
    if (inFreezeTime(rounds, row.tick)) continue;
    const name = `${weapon} throw`;
    const key = `${row.tick}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ tick: row.tick, name });
  }
  out.sort((a, b) => a.tick - b.tick);
  return out;
}

// knifeCues — the knife's ONLY sound source: DAMAGE rows (kind
// 'damage', weapon 'Knife') → [{tick, name:'Knife'}] in tick order.
// Swings and wall hits make no cue (they are not damage), and neither
// does a kill row on its own — the flesh-hit sound accompanies the
// DAMAGE the demo records for the hit (a backstab records damage too).
// The manifest's "Knife" group is the game's networked
// Weapon_Knife.Hit.*.Flesh set (internal/mappack/sounds.go), so a hit
// on an enemy plays the real hit sound and a swing plays nothing.
// Freeze-gated with the same rule as grenadeCues (rounds.js).
// Pure — unit-tested by src/lib/sfx.test.js.
export function knifeCues(rows, rounds) {
  const out = [];
  for (const row of rows || []) {
    if (!row || !Number.isFinite(row.tick)) continue;
    if (String(row.kind || '') !== 'damage') continue;
    if (String(row.weapon || '') !== 'Knife') continue;
    if (inFreezeTime(rounds, row.tick)) continue;
    out.push({ tick: row.tick, name: 'Knife' });
  }
  out.sort((a, b) => a.tick - b.tick);
  return out;
}

// bombActionCues — the plant/defuse ATTEMPT cue list: drawNorm rows →
// [{tick, name, bucket: 'c4'}] in tick order, one cue per lifecycle
// moment the game has a sound for AND spectra plays:
//
//   bomb_plant_begin  → 'C4 plant start'      (c4.initiate → c4_initiate)
//   bomb_defuse_start → 'C4 defuse start'     (c4.disarmstart → c4_disarmstart)
//   bomb_defuse       → 'C4 defuse complete'  (c4.disarmfinish → c4_disarmfinish)
//
// The plant-COMPLETE row (bomb_plant → 'C4 plant complete',
// c4.plant → c4_plant) deliberately makes NO cue: owner instruction
// 2026-11-09 removed the bomb-itself's plant sound from playback ("not
// the announcer 'bomb has been planted' sound — the sound of the bomb
// itself being planted"). The asset stays extracted and in the manifest
// (soundTable "C4 plant complete" — extraction stability wins), only
// the playback is gone, and the ANNOUNCER `bombpl` line still fires
// from that same row (bombAnnouncerCues below — a different list, a
// different bus).
// The kind → cue-name mapping comes from bomb.js ACTION_KINDS (THE
// lifecycle taxonomy the renderer's rings read too), so the arc and the
// sound can never disagree about which row is which; the manifest key
// each name builds is soundTable's (internal/mappack — those files are
// single-file groups, one cue each). The ABORT rows make NO cue:
// the game plays nothing when a plant/defuse is abandoned and spectra
// ships no cancel sound. Freeze-gated with the same rule as
// grenadeCues (a plant/defuse cannot begin inside freeze time — belt
// and braces for a mis-stamped row), deduped by (tick, name) like every
// other cue list. Pure — unit-tested by src/lib/sfx.test.js.
export function bombActionCues(rows, rounds) {
  const names = {
    [ACTION_KINDS.plant.begin]: 'C4 plant start',
    // [ACTION_KINDS.plant.complete] — 'C4 plant complete' is NOT played
    // (owner instruction 2026-11-09 — the removal lives HERE, in the one
    // cue builder, so no playback path can resurrect it).
    [ACTION_KINDS.defuse.begin]: 'C4 defuse start',
    [ACTION_KINDS.defuse.complete]: 'C4 defuse complete',
  };
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    if (!row || !Number.isFinite(row.tick)) continue;
    const name = names[String(row.kind || '')];
    if (!name) continue;
    if (inFreezeTime(rounds, row.tick)) continue;
    const key = `${row.tick}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ tick: row.tick, name, bucket: 'c4' });
  }
  out.sort((a, b) => a.tick - b.tick);
  return out;
}

// --- announcer lines (ctwin / terwin / rounddraw / bombpl / bombdef) --------
// The five ANNOUNCER voice lines (owner-provided mapping 2026-11-09,
// NOT verified against primary sources — see internal/mappack/sounds.go
// soundTable for the asset paths). These are the game's round/bomb
// announcer VO, distinct from the C4 DEVICE sounds above (bombActionCues
// — the arm/disarm cues) and from the C4 boom (grenadeCues): they ride
// their own 'announcer' bus with their own fader (announcer_volume).
// The SIXTH announcer-group cue is the match-point stinger
// (matchPointCues — "matchpoint"): NOT owner-provided — cs2find
// discovered the game's Music.Match.MatchPoint soundevent
// (sounds/music/cs_stinger.vsnd_c, existence-verified against the local
// VPK 2026-11-09) when no match-point line exists under
// sounds/vo/announcer/cs2_classic/. It is a 4.1 s music stinger rather
// than a VO line, and the product spec routes it onto this same
// 'announcer' bus (no new gain, no new pref).

// ANNOUNCER_ORDER_DELAY_S — the owner-observed defuse ordering made
// deterministic: when `bombdef` and a round-end line land in the SAME
// playback window, the defuse line starts now and the round-win line
// starts this many wall-seconds later (the game's own "Bomb defused" …
// "Counter-Terrorists win" sequence). Explicit rather than incidental:
// both rows usually share a tick, so without the delay the two would
// start simultaneously and the sequence would be lost.
export const ANNOUNCER_ORDER_DELAY_S = 0.5;

// The round-END lines — the only cues the ordering rule delays.
const ROUND_END_LINES = new Set(['ctwin', 'terwin', 'rounddraw']);

// announcerOrder — THE defuse-then-win ordering rule, applied to the
// window's announcer cues (in tick order) right before playback: a
// window containing `bombdef` delays its round-end line by
// ANNOUNCER_ORDER_DELAY_S; every other cue (and every cue in a window
// with no defuse) keeps delay 0 and plays on arrival. Returns COPIES —
// the stored cue list is never mutated. Pure — unit-tested by
// src/lib/sfx.test.js.
export function announcerOrder(cues) {
  const list = cues || [];
  const defused = list.some((c) => c && c.name === 'bombdef');
  if (!defused) return list.map((c) => ({ ...c, delay: 0 }));
  return list.map((c) => ({
    ...c,
    delay: c && ROUND_END_LINES.has(String(c.name)) ? ANNOUNCER_ORDER_DELAY_S : 0,
  }));
}

// roundEndCues — the round-END announcer cue list: drawNorm round_end
// rows JOINED to the GetRounds rows (roundsByNumber's lookup — the
// winner/reason live on the ROUND row, never on the payload-free event
// row, so an unresolvable round makes NOTHING: missing data is silence,
// never a guessed side). Owner-provided mapping (2026-11-09, unverified):
//   winner 'ct'                    → 'ctwin'   (reason-independent)
//   winner 't'                     → 'terwin'  (reason-independent)
//   winner '' + reason 'Draw'
//     + round endTick > 0          → 'rounddraw'
// anything else (unknown winner, a non-draw row without a winner, a
// knife/warmup round — lib/rounds.js isCounted) makes no cue, so the
// knife round and warmup stay silent. No freeze gate: a round_end cannot
// fall inside freeze time by construction (the round is over), unlike
// the plant/defuse cues below. Deduped by (tick, name) like every other
// cue list. Pure — unit-tested by src/lib/sfx.test.js.
export function roundEndCues(rows, rounds) {
  const byNumber = new Map();
  for (const r of rounds || []) {
    if (r && Number.isFinite(r.number)) byNumber.set(r.number, r);
  }
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    if (!row || !Number.isFinite(row.tick)) continue;
    if (String(row.kind || '') !== 'round_end') continue;
    const rnd = byNumber.get(row.round);
    if (!rnd || !isCounted(rnd)) continue; // unknown or knife/warmup round → silence
    const winner = String(rnd.winner || '');
    let name;
    if (winner === 'ct') name = 'ctwin';
    else if (winner === 't') name = 'terwin';
    else if (
      winner === '' &&
      String(rnd.reason || '') === 'Draw' &&
      Number.isFinite(rnd.endTick) &&
      rnd.endTick > 0
    ) {
      name = 'rounddraw';
    } else {
      continue; // no winner and no draw evidence → never a guess
    }
    const key = `${row.tick}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ tick: row.tick, name, bucket: 'announcer' });
  }
  out.sort((a, b) => a.tick - b.tick);
  return out;
}

// bombAnnouncerCues — the plant/defuse ANNOUNCER lines: the canonical
// completion rows of bomb.js ACTION_KINDS (the SAME taxonomy
// bombActionCues keys its device cues from — one source, two cue lists:
// the device arm/disarm cues and the voice line), so the two can never
// disagree about which row is which. The plant-COMPLETE row still plays
// its VOICE line here even though its DEVICE cue is gone
// (bombActionCues — owner instruction 2026-11-09 removed only the
// bomb's own plant sound).
//   bomb_plant  → 'bombpl'  (the plant event row)
//   bomb_defuse → 'bombdef' (the defuse event row — ordered before the
//                              round-win line by announcerOrder)
// Begin/abort rows make NOTHING (the game has no announcer line for an
// attempt). Freeze-gated with the same rule as bombActionCues (a
// plant/defuse cannot complete inside freeze — belt and braces for a
// mis-stamped row), and a KNOWN non-counted round (knife/warmup) makes
// nothing — a round the lookup does not know is kept (the canonical
// convention in landmarks.js normalizeEvent). Deduped by (tick, name).
// Pure — unit-tested by src/lib/sfx.test.js.
export function bombAnnouncerCues(rows, rounds) {
  const names = {
    [ACTION_KINDS.plant.complete]: 'bombpl',
    [ACTION_KINDS.defuse.complete]: 'bombdef',
  };
  const byNumber = new Map();
  for (const r of rounds || []) {
    if (r && Number.isFinite(r.number)) byNumber.set(r.number, r);
  }
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    if (!row || !Number.isFinite(row.tick)) continue;
    const name = names[String(row.kind || '')];
    if (!name) continue;
    const rnd = byNumber.get(row.round);
    if (rnd && !isCounted(rnd)) continue; // knife/warmup round → silent
    if (inFreezeTime(rounds, row.tick)) continue;
    const key = `${row.tick}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ tick: row.tick, name, bucket: 'announcer' });
  }
  out.sort((a, b) => a.tick - b.tick);
  return out;
}

// --- match-point freeze cue (matchPointCues) --------------------------------
// The match-POINT stinger: at the FREEZE START of every counted round
// in which one more win clinches the match, the game's own match-point
// sound plays (soundTable "matchpoint" → sounds/music/cs_stinger.vsnd_c
// — the Music.Match.MatchPoint soundevent, cs2find-discovered and
// existence-verified 2026-11-09; NOT one of the five owner-provided
// announcer lines, see internal/mappack/sounds.go). It rides the
// 'announcer' bus per the product spec (bus choice — no new gain, no
// new pref, no new event).

// matchPointBefore — THE clinch predicate: given the scoreline BEFORE a
// counted round ({ct, t} round wins), is either side ONE WIN from
// taking the match? The CS2 MR12 + MR3-overtime rule (CS2.md "MR12
// regulation + MR3 overtime"; predicate sources: CS wiki Competitive +
// Overtime pages and Valve's MR12 statement via HLTV, all retrieved
// 2026-11-09 — see the CS2.md draft in the work report):
//   REGULATION — first to 13 round wins, capped at 24 rounds: a side at
//     12 with the opponent at ≤11 is one win from 13 (so 12-X is a
//     point for EITHER side). 12-12 is NOT a point: regulation ends
//     there and the match goes to overtime (or ends tied where there is
//     none), so no round ever starts at 12-12 needing only a 13th win.
//   OVERTIME — after 12-12 the match plays MR3 blocks of 6 rounds,
//     first to 4 block wins takes it: inside the CURRENT block a side at
//     3 block wins (opponent ≤2) is one win from 4 — the first block's
//     point scorelines are 15-X (X ≤14, never 15-15), the second block's
//     18-X after a tied 3-3. A block that reaches 3-3 is COMPLETE:
//     CS2 Premier ends the match there (draw) and other configurations
//     start a fresh 0-0 block — so a round starting at block 3-3 is
//     never a point either way. Completed ties are unwound from the
//     overall scoreline by subtracting 3 per side per tie (each tied
//     block awarded both sides exactly 3).
// Non-MR12 formats (Wingman MR8 first-to-9, legacy MR15 first-to-16)
// are OUTSIDE this rule: Wingman never reaches these scorelines (always
// silent), while an MR15 demo could cue falsely at 12-11 / 15-X — the
// product targets CS2 MR12. An unreachable, negative or non-finite
// scoreline returns false (never a guess). Pure — unit-tested by
// src/lib/sfx.test.js.
export function matchPointBefore(ct, t) {
  if (!Number.isFinite(ct) || !Number.isFinite(t) || ct < 0 || t < 0) return false;
  if (ct <= 12 && t <= 12) {
    if (ct === 12 && t <= 11) return true;
    if (t === 12 && ct <= 11) return true;
    return false; // below 12-12, or exactly 12-12 (overtime / tie follows)
  }
  if (ct < 12 || t < 12) return false; // unreachable scoreline → no cue
  let a = ct - 12;
  let b = t - 12;
  while (a >= 3 && b >= 3) {
    a -= 3; // a completed 3-3 OT block: +3 to each side, next block 0-0
    b -= 3;
  }
  return (a === 3 && b <= 2) || (b === 3 && a <= 2);
}

// scorelineBefore — the scoreline BEFORE counted round `number`
// ({ct, t}), or null when it cannot be resolved: a match-point decision
// must never run on a guess (the roundEndCues silence convention).
// Rounds are numbered in time order (extract's renumber), so
// "number < n" is "played before this round"; knife/warmup rows drop
// out through lib/rounds.js isCounted — the SAME counted gate
// roundEndCues applies. A prior counted round resolves only with a
// winner ('ct' / 't') or as a SETTLED draw (winner '' + reason 'Draw'
// + endTick > 0 — roundEndCues' draw evidence, awarding neither side);
// anything else (unknown winner, a draw with no end tick) makes the
// whole scoreline unknown → null → silence.
// Cross-reference: rounds.js scoreThrough is THE display scoreline
// aggregate (it counts an unknown winner for NEITHER side on purpose —
// a HUD readout may render partial data); a CLINCH decision may not,
// hence this walk instead of a scoreThrough call. Pure.
function scorelineBefore(rounds, number) {
  let ct = 0;
  let t = 0;
  for (const r of rounds || []) {
    if (!r || !Number.isFinite(r.number) || !isCounted(r) || r.number >= number) continue;
    const winner = String(r.winner || '');
    if (winner === 'ct') ct++;
    else if (winner === 't') t++;
    else if (
      winner === '' &&
      String(r.reason || '') === 'Draw' &&
      Number.isFinite(r.endTick) &&
      r.endTick > 0
    ) {
      // A settled draw awards neither side a round — resolved, keep counting.
    } else {
      return null; // unresolvable round → the scoreline is unknown
    }
  }
  return { ct, t };
}

// matchPointCues — the match-POINT cue list: drawNorm round_start rows
// JOINED to the GetRounds rows, the same roundEndCues shape (the
// round_start event row is stamped at the SAME tick as the round row's
// startTick — extract.agg.roundStart — and startTick IS the round's
// FREEZE START: rounds.js inFreezeTime's window is
// [startTick, freezeEndTick), whose end the freeze-end handler stamps,
// so the cue fires exactly where freeze begins). One cue per match-point
// round, so consecutive match-point rounds (12-X stays a point until
// clinched) each get their own line:
//   counted round, resolvable pre-round scoreline, one win from
//     clinching (matchPointBefore) → 'matchpoint', bucket 'announcer'
//   unknown round / knife/warmup (isCounted) / unresolvable scoreline
//     (scorelineBefore) → NO cue, never a guess
//   rows or rounds absent (setRounds has not arrived) → silence
// NO freeze gate, deliberately: unlike every other cue list here this
// cue SITS at freeze start, so inFreezeTime (which opens the round's
// window on this very tick) would always drop it. Deduped by (tick|name)
// like every other cue list. Pure — unit-tested by src/lib/sfx.test.js.
export function matchPointCues(rows, rounds) {
  const byNumber = new Map();
  for (const r of rounds || []) {
    if (r && Number.isFinite(r.number)) byNumber.set(r.number, r);
  }
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    if (!row || !Number.isFinite(row.tick)) continue;
    if (String(row.kind || '') !== 'round_start') continue;
    const rnd = byNumber.get(row.round);
    if (!rnd || !isCounted(rnd)) continue; // unknown or knife/warmup round → silence
    const score = scorelineBefore(rounds, rnd.number);
    if (!score || !matchPointBefore(score.ct, score.t)) continue;
    const key = `${row.tick}|matchpoint`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ tick: row.tick, name: 'matchpoint', bucket: 'announcer' });
  }
  out.sort((a, b) => a.tick - b.tick);
  return out;
}

// tickRange — the ONE (from, to] selector over ANY tick-sorted list:
// open at the left (the previous compare point already played its tick),
// closed at the right (the current tick is reached this draw). Binary
// search — the lists are tick-sorted, so a full-match sweep stays
// O(log n) per draw. Shared by the utility and the bullet cue lists (the
// two exported wrappers below pin the names their callers use).
function tickRange(list, fromTick, toTick) {
  if (!list || !list.length || !Number.isFinite(fromTick) || !Number.isFinite(toTick)) return [];
  let lo = 0;
  let hi = list.length - 1;
  let first = list.length; // first index with tick > fromTick
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].tick > fromTick) {
      first = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  const out = [];
  for (let i = first; i < list.length && list[i].tick <= toTick; i++) out.push(list[i]);
  return out;
}

// utilCuesInRange — the detonation/knife cues in (fromTick, toTick].
// Pure — unit-tested by src/lib/sfx.test.js.
export function utilCuesInRange(cues, fromTick, toTick) {
  return tickRange(cues, fromTick, toTick);
}

// bulletCuesInRange — the bullets.js rows in (fromTick, toTick] whose
// gun sounds play this draw: EVERY row in range (the `draw` flag is the
// tracer selection — sounds are the full fire cadence, see bullets.js).
// Rows are globally tick-sorted by deriveBullets' contract; the engine
// only calls this while cueGapJump says the movement was ordinary
// playback (a seek re-seeds instead of playing the crossed rows).
// Pure — unit-tested by src/lib/sfx.test.js.
export function bulletCuesInRange(rows, fromTick, toTick) {
  return tickRange(rows, fromTick, toTick);
}

// decoyCues — the decoy PLAN (lib/replay/decoy.js buildDecoyPlan output)
// flattened into the fake-gunshot cue list [{tick, weapon}] in tick
// order. Each plan row's shots carry the thrower's MAIN weapon name
// (mainWeaponOf resolved at plan build — one weapon per plan row, so
// every fake shot of one decoy sounds like the same gun); rows without a
// resolved weapon contribute nothing (never a guessed gun). The noise
// rides the GUNS channel on purpose: these ARE gunshots (the decoy
// mimics the thrower's weapon), so they share the gun fader, mute and
// internal gain with real fire — the utility bus is for utility.
// Pure — unit-tested by src/lib/sfx.test.js.
export function decoyCues(plan) {
  const out = [];
  for (const p of plan || []) {
    if (!p || !p.weapon) continue;
    for (const s of p.shots || []) {
      if (s && Number.isFinite(s.tick)) out.push({ tick: s.tick, weapon: String(p.weapon) });
    }
  }
  out.sort((a, b) => a.tick - b.tick);
  return out;
}

// decoyCuesInRange — the plan's fake gunshots in (fromTick, toTick];
// same open/closed window as every other cue list (the compare point
// that just played its tick never replays it). Pure — unit-tested by
// src/lib/sfx.test.js.
export function decoyCuesInRange(cues, fromTick, toTick) {
  return tickRange(cues, fromTick, toTick);
}

// --- C4 beeps ---------------------------------------------------------------
// The planted C4's beep cadence is SYNTHESIZED from the landmark rows:
// demos carry no per-beep event at all (demoinfocs has no BombBeep), so
// the schedule is derived from the plant / detonation ticks the replay
// already has (setLandmarks' drawNorm rows). All four helpers below are
// pure — unit-tested by frontend/src/lib/sfx.test.js.

// c4BeepRows — the ONE filter of drawNorm rows into the bomb lifecycle
// lists the beep scheduler consumes, keyed by the PRE-BUCKETED landmark
// buckets (landmarks.js drawBucket — no second classification here).
export function c4BeepRows(rows) {
  const out = { plants: [], explodes: [], defuses: [], roundEnds: [], roundStarts: [] };
  for (const r of rows || []) {
    if (!r || !Number.isFinite(r.tick)) continue;
    switch (String(r.bucket || '')) {
      case 'plant':
        out.plants.push(r);
        break;
      case 'explode':
        out.explodes.push(r);
        break;
      case 'defuse':
        out.defuses.push(r);
        break;
      case 'round':
        out.roundEnds.push(r);
        break;
      case 'start':
        out.roundStarts.push(r);
        break;
    }
  }
  return out;
}

// c4BombAt — the bomb that is TICKING at `tick`: the last plant at or
// before it, plus
//   stop    — when beeping must STOP (defuse / detonation / round end /
//             next round start / the 40 s timer): bombEndTick, THE
//             planted-C4 termination rule from lib/replay/bomb.js — it
//             is imported, never re-implemented here;
//   fuseEnd — the detonation timeline the cadence is measured AGAINST:
//             the plant's own bomb_explode row, else the 40 s C4 timer
//             (mp_c4timer — CS2.md). Computed through the SAME
//             bombEndTick call with only the explode list, so "earliest
//             same-round terminator, 40 s fallback when none is loaded"
//             has exactly one home. Deliberately NOT cut by a defuse: a
//             bomb defused at half its fuse beeps at the half-fuse
//             cadence, not a cadence racing toward a blast that never
//             happens.
// Null when nothing is planted or the round already resolved it.
// Pure — unit-tested by frontend/src/lib/sfx.test.js.
export function c4BombAt(bombRows, tick, tr) {
  if (!bombRows || !Number.isFinite(tick) || !Number.isFinite(tr) || tr <= 0) return null;
  let plant = null;
  for (const p of bombRows.plants || []) {
    if (p && Number.isFinite(p.tick) && p.tick <= tick) plant = p;
  }
  if (!plant) return null;
  const stop = bombEndTick(
    plant,
    tr,
    bombRows.explodes,
    bombRows.defuses,
    bombRows.roundEnds,
    bombRows.roundStarts,
  );
  if (!(tick < stop)) return null;
  const fuseEnd = bombEndTick(plant, tr, bombRows.explodes, null, null, null);
  return { plant, stop, fuseEnd, site: String(plant.site || '') };
}

// c4BeepRate — beeps per second at fraction p of the fuse (0 at the
// plant, 1 at the detonation): the CS:GO-measured fit
// g(p) = 1.04865 · e^(0.24402·p + 1.76380·p²) — ≈1.05/s right after the
// plant (first beep ~0.95 s in), ≈7.8/s (~128 ms apart) at the blast.
// APPROXIMATE FOR CS2: the curve was fitted to CS:GO's 45 s fuse
// (gritter.nl/posts/csgo-bomb-beep-pattern, 2020-07-21) and is evaluated
// here against CS2's 40 s timer — the shape is right, the exact spacing
// is not claimed to be CS2-verified. p is clamped to [0,1] so a hostile
// tick can never produce an absurd rate. Pure.
export function c4BeepRate(p) {
  const x = Math.max(0, Math.min(1, p));
  return 1.04865 * Math.exp(0.24402 * x + 1.7638 * x * x);
}

// c4BeepTicks — the beep schedule of ONE fuse: every tick a beep fires
// between the plant and the detonation, integrating c4BeepRate over the
// tick domain (a beep fires when the accumulated beeps-per-second cross
// 1). Deterministic — the same (plant, fuse, tickRate) always yields the
// same ticks — and because the accumulation runs in TICKS, the whole
// schedule compresses with the replay clock (8× → beeps 8× closer in
// wall time; deliberate, like every other replay sound). No beep lands
// ON the plant tick (the first arrives one interval in) or ON the
// detonation (the explosion cue owns that tick). Pure — unit-tested by
// frontend/src/lib/sfx.test.js.
export function c4BeepTicks(plantTick, fuseEndTick, tr) {
  const out = [];
  if (
    !Number.isFinite(plantTick) ||
    !Number.isFinite(fuseEndTick) ||
    !Number.isFinite(tr) ||
    tr <= 0 ||
    !(fuseEndTick > plantTick)
  ) {
    return out;
  }
  const fuse = fuseEndTick - plantTick;
  let acc = 0;
  for (let t = Math.floor(plantTick) + 1; t < fuseEndTick; t++) {
    acc += c4BeepRate((t - plantTick) / fuse) / tr;
    while (acc >= 1) {
      out.push(t);
      acc -= 1;
    }
  }
  return out;
}

// c4BeepGroup — the manifest key of ONE beep, chosen DETERMINISTICALLY:
// the plant row's site picks the tone (the game's own C4.PlantSound /
// C4.PlantSoundB sample pairs — mappack soundTable `C4 beep A|B`). A
// site we cannot name resolves to null — silence, never a guessed tone.
// Nothing else picks a sample: the WHOLE fuse plays this one tone at the
// established cadence (c4BeepRate / c4BeepTicks — no phase switch). Each
// group holds exactly one sample, so the engine's random pickVariant is
// the identity here. Pure — unit-tested by frontend/src/lib/sfx.test.js.
export function c4BeepGroup(site) {
  if (site !== 'A' && site !== 'B') return null;
  return `C4 beep ${site}`;
}

// firstBeepAfter — index of the first beep tick STRICTLY after `tick`
// (binary search like tickRange — the schedule is tick-sorted). The
// scheduler's re-seed rule: beeps the playhead already reached are never
// queued again, and a scrub never plays the ones it crossed.
function firstBeepAfter(ticks, tick) {
  let lo = 0;
  let hi = ticks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ticks[mid] <= tick) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// cueGapJump — the seek/frame-jump detector for the sound cues (the
// renderer's fireJump idea, renderer.js): true when the playhead moved
// somewhere the previous compare point cannot be compared across, so the
// cursors re-SEED instead of playing every cue they crossed.
//   - first draw (prevTick not finite) → seed;
//   - backwards (loop restart, reverse scrub) → seed;
//   - the same tick (paused redraw) → NOT a jump;
//   - forward by more than one normal playback step (with slack for the
//     engine's 0.25 s dt clamp at `speed`×) → seed.
// Pure — unit-tested by src/lib/sfx.test.js.
export function cueGapJump(tick, prevTick, speed, tickRate) {
  if (!Number.isFinite(tick) || !Number.isFinite(prevTick)) return true;
  const gap = tick - prevTick;
  if (gap < 0) return true;
  if (gap === 0) return false;
  const tr = Number.isFinite(tickRate) && tickRate > 0 ? tickRate : 64;
  const sp = Number.isFinite(speed) && speed > 0 ? speed : 1;
  return gap > sp * tr * 0.3;
}

// pickVariant — one random variant of a logical item's buffers (the
// "extract ALL variants, pick one at random each play" rule). rand is
// injectable for tests; an empty list returns null (the caller skips).
// Pure — unit-tested by src/lib/sfx.test.js.
export function pickVariant(buffers, rand = Math.random) {
  if (!buffers || buffers.length === 0) return null;
  const i = Math.floor(rand() * buffers.length);
  return buffers[Math.min(Math.max(i, 0), buffers.length - 1)];
}

// createSfxEngine wires the sound-effect mixer to the replay engine.
// The manifest is read through loadSoundManifest() (memoized — the
// Replay checks it first and skips construction entirely when nothing
// has been extracted: no context, no retry listener, silent replay).
// Setup never throws: per-file preload failures are swallowed (the
// FIRST one is reported through onError), and a cue whose buffer is not
// decoded yet is silently skipped — a sound must never break playback.
export function createSfxEngine({ engine, matchId, onError }) {
  // matchId mirrors createVoiceEngine's signature (kept for parity —
  // every sound is a shared static file, so nothing is keyed per match).
  void matchId;
  const tr = engine.tickRate;

  let ctx = null;
  let gunGain = null;
  let utilGain = null;
  let c4Gain = null;
  let announcerGain = null;
  let destroyed = false;
  let error = '';
  let retryOff = null; // tears down the parked retry listeners
  let reported = false; // onError fires at most once (first failure)
  let gunVol = AUDIO_VOL_DEFAULT;
  let utilVol = AUDIO_VOL_DEFAULT;
  let c4Vol = AUDIO_VOL_DEFAULT;
  let annVol = AUDIO_VOL_DEFAULT;
  let gunMuted = false;
  let utilMuted = false;
  let c4Muted = false;
  let annMuted = false;

  const buffers = new Map(); // name → AudioBuffer[] (manifest order)
  let total = 0;
  let loaded = 0;
  // Live sources, OLDEST first ({src, when} — the cap drops the head):
  // `live` holds the cues that started immediately, `beepLive` the C4
  // beeps queued at a future AudioContext time (the lookahead
  // scheduler), so a burst of gunfire can never drop a queued beep.
  const live = [];
  const beepLive = [];

  // Cue inputs (pushed by the Replay at its load/engine push sites).
  let landmarkRows = []; // drawNorm — the ONE source of util + knife cues
  let rounds = null; // GetRounds rows — the freeze gate (rounds.js)
  let utilCues = []; // grenadeCues(landmarkRows, rounds) — tick-sorted
  let throwHits = []; // throwCues(landmarkRows, rounds) — tick-sorted
  let knifeHits = []; // knifeCues(landmarkRows, rounds) — tick-sorted
  let actionCues = []; // bombActionCues(landmarkRows, rounds) — tick-sorted
  let announcerCues = []; // roundEndCues + bombAnnouncerCues + matchPointCues merged, tick-sorted
  let bullets = []; // setBullets — bullets.js rows, tick-sorted
  let decoyShots = []; // setDecoyPlan → decoyCues(plan), tick-sorted
  let bombRows = c4BeepRows([]); // the C4 beep scheduler's row lists
  // C4 beep scheduler state (see updateC4Beeps): the schedule belongs to
  // ONE bomb at a time — `beepBombKey` identifies it, `beepTicks` is its
  // c4BeepTicks output, `beepCursor` the next index to queue, and
  // `beepAnchor` the {ctxNow, tick, speed} mapping replay ticks onto
  // AudioContext time (audio.js's anchor idea).
  let beepBombKey = '';
  let beepTicks = [];
  let beepCursor = 0;
  let beepAnchor = null;
  // Compare point of the last engine change (see the header contract).
  let prevTick = null;
  let lastPlaying = false; // play-START edge → one silent resume retry

  const offChange = engine.onChange(onEngineChange);

  function fail(msg) {
    if (reported || destroyed) return;
    reported = true;
    error = msg;
    if (onError) onError(msg);
  }

  function applyGains() {
    // Internal mix calibration (see GUNS_GAIN_SCALE): the fader keeps
    // its user-facing 0..1 meaning, the bus gain carries the reduction.
    // The ANNOUNCER bus scales like every other bus here, by
    // ANNOUNCER_GAIN_SCALE (×1/2 — owner instruction 2026-11-09 halved
    // it from its previously UNSCALED ×1, when the C4 bus was halved
    // too): these are the game's own announcer VO lines, so they belong
    // near the voice level, not at the 1/12 the raw weapon/utility
    // samples run at.
    if (gunGain) gunGain.gain.value = gunMuted ? 0 : gunVol * GUNS_GAIN_SCALE;
    if (utilGain) utilGain.gain.value = utilMuted ? 0 : utilVol * UTILITY_GAIN_SCALE;
    if (c4Gain) c4Gain.gain.value = c4Muted ? 0 : c4Vol * C4_GAIN_SCALE;
    if (announcerGain) announcerGain.gain.value = annMuted ? 0 : annVol * ANNOUNCER_GAIN_SCALE;
  }

  // tryResume calls ctx.resume() SYNCHRONOUSLY (a listener must invoke
  // it inside the user gesture) and resolves to whether the context
  // ended up running — resume()'s promise may stay pending forever when
  // autoplay is blocked, so it is raced against RESUME_MS (the pattern
  // audio.js's tryResume uses). A resume() that REJECTS propagates: a
  // rejecting resume IS the device failure, and attemptResume reports it
  // with the GStreamer hint. A lost race resolves to the running check —
  // "still suspended", which is NOT an error.
  function tryResume() {
    if (!ctx) return Promise.resolve(false);
    if (ctx.state === 'running') return Promise.resolve(true);
    let p;
    try {
      p = Promise.resolve(ctx.resume());
    } catch (e) {
      return Promise.reject(e);
    }
    const timeout = new Promise((r) => setTimeout(() => r(undefined), RESUME_MS));
    return Promise.race([p, timeout]).then(() => !!ctx && ctx.state === 'running');
  }

  function clearRetry() {
    if (retryOff) {
      retryOff();
      retryOff = null;
    }
  }

  // installRetry parks document-level pointerdown/keydown capture
  // listeners that retry the resume on EVERY interaction while the
  // context is suspended — persistent, not one-time: they stay until the
  // context runs or the engine fails/destroys. No pending flag, no UI
  // and no error while merely suspended — the autoplay policy is not a
  // failure, the sounds simply start on the first interaction (or by
  // themselves where the platform allows it).
  function installRetry() {
    if (retryOff || typeof document === 'undefined' || !document.addEventListener) return;
    const handler = () => attemptResume();
    document.addEventListener('pointerdown', handler, true);
    document.addEventListener('keydown', handler, true);
    retryOff = () => {
      document.removeEventListener('pointerdown', handler, true);
      document.removeEventListener('keydown', handler, true);
    };
  }

  // attemptResume — ONE silent resume attempt: running → the retry
  // listeners come down; still suspended → keep them and stay SILENT;
  // a REJECTED resume() → the device is broken, report it once with the
  // GStreamer hint (the only error this engine ever surfaces for audio).
  function attemptResume() {
    if (destroyed || !ctx) return;
    if (ctx.state === 'running') {
      clearRetry();
      return;
    }
    tryResume().then(
      (ok) => {
        if (destroyed || !ctx) return;
        if (ok) {
          clearRetry();
          return;
        }
        if (ctx.state === 'closed') {
          clearRetry(); // destroy closed it mid-flight
          return;
        }
        // Merely suspended — retry stays armed, unless a device failure
        // already surfaced (`reported`): a stale attempt must never
        // re-arm the listeners after the engine reported a broken device.
        if (!reported) installRetry();
      },
      () => {
        if (destroyed || !ctx) return;
        clearRetry();
        fail(
          `Failed to start the audio device (AudioContext state "${ctx ? ctx.state : 'none'}"). ` +
            GST_AUDIO_HINT,
        );
      },
    );
  }

  // Own context: created only when the engine is (i.e. sounds EXIST —
  // matches without extracted audio never get here), independent of the
  // voice engine so gun/utility audio works with no voice at all.
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    ctx = new Ctx();
    gunGain = ctx.createGain();
    utilGain = ctx.createGain();
    c4Gain = ctx.createGain();
    // 4th bus — the creation order pins the test fixture's gain indexes
    // (guns=0, utility=1, C4=2, announcer=3) and keeps them stable.
    announcerGain = ctx.createGain();
    gunGain.connect(ctx.destination);
    utilGain.connect(ctx.destination);
    c4Gain.connect(ctx.destination);
    announcerGain.connect(ctx.destination);
    applyGains();
  } catch (e) {
    fail(errText(e));
  }

  // First attempt starts the context wherever the platform allows it;
  // the retry listeners are armed from the start so an interaction
  // during the attempt window is never missed (cleared on success).
  if (ctx) {
    installRetry();
    attemptResume();
  }

  // --- preload -------------------------------------------------------------
  // Fetch + decode every manifest URL through a bounded pool; each name
  // keeps ALL of its variants (manifest order — the slot is assigned up
  // front so the parallel pool cannot reshuffle it). Per-file failures are
  // swallowed after the ONE onError report; the rest keep loading.
  async function preload() {
    const manifest = await loadSoundManifest().catch(() => null);
    if (destroyed || !ctx || !manifest || !manifest.sounds) return;
    const tasks = [];
    for (const [name, urls] of Object.entries(manifest.sounds)) {
      if (!Array.isArray(urls)) continue;
      const slots = new Array(urls.length).fill(null);
      buffers.set(name, slots);
      urls.forEach((url, i) => tasks.push({ name, url, slots, i }));
    }
    total = tasks.length;
    if (total === 0) return;
    let next = 0;
    const worker = async () => {
      for (;;) {
        const idx = next++;
        if (idx >= tasks.length || destroyed) return;
        const t = tasks[idx];
        try {
          const res = await fetch(t.url, { cache: 'force-cache' });
          if (!res.ok) throw new Error(`sound unavailable (HTTP ${res.status})`);
          const raw = await res.arrayBuffer();
          const audio = await ctx.decodeAudioData(raw);
          if (destroyed) return;
          t.slots[t.i] = audio;
        } catch (e) {
          fail(errText(e)); // first failure only — the rest stay silent
        }
        loaded++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(PRELOAD_POOL, tasks.length) }, worker));
  }
  preload();

  // --- playback ------------------------------------------------------------
  // busFor — the ONE bucket → GainNode routing: 'guns' → gunGain,
  // 'c4' → c4Gain (the bomb's own fader/mute), 'announcer' →
  // announcerGain (the round/bomb VO lines' fader/mute), everything
  // else the historical default, utilGain (throw/detonation/knife cues
  // ride 'utility').
  function busFor(bucket) {
    if (bucket === 'guns') return gunGain;
    if (bucket === 'c4') return c4Gain;
    if (bucket === 'announcer') return announcerGain;
    return utilGain;
  }

  // pickReady — one RANDOM ready variant of a manifest group (the
  // "extract ALL variants, pick one at random per play" rule). Only
  // READY variants are candidates: a file still decoding (or one that
  // failed) is skipped silently — a sound must never break play. The C4
  // beep groups hold exactly ONE sample each, so their pick is the
  // identity (deterministic by construction).
  function pickReady(name) {
    const variants = buffers.get(name);
    const ready = variants ? variants.filter(Boolean) : null;
    return pickVariant(ready);
  }

  // spawnSource — the ONE "new AudioBufferSourceNode onto a bus, cap the
  // fan-out, track its lifecycle" routine behind every sound here (that
  // one-node-per-play IS the Web Audio contract for unlimited
  // simultaneous instances of one buffer — no pooling, no voice-stealing
  // between cues). `when` null starts immediately (cue playback into
  // `live`); a future AudioContext time queues it (the C4 beep scheduler
  // into `beepLive`). `cap` is the fan-out ceiling for THIS track (see
  // BEEP_TRACK_CAP — a queue's oldest entry is its NEXT beep, so the
  // immediate-cue ceiling must not be reused there). Returns the tracked
  // entry, or null when the start was refused.
  function spawnSource(buf, bucket, when, track, cap) {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(busFor(bucket));
    // Cap the fan-out: drop the OLDEST still-playing source so the
    // newest cue always gets through.
    while (track.length >= cap) {
      const oldest = track.shift();
      try {
        oldest.src.stop();
      } catch {
        /* already ended */
      }
      try {
        oldest.src.disconnect();
      } catch {
        /* already detached */
      }
    }
    const entry = { src, when: when == null ? ctx.currentTime : when };
    src.onended = () => {
      const at = track.indexOf(entry);
      if (at >= 0) track.splice(at, 1);
      try {
        src.disconnect();
      } catch {
        /* already detached */
      }
    };
    track.push(entry);
    try {
      if (when == null) src.start();
      else src.start(when);
    } catch (e) {
      fail(errText(e));
      const at = track.indexOf(entry);
      if (at >= 0) track.splice(at, 1);
      return null;
    }
    return entry;
  }

  // playGroup — one cue of a manifest group on a bus, right now (the
  // scheduled-beep path calls spawnSource directly with a future time).
  // delay > 0 starts the cue that many wall-seconds from now instead
  // (the announcer ordering rule — announcerOrder); it still tracks on
  // the immediate-cue `live` list, which is bounded by LIVE_CAP like any
  // other cue (a window carries at most a handful of announcer lines).
  function playGroupAt(name, bucket, delay) {
    if (destroyed || !ctx || ctx.state !== 'running') return false;
    const buf = pickReady(name);
    if (!buf) return false;
    const when = delay > 0 ? ctx.currentTime + delay : null;
    return !!spawnSource(buf, bucket, when, live, LIVE_CAP);
  }

  function playGroup(name, bucket) {
    return playGroupAt(name, bucket, 0);
  }

  // --- clock cues ----------------------------------------------------------
  function playUtilInRange(fromTick, toTick) {
    for (const cue of utilCuesInRange(utilCues, fromTick, toTick)) {
      // The cue carries its bus (grenadeCues): only the C4 explosion
      // rides 'c4', every grenade detonation stays on 'utility'.
      playGroup(cue.name, cue.bucket || 'utility');
    }
  }

  // playThrowInRange — one throw sound per grenade_throw row in range,
  // on the UTILITY channel (a throw is utility audio, not a gunshot).
  function playThrowInRange(fromTick, toTick) {
    for (const cue of utilCuesInRange(throwHits, fromTick, toTick)) {
      playGroup(cue.name, 'utility');
    }
  }

  function playKnifeInRange(fromTick, toTick) {
    for (const cue of utilCuesInRange(knifeHits, fromTick, toTick)) {
      // The guns bucket: a knife hit shares the gun fader/mute, and the
      // manifest's "Knife" group is the networked flesh-hit set.
      playGroup(cue.name, 'guns');
    }
  }

  // playActionInRange — the THREE played plant/defuse lifecycle cues,
  // all on the C4 bus (bombActionCues carries bucket 'c4' — the bomb's
  // own fader/mute, like the explosion and the beeps). The
  // plant-complete device cue is never built (bombActionCues — owner
  // instruction 2026-11-09), so nothing filters it out here.
  function playActionInRange(fromTick, toTick) {
    for (const cue of utilCuesInRange(actionCues, fromTick, toTick)) {
      playGroup(cue.name, 'c4');
    }
  }

  // playAnnouncerInRange — the announcer voice lines (roundEndCues +
  // bombAnnouncerCues + matchPointCues) in (prevTick, curTick] on the
  // ANNOUNCER bus. The window's cues go through announcerOrder first: a
  // `bombdef` and a round-end line in the SAME window start in the
  // owner-observed order (bombdef now, the win line ANNOUNCER_ORDER_DELAY_S
  // later) — the one place two cues must not start together. Everything
  // else starts on arrival, exactly like the other cue lists (same
  // open/closed window, same seek/pause guards — it is called only inside
  // the guarded block), which is what makes the match-point stinger fire
  // once per match-point round at freeze start and re-seed on a seek.
  function playAnnouncerInRange(fromTick, toTick) {
    const win = utilCuesInRange(announcerCues, fromTick, toTick);
    if (!win.length) return;
    for (const cue of announcerOrder(win)) {
      playGroupAt(cue.name, cue.bucket || 'announcer', cue.delay || 0);
    }
  }

  // playBulletsInRange — ONE gun sound per bullets.js row in range.
  // EVERY row plays: `draw` is the renderer's tracer selection, not a
  // sound filter (bullets.js contract — the real fire cadence). The rows
  // themselves are already guns-only and freeze-filtered there, so this
  // engine never re-checks either rule.
  function playBulletsInRange(fromTick, toTick) {
    for (const row of bulletCuesInRange(bullets, fromTick, toTick)) {
      playGroup(row.weapon, 'guns');
    }
  }

  // playDecoyInRange — the decoy's FAKE gunshots (the plan's scheduled
  // shots), on the GUNS channel with the mimic weapon's own samples
  // (decoyCues' comment): the noise is a gunshot, so it rides the gun
  // fader/mute. The plan is already the deterministic schedule (seeded
  // by landTick — same shots every redraw/seek), so a seek re-seeds the
  // compare point via cueGapJump like every other cue list.
  function playDecoyInRange(fromTick, toTick) {
    for (const cue of decoyCuesInRange(decoyShots, fromTick, toTick)) {
      playGroup(cue.weapon, 'guns');
    }
  }

  // --- C4 beep scheduler ---------------------------------------------------
  // One bomb's schedule at a time, queued ahead against an
  // AudioContext anchor (the voice engine's lookahead pattern —
  // audio.js LOOKAHEAD / DRIFT_S): beeps land at exact Web Audio times
  // instead of wherever a rAF frame happens to arrive, so the
  // accelerating cadence stays even. A re-seed (a seek or loop wrap, a
  // speed change, >BEEP_DRIFT_S of clock drift) drops the QUEUED —
  // not-yet-started — beeps and re-seeds the cursor, so a scrub NEVER
  // fast-forwards through the beeps it crossed (cueGapJump's contract)
  // and a beep that already sounded is never queued twice. While paused,
  // with the context suspended, or with no bomb ticking it goes silent.

  function stopSourceEntry(entry) {
    try {
      entry.src.stop();
    } catch {
      /* already ended */
    }
    try {
      entry.src.disconnect();
    } catch {
      /* already detached */
    }
  }

  // clearBeeps — stop and drop EVERY tracked beep (ringing and queued):
  // a re-arm belongs to a NEW schedule (a new bomb, or playback finding
  // the bomb again after a pause) and inherits nothing.
  function clearBeeps() {
    for (const entry of beepLive.splice(0)) stopSourceEntry(entry);
  }

  // cancelQueuedBeeps — drop only the beeps whose AudioContext time has
  // not arrived; an already-ringing beep plays out (≤180 ms) and removes
  // itself through onended.
  function cancelQueuedBeeps() {
    if (!ctx) return;
    for (let i = beepLive.length - 1; i >= 0; i--) {
      if (beepLive[i].when > ctx.currentTime) {
        stopSourceEntry(beepLive[i]);
        beepLive.splice(i, 1);
      }
    }
  }

  // armC4Beeps — (re)build the schedule for `bomb` and anchor it at the
  // playhead: the cursor starts past the playhead (a beep the playhead
  // already reached is never queued) and the anchor maps its ticks onto
  // AudioContext time.
  function armC4Beeps(bomb, st) {
    clearBeeps();
    beepBombKey = `${bomb.plant.tick}|${bomb.stop}|${bomb.fuseEnd}|${bomb.site}`;
    beepTicks = c4BeepTicks(bomb.plant.tick, bomb.fuseEnd, tr);
    beepCursor = firstBeepAfter(beepTicks, st.tick);
    beepAnchor = { ctxNow: ctx.currentTime, tick: st.tick, speed: st.speed };
  }

  // c4BeepDrift — replay seconds between the anchor's mapping of time
  // and the engine's own clock (audio.js's drift test).
  function c4BeepDrift(st) {
    const expected = beepAnchor.tick / tr + (ctx.currentTime - beepAnchor.ctxNow) * beepAnchor.speed;
    return Math.abs(st.tick / tr - expected);
  }

  // reseedC4Beeps — the same-bomb re-seed: drop the queued beeps (their
  // `when` came from the anchor being replaced) and re-anchor here. The
  // new cursor floors at the LAST BEEP THAT ALREADY SOUNDED —
  // `wallTick` is where the old anchor says the replay should be right
  // now (a stalled rAF lets queued beeps fire while the replay clock is
  // frozen), never past what was actually queued. A BACKWARD seek floors
  // at the playhead instead: its region replays as playback re-crosses
  // it, exactly like the gun cues.
  function reseedC4Beeps(st) {
    cancelQueuedBeeps();
    const lastQueued = beepCursor > 0 ? beepTicks[beepCursor - 1] : -Infinity;
    const wallTick =
      beepAnchor.tick + (ctx.currentTime - beepAnchor.ctxNow) * tr * beepAnchor.speed;
    const fired = Math.min(wallTick, lastQueued);
    const floor = st.tick < prevTick ? st.tick : Math.max(st.tick, fired);
    beepCursor = firstBeepAfter(beepTicks, floor);
    beepAnchor = { ctxNow: ctx.currentTime, tick: st.tick, speed: st.speed };
  }

  function scheduleC4Beep(beatTick, bomb) {
    // Deterministic sample: the site picks the tone (c4BeepGroup) —
    // the whole fuse beeps the same normal beep.
    const name = c4BeepGroup(bomb.site);
    if (!name) return; // a site we cannot name — silence, never a guess
    const buf = pickReady(name);
    if (!buf) return; // not extracted / not decoded yet — silent, no error
    let when = beepAnchor.ctxNow + (beatTick - beepAnchor.tick) / (tr * beepAnchor.speed);
    // A re-anchor can leave `when` a hair in the past (drift is bounded
    // by BEEP_DRIFT_S) — a beep never starts before now.
    if (when < ctx.currentTime) when = ctx.currentTime;
    spawnSource(buf, 'c4', when, beepLive, BEEP_TRACK_CAP);
  }

  function updateC4Beeps(st, jump, running) {
    if (destroyed || !ctx) return;
    const bomb = running ? c4BombAt(bombRows, st.tick, tr) : null;
    if (!st.playing || !bomb) {
      // Pause, a suspended context or no ticking bomb (not planted yet,
      // defused, round over): silence the queued beeps and re-arm from
      // scratch when playback finds the bomb again.
      cancelQueuedBeeps();
      beepBombKey = '';
      beepAnchor = null;
      return;
    }
    const key = `${bomb.plant.tick}|${bomb.stop}|${bomb.fuseEnd}|${bomb.site}`;
    if (key !== beepBombKey || !beepAnchor) {
      armC4Beeps(bomb, st);
    } else if (jump || st.speed !== beepAnchor.speed || c4BeepDrift(st) > BEEP_DRIFT_S) {
      reseedC4Beeps(st);
    }
    const horizon = st.tick + BEEP_LOOKAHEAD * tr * st.speed;
    while (beepCursor < beepTicks.length && beepTicks[beepCursor] <= horizon) {
      scheduleC4Beep(beepTicks[beepCursor], bomb);
      beepCursor++;
    }
  }

  function onEngineChange(st) {
    if (destroyed) return;
    // Silent resume retry when playback (re)starts: the platform may
    // grant the context by now — never a hint, never an error (a
    // rejected resume surfaces through attemptResume).
    if (st.playing && !lastPlaying) attemptResume();
    lastPlaying = st.playing;
    const jump = cueGapJump(st.tick, prevTick, st.speed, tr);
    const running = !!ctx && ctx.state === 'running';
    updateC4Beeps(st, jump, running);
    if (st.playing && running && !jump) {
      playUtilInRange(prevTick, st.tick);
      playThrowInRange(prevTick, st.tick);
      playKnifeInRange(prevTick, st.tick);
      playBulletsInRange(prevTick, st.tick);
      playDecoyInRange(prevTick, st.tick);
      playActionInRange(prevTick, st.tick);
      playAnnouncerInRange(prevTick, st.tick);
    }
    // EVERY path advances the compare point: a seek, a loop wrap or a
    // paused scrub must not machine-gun the cues it crossed when
    // playback (or the context) comes back.
    prevTick = st.tick;
  }

  // rebuildCues re-derives the landmark cue lists (detonations, throws,
  // knife, the announcer lines) and the C4 beep scheduler's bomb rows
  // from the rows last pushed — called by setLandmarks and setRounds
  // (either input may arrive second; the freeze gate and the
  // match-point scoreline both need the pair). The decoy plan is NOT
  // rebuilt here: it arrives pre-derived through setDecoyPlan
  // (lib/replay/decoy.js).
  function rebuildCues() {
    utilCues = grenadeCues(landmarkRows, rounds);
    throwHits = throwCues(landmarkRows, rounds);
    knifeHits = knifeCues(landmarkRows, rounds);
    actionCues = bombActionCues(landmarkRows, rounds);
    // The announcer list merges the three voice-line builders, bomb lines
    // FIRST so a same-tick `bombdef`/`ctwin` pair iterates in the
    // owner-observed order (announcerOrder then adds the explicit delay
    // to the win line); matchPointCues rides last (its freeze-start tick
    // marks the next round's start, and it has no ordering rule of its
    // own). One tick-sorted list → the ONE window selector
    // (utilCuesInRange) serves it like every other cue list.
    announcerCues = [
      ...bombAnnouncerCues(landmarkRows, rounds),
      ...roundEndCues(landmarkRows, rounds),
      ...matchPointCues(landmarkRows, rounds),
    ].sort((a, b) => a.tick - b.tick);
    bombRows = c4BeepRows(landmarkRows);
  }

  return {
    get state() {
      return {
        ready: total > 0 && loaded >= total && buffers.size > 0,
        total,
        error,
      };
    },
    // setLandmarks pushes the Replay's drawNorm rows (pre-bucketed by
    // landmarks.js); repeats are tolerated — the cue list is rebuilt
    // from scratch each call.
    setLandmarks(rows) {
      landmarkRows = rows || [];
      rebuildCues();
    },
    // setRounds hands over GetRounds' rows — the freeze gate the util
    // and knife cue lists are built under (rounds.js inFreezeTime;
    // bullets are freeze-filtered upstream in bullets.js) and the
    // scoreline the match-point cue derives its clinch decision from
    // (silence until this arrives).
    setRounds(rs) {
      rounds = rs || null;
      rebuildCues();
    },
    // setBullets pushes the bullets.js rows (deriveBullets — globally
    // tick-sorted, guns-only, freeze-filtered; see bullets.js). Tolerates
    // a repeat push; compare points are engine-side and unaffected.
    setBullets(rows) {
      bullets = rows || [];
    },
    // setDecoyPlan pushes the decoy plan (lib/replay/decoy.js
    // buildDecoyPlan — {landTick, detTick, weapon, shots:[{tick}]} rows,
    // the SAME plan the renderer draws its rest icon + noise pulses
    // from). Flattened once into the fake-gunshot cue list; tolerates a
    // repeat push exactly like setBullets.
    setDecoyPlan(plan) {
      decoyShots = decoyCues(plan);
    },
    // playGroup is exported on the engine for one-off cues (and tests).
    playGroup,
    setVolume(v) {
      gunVol = Math.max(0, Math.min(1, Number(v) || 0));
      applyGains();
    },
    setUtilityVolume(v) {
      utilVol = Math.max(0, Math.min(1, Number(v) || 0));
      applyGains();
    },
    // setC4Volume — the C4 fader (beeps + the explosion), the same
    // 0..1 coercion as the other two sfx faders.
    setC4Volume(v) {
      c4Vol = Math.max(0, Math.min(1, Number(v) || 0));
      applyGains();
    },
    // setAnnouncerVolume — the announcer fader (the round/bomb voice
    // lines), the same 0..1 coercion as the other sfx faders.
    setAnnouncerVolume(v) {
      annVol = Math.max(0, Math.min(1, Number(v) || 0));
      applyGains();
    },
    // setMuted(bucket, m) — 'guns' | 'utility' | 'c4' | 'announcer';
    // session-only (the
    // popover's toggles are not persisted, unlike the faders). An
    // unknown bucket is ignored on purpose — it never silently mutes a
    // different bus.
    setMuted(bucket, m) {
      if (bucket === 'guns') gunMuted = !!m;
      else if (bucket === 'utility') utilMuted = !!m;
      else if (bucket === 'c4') c4Muted = !!m;
      else if (bucket === 'announcer') annMuted = !!m;
      applyGains();
    },
    destroy() {
      destroyed = true;
      clearRetry(); // never leak the parked retry listeners
      offChange();
      // Every tracked source, cue and QUEUED beep alike — a scheduled
      // beep must not outlive its engine.
      for (const entry of live.splice(0).concat(beepLive.splice(0))) {
        stopSourceEntry(entry);
      }
      const c = ctx;
      ctx = null;
      if (c) {
        try {
          c.close();
        } catch {
          /* already closed */
        }
      }
    },
  };
}

// The fail-soft empty manifest — frozen so callers can share it safely.
const EMPTY_MANIFEST = Object.freeze({
  extracted: false,
  count: 0,
  sounds: Object.freeze({}),
  note: '',
});

// Session memo: one fetch per page load; resetSoundManifest() drops it
// (the services.extractSounds wrapper does this after a successful
// extraction). Mirrors icons.js's loadIconManifest.
let manifestPromise = null;

// normalizeManifest is the fail-soft boundary: any input (null, a 404
// body, a malformed payload) becomes a well-formed manifest with the same
// three keys, so callers never shape-check. Only string→string[] entries
// survive; count is recomputed so count === sounds size.
export function normalizeSoundManifest(raw) {
  if (raw == null || typeof raw !== 'object') return EMPTY_MANIFEST;
  const sounds = {};
  if (raw.sounds != null && typeof raw.sounds === 'object') {
    for (const [name, urls] of Object.entries(raw.sounds)) {
      if (typeof name !== 'string' || !Array.isArray(urls)) continue;
      const list = urls.filter((u) => typeof u === 'string' && u !== '');
      if (list.length > 0) sounds[name] = list;
    }
  }
  if (Object.keys(sounds).length === 0) return EMPTY_MANIFEST;
  return Object.freeze({
    extracted: raw.extracted !== false,
    count: Object.keys(sounds).length,
    sounds: Object.freeze(sounds),
    note: typeof raw.note === 'string' ? raw.note : '',
  });
}

// loadSoundManifest fetches /api/sounds/manifest.json once per session.
// Resolves to a normalized manifest on every path: 404/network failure →
// the empty manifest (extracted:false) — the caller then skips sound
// playback entirely. Failures are NOT memoized (the next call retries);
// a successful body stays memoized until resetSoundManifest().
export function loadSoundManifest() {
  if (!manifestPromise) {
    const p = fetch('/api/sounds/manifest.json', { cache: 'no-store' })
      .then((res) =>
        res && res.ok
          ? res.json().then(normalizeSoundManifest)
          : Promise.reject(new Error('sound manifest unavailable')),
      )
      .catch(() => {
        // Fail-soft for THIS caller (resolves to the empty manifest) but
        // re-arm the memo so the next call refetches — re-arm only if
        // the memo still points at us (resetSoundManifest may have won).
        if (manifestPromise === p) manifestPromise = null;
        return EMPTY_MANIFEST;
      });
    manifestPromise = p;
  }
  return manifestPromise;
}

// resetSoundManifest drops the session memo so the next
// loadSoundManifest refetches — call it after SoundService.ExtractSounds
// (services.js's extractSounds() wrapper already does).
export function resetSoundManifest() {
  manifestPromise = null;
}
