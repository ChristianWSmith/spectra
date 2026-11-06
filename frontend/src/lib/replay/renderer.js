// M2 replay renderer: layered Canvas 2D draw over the engine's typed arrays.
//
// Layers, bottom → top: radar (or world grid) → movement trails → grenade
// landmarks (lingering smoke/fire areas → utility flight with the
// extracted icon → per-type detonation pops) → death markers (the victim's
// team-color X, until the round ends) → bomb (pulse ring + the extracted
// C4 icon — the dropped/planted C4 renders ABOVE the death markers, so an
// X can never overlap it) → players (view chevron, body, player-color rim,
// white talking bloom, flash-white overlay, muzzle line, damage flash,
// follow ring, name) → HUD + kill feed.
// The camera is a pan/zoom view over the radar's image-pixel space with
// two modes: 'smart' (the default — eased
// fit that keeps every alive player + the active bomb on screen; see
// smartCamTarget/stepSmart below) and 'free' (manual pan/zoom); world→image
// uses the map pack's transform — the canonical pack→transform reader is
// makeTransform (lib/components/mapxform.js, shared with HeatmapLayer):
// px=(wx-pos_x)/scale, py=(pos_y-wy)/scale (Z-up world, inverted Y).
// With no transform (missing pack) one is derived from sample extents so
// a blank coordinate grid still frames the players.
import { makeTransform } from '../components/mapxform.js';
// (bucketing/classification lives in ./landmarks.js — rows arrive
// pre-bucketed from normalizeEvent; see setLandmarks.)
import { detonationStyleOf, sameUtilityWeapon } from './landmarks.js';
import { slotStateAt } from './state.js';
import { bombEndTick, bombEvidenceAt, hasBombPos } from './bomb.js';

const CT_COLOR = '#5aa9e6';
const T_COLOR = '#e6a35a';
const OTHER_COLOR = '#9aa4b5';
const TRAIL_FRAMES = 192; // ~3 s at 64 Hz
// Trail continuity: a trail segment is only drawn between two ADJACENT
// frames that are continuous — a bounded tick gap AND a bounded step.
// Round resets and death→respawns teleport a player across the map
// between two otherwise-alive frames; without this rule the polyline
// connects through the teleport and draws one long streaking line from
// the old position back to spawn. The sidecar samples 1:1 with demo
// frames, so a normal gap is ~1 tick and a normal step is a few units.
const TRAIL_MAX_TICK_GAP = 8; // ticks — anything larger is a discontinuity
const TRAIL_MAX_STEP2 = 256 * 256; // world units² — human movement is ~8/frame
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 8;
// --- Smart camera (the DEFAULT mode) -----------------------------------------
// Keeps every alive player + the active bomb on screen at all times,
// easing toward a fitted target each frame (never snapping).
const SMART_MARGIN = 56; // CSS px of breathing room around the entities
const SMART_TAU_CENTER = 0.18; // s — center ease time constant
const SMART_TAU_ZOOM = 0.26; // s — zoom ease (slower = calmer)
const SMART_DT_CLAMP = 0.033; // s — max eased step per draw: after a
//                             stall/seek the first frame glides (~17%)
//                             instead of lurching toward the target
const SMART_ZOOM_MIN = 0.08; // floor — a full-map spread must still fit;
//                            // deliberately BELOW ZOOM_MIN (the manual
//                            // zoom floor): on-screen beats tight here
const SMART_ZOOM_MAX = 4; // cap — never tunnel-vision tighter than ~1/4 map
const SMART_EPS_CENTER = 0.25; // img px — "converged" for the settle loop
const SMART_EPS_ZOOM = 0.002; // relative zoom tolerance
const SMOKE_LIFETIME_S = 18;
const FIRE_LIFETIME_S = 7;
const FIRE_RADIUS = 130; // world units
const SMOKE_RADIUS = 144;
// --- World-layer effect windows (all TICK-derived — seek-correct) -----------
const FIRE_FLASH_S = 0.22; // muzzle-flash window after an attack bit edge
const DAMAGE_FLASH_S = 0.35; // victim-hit flash window after a damage event
// Talking bloom (voiceBloom): a white ring expanding OUTWARD FROM THE
// DOT'S CENTER and fading, looping while the player speaks — the
// flashbang-detonation style, anchored at the dot. All tick-derived.
const VOICE_BLOOM_PERIOD_S = 0.85; // s — one bloom loop (pure tick math)
const VOICE_BLOOM_MIN_R = 3; // px — the ring's start radius (inside the dot)
const VOICE_BLOOM_MAX_R = 14; // px — growth past the dot edge (→ r + 14)
const VOICE_BLOOM_MAX_A = 0.9; // the bloom's start alpha (fades to 0)
const BLIND_SOLID_FRACTION = 0.25; // share of a blind's window the dot
//                                  stays SOLID white before it fades
//                                  back to its team color
const DEATH_X_HALF = 7; // px — half-diagonal of a death marker
const BOMB_ICON_PX = 12; // px — the extracted C4 icon's screen size
const NADE_ICON_PX = 16; // px — the extracted utility icon's screen size
const KILL_MARKER_FALLBACK_S = 180; // s — death-X cleanup when the round's
//                                    round_end row was never loaded
//                                    (longer than any round: it can
//                                    never cut a live round short)
// --- Kill feed (drawKillFeed — the top-right overlay) ------------------------
const KILL_FEED_MAX = 6; // entries shown, newest on top
const KILL_FEED_LH = 18; // px per entry line (the box's HEIGHT)
const KILL_FEED_PITCH = 22; // px between entry TOPS: the 18 px box + a
//                            4 px gap — entries must not stack touching
const KILL_FEED_EDGE = 8; // px from the stage's top/right edge
const KILL_FEED_INSET = 6; // px of padding inside an entry
const KILL_FEED_GAP = 12; // px of breathing room between a name and the
//                        weapon mark (image or →) on EACH side — 8 px
//                        still read as the mark hugging the names, so
//                        the mark got its own beat on both sides
const KILL_FEED_ICON = 14; // px — the weapon image's size on a line
const KILL_FEED_R = 4; // px — entry corner radius (hudBox uses 6)

function teamColor(side) {
  if (side === 'ct') return CT_COLOR;
  if (side === 't') return T_COLOR;
  return OTHER_COLOR;
}

// sideFromFlags — THE canonical per-frame side rule:
// the q16-v2 side bits (flags bits 2-3: 1 = t, 2 = ct) with a
// caller-supplied fallback for frames whose bits are 0 — a dead player's
// frame or an unassigned team, where the slot's final side
// (meta.players[].side) is all the data there is. Exported so Replay's
// player-card columns resolve the SAME side at the playhead:
// createRenderer's sideAtFrame and the Replay columns both go through
// it — there is no second copy of the bit arithmetic anywhere.
export function sideFromFlags(flagsByte, finalSide = '') {
  const b = (flagsByte >> 2) & 3;
  return (b === 1 ? 't' : b === 2 ? 'ct' : '') || finalSide || '';
}

function hasPos(l) {
  return l && Number.isFinite(l.x) && Number.isFinite(l.y);
}

// trailConnects — the pure continuity rule drawTrails applies per segment:
// does the trail draw between frame f and f+1 of one slot? `ticks` is the
// store's tick array, `pos` that slot's interleaved Float32Array
// [x, y, z, yaw] per frame. False breaks the polyline here (teleport /
// stalled sampling); the chain restarts at the next segment, so trails
// across a round reset or a death→respawn never connect — the first
// post-respawn segments start fresh at spawn. Exported for the headless
// test in src/lib/renderer.test.js.
export function trailConnects(ticks, pos, f) {
  if (f < 0 || f + 1 >= ticks.length) return false;
  const gap = ticks[f + 1] - ticks[f];
  if (gap <= 0 || gap > TRAIL_MAX_TICK_GAP) return false;
  const b = f * 4;
  const pb = (f + 1) * 4;
  const dx = pos[b] - pos[pb];
  const dy = pos[b + 1] - pos[pb + 1];
  return dx * dx + dy * dy <= TRAIL_MAX_STEP2;
}

// smartCamTarget — the smart camera's FIT algorithm (pure; head-tested
// in renderer.test.js). `box` is the entity bounding box in IMAGE px,
// cssW/cssH the canvas size, cfg { margin, minZoom, maxZoom, extW, extH }.
// Returns the target camera state { cx, cy, s } where s is the ABSOLUTE
// scale (screen px per image px = cam.fit * cam.zoom): the box is padded
// by `margin` on every side and scaled to fit the canvas (clamped to the
// smart zoom band), then the center is clamped so a view that FITS
// INSIDE the image extent never shows void outside it — a view wider
// than the image centers on the image instead (the entities are inside
// the image either way, so they stay on screen).
export function smartCamTarget(box, cssW, cssH, cfg = {}) {
  const margin = cfg.margin ?? SMART_MARGIN;
  const minS = cfg.minZoom ?? SMART_ZOOM_MIN;
  const maxS = cfg.maxZoom ?? SMART_ZOOM_MAX;
  const w = Math.max(1e-6, box.maxX - box.minX);
  const h = Math.max(1e-6, box.maxY - box.minY);
  const availW = Math.max(1, cssW - 2 * margin);
  const availH = Math.max(1, cssH - 2 * margin);
  const s = Math.min(maxS, Math.max(minS, Math.min(availW / w, availH / h)));
  let cx = (box.minX + box.maxX) / 2;
  let cy = (box.minY + box.maxY) / 2;
  const halfW = cssW / (2 * s);
  const halfH = cssH / (2 * s);
  if (Number.isFinite(cfg.extW)) {
    cx = 2 * halfW <= cfg.extW ? Math.min(Math.max(cx, halfW), cfg.extW - halfW) : cfg.extW / 2;
  }
  if (Number.isFinite(cfg.extH)) {
    cy = 2 * halfH <= cfg.extH ? Math.min(Math.max(cy, halfH), cfg.extH - halfH) : cfg.extH / 2;
  }
  return { cx, cy, s };
}

// easeValue — one exponential-approach step toward target: the smoothing
// that keeps smart pan/zoom from ever snapping (the caller clamps dt).
export function easeValue(cur, target, dt, tau) {
  if (!(dt > 0) || !(tau > 0)) return cur;
  const k = 1 - Math.exp(-dt / tau);
  return cur + (target - cur) * k;
}

// camConverged — has the eased camera reached its target within the
// center/zoom tolerances? Drives the renderer's settle loop (the ease
// keeps running after a paused seek, where nothing else redraws).
export function camConverged(cur, target) {
  return (
    Math.abs(cur.cx - target.cx) < SMART_EPS_CENTER &&
    Math.abs(cur.cy - target.cy) < SMART_EPS_CENTER &&
    Math.abs(cur.s - target.s) <= SMART_EPS_ZOOM * Math.max(target.s, 1e-9)
  );
}

// chevronPath — the view-direction CHEVRON (spec 27): an open ">" of
// two arms meeting at the apex pointing along `angleRad` (screen
// radians — the engine yaw convention, -yaw), from the dot's center
// outward — NO shaft, unlike the old filled arrowPath it replaces.
// `size` is the apex distance from (cx, cy) in SCREEN px (callers scale
// it with the dot radius so it stays legible at any camera zoom).
// Returns 3 [x, y] points, apex in the middle: arm-end-left → APEX →
// arm-end-right — stroked (never filled) by drawPlayers. Pure — head-
// tested in src/lib/renderer.test.js; drawn by drawPlayers.
export function chevronPath(cx, cy, angleRad, size) {
  const s = Math.max(0, Number(size) || 0);
  const back = s * 0.4; // how far the arm ends sit back from the apex
  const spread = s * 0.5; // their perpendicular half-spread
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  // local frame: +x along the look direction, +y to its right
  const local = [
    [s - back, -spread],
    [s, 0],
    [s - back, spread],
  ];
  return local.map(([lx, ly]) => [cx + lx * cos - ly * sin, cy + lx * sin + ly * cos]);
}

// crossPath — a death marker's X (spec 28): two segments of half-length
// `half` (screen px) crossing at (cx, cy), drawn in the victim's team
// color by drawDeaths. Pure — head-tested in src/lib/renderer.test.js.
export function crossPath(cx, cy, half) {
  const h = Math.max(0, Number(half) || 0);
  return [
    [cx - h, cy - h, cx + h, cy + h],
    [cx - h, cy + h, cx + h, cy - h],
  ];
}

// muzzleRays — the firing burst (spec 24): `count` short radial ticks
// fanned ±`spreadRad` around the look direction, each from `inner` to
// `outer` screen px out from the dot's center (outer > inner; a
// degenerate size yields no rays). Returns count [x1, y1, x2, y2]
// segments. Pure — head-tested in src/lib/renderer.test.js; drawn by
// drawPlayers with a windowAlpha-driven alpha, as ONE straight line
// (count=1, spread=0 — a single ray along the aim direction).
export function muzzleRays(cx, cy, angleRad, inner, outer, count = 5, spreadRad = 0.7) {
  const n = Math.max(0, Math.floor(count));
  const out = [];
  if (!(outer > inner) || n === 0) return out;
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const a = angleRad + (t * 2 - 1) * spreadRad;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    out.push([cx + inner * ca, cy + inner * sa, cx + outer * ca, cy + outer * sa]);
  }
  return out;
}

// windowAlpha — THE tick-window envelope for the map's momentary
// effects (damage flash, muzzle flash): 1 at the event's tick, linear
// decay to 0 at `durS` seconds of DEMO time, 0 outside the window
// (before the event — a scrub past it — and after it). Pure, tick-only:
// seek-correct by construction and self-clearing (nothing to reset).
// `tickRate <= 0` or a non-finite start yields 0 (never a stuck flash).
export function windowAlpha(tick, startTick, tickRate, durS) {
  if (!Number.isFinite(tick) || !Number.isFinite(startTick)) return 0;
  if (!(tickRate > 0) || !(durS > 0)) return 0;
  const age = (tick - startTick) / tickRate;
  if (age < 0 || age >= durS) return 0;
  return 1 - age / durS;
}

// blindAlpha — THE flash-white envelope for a blinded player's dot: 1
// (solid white over the team color) for the first BLIND_SOLID_FRACTION
// of the blind's `ms` window, then a linear fade back to the normal
// color until the window closes. Pure and tick-derived exactly like
// windowAlpha — seek-correct in both directions (scrubbing backwards
// into the window re-renders the same overlay, nothing is sticky).
// `tickRate <= 0`, a non-finite start or a non-positive ms → 0.
export function blindAlpha(tick, startTick, tickRate, ms) {
  if (!Number.isFinite(tick) || !Number.isFinite(startTick)) return 0;
  if (!(tickRate > 0) || !(ms > 0)) return 0;
  const ageMs = ((tick - startTick) / tickRate) * 1000;
  if (ageMs < 0 || ageMs >= ms) return 0;
  const k = ageMs / ms;
  if (k <= BLIND_SOLID_FRACTION) return 1;
  return 1 - (k - BLIND_SOLID_FRACTION) / (1 - BLIND_SOLID_FRACTION);
}

// voiceBloom — THE talking indicator: a WHITE bloom expanding outward
// FROM THE DOT'S CENTER and fading, looping for as long as the player
// speaks — the flashbang-detonation style (drawGrenades' expanding
// stroked ring + fading core) anchored at the dot. Pure tick math, like
// the voicePulseAlpha sine it replaces: phase = ((tick/tr) mod P)/P, so
// a scrub lands on the same expansion and nothing depends on wall-clock
// time. Returns { k, radius, alpha } — k the loop progress in [0, 1)
// (the caller shrinks the stroke with it), radius in screen px growing
// VOICE_BLOOM_MIN_R → dotR + VOICE_BLOOM_MAX_R, alpha fading
// VOICE_BLOOM_MAX_A → 0 — or null on bad input (a broken clock never
// draws). Pure — head-tested in src/lib/renderer.test.js; drawn by
// drawPlayers while voiceSpeaking says this slot talks.
export function voiceBloom(tick, tickRate, dotR) {
  if (!Number.isFinite(tick) || !(tickRate > 0)) return null;
  if (!Number.isFinite(dotR) || !(dotR > 0)) return null;
  const period = VOICE_BLOOM_PERIOD_S;
  const secs = tick / tickRate;
  const raw = secs % period; // in (-P, P)
  const phase = raw < 0 ? raw + period : raw; // in [0, P)
  const k = phase / period;
  return {
    k,
    radius: VOICE_BLOOM_MIN_R + k * (dotR + VOICE_BLOOM_MAX_R - VOICE_BLOOM_MIN_R),
    alpha: VOICE_BLOOM_MAX_A * (1 - k),
  };
}

// fireJump — the seek/frame-jump detector for the firing edge state
// (spec 24): true when the playhead moved somewhere the previous attack
// bit cannot be compared across, so the per-slot edge state must RE-SEED
// instead of flashing (a scrub must never leave a stuck muzzle flash).
//   - first draw (lastTick null/NaN) → seed;
//   - backwards (loop restart, reverse scrub) → seed;
//   - the same tick (a paused redraw / double draw) → NOT a jump: the
//     flash freezes at its current age instead of flickering off;
//   - forward by more than one normal playback step (with slack for the
//     engine's 0.25 s dt clamp at `speed`×) → seed; ordinary playback
//     advances `speed * tickRate` ticks per second, far below that.
// Pure — head-tested in src/lib/renderer.test.js.
export function fireJump(tick, lastTick, speed, tickRate) {
  if (!Number.isFinite(tick) || !Number.isFinite(lastTick)) return true;
  const gap = tick - lastTick;
  if (gap < 0) return true;
  if (gap === 0) return false;
  const tr = Number.isFinite(tickRate) && tickRate > 0 ? tickRate : 64;
  const sp = Number.isFinite(speed) && speed > 0 ? speed : 1;
  const limit = sp * tr * 0.3 + TRAIL_MAX_TICK_GAP;
  return gap > limit;
}

// killEndTick — the death-marker lifetime (spec 28): the bomb.js
// bombEndTick rule over `roundEnds` (bucket 'round') and `roundStarts`
// (bucket 'start') rows — an X drawn for a kill in round N stays while
// the playhead is inside round N and clears at the EARLIER of that
// round's FIRST round_end at/after the kill and the NEXT round's first
// round_start after it (a pure function of tick, so scrubbing backwards
// into round N shows it again — nothing sticky). The round_start
// terminator matters for kills stamped round N that land AFTER round
// N's round_end (the C4-detonation kill: round 2's round_end at 14930,
// the kill at 14963) — without it the X would survive on its own round's
// end alone into the next round. Terminators from before the kill are
// ignored; with NEITHER a same-round round_end nor a later round_start
// in the loaded rows (the truncated final round) the fallback —
// deliberately LONGER than any round — keeps the marker from outliving
// the demo without ever cutting a live round short. Pure — head-tested
// in src/lib/renderer.test.js; drawn by drawDeaths.
export function killEndTick(row, tickRate, roundEnds, roundStarts) {
  if (!row || !Number.isFinite(row.tick)) return 0;
  const tr = tickRate > 0 ? tickRate : 64;
  let end = null;
  for (const e of roundEnds || []) {
    if (e && e.round === row.round && e.tick >= row.tick && (end === null || e.tick < end)) {
      end = e.tick;
    }
  }
  let next = null;
  for (const s of roundStarts || []) {
    if (s && Number.isFinite(s.tick) && s.tick > row.tick && (next === null || s.tick < next)) {
      next = s.tick;
    }
  }
  if (end !== null) return next !== null ? Math.min(end, next) : end;
  return next !== null ? next : row.tick + KILL_MARKER_FALLBACK_S * tr;
}

// --- Top-box HUD layout (pure) -----------------------------------------------
//
// The top-center box's SCORE line is laid out around the SCORE segment,
// not around the block: with unequal team names the old block centering
// pushed '‹ct› – ‹t›' off the box's center. The score segment sits
// dead-center of the box, the longer-name side defines the box's extent
// on its side, and the shorter side absorbs the slack as padding — the
// names stay ADJACENT to the score (never stretched apart). Pure with
// injected widths — the test harness's measureText is a flat 40 px, so
// the unequal-name case is pinned here (renderer.test.js). The clock
// line keeps the plain block centering (hudBox's default).

// scoreLineWidth — the score line's CONTENT width for the box: twice the
// longer name (both sides must reach from the centered score to the box
// edge with the shorter side padding) plus the score segment. Equal to
// the plain sum only when the names match; wider otherwise, which is the
// point — the box grows toward the longer name instead of letting the
// score drift.
export function scoreLineWidth(leftW, scoreW, rightW) {
  return 2 * Math.max(leftW, rightW) + scoreW;
}

// scoreLineLayout — the score line's segment x positions in a box whose
// center is at boxCenterX: the score starts at center − scoreW/2 (its
// midpoint lands exactly on the center) and each name hugs the score.
export function scoreLineLayout(leftW, scoreW, rightW, boxCenterX) {
  const scoreX = boxCenterX - scoreW / 2;
  return { leftX: scoreX - leftW, scoreX, rightX: scoreX + scoreW };
}

// hudTeamNames — the setHud teamNames PAIRING (exported for tests; the
// only caller is Replay's hudFor — the dom harness stubs setHud and never
// reaches it). getTeamNames returns the teams keyed by their FINAL side
// (the extract's end-of-demo snapshot; teams.name is keyed by final side
// — see lib/teams.js), but the HUD colors its slots by the side each team
// is on AT THE PLAYHEAD, which flips at halftime. Given the two card
// columns' current sides (Replay's columnSideAt at uiFrame: the left
// column is the team that FINISHED ct), return {ct, t} with the team
// currently on CT in the ct slot — so the renderer's per-slot CT/T colors
// are trivially correct. Unknown sides ('') keep the stored pairing: no
// side information, no guessed swap. Empty names stay empty (drawHUD
// falls back to the bare CT / T).
export function hudTeamNames(names, leftSide, rightSide) {
  const left = (names && names.ct) || '';
  const right = (names && names.t) || '';
  // the finished-ct team is on T now when its own column says so, or when
  // only the OTHER column carries a side (two teams: right ct ⇒ left t)
  const leftOnT = leftSide === 't' || rightSide === 'ct';
  return leftOnT ? { ct: right, t: left } : { ct: left, t: right };
}

export function createRenderer(canvas, { engine, data, players, onUserCamera = null }) {
  const ctx = canvas.getContext('2d');
  let dpr = 1;
  let cssW = 0;
  let cssH = 0;

  let store = data; // parsed positions
  let slotSides = (players || []).map((p) => p.side);
  let slotNames = (players || []).map((p) => p.name || '');
  let pack = null; // map pack meta.json or null
  let packTf = null; // makeTransform(meta) output — the canonical
  //                    pack→{posX,posY,scale,width,height} derivation
  let radar = null; // Image, when the pack ships one
  let landmarks = [];
  let polylines = []; // grenade throw→detonate pairs
  let dets = []; // grenade detonations
  let smokes = [];
  let fires = [];
  let plants = [];
  let explodes = [];
  let defuses = [];
  let drops = []; // bomb_drop evidence rows (carrier position — bomb.js)
  let pickups = []; // bomb_pickup evidence rows
  let roundEnds = []; // round_end rows — the round-end bomb terminator
  // round_start rows (bucket 'start') — the death-X NEXT-round
  // terminator killEndTick reads (never drawn as a world marker).
  let roundStarts = [];
  // The dropped-C4 evidence bundle consumed by bomb.js bombEvidenceAt
  // (the smart camera's bomb point and drawBomb's dropped marker).
  let bombEv = { drops: [], pickups: [], plants: [], roundEnds: [] };
  let packNote = ''; // HUD hint (missing radar / missing pack)

  // --- setIcons / setVoices / setStateIndex inputs (all optional) -----------
  // icons: canonical equipment name ('C4', 'Smoke Grenade', …) → a
  // preloaded HTMLImageElement (or null when the pipeline has none for
  // that name). Absent/null ALWAYS falls back to the text/vector drawing —
  // never an error, never a fetch (the icon pipeline owns loading).
  let icons = Object.create(null);
  // voiceColors: slot → the assigned voice color ('' / null = none: the
  // dot keeps its plain white rim). voiceSpeaking: (slot, tick) =>
  // boolean|null — null when the match has no voice. Both come from
  // setVoices; both are read as pure functions of tick (seek-safe).
  let voiceColors = [];
  let voiceSpeaking = null;
  // stateIndex: lib/replay/state.js buildStateIndex output (or null — an
  // older import with no state stream: the firing animation degrades to
  // nothing). Consumed through slotStateAt in stepFiring.
  let stateIndex = null;
  // Deaths (bucket 'kill') and damage ticks grouped by VICTIM slot —
  // both rebuilt by setLandmarks, both rendered as pure functions of
  // tick (see drawDeaths / drawPlayers' hit flash).
  let kills = [];
  let damages = []; // damages[slot] = [tick, …]
  // Flash-white overlay (setBlinds): blinds[slot] = [{tick, ms}] — the
  // blind windows bucketed per victim slot, like `damages`. Rebuilt by
  // setBlinds, rendered as a pure function of tick (drawPlayers' white
  // overlay via blindAlpha), so any scrub is correct.
  let blinds = [];
  // steamId → slot, from the sidecar slot table (meta.players, slot
  // order) — resolves a kill/damage row's victim to the dot it marks.
  const slotOfSteam = new Map();
  (players || []).forEach((p, i) => {
    if (p && p.steamId) slotOfSteam.set(String(p.steamId), i);
  });
  // Firing edge state (spec 24): the previous attack bit per slot, the
  // tick of the last rising edge, and the tick of the previous draw
  // (fireJump's comparison point). Re-seeded on every seek/jump.
  let fireEdge = [];
  let fireAt = [];
  let lastFireTick = null;
  // Offscreen tint cache for the equipment icons (draw → 'source-in'
  // fill), keyed color|size|source — a handful of entries, rebuilt only
  // when the icon map changes, never per frame.
  const tintCache = new Map();

  // Camera: center of view in image-pixel space + zoom multiplier over the
  // fit scale (which is recomputed on resize).
  const cam = { cx: 0, cy: 0, zoom: 1, fit: 1 };
  // Follow camera: last ALIVE world position of the followed slot (the
  // camera holds it while they are dead — see draw()).
  let followFor = -1;
  let followX = null;
  let followY = null;
  // Camera mode: 'smart' (the default — eases the view to keep every
  // alive player + the active bomb framed) or 'free' (manual pan/zoom).
  // Follow overrides both (explicit user intent) and smart resumes when
  // follow releases. Panning/zooming while smart takes over to free and
  // notifies the caller (onUserCamera) so its selector follows — the
  // pref keeps whatever the user picked there explicitly.
  let camMode = 'free';
  let easeRaf = 0; // the smart settle loop's pending frame (0 = idle)
  let lastEaseT = 0; // last eased draw, for the dt of the next step
  let smartConverged = true;
  // Effective world→image transform + image extent, rebuilt by reproject()
  // from packTf (makeTransform's canonical derivation) or sample bounds.
  // The numeric fields — not an allocating toImage() call — keep the
  // per-frame paths (drawTrails) allocation-free.
  const tf = { pos_x: 0, pos_y: 0, scale: 1 };
  let extW = 1024;
  let extH = 1024;

  const tmp = {};

  function worldToImage(wx, wy, out) {
    out.x = (wx - tf.pos_x) / tf.scale;
    out.y = (tf.pos_y - wy) / tf.scale;
    return out;
  }

  const imgPt = { x: 0, y: 0 };
  function worldToScreen(wx, wy) {
    worldToImage(wx, wy, imgPt);
    const s = cam.fit * cam.zoom;
    return { x: cssW / 2 + (imgPt.x - cam.cx) * s, y: cssH / 2 + (imgPt.y - cam.cy) * s };
  }

  function screenToImage(sx, sy) {
    const s = cam.fit * cam.zoom;
    imgPt.x = cam.cx + (sx - cssW / 2) / s;
    imgPt.y = cam.cy + (sy - cssH / 2) / s;
    return imgPt;
  }

  // reproject derives the effective transform + extent from whatever we have:
  // the pack transform (via makeTransform — packTf) ± radar size, else
  // sample bounds (the no-pack fallback stays renderer-only).
  function reproject() {
    const b = store ? store.bounds : { minX: 0, maxX: 1024, minY: 0, maxY: 1024 };
    const spanX = Math.max(1, b.maxX - b.minX);
    const spanY = Math.max(1, b.maxY - b.minY);
    if (packTf && Number.isFinite(packTf.posX)) {
      tf.pos_x = packTf.posX;
      tf.pos_y = packTf.posY;
      // makeTransform copies scale verbatim; keep the renderer's
      // degenerate-scale guard (0/negative would divide to NaN/infinity).
      tf.scale = packTf.scale > 0 ? packTf.scale : 1;
      extW = packTf.width;
      extH = packTf.height;
      if (radar) packNote = '';
      else packNote = 'map pack has no radar image — grid only';
    } else {
      // Blank coordinate grid: invent an image space from sample extents.
      const scale = Math.max(spanX, spanY) / 900;
      tf.pos_x = b.minX - spanX * 0.05;
      tf.pos_y = b.maxY + spanY * 0.05;
      tf.scale = scale > 0 ? scale : 1;
      extW = Math.max(64, (spanX * 1.1) / tf.scale);
      extH = Math.max(64, (spanY * 1.1) / tf.scale);
      packNote = pack
        ? 'map pack missing radar — world-coordinate grid'
        : 'map pack missing — world-coordinate grid (transform unknown)';
    }
  }

  function fit() {
    reproject();
    cam.zoom = 1;
    cam.cx = extW / 2;
    cam.cy = extH / 2;
    // cam.fit is the canvas→image scale, i.e. what "1× zoom" MEANS:
    // the largest scale at which the whole image still fits the canvas.
    // Without it, 1× was one screen px per image px — on a stage smaller
    // than the 1024 px radar (the player-card columns now take that
    // space) free mode opened on a centre crop and the off-screen cull
    // dropped every player outside the slice, so the map looked empty.
    // Guarded: fit() also runs before the first resize (canvas not sized
    // yet) and after a degenerate transform — fall back to raw pixels.
    const s = Math.min(cssW / extW, cssH / extH);
    cam.fit = Number.isFinite(s) && s > 0 ? s : 1;
  }

  function resize() {
    dpr = window.devicePixelRatio || 1;
    cssW = canvas.clientWidth;
    cssH = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fit();
    draw();
  }

  // setPack(meta, image, transform): transform is the makeTransform()
  // output loadMapPack already built (Replay passes it through); a caller
  // handing us a bare meta gets it derived here — either way makeTransform
  // is the single pack→transform reader.
  function setPack(newPack, image, transform) {
    pack = newPack || null;
    radar = image || null;
    packTf = transform || (pack ? makeTransform(pack) : null);
    fit();
  }

  function setLandmarks(list) {
    // Rows arrive PRE-BUCKLETED (lib/replay/landmarks.js normalizeEvent
    // stamps `bucket`) — no classification happens in the render path.
    // Two passes: bucket everything, then pair throws against the
    // COMPLETE detonation set (a single pass would scan a half-populated
    // raw list and re-classify every row per throw).
    landmarks = list || [];
    polylines = [];
    dets = [];
    smokes = [];
    fires = [];
    plants = [];
    explodes = [];
    defuses = [];
    drops = [];
    pickups = [];
    roundEnds = [];
    roundStarts = [];
    kills = [];
    damages = [];
    const throws = [];
    for (const l of landmarks) {
      switch (l.bucket) {
        case 'throw':
          throws.push(l);
          break;
        case 'kill':
          // Death markers (spec 28): the victim's steamId resolves to the
          // slot whose dot the X replaces; x/y are the kill row's stored
          // VICTIM position (normalizeEvent aliases posX/posY).
          kills.push(l);
          break;
        case 'damage':
          // Victim-hit flash (spec 25): grouped by victim slot — only the
          // tick matters, the dot supplies the position. A victim we
          // cannot resolve to a slot has no dot to flash (skip).
          {
            const vs = slotOfSteam.get(String(l.victim || ''));
            if (vs != null && Number.isFinite(l.tick)) {
              (damages[vs] || (damages[vs] = [])).push(l.tick);
            }
          }
          break;
        case 'detonation':
        case 'flash':
        case 'he':
        case 'decoy':
          dets.push(l);
          break;
        case 'smoke':
          // Typed detonations land in their OWN bucket (drawBucket routes
          // grenade rows by weapon), so a smoke both blooms and fills the
          // lingering-area array its lifetime model reads.
          smokes.push(l);
          dets.push(l);
          break;
        case 'fire':
          fires.push(l);
          dets.push(l);
          break;
        case 'plant':
          plants.push(l);
          break;
        case 'explode':
          explodes.push(l);
          break;
        case 'defuse':
          defuses.push(l);
          break;
        case 'drop':
          drops.push(l);
          break;
        case 'pickup':
          pickups.push(l);
          break;
        case 'round':
          roundEnds.push(l);
          break;
        case 'start':
          // Stored ONLY for killEndTick's next-round cutoff — a
          // round_start row is never drawn as a world marker and never
          // becomes a scrubber marker (landmarks.scrubberMarkerClass).
          roundStarts.push(l);
          break;
      }
    }
    // The bomb evidence bundle for bomb.js (dropped reconstruction +
    // planted round-end cleanup). One rebuild per setLandmarks call —
    // the per-frame paths only scan these small arrays.
    bombEv = { drops, pickups, plants, roundEnds };
    for (const l of throws) {
      // pair with the nearest detonation of same round+thrower+weapon
      // (weapon equality is sameUtilityWeapon — Molotov ≡ Incendiary,
      // see landmarks.js)
      let best = null;
      let bestDelta = Infinity;
      for (const d of dets) {
        if (d.round !== l.round) continue;
        if (l.steamId && d.steamId !== l.steamId) continue;
        if (!sameUtilityWeapon(l.weapon, d.weapon)) continue;
        if (d.tick < l.tick) continue;
        const delta = d.tick - l.tick;
        if (delta < bestDelta) {
          bestDelta = delta;
          best = d;
        }
      }
      polylines.push({ from: l, to: best });
    }
  }

  function setData(newData) {
    store = newData;
    // New frames/ticks: the firing edge state cannot be compared across
    // datasets — re-seed (stepFiring rebuilds it on the next draw).
    fireEdge = [];
    fireAt = [];
    lastFireTick = null;
    fit();
  }

  // setIcons(map): the preloaded equipment icons — { [canonical name]:
  // HTMLImageElement | null }, built by the icon pipeline (another
  // agent's). Call before the first draw (or after it: every setter
  // redraws when the canvas is already sized). Absent/null entries fall
  // back to the text/vector drawing; this never fetches anything.
  function setIcons(map) {
    icons = map || Object.create(null);
    tintCache.clear();
    draw();
  }

  // setVoices({ colors, speaking }): the voice assignment — colors is
  // indexed by SLOT (null/'' = no assigned color: the dot keeps its
  // plain rim), speaking is (slot, tick) => boolean|null (null when the
  // match has no voice). Both are read as pure functions of tick every
  // draw, so a scrub is always correct.
  function setVoices(v) {
    voiceColors = (v && v.colors) || [];
    voiceSpeaking = (v && v.speaking) || null;
    draw();
  }

  // setBlinds(rows): the flash-white overlay input — [{slot, tick, ms}]
  // rows (the view joined the blind events with the narrow flash-duration
  // read by seq and resolved each victim to its slot). Bucketed per slot
  // exactly like `damages` in setLandmarks; a row without a usable slot,
  // tick or positive duration is dropped here too (defensive — the view
  // already filters). Absent/null clears the overlay.
  function setBlinds(rows) {
    blinds = [];
    for (const b of rows || []) {
      if (!b || !Number.isFinite(b.tick) || !(b.ms > 0)) continue;
      if (!Number.isInteger(b.slot) || b.slot < 0) continue;
      (blinds[b.slot] || (blinds[b.slot] = [])).push({ tick: b.tick, ms: b.ms });
    }
    draw();
  }

  // setStateIndex(index): lib/replay/state.js buildStateIndex output (or
  // null — no state stream / older import: the firing animation simply
  // does not draw). Resetting re-seeds the edge state so a later set
  // cannot inherit a stale attack bit.
  function setStateIndex(index) {
    stateIndex = index || null;
    fireEdge = [];
    fireAt = [];
    lastFireTick = null;
    draw();
  }

  function panBy(dx, dy) {
    if (camMode === 'smart') takeOver(); // manual drag → free camera
    const s = cam.fit * cam.zoom;
    cam.cx -= dx / s;
    cam.cy -= dy / s;
  }

  function zoomAt(factor, sx, sy) {
    if (camMode === 'smart') takeOver(); // manual wheel → free camera
    screenToImage(sx, sy);
    const bx = imgPt.x;
    const by = imgPt.y;
    // Clamp the on-screen scale (fit-relative zoom × fit), not the raw
    // ratio: ZOOM_MIN/MAX are about how much map is visible, so they
    // must mean the same thing whatever the canvas/image size is.
    const eff = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, cam.fit * cam.zoom * factor));
    cam.zoom = eff / cam.fit;
    const s = cam.fit * cam.zoom;
    cam.cx = bx - (sx - cssW / 2) / s;
    cam.cy = by - (sy - cssH / 2) / s;
  }

  // --- smart camera ---------------------------------------------------------

  // takeOver: user panned/zoomed while smart — drop to free for the
  // session and tell the caller (Replay updates its selector; the pref
  // keeps the explicit choice, so the next entry starts smart again).
  function takeOver() {
    camMode = 'free';
    cancelEase();
    if (onUserCamera) onUserCamera();
  }

  function cancelEase() {
    if (easeRaf) cancelAnimationFrame(easeRaf);
    easeRaf = 0;
  }

  // setCameraMode: 'smart' | 'free' (anything else reads as free).
  // Switching to smart re-arms the ease from wherever the camera is —
  // the target is computed on the next draw, never snapped to.
  function setCameraMode(mode) {
    const next = mode === 'smart' ? 'smart' : 'free';
    if (next === camMode) return;
    camMode = next;
    lastEaseT = 0;
    if (next === 'smart') smartConverged = false;
    else cancelEase();
    draw();
  }

  // smartTarget: the bounding box of everything that must stay on
  // screen — ALIVE players (the store only samples alive slots; a dead
  // player has no current position and their last spot would pin the
  // view to a ghost) plus the ACTIVE bomb: planted (the bombEndTick
  // window) or dropped (bomb.js evidence). A carried bomb needs no
  // point of its own — its carrier is an alive player. Returns null
  // when there is nobody to frame (hold the current view).
  function smartTarget() {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const img = { x: 0, y: 0 };
    const add = (wx, wy) => {
      worldToImage(wx, wy, img);
      if (img.x < minX) minX = img.x;
      if (img.x > maxX) maxX = img.x;
      if (img.y < minY) minY = img.y;
      if (img.y > maxY) maxY = img.y;
    };
    for (let slot = 0; slot < store.slots.length; slot++) {
      engine.lerpAt(slot, tmp);
      if (tmp.alive && Number.isFinite(tmp.x)) add(tmp.x, tmp.y);
    }
    const tr = engine.tickRate;
    const tick = engine.state.tick;
    for (const l of plants) {
      if (!hasPos(l)) continue;
      if (tick >= l.tick && tick <= bombEndTick(l, tr, explodes, defuses, roundEnds)) {
        add(l.x, l.y);
      }
    }
    const ev = bombEvidenceAt(bombEv, tick);
    if (ev && ev.state === 'dropped' && hasBombPos(ev)) add(ev.x, ev.y);
    if (!(minX <= maxX)) return null;
    return smartCamTarget({ minX, minY, maxX, maxY }, cssW, cssH, { extW, extH });
  }

  // stepSmart eases cam one step toward the fitted target (log-space
  // zoom so in/out feel symmetric) and records convergence.
  function stepSmart(now) {
    const target = smartTarget();
    if (!target) {
      smartConverged = true; // nothing to frame — hold the view
      lastEaseT = now;
      return;
    }
    let dt = lastEaseT ? (now - lastEaseT) / 1000 : SMART_DT_CLAMP;
    lastEaseT = now;
    dt = Math.max(0, Math.min(SMART_DT_CLAMP, dt));
    cam.cx = easeValue(cam.cx, target.cx, dt, SMART_TAU_CENTER);
    cam.cy = easeValue(cam.cy, target.cy, dt, SMART_TAU_CENTER);
    const sCur = cam.fit * cam.zoom;
    // Ease in SCREEN scale — that is what target.s is — and clamp there
    // too: the smart bounds (and the manual zoom band) are about how much
    // map fits the CANVAS, not about the fit-relative zoom ratio. Storing
    // s/fit keeps every consumer (wheel, pan, smoke radii) on one scale.
    const s = Math.max(
      SMART_ZOOM_MIN,
      Math.min(
        ZOOM_MAX,
        Math.exp(easeValue(Math.log(sCur), Math.log(target.s), dt, SMART_TAU_ZOOM)),
      ),
    );
    cam.zoom = s / cam.fit;
    smartConverged = camConverged(
      { cx: cam.cx, cy: cam.cy, s: cam.fit * cam.zoom },
      target,
    );
  }

  // The settle loop: draw() arms it while the smart camera has not
  // converged (a paused seek, a mode switch — anywhere nothing else
  // redraws). While the engine is PLAYING its own per-frame draw() has
  // already eased, so the loop just stays armed instead of double-
  // drawing. It stops on convergence, on 'free', or on follow.
  function easeTick() {
    easeRaf = 0;
    if (camMode !== 'smart') return;
    const st = engine.state;
    if (st.followSlot != null) return; // follow owns the camera
    if (st.playing) {
      if (!smartConverged) easeRaf = requestAnimationFrame(easeTick);
      return;
    }
    draw();
  }

  function destroy() {
    cancelEase();
  }

  // --- layers ----------------------------------------------------------------

  function drawGrid() {
    ctx.fillStyle = '#0a0d12';
    ctx.fillRect(0, 0, cssW, cssH);
    const s = cam.fit * cam.zoom;
    ctx.strokeStyle = 'rgba(215, 221, 232, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const step = 64; // image px (= 64 * scale world units)
    const gx0 = Math.floor(screenToImage(0, 0).x / step) * step;
    const gy0 = Math.floor(screenToImage(0, 0).y / step) * step;
    const brX = screenToImage(cssW, cssH).x;
    const brY = screenToImage(cssW, cssH).y;
    for (let gx = gx0; gx <= brX; gx += step) {
      // vertical grid line at image x = gx
      const sx = cssW / 2 + (gx - cam.cx) * s;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, cssH);
    }
    for (let gy = gy0; gy <= brY; gy += step) {
      const sy = cssH / 2 + (gy - cam.cy) * s;
      ctx.moveTo(0, sy);
      ctx.lineTo(cssW, sy);
    }
    ctx.stroke();
    // extent border
    ctx.strokeStyle = 'rgba(58, 67, 86, 0.9)';
    ctx.lineWidth = 2;
    const c0 = worldToScreen(0, 0);
    ctx.strokeRect(c0.x, c0.y, extW * s, extH * s);
  }

  function drawRadar() {
    if (!radar) return false;
    const s = cam.fit * cam.zoom;
    const x = cssW / 2 - cam.cx * s;
    const y = cssH / 2 - cam.cy * s;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(radar, x, y, extW * s, extH * s);
    return true;
  }

  // sideAtFrame resolves a slot's side at frame f through the ONE
  // canonical rule (module-level sideFromFlags): the per-frame side bits
  // (q16-v2 — sides flip at halftime), falling back to the slot's final
  // side from meta. The fallback is not an old-format shim: v2 side bits
  // are 0 (unknown) whenever the slot carries no payload that frame (dead
  // player) or the extractor saw an unassigned team, and the final-side
  // table is all we have for those frames.
  function sideAtFrame(slot, f) {
    return sideFromFlags(store.slots[slot].flags[f], slotSides[slot]);
  }

  function drawTrails(frame) {
    const n = store.frames;
    const from = Math.max(0, frame - TRAIL_FRAMES);
    const s = cam.fit * cam.zoom;
    for (let slot = 0; slot < store.slots.length; slot++) {
      const p = store.slots[slot].pos;
      const color = teamColor(sideAtFrame(slot, frame));
      let prev = null;
      for (let f = frame; f >= from; f--) {
        if (!(store.masks[f] & (1 << slot))) {
          prev = null;
          continue;
        }
        const b = f * 4;
        const sx = cssW / 2 + ((p[b] - tf.pos_x) / tf.scale - cam.cx) * s;
        const sy = cssH / 2 + ((tf.pos_y - p[b + 1]) / tf.scale - cam.cy) * s;
        // prev is frame f+1 (the loop is contiguous and only alive frames
        // set it); trailConnects breaks the chain across a round reset /
        // respawn teleport instead of drawing the streaking line.
        if (prev && trailConnects(store.ticks, p, f)) {
          const age = (frame - f) / TRAIL_FRAMES;
          ctx.strokeStyle = color;
          ctx.globalAlpha = (1 - age) * 0.5;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(prev[0], prev[1]);
          ctx.lineTo(sx, sy);
          ctx.stroke();
        }
        prev = [sx, sy];
      }
    }
    ctx.globalAlpha = 1;
  }

  // iconFor — the preloaded icon for a canonical weapon name, or null
  // (absent / explicitly null / not decoded yet → the caller's text or
  // vector fallback; this module never fetches anything).
  function iconFor(weapon) {
    const img = weapon ? icons[weapon] : null;
    return img && typeof img === 'object' && (img.width || img.height) ? img : null;
  }

  // drawGrenades — the utility layer: lingering smoke/fire areas first,
  // then each grenade's flight (the extracted icon interpolated linearly
  // between the pair's ticks — progress is pure tick math, so a scrub
  // lands on the right spot), then ONE distinct detonation visual per
  // type (detonationStyleOf): HE expanding ring, flash white pop, smoke
  // bloom, fire ring, decoy pulse.
  function drawGrenades(tick) {
    const tr = engine.tickRate;
    // smoke / fire areas first (under the lines)
    for (const l of smokes) {
      if (!hasPos(l)) continue;
      const age = (tick - l.tick) / tr;
      if (age < 0 || age > SMOKE_LIFETIME_S) continue;
      const c = worldToScreen(l.x, l.y);
      const r = (SMOKE_RADIUS / tf.scale) * cam.fit * cam.zoom;
      const fade = age > SMOKE_LIFETIME_S - 2 ? (SMOKE_LIFETIME_S - age) / 2 : 1;
      ctx.fillStyle = `rgba(180, 190, 205, ${0.3 * fade})`;
      ctx.strokeStyle = `rgba(180, 190, 205, ${0.55 * fade})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    for (const l of fires) {
      if (!hasPos(l)) continue;
      const age = (tick - l.tick) / tr;
      if (age < 0 || age > FIRE_LIFETIME_S) continue;
      const c = worldToScreen(l.x, l.y);
      const r = (FIRE_RADIUS / tf.scale) * cam.fit * cam.zoom;
      // Molotov/incendiary areas read RED (not orange) — see the
      // detonation ring below for the same hue family.
      ctx.fillStyle = 'rgba(235, 70, 55, 0.3)';
      ctx.strokeStyle = 'rgba(245, 90, 70, 0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    // throw→detonate: the grenade's flight, visible while it is "in the
    // air" (from throw tick to detonation tick). Progress = pure tick
    // interpolation; equal/unknown pair ticks keep the origin dot only.
    for (const pl of polylines) {
      if (!hasPos(pl.from)) continue;
      if (tick < pl.from.tick) continue;
      if (pl.to && tick > pl.to.tick) continue;
      const a = worldToScreen(pl.from.x, pl.from.y);
      const flight =
        pl.to &&
        hasPos(pl.to) &&
        Number.isFinite(pl.from.tick) &&
        Number.isFinite(pl.to.tick) &&
        pl.to.tick > pl.from.tick;
      if (flight) {
        const b = worldToScreen(pl.to.x, pl.to.y);
        ctx.strokeStyle = 'rgba(251, 172, 24, 0.4)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.setLineDash([]);
        const p = Math.max(0, Math.min(1, (tick - pl.from.tick) / (pl.to.tick - pl.from.tick)));
        const img = iconFor(pl.from.weapon) || iconFor(pl.to.weapon);
        let drawn = false;
        if (img) {
          const c = worldToScreen(
            pl.from.x + (pl.to.x - pl.from.x) * p,
            pl.from.y + (pl.to.y - pl.from.y) * p,
          );
          drawn = drawIcon(img, c.x, c.y, NADE_ICON_PX);
        }
        if (!drawn) {
          // no icon for this weapon — today's vector drawing (the orange
          // origin dot), never an error.
          ctx.fillStyle = 'rgba(251, 172, 24, 0.8)';
          ctx.beginPath();
          ctx.arc(a.x, a.y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        // unpaired throw / unknown ticks: today's origin dot, no motion.
        ctx.fillStyle = 'rgba(251, 172, 24, 0.8)';
        ctx.beginPath();
        ctx.arc(a.x, a.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // Detonations — one visual per type (smoke/fire also linger above;
    // their bloom hands the area off to it). Every branch is a function
    // of the event tick: scrubbing replays it, nothing is sticky.
    for (const l of dets) {
      if (!hasPos(l)) continue;
      const age = (tick - l.tick) / tr;
      if (age < 0) continue;
      const c = worldToScreen(l.x, l.y);
      const style = detonationStyleOf(l);
      if (style === 'smoke') {
        const dur = 0.9; // s — the bloom racing out to the smoke radius
        if (age > dur) continue;
        const k = age / dur;
        const r = 6 + k * (SMOKE_RADIUS / tf.scale) * cam.fit * cam.zoom;
        ctx.strokeStyle = `rgba(180, 190, 205, ${0.8 * (1 - k)})`;
        ctx.lineWidth = 3 * (1 - k) + 1;
        ctx.beginPath();
        ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
        ctx.stroke();
      } else if (style === 'fire') {
        const dur = 0.6; // s — molotov/incendiary spread
        if (age > dur) continue;
        const k = age / dur;
        const r = 6 + k * (FIRE_RADIUS / tf.scale) * cam.fit * cam.zoom;
        // RED ring + hot-red core (the old orange read as a different
        // utility than the lingering area it hands off to).
        ctx.strokeStyle = `rgba(240, 75, 60, ${0.92 * (1 - k)})`;
        ctx.lineWidth = 3 * (1 - k) + 1;
        ctx.beginPath();
        ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = `rgba(255, 110, 90, ${0.6 * (1 - k)})`;
        ctx.beginPath();
        ctx.arc(c.x, c.y, 7 * (1 - k) + 2, 0, Math.PI * 2);
        ctx.fill();
      } else if (style === 'flash') {
        const dur = 0.5; // s — the bang: white pop + core (slightly
        //                 faster than the old 0.7 s)
        if (age > dur) continue;
        const k = age / dur;
        ctx.strokeStyle = `rgba(255, 255, 255, ${0.95 * (1 - k)})`;
        ctx.lineWidth = 2.5 * (1 - k) + 1;
        ctx.beginPath();
        ctx.arc(c.x, c.y, 4 + k * 26, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = `rgba(255, 255, 255, ${0.7 * (1 - k)})`;
        ctx.beginPath();
        ctx.arc(c.x, c.y, 6 * (1 - k) + 1.5, 0, Math.PI * 2);
        ctx.fill();
      } else if (style === 'decoy') {
        const dur = 2.4; // s — three soft pulses while it fakes fire
        if (age > dur) continue;
        const k = age / dur;
        const r = 6 + 4 * (0.5 + 0.5 * Math.sin(k * Math.PI * 6));
        ctx.strokeStyle = `rgba(140, 205, 255, ${0.85 * (1 - k)})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        // HE (and any unknown weapon): the classic expanding ring —
        // ~1.3 s total (slightly faster than the old ~2 s), growth
        // scaled so the ring still reaches the same maximum radius.
        const dur = 1.3;
        if (age > dur) continue;
        const r = 4 + age * (20 / dur);
        ctx.strokeStyle = `rgba(224, 91, 91, ${0.9 - age * 0.4})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  // iconAspect — an icon's natural width per unit height (img.width /
  // img.height): every icon draw keeps the HEIGHT at `size` and derives
  // the width from it, so the extracted utility/bomb art renders in its
  // ORIGINAL aspect ratio instead of being squashed to 1:1. A missing
  // or degenerate image falls back to 1 (square — the old behavior).
  function iconAspect(img) {
    const h = img && Number(img.height);
    const w = img && Number(img.width);
    return h > 0 && w > 0 ? w / h : 1;
  }

  // tintedIcon — the C4 silhouette recolored for its state through an
  // offscreen canvas (draw the image, then a 'source-in' fill with the
  // target color — drawImage alone cannot recolor an SVG silhouette).
  // The canvas is (size · aspect) × size — the icon's own proportions
  // (iconAspect), never a 1:1 squash. Cached per color|size|source
  // (setIcons clears it), so the per-frame path is one Map lookup; never
  // rebuilt per frame. Returns null when no canvas context is available —
  // the caller falls back to the text label rather than throwing.
  function tintedIcon(img, color, size) {
    const w = Math.max(1, Math.round(size * iconAspect(img)));
    const h = Math.max(1, Math.round(size));
    const key = `${color}|${w}x${h}|${img.src || img.width + 'x' + img.height}`;
    const hit = tintCache.get(key);
    if (hit) return hit;
    let cv = null;
    try {
      if (typeof document !== 'undefined' && document.createElement) {
        cv = document.createElement('canvas');
      } else if (typeof OffscreenCanvas === 'function') {
        cv = new OffscreenCanvas(w, h);
      }
      if (!cv) return null;
      cv.width = w;
      cv.height = h;
      const c2 = cv.getContext('2d');
      if (!c2) return null;
      c2.drawImage(img, 0, 0, w, h);
      c2.globalCompositeOperation = 'source-in';
      c2.fillStyle = color;
      c2.fillRect(0, 0, w, h);
      c2.globalCompositeOperation = 'source-over';
    } catch {
      return null;
    }
    tintCache.set(key, cv);
    return cv;
  }

  // drawIcon — one equipment icon at (cx, cy) in its ORIGINAL aspect
  // ratio (height = size, width = size · iconAspect — the util/bomb art
  // keeps its proportions), optionally recolored (`tint` via the
  // tintedIcon cache) and always over a thin dark silhouette (also
  // cached, drawn 1 px larger on every side for a uniform outline) so it
  // stays legible on the LIGHT theme as well as the dark radar. Returns
  // false when nothing could be drawn — the caller falls back to its
  // text/vector mark, never an error.
  function drawIcon(img, cx, cy, size, tint = null) {
    const w = size * iconAspect(img);
    const halo = tintedIcon(img, 'rgba(8, 10, 14, 0.85)', size);
    if (halo) ctx.drawImage(halo, cx - w / 2 - 1, cy - size / 2 - 1, w + 2, size + 2);
    const body = tint ? tintedIcon(img, tint, size) : img;
    if (!body) return false;
    ctx.drawImage(body, cx - w / 2, cy - size / 2, w, size);
    return true;
  }

  // drawBombIcon — the extracted C4 image in place of the 'C4' text
  // (spec 29): WHITE when the bomb is dropped, RED when it is planted.
  // The planted marker prefers a dedicated 'planted_c4' entry when the
  // icon pipeline exposes one, else the shared 'C4' image. No image (or
  // no tintable canvas) → the text label, exactly as before.
  function drawBombIcon(c, planted) {
    const src = (planted && iconFor('planted_c4')) || iconFor('C4');
    if (src && drawIcon(src, c.x, c.y, BOMB_ICON_PX, planted ? '#ff4d4d' : '#ffffff')) return;
    ctx.fillStyle = '#fbac18';
    ctx.font = 'bold 10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('C4', c.x, c.y + 3);
  }

  function drawBomb(tick, now) {
    const tr = engine.tickRate;
    for (const l of plants) {
      if (!hasPos(l)) continue;
      // Visible from plant until the first same-round terminator —
      // detonation, defuse, or the ROUND END (the planted-C4 cleanup:
      // a round that ends before the bomb resolves no longer keeps the
      // marker on screen). bomb.js bombEndTick owns the rule; the 40 s
      // C4 timer is its no-terminator fallback.
      const endTick = bombEndTick(l, tr, explodes, defuses, roundEnds);
      if (tick < l.tick || tick > endTick) continue;
      const c = worldToScreen(l.x, l.y);
      const pulse = 10 + 4 * Math.sin(now / 200);
      ctx.strokeStyle = 'rgba(251, 172, 24, 0.95)';
      ctx.fillStyle = 'rgba(251, 172, 24, 0.25)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(c.x, c.y, pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      drawBombIcon(c, true); // planted → RED C4 icon (text fallback)
    }
    // Dropped C4 — drawn only while the reconstruction says it is ON
    // THE GROUND (bomb.js bombEvidenceAt state 'dropped'; the position
    // is the carrier's evidence position from bomb_drop). A picked-up
    // bomb follows its carrier's player row and a planted one is the
    // loop above — neither draws here. Dashed ring = not armed.
    const ev = bombEvidenceAt(bombEv, tick);
    if (ev && ev.state === 'dropped' && hasBombPos(ev)) {
      const c = worldToScreen(ev.x, ev.y);
      const pulse = 9 + 3 * Math.sin(now / 240);
      ctx.strokeStyle = 'rgba(251, 172, 24, 0.9)';
      ctx.fillStyle = 'rgba(251, 172, 24, 0.16)';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.arc(c.x, c.y, pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      drawBombIcon(c, false); // dropped → WHITE C4 icon (text fallback)
    }
    for (const l of explodes) {
      if (!hasPos(l)) continue;
      const age = (tick - l.tick) / tr;
      if (age < 0 || age > 3) continue;
      const c = worldToScreen(l.x, l.y);
      const r = 12 + age * 28;
      ctx.strokeStyle = `rgba(224, 91, 91, ${0.9 - age * 0.3})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const l of defuses) {
      if (!hasPos(l)) continue;
      const age = (tick - l.tick) / tr;
      if (age < 0 || age > 2) continue;
      const c = worldToScreen(l.x, l.y);
      ctx.fillStyle = `rgba(90, 169, 230, ${0.8 - age * 0.4})`;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // stepFiring — the muzzle-flash edge detector (spec 24). Once per
  // draw, BEFORE the player dots: compare each slot's attack bit
  // (state.js slotStateAt → .attack) with the previous draw's and
  // record the tick of every RISING edge. fireJump re-seeds the edge
  // state across a seek / loop restart / first draw, so scrubbing never
  // leaves a stuck flash; a paused redraw (same tick) leaves the state
  // alone, so the flash FREEZES instead of flickering. No state stream
  // (stateIndex null) → every bit reads false and nothing ever arms.
  function stepFiring(tick) {
    const n = store.slots.length;
    if (fireEdge.length !== n) {
      fireEdge = new Array(n).fill(null);
      fireAt = new Array(n).fill(null);
      lastFireTick = null;
    }
    const jump = fireJump(tick, lastFireTick, engine.state.speed, engine.tickRate);
    lastFireTick = tick;
    const frame = engine.state.frame;
    for (let slot = 0; slot < n; slot++) {
      const attack = stateIndex ? !!slotStateAt(stateIndex, slot, frame).attack : false;
      const prev = fireEdge[slot];
      if (jump || prev == null) {
        fireEdge[slot] = attack; // re-seed — never flash across a jump
        continue;
      }
      if (attack && !prev) fireAt[slot] = tick; // rising edge → burst
      fireEdge[slot] = attack;
    }
  }

  // haloRing — a colored ring with a thin dark halo underneath so it
  // reads on BOTH the dark radar and the light theme (the assigned
  // voice colors include near-white yellows).
  function haloRing(x, y, radius, color, width) {
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = width + 2;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  // drawDeaths — the death markers (spec 28): an X in the VICTIM's team
  // color where their dot was, drawn from the kill's tick until that
  // round's round_end (killEndTick — a pure function of tick + rows, so
  // scrubbing backwards into the round redraws the X and nothing is ever
  // remembered across rounds). The side is read at the tick BEFORE the
  // kill: at the kill tick the victim may already be unalived (no side
  // bits) and the final-side fallback would be wrong across halftime.
  function drawDeaths(tick) {
    const tr = engine.tickRate;
    for (const k of kills) {
      if (!hasPos(k)) continue;
      if (tick < k.tick) continue;
      // The marker is gone AT its cutoff, not one tick after it: the
      // round ribbon seeks to EXACTLY the next round's startTick, and
      // killEndTick returns that very tick for the post-round C4 kill —
      // with the old `tick > end` test the boundary X still drew and,
      // paused, never cleared (the stuck blue X repro). The kill's OWN
      // tick always draws even when the cutoff lands on it: a kill
      // stamped on the round_end tick (golden demo round 1, tick 7626
      // — kill and round_end share the tick) must still mark the spot
      // for that one tick. `tick !== k.tick` also keeps a NaN-tick row
      // (killEndTick → 0) from ever drawing.
      const end = killEndTick(k, tr, roundEnds, roundStarts);
      if (tick >= end && tick !== k.tick) continue;
      const slot = slotOfSteam.get(String(k.victim || ''));
      if (slot == null || slot >= store.slots.length) continue; // no dot to mark
      const c = worldToScreen(k.x, k.y);
      if (c.x < -60 || c.y < -60 || c.x > cssW + 60 || c.y > cssH + 60) continue;
      const frame = engine.frameForTick(Math.max(engine.firstTick, k.tick - 1));
      const color = teamColor(sideAtFrame(slot, frame));
      const segs = crossPath(c.x, c.y, DEATH_X_HALF);
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 5;
      ctx.beginPath();
      for (const [x1, y1, x2, y2] of segs) {
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
      }
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      for (const [x1, y1, x2, y2] of segs) {
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
      }
      ctx.stroke();
      ctx.lineCap = 'butt';
    }
  }

  function drawPlayers() {
    const st = engine.state;
    const tick = st.tick;
    const tr = engine.tickRate;
    for (let slot = 0; slot < store.slots.length; slot++) {
      engine.lerpAt(slot, tmp);
      if (!tmp.alive) continue;
      const c = worldToScreen(tmp.x, tmp.y);
      if (c.x < -60 || c.y < -60 || c.x > cssW + 60 || c.y > cssH + 60) continue;
      const color = teamColor(sideAtFrame(slot, st.frame));
      // Constant radius: a crouching player's dot is the same size as a
      // standing one (the duck flag stays on `tmp` for every other
      // consumer — it only ever shrank the dot here).
      const r = 9;
      const angle = (-tmp.yaw) * Math.PI / 180; // engine yaw → screen

      // 27 — view CHEVRON: an open ">" of two arms meeting at the apex
      // pointing along the look direction (no shaft), CENTERED on the
      // dot. Sized at r · 1.8 so the arm ends sit just outside the dot
      // edge (0.6·size along the look ≈ r + 0.7, ±0.5·size across —
      // radius ≈ 0.78·size ≈ 12.6 px at r = 9) instead of floating far
      // away; a 2.75 px stroke at near-opaque team color keeps it
      // clearly visible without competing with the dot itself.
      const pts = chevronPath(c.x, c.y, angle, r * 1.8);
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 2.75;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      ctx.lineTo(pts[1][0], pts[1][1]);
      ctx.lineTo(pts[2][0], pts[2][1]);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // body — the team/side fill stays (side must stay readable); the
      // RIM is the assigned voice color when there is one (21), the
      // plain white rim otherwise (no voice / no assigned color). Both
      // are MINIMAL: a 1 px stroke over a thin dark underlay so they
      // read on the dark radar and the light theme alike.
      const voice = voiceColors[slot] || null;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fill();
      // Flash-white: while a blind window is open the dot turns WHITE —
      // solid for the first quarter of the window, then a linear fade
      // back to the team color (blindAlpha — a pure function of tick, so
      // scrubbing backwards re-renders it and nothing is sticky).
      const blindsFor = blinds[slot];
      if (blindsFor) {
        let flash = 0;
        for (let i = 0; i < blindsFor.length; i++) {
          const a = blindAlpha(tick, blindsFor[i].tick, tr, blindsFor[i].ms);
          if (a > flash) flash = a;
        }
        if (flash > 0) {
          ctx.globalAlpha = flash;
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }
      haloRing(c.x, c.y, r, voice || 'rgba(255,255,255,0.85)', 1);

      // 25 — damage flash: a white pop over the dot plus a red ring
      // that eases outward, purely from the damage tick window (never
      // wall-clock → a scrub replays it and it self-clears).
      const hits = damages[slot];
      if (hits) {
        let hit = 0;
        for (let i = 0; i < hits.length; i++) {
          const a = windowAlpha(tick, hits[i], tr, DAMAGE_FLASH_S);
          if (a > hit) hit = a;
        }
        if (hit > 0) {
          const hr = r + 2.5 * hit;
          ctx.globalAlpha = 0.75 * hit;
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(c.x, c.y, hr, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 0.9 * hit;
          ctx.strokeStyle = 'rgba(255,70,70,0.95)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(c.x, c.y, hr, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }

      // 24 — muzzle burst: ONE straight line along the look direction
      // (r+2 → r+14, slightly longer than the old fan), alpha decaying
      // over the tick window armed by stepFiring (frozen at a constant
      // age while paused — it never flickers on its own).
      const fire = windowAlpha(tick, fireAt[slot], tr, FIRE_FLASH_S);
      if (fire > 0) {
        const rays = muzzleRays(c.x, c.y, angle, r + 2, r + 14, 1, 0);
        if (rays.length) {
          ctx.globalAlpha = fire;
          ctx.strokeStyle = 'rgba(0,0,0,0.45)';
          ctx.lineWidth = 4;
          ctx.beginPath();
          for (const [x1, y1, x2, y2] of rays) {
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
          }
          ctx.stroke();
          ctx.strokeStyle = '#ffd982';
          ctx.lineWidth = 2;
          ctx.beginPath();
          for (const [x1, y1, x2, y2] of rays) {
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
          }
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }

      // 26 — talking BLOOM: a WHITE ring expanding OUTWARD FROM THE
      // DOT'S CENTER and fading, looping as long as this slot speaks —
      // the flashbang detonation style anchored at (c.x, c.y), plus a
      // small fading white core over the fill. Pure tick math
      // (voiceBloom), so a scrub re-renders the same phase and nothing
      // is sticky; drawn ONLY while voiceSpeaking says this slot talks.
      // It is an OVERLAY, not a blocker: the ring starts inside the dot,
      // the core never exceeds it, and the fill + rim + chevron are
      // already painted underneath.
      if (voiceSpeaking && voiceSpeaking(slot, tick)) {
        const bloom = voiceBloom(tick, tr, r);
        if (bloom) {
          ctx.strokeStyle = '#ffffff';
          ctx.globalAlpha = bloom.alpha;
          ctx.lineWidth = 2.5 * (1 - bloom.k) + 1; // shrinks as it expands
          ctx.beginPath();
          ctx.arc(c.x, c.y, bloom.radius, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = '#ffffff';
          ctx.globalAlpha = 0.7 * (1 - bloom.k);
          ctx.beginPath();
          ctx.arc(c.x, c.y, 4 * (1 - bloom.k) + 1.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }

      // follow ring
      if (st.followSlot === slot) {
        ctx.strokeStyle = '#fbac18';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(c.x, c.y, r + 5, 0, Math.PI * 2);
        ctx.stroke();
      }
      // name label
      const name = slotNames[slot] || `#${slot}`;
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur = 3;
      ctx.fillStyle = '#d7dde8';
      ctx.fillText(name, c.x, c.y + r + 13);
      ctx.shadowBlur = 0;
    }
  }

  // --- HUD -------------------------------------------------------------------
  // Two boxes, both pure functions of the engine state + the setHud
  // payload:
  //   top-center   — team score + round clock, CENTERED on the stage
  //                  (x = (cssW − boxWidth) / 2, HUD_PAD from the top).
  //                  The score line is SCORE-ANCHORED (scoreLineLayout):
  //                  the '‹ct› – ‹t›' segment sits dead-center of the
  //                  box, the longer-name side defines the box's extent
  //                  on its side and the shorter side absorbs the slack
  //                  as padding (names stay adjacent to the score); the
  //                  clock line centers as a block. The stage's top
  //                  corners belong to the overlays, so the readout no
  //                  longer dodges a back button;
  //   bottom-left  — the playback readout (speed×, follow, loop,
  //                  packNote), 8px off the BOTTOM-left corner so it can
  //                  never fight the top-center box or the top-right
  //                  kill feed (drawKillFeed).
  // setHud payload (view-supplied, plain data): {
  //   score: {ct, t} | null,          // cumulative counted wins at the
  //                                   // playhead (lib/rounds.js scoreThrough)
  //   teamNames: {ct, t},             // the two SIDES' names AT THE
  //                                   // PLAYHEAD — hudFor resolves them
  //                                   // through hudTeamNames (the teams
  //                                   // table is keyed by FINAL side);
  //                                   // an empty name falls back to CT / T
  //   round: {                        // round containing the playhead, or
  //     number, label,                //   null before the first round
  //     startTick, freezeEndTick, endTick, bombSite
  //   } | null,
  //   tickRate: number | undefined
  // }
  // Before the first setHud call the renderer draws the playback box
  // alone (no score line) — the other createRenderer callers (node
  // tests, stubs) never supply one.
  let hud = null;

  // CS2 competitive round clock (CS2.md "Competitive round clock"):
  // 115 s of round time (mp_roundtime_defuse 1.92 min) counted from
  // freeze-time end. The C4's 40 s belongs to bombEndTick
  // (lib/replay/bomb.js) — this constant is ONLY the round-time length.
  const ROUND_TIME_S = 115;
  const HUD_LH = 15; // px per HUD line
  const HUD_PAD = 8; // px inside/around a HUD box
  const HUD_ICON_PX = 12; // px — an icon's size on an icon+text line
  const HUD_ICON_GAP = 4; // px — icon → text gap on an icon+text line
  // Codicon clock for the freeze-time line: the codicon font ships with
  // the app (@vscode/codicons/dist/codicon.css, imported app-wide in
  // main.js) and .codicon-clock:before { content: "\ea82" } — codepoint
  // confirmed in frontend/node_modules/@vscode/codicons/dist/codicon.css
  // line 145. Canvas can only draw the glyph once the font is LOADED,
  // so codiconFont() probes document.fonts.check('16px codicon') and
  // returns null (→ the literal 'freeze 0:10' word) when it cannot.
  const CODICON_CLOCK = '\uea82'; // .codicon-clock glyph
  const CODICON_CLOCK_FONT = '12px codicon'; // draw at the HUD line size

  // codiconFont — the codicon font spec for canvas when the codicon font
  // is loaded, else null (the caller falls back to text). Guards every
  // browser global node's headless test harness lacks: no document, no
  // document.fonts, no FontFaceSet.check.
  function codiconFont() {
    try {
      if (
        typeof document === 'undefined' ||
        !document.fonts ||
        typeof document.fonts.check !== 'function'
      ) {
        return null;
      }
      return document.fonts.check('16px codicon') ? CODICON_CLOCK_FONT : null;
    } catch {
      return null;
    }
  }

  function fmtClock(tick) {
    const sec = Math.max(0, Math.floor(tick / engine.tickRate));
    const m = Math.floor(sec / 60);
    const s2 = sec % 60;
    return `${m}:${String(s2).padStart(2, '0')}`;
  }

  // plantedEndAt — the tick a PLANTED C4's countdown reaches at `tick`,
  // or null when the bomb is not planted: the same plant evidence +
  // bomb.js terminator rule the world layer (drawBomb) and the smart
  // camera already use — never a second bomb rule.
  function plantedEndAt(tick, tr, roundNumber) {
    for (const l of plants) {
      if (!l || l.round !== roundNumber || !Number.isFinite(l.tick)) continue;
      if (tick < l.tick) continue;
      const end = bombEndTick(l, tr, explodes, defuses, roundEnds);
      if (tick <= end) return end;
    }
    return null;
  }

  // detonatedAt — true once a plant of this round has EXPLODED at
  // `tick`: the plant's bombEndTick terminator IS a bomb_explode row
  // (bomb.js owns the terminator rule; a defused / round-ended plant is
  // NOT a detonation and keeps today's behavior). Keys off the plant's
  // explode tick — never the round's recorded endTick, which can precede
  // the detonation — so the window between the explosion and the next
  // round's start reads 0:00 instead of the 115 s round clock.
  function detonatedAt(tick, tr, roundNumber) {
    for (const l of plants) {
      if (!l || l.round !== roundNumber || !Number.isFinite(l.tick)) continue;
      if (tick < l.tick) continue;
      const end = bombEndTick(l, tr, explodes, defuses, roundEnds);
      if (tick <= end) continue; // still ticking — plantedEndAt covers it
      for (const e of explodes) {
        if (e && e.round === l.round && e.tick >= l.tick && e.tick === end) return true;
      }
    }
    return false;
  }

  // roundClockLine — the top-center round clock: the C4 countdown while
  // the bomb is planted (the extracted C4 image leads the line when the
  // icon pipeline has one — 'C4 0:35' text otherwise), else 0:00 once
  // this round's plant has DETONATED and the next round has not started
  // yet (the round is over but its 115 s clock would keep counting down
  // to the next round — there is no countdown left to show), else the
  // freeze-time countdown before freeze end — the codicon CLOCK glyph +
  // time when canvas can use the codicon font, the literal 'freeze …'
  // word otherwise — else the remaining round time (clamped at 0). With
  // no usable freeze end
  // (startTick/freezeEndTick missing) the honest fallback is the time
  // ELAPSED into the round — a countdown we cannot know is never
  // invented. Returns a plain string, or {img, text} / {segs} pairs for
  // the icon/glyph lines.
  function roundClockLine(tick, round, tr) {
    const planted = plantedEndAt(tick, tr, round.number);
    if (planted != null) {
      const text = fmtClock(planted - tick);
      // Same image resolution as drawBombIcon (planted_c4 → the shared
      // C4 image), resolved HERE so hudBox only renders what it is given.
      const img = iconFor('planted_c4') || iconFor('C4');
      return img ? { img, text } : `C4 ${text}`;
    }
    if (detonatedAt(tick, tr, round.number)) return '0:00';
    const fe = round.freezeEndTick;
    if (Number.isFinite(fe) && Number.isFinite(round.startTick) && fe > round.startTick) {
      if (tick < fe) {
        const time = fmtClock(fe - tick);
        // The codicon clock glyph INSTEAD of the word "freeze" when the
        // codicon font is loaded for canvas (codiconFont); hudBox
        // re-measures the glyph so the box centering stays exact. Text
        // fallback keeps today's line character-for-character.
        const font = codiconFont();
        if (font) {
          // gap: the glyph's em alone sits too tight against the digits
          return { segs: [{ text: CODICON_CLOCK, font, gap: HUD_ICON_GAP }, { text: time }] };
        }
        return `freeze ${time}`;
      }
      const budget = Math.round(ROUND_TIME_S * tr);
      return fmtClock(Math.max(0, budget - (tick - fe)));
    }
    return `+${fmtClock(Math.max(0, tick - (round.startTick || 0)))}`;
  }

  function hudBoxHeight(n) {
    return n * HUD_LH + HUD_PAD * 2 - 3;
  }

  // measureHudSeg — one line segment measured in ITS font: a codicon
  // glyph has to be measured in the codicon family so its advance
  // matches what the centered layout actually draws. Restores ctx.font.
  function measureHudSeg(seg) {
    const prev = ctx.font;
    if (seg.font) ctx.font = seg.font;
    const w = ctx.measureText(seg.text).width;
    ctx.font = prev;
    return w;
  }

  // segWidths — every segment's drawn width (its own font + an optional
  // explicit gap): the ONE measure hudLineWidth (box width) and hudBox
  // (segment positions) both step by.
  function segWidths(ln) {
    return ln.segs.map((s) => measureHudSeg(s) + (s.gap || 0));
  }

  // hudLineWidth — one line's drawn width: a plain string is its text;
  // a {segs} run is the sum of its segments (each in its own font, plus
  // an optional explicit gap after a segment); an
  // {img, text} line reserves the icon slot ahead of its text (the
  // caller resolved the image — an icon line always has one). The
  // SCORE-ANCHORED line ({segs, scoreAnchor}) measures scoreLineWidth
  // instead of the plain sum: the box has to reach past the LONGER name
  // (see scoreLineWidth), never just hug the block.
  function hudLineWidth(ln) {
    if (typeof ln === 'string') return ctx.measureText(ln).width;
    if (ln.segs) {
      if (ln.scoreAnchor && ln.segs.length === 3) {
        const [leftW, scoreW, rightW] = segWidths(ln);
        return scoreLineWidth(leftW, scoreW, rightW);
      }
      let w = 0;
      for (const sw of segWidths(ln)) w += sw;
      return w;
    }
    return HUD_ICON_PX + HUD_ICON_GAP + ctx.measureText(ln.text).width;
  }

  // hudBoxWidth — the full box width (widest line + padding). The top
  // box centers itself on this, so it is measured once, not twice.
  function hudBoxWidth(lines) {
    let w = 0;
    for (const ln of lines) w = Math.max(w, hudLineWidth(ln));
    return w + HUD_PAD * 2;
  }

  // hudBox draws one HUD box with its lines (first line amber) at (x, y).
  // A line may be a string, an {img, text} pair drawn as icon + text, or
  // a {segs: [{text, color?, font?, gap?}]} run of colored segments (the
  // score line — a segment without a color takes the line's usual one,
  // `gap` is extra space after the segment, shared by measure + draw).
  // align 'center' centers each line's CONTENT in the box: a plain line
  // centers as a BLOCK, while a {scoreAnchor} line (the score line) lays
  // its segments out around the SCORE segment — scoreLineLayout pins it
  // dead-center of the box so unequal team names pad the shorter side
  // instead of pushing the score off-center; the default 'left' keeps the
  // bottom playback readout's inset.
  function hudBox(lines, x, y, w = hudBoxWidth(lines), align = 'left') {
    const bh = hudBoxHeight(lines.length);
    ctx.fillStyle = 'rgba(14, 17, 22, 0.78)';
    ctx.strokeStyle = 'rgba(35, 42, 55, 0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    // roundRect is baseline in modern WebKit; fall back for older builds
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, bh, 6);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(x, y, w, bh);
      ctx.strokeRect(x, y, w, bh);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const baseFont = ctx.font;
    lines.forEach((ln, i) => {
      const y0 = y + HUD_PAD + i * HUD_LH;
      const color = i === 0 ? '#fbac18' : '#8b94a7';
      ctx.fillStyle = color;
      // content start: the centered box centers every line's measured
      // content (segments then step from here by their own widths); the
      // left box keeps its HUD_PAD inset.
      let cx = x + HUD_PAD;
      if (align === 'center') cx = x + (w - hudLineWidth(ln)) / 2;
      if (typeof ln === 'string') {
        ctx.fillText(ln, cx, y0);
        return;
      }
      if (ln.segs) {
        // score-anchored: absolute positions from the box's center (the
        // score midpoint IS the center); every other segs line keeps the
        // block-centered step from cx.
        let xs = null;
        if (ln.scoreAnchor && ln.segs.length === 3 && align === 'center') {
          const [leftW, scoreW, rightW] = segWidths(ln);
          const lay = scoreLineLayout(leftW, scoreW, rightW, x + w / 2);
          xs = [lay.leftX, lay.scoreX, lay.rightX];
        }
        ln.segs.forEach((s, si) => {
          ctx.font = s.font || baseFont;
          ctx.fillStyle = s.color || color;
          const sx = xs ? xs[si] : cx;
          ctx.fillText(s.text, sx, y0);
          if (!xs) {
            // same step the width was measured with (incl. an explicit gap)
            cx += ctx.measureText(s.text).width + (s.gap || 0);
          }
        });
        ctx.font = baseFont;
        return;
      }
      // icon + text: the image leads (drawIcon keeps its dark halo so it
      // stays legible on the light theme too), the text follows.
      if (ln.img) drawIcon(ln.img, cx + HUD_ICON_PX / 2, y0 + HUD_LH / 2, HUD_ICON_PX);
      ctx.fillText(ln.text, cx + HUD_ICON_PX + HUD_ICON_GAP, y0);
    });
    ctx.font = baseFont;
    ctx.textBaseline = 'alphabetic';
  }

  // setHud(payload): score/round context for the top-center HUD box —
  // additive like the other setters (redraws on set). A null/absent
  // payload clears it: the renderer then draws the playback box (and no
  // kill feed) alone — the state before any view supplied a score line.
  function setHud(payload) {
    hud = payload || null;
    draw();
  }

  function drawHUD() {
    const st = engine.state;
    const tr = engine.tickRate;
    ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';

    // top-center: team score + round clock, centered on the stage (only
    // once a view supplied the HUD payload — without it there is no
    // score line). The payload's teamNames are ALREADY resolved to the
    // sides at the playhead (hudFor → hudTeamNames), so the renderer
    // colors each slot with ITS side color — the bare CT / T is the
    // empty-name fallback — with the score + separator between them in
    // white, SCORE-ANCHORED (scoreAnchor): the score segment sits
    // dead-center of the box and unequal names pad the shorter side, so
    // the score never drifts off the box's center. The clock line keeps
    // the block centering, and carries no round label: the ribbon above
    // the stage owns the round number.
    if (hud) {
      const top = [];
      if (hud.score) {
        const tn = hud.teamNames || {};
        top.push({
          scoreAnchor: true, // center the SCORE segment, not the block
          segs: [
            { text: tn.ct || 'CT', color: CT_COLOR },
            { text: ` ${hud.score.ct} – ${hud.score.t} `, color: '#ffffff' },
            { text: tn.t || 'T', color: T_COLOR },
          ],
        });
      }
      if (hud.round) top.push(roundClockLine(st.tick, hud.round, tr));
      if (top.length) {
        const w = hudBoxWidth(top);
        hudBox(top, (cssW - w) / 2, HUD_PAD, w, 'center');
      }
    }

    // bottom-left: the playback readout (speed / follow / loop /
    // packNote), 8px off the corner — clear of the top-center score box
    // and the top-right kill feed.
    const lines = [`${st.speed}×`];
    if (st.followSlot != null) {
      lines.push(`follow: ${slotNames[st.followSlot] || '#' + st.followSlot}`);
    }
    if (st.loopEnabled && st.loopFrom >= 0) {
      lines.push(`loop: f${st.loopFrom}–${st.loopTo}`);
    }
    if (packNote) lines.push(packNote);
    const y = Math.max(HUD_PAD, cssH - hudBoxHeight(lines.length) - HUD_PAD);
    hudBox(lines, HUD_PAD, y);
  }

  // --- Kill feed -------------------------------------------------------------
  // Top-right, canvas-drawn (snapshots and clip recordings capture ONLY
  // the canvas): the kills of the ROUND CONTAINING the playhead that have
  // already happened — round-scoped AND tick ≤ playhead, so a round
  // change clears the feed and a backwards scrub re-derives it (nothing
  // sticky, nothing remembered). Newest on top, capped. One line each:
  // killer name → weapon → victim name over a dark transparent box
  // outlined in the KILLER's team color (neutral when unknown); names
  // are tinted by their own side AT THE KILL TICK (sideAtFrame — the
  // same rule the death markers use).
  function drawKillFeed() {
    if (!hud || !hud.round || !Number.isFinite(hud.round.number)) return;
    const st = engine.state;
    const rn = hud.round.number;
    const rows = [];
    for (const k of kills) {
      if (!k || k.round !== rn || !Number.isFinite(k.tick) || k.tick > st.tick) continue;
      rows.push(k);
    }
    if (!rows.length) return;
    rows.sort((a, b) => b.tick - a.tick); // newest first
    const shown = rows.slice(0, KILL_FEED_MAX);
    // No position store (a caller that never fed data) → no side to
    // resolve: every name/border degrades to the neutral color instead
    // of throwing — sideAtFrame needs the store.
    const nSlots = (store && store.slots && store.slots.length) || 0;

    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 1;
    for (let i = 0; i < shown.length; i++) {
      const k = shown[i];
      // Side at the kill tick (frame BEFORE the kill — the victim may
      // already be unalived on the kill frame; drawDeaths' reasoning).
      const frame = engine.frameForTick(Math.max(engine.firstTick, k.tick - 1));
      const ks = slotOfSteam.get(String(k.attacker || ''));
      const vs = slotOfSteam.get(String(k.victim || ''));
      const kSide = ks != null && ks < nSlots ? sideAtFrame(ks, frame) : '';
      const vSide = vs != null && vs < nSlots ? sideAtFrame(vs, frame) : '';
      const killer = k.attackerName || k.attacker || '?';
      const victim = k.victimName || k.victim || '?';
      const img = iconFor(k.weapon); // canonical name → manifest image
      const kw = ctx.measureText(killer).width;
      const vw = ctx.measureText(victim).width;
      const ww = img ? KILL_FEED_ICON : ctx.measureText('→').width;
      const w = KILL_FEED_INSET * 2 + kw + KILL_FEED_GAP + ww + KILL_FEED_GAP + vw;
      const x = cssW - KILL_FEED_EDGE - w;
      // newest on top, entries on the PITCH (box height + gap) so they
      // read as separate lines instead of one touching stack
      const y = KILL_FEED_EDGE + i * KILL_FEED_PITCH;

      // box: dark transparent fill + the killer's team-color hairline on
      // ONE rounded path — roundRect mirrors hudBox's corners (plain rect
      // fallback), so the fill and the stroke share the exact outline.
      ctx.fillStyle = 'rgba(14,17,22,0.78)';
      ctx.strokeStyle = teamColor(kSide);
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(x, y, w, KILL_FEED_LH, KILL_FEED_R);
      } else {
        ctx.rect(x, y, w, KILL_FEED_LH);
      }
      ctx.fill();
      ctx.stroke();

      let tx = x + KILL_FEED_INSET;
      ctx.fillStyle = teamColor(kSide);
      ctx.fillText(killer, tx, y + 4);
      tx += kw + KILL_FEED_GAP;
      if (img) {
        drawIcon(img, tx + KILL_FEED_ICON / 2, y + KILL_FEED_LH / 2, KILL_FEED_ICON);
      } else {
        // no image for this weapon — a simple arrow, never an error
        ctx.fillStyle = '#8b94a7';
        ctx.fillText('→', tx, y + 4);
      }
      tx += ww + KILL_FEED_GAP;
      ctx.fillStyle = teamColor(vSide);
      ctx.fillText(victim, tx, y + 4);
    }
    ctx.textBaseline = 'alphabetic';
  }

  function draw() {
    if (!cssW || !cssH) return;
    const now = performance.now();
    const st = engine.state;
    // Smart mode eases toward its fitted target BEFORE the frame renders
    // (an explicit follow overrides it — follow is user intent, smart
    // resumes the moment follow releases).
    if (camMode === 'smart') {
      if (st.followSlot == null && store && store.frames > 0) stepSmart(now);
      else smartConverged = true; // follow owns it / nothing to frame
    }
    ctx.clearRect(0, 0, cssW, cssH);
    if (!drawRadar()) drawGrid();
    if (store && store.frames > 0) {
      // center on the followed player before drawing the rest
      if (st.followSlot != null) {
        if (st.followSlot !== followFor) {
          followFor = st.followSlot;
          followX = followY = null;
        }
        engine.lerpAt(st.followSlot, tmp);
        // Hold the last ALIVE position while they are dead (respawn /
        // round transition): lerpAt leaves x/y untouched for dead frames
        // and tmp is shared with drawPlayers, so without this hold the
        // camera would jump to whichever slot drew last.
        if (tmp.alive && Number.isFinite(tmp.x)) {
          followX = tmp.x;
          followY = tmp.y;
        }
        if (followX != null) {
          worldToImage(followX, followY, imgPt);
          cam.cx = imgPt.x;
          cam.cy = imgPt.y;
        }
      } else {
        followFor = -1;
      }
      stepFiring(st.tick); // arms the muzzle flashes (spec 24)
      drawTrails(st.frame);
      drawGrenades(st.tick);
      // Death X UNDER the bomb layer: the dropped/planted C4 icon and
      // its rings must render ABOVE a victim's X (an X overlapping the
      // bomb read as a stray mark on it).
      drawDeaths(st.tick); // the victim's team-color X (spec 28)
      drawBomb(st.tick, now);
      drawPlayers();
    }
    drawHUD();
    drawKillFeed();
    // Arm the settle loop when smart is still short of its target — a
    // paused seek (or a mode switch) has no other redraw driver. draw()
    // is the single arming point and it checks !easeRaf, so the engine's
    // per-frame draws while playing never double up with the loop.
    if (camMode === 'smart' && st.followSlot == null && !smartConverged && !easeRaf) {
      easeRaf = requestAnimationFrame(easeTick);
    }
  }

  return {
    draw,
    resize,
    fit,
    setPack,
    setLandmarks,
    setHud,
    setIcons,
    setVoices,
    setBlinds,
    setStateIndex,
    setData,
    panBy,
    zoomAt,
    setCameraMode,
    destroy,
    worldToScreen,
    getCam: () => cam,
  };
}
