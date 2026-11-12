// M2 replay renderer: layered Canvas 2D draw over the engine's typed arrays.
//
// Layers, bottom → top: radar (or world grid) → movement trails → grenade
// landmarks (lingering smoke/fire areas → utility flight with the
// extracted icon → per-type detonation pops) → death markers (the victim's
// team-color X, until the round ends) → bomb (pulse ring + the extracted
// C4 icon — the dropped/planted C4 renders ABOVE the death markers, so an
// X can never overlap it) → tracers (the bullet tracer — a short
// side-colored DASH sliding from where it was fired out r+MUZZLE_REACH,
// fading as it travels — and the hit-shot tracer (the same dash from
// shooter to victim, held at full alpha until it arrives), both over
// their ~0.1 s travel — UNDER the dots, so they read as coming out of
// the shooter's dot and never cover a name; both moved OUT of the
// players layer with the tracer rework) → players (elevation indicator T/⊥
// UNDER the dot → white talking bloom UNDER the dot →
// view chevron, body, player-color rim, flash-white overlay, damage
// flash, follow ring, name — and the carried-C4 badge, which is
// COLLECTED in the slot loop and painted in a SECOND pass after it so
// it sits above every dot, label and ring of the frame — see
// drawPlayers) → HUD +
// kill feed (top-right) + in-game chat (bottom-left).
//
// Multi-floor packs (meta.layers — e.g. Nuke's upper + lower radars)
// draw their layer images SIDE BY SIDE inside this one canvas: every
// world-positioned element projects through the panel of ITS OWN layer
// (layerIndexForZ over the layer's world-Z band; see lib/replay/layers.js),
// so players, C4, grenades, trails, tracers, landmarks and death markers
// all land on the correct floor's panel. A pack without `layers` builds
// exactly one panel at offset 0 — the pre-layers geometry, unchanged.
// Elevation indicators (CS2's ⊥/T marks) draw behind their entity when
// an `elevation_regions` box claims its XY — the region thresholds are
// the ONLY source (an unboxed XY is unambiguous → never marked; see
// lib/replay/layers.js).
//
// The camera is a pan/zoom view over the radar's image-pixel space (for
// layered packs: the COMBINED side-by-side extent) with
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
// Layer assignment + the T/⊥ elevation rules (pure — node-tested in
// src/lib/layers.test.js).
import { elevationFor, layerIndexForZ } from './layers.js';
import { slotStateAt } from './state.js';
import { bombEndTick, bombEvidenceAt, hasBombPos, actionIntervals, actionDurationTicks, actionProgressAt } from './bomb.js';
import { buildDropWindows } from './drops.js';
// The ONE round-boundary cleanup rule (ROUND_POLICY + entityEndTick) —
// setLandmarks precomputes its cutoffs beside killEnds/dropWins so no
// draw loop ever re-scans the round rows — plus the two boundary SCANS
// killEndTick delegates to (sameRoundEndTick / nextRoundStartTick).
import { ROUND_POLICY, entityEndTick, sameRoundEndTick, nextRoundStartTick } from './roundcut.js';
// fmt.js chatTag — the ONE chat display rule's tag spelling (drawChat).
// The seconds clock (fmtClock over tickSeconds) used to ride here too,
// aliased as fmtClockSecs for the bottom playback readout's `loop:`
// line — that readout moved to the DOM control group
// (Replay.svelte .rp-ctrl-list), which formats the SAME times through
// fmt.js itself; the renderer no longer owns any clock text.
import { chatTag } from '../fmt.js';

const CT_COLOR = '#5aa9e6';
const T_COLOR = '#e6a35a';
const OTHER_COLOR = '#9aa4b5';
// SECONDARY_TEXT — the canvas's neutral secondary-text tone: every HUD
// line after the first (hudBox), the kill feed's arrow fallback and the
// chat's message text all draw it — one spelling for the same color.
const SECONDARY_TEXT = '#8b94a7';
const TRAIL_FRAMES = 192; // ~3 s at 64 Hz
// Trail continuity: a trail segment is only drawn between two ADJACENT
// frames that are continuous — a bounded tick gap AND a bounded step —
// and only while the player actually MOVED fast enough (the
// TRAIL_MIN_SPEED gate below: slow/walking history draws no trail).
// Round resets and death→respawns teleport a player across the map
// between two otherwise-alive frames; without this rule the polyline
// connects through the teleport and draws one long streaking line from
// the old position back to spawn. The sidecar samples 1:1 with demo
// frames, so a normal gap is ~1 tick and a normal step is a few units.
const TRAIL_MAX_TICK_GAP = 8; // ticks — anything larger is a discontinuity
const TRAIL_MAX_STEP2 = 256 * 256; // world units² — human movement is ~8/frame
// Speed gate: a segment draws only when the player traversed it at
// ≥ TRAIL_MIN_SPEED horizontal units/sec. Slow/walking movement and
// standing jitter leave NO trail — history covered below the threshold
// contributes nothing (the polyline simply restarts once speed picks up
// again). It is a LOWER bound on the step (the teleport guard above is
// the upper one): at 64 Hz, gap 1, a drawn step is 2.11…256 units.
// Compared SQUARED (step² ≥ (v·gap/tickRate)²) so the predicate stays
// sqrt-free.
export const TRAIL_MIN_SPEED = 135; // units/sec — below this no trail is drawn
// Trail alpha BANDS — the approved batching tradeoff: the age-fade
// (1 − age) · 0.5 is quantized into TRAIL_BANDS steps and every segment
// of one band strokes on ONE path (one beginPath/stroke per band instead
// of one per segment — a late-match frame was up to ~1,900 strokes).
// The visual direction is unchanged: the fade still runs oldest → newest
// in the player's team color, at the band's CENTER alpha (always strictly
// below 0.5, so every "trails draw at ≤ 0.5" filter downstream keeps
// holding). Pure — head-tested in src/lib/renderer.test.js.
export const TRAIL_BANDS = 8;
const TRAIL_ALPHA_MAX = 0.5;
// trailBandIndex — a segment's age (0 = newest, 1 = the window's oldest)
// → its band: 0 is the oldest/faintest, TRAIL_BANDS − 1 the newest.
export function trailBandIndex(age) {
  return Math.max(0, Math.min(TRAIL_BANDS - 1, Math.floor((1 - age) * TRAIL_BANDS)));
}
// trailBandAlpha — a band's representative alpha (its CENTER).
export function trailBandAlpha(band) {
  const b = Math.max(0, Math.min(TRAIL_BANDS - 1, Math.floor(band)));
  return ((b + 0.5) / TRAIL_BANDS) * TRAIL_ALPHA_MAX;
}
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 8;
// --- Smart camera (the DEFAULT mode) -----------------------------------------
// Keeps every alive player + the active bomb on screen at all times,
// easing toward a fitted target each frame (never snapping).
const SMART_MARGIN = 56; // CSS px of breathing room around the entities —
//                        // the FULL-SIZE value (the ceiling of the
//                        // size-aware smartMarginFor below; identical
//                        // framing at every canvas ≥ the reference)
const SMART_MARGIN_REF = 480; // px short side at/above which the margin is exactly SMART_MARGIN
const SMART_MARGIN_MIN = 10; // px floor — even a tiny canvas keeps some padding
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
// LIFETIME_S_BY_BUCKET — the roundcut 'area' policy's OWN lifetime per
// bucket (entityEndTick takes min(lifetime, round cut), so a smoke whose
// 18 s would outrun its round dies with the round instead). The only two
// 'area' buckets in ROUND_POLICY — an 'area' bucket without an entry here
// would be round-cut but never lifetime-capped (none exists today).
const LIFETIME_S_BY_BUCKET = { smoke: SMOKE_LIFETIME_S, fire: FIRE_LIFETIME_S };
const FIRE_RADIUS = 130; // world units
const SMOKE_RADIUS = 144;
// Detonated-smoke TINT — the lingering area AND its detonation bloom ring
// read the THROWER's side (smokeColorRGB below) instead of neutral gray:
// the team color blended 50/50 with the existing smoke gray, so a known
// side is clearly CT/T while still reading as smoke (desaturated blue-gray
// / warm gray-orange), at the SAME alphas as before. Concrete blends:
//   CT  (90,169,230) #5aa9e6 ⊕ (180,190,205) → (135,180,218)
//   T   (230,163,90) #e6a35a ⊕ (180,190,205) → (205,177,148)
// An UNRESOLVABLE thrower keeps SMOKE_GRAY exactly — a side is never
// guessed (the repo's no-guessed-fallback rule).
const SMOKE_GRAY = '180, 190, 205'; // rgba base — the neutral/unknown tint
const SMOKE_CT = '135, 180, 218'; // 50% CT color + 50% smoke gray
const SMOKE_T = '205, 177, 148'; // 50% T color + 50% smoke gray
// --- World-layer effect windows (all TICK-derived — seek-correct) -----------
const TRAVEL_S = 0.1; // tracer TRAVEL — demo seconds for the dash to slide
//                     // origin → destination. Chosen "very quick" (the
//                     // spec's 0.08–0.15 s band): 6.4 ticks at 64 Hz ≈
//                     // 6 demo frames — reads as a shot streak, every
//                     // frame shows a distinct head position (no
//                     // teleport, no slow crawl), and it is the tracer's
//                     // WHOLE lifetime: a miss fades to 0 exactly at
//                     // arrival, a hit stops drawing at progress ≥ 1.
//                     // (The old 0.22 s static window retired with the
//                     // solid line.)
const TRACER_DASH_PX = 14; // px — the dash's LENGTH along its path: inside
//                         // the 10–16 px "short dash" band, ~1/6 of the
//                         // 85 px bullet reach, so the head/tail motion
//                         // reads as movement rather than a stub.
const TRACER_UNKNOWN = '#ffffff'; // stroke when the shooter's side is
//                                 // unresolvable — WHITE, a side is
//                                 // NEVER guessed (the old neutral
//                                 // tracer color)
const DAMAGE_FLASH_S = 0.35; // victim-hit flash window after a damage event
// Bullet TRACER: a SHORT dash (TRACER_DASH_PX) riding the shot's PATH
// from the FIRE POSITION (dark 4 px underlay + side-color 2 px top,
// strokeTracer): its head slides origin → r + MUZZLE_REACH along that
// frame's yaw over TRAVEL_S of demo time — pure tick math, so the
// travel is seek-correct and frozen while paused like every other world
// effect. A MISS fades out on the way to the end point (linear
// 1 − progress: exactly 0 at arrival); the stroke is the SHOOTER's side
// color at row.frame (CT blue / T amber via teamColor; an unresolvable
// side is white — never guessed). WHICH bullets animate: ALL of them —
// the `draw` selection (semi every shot, auto first + every 3rd) lived
// in bullets.js and was retired by spec ("every third tracer" rule
// gone); gun-only and freeze-time filtering still happen there — the
// renderer re-derives or re-gates none of it.
const MUZZLE_REACH = 76; // px from the tracer's ORIGIN (the fire position) —
//                        // the reach was doubled twice over its history
//                        // (was 38, before that 20; the original ray
//                        // stopped at r+14)
const DOT_R = 9; // px — the player dot's radius: drawPlayers paints the
//                // dot at it and the bullet tracer measures its reach
//                // r + MUZZLE_REACH from the fire position with it
// Talking bloom (voiceBloom): a white ring expanding OUTWARD FROM THE
// DOT'S CENTER and fading, looping while the player speaks — the
// flashbang-detonation style, anchored at the dot. All tick-derived.
// It is painted FIRST in drawPlayers — BENEATH the chevron, fill and
// rim — so the dot sits on top of its own bloom.
const VOICE_BLOOM_PERIOD_S = 0.85; // s — one bloom loop (pure tick math)
const VOICE_BLOOM_MIN_R = 3; // px — the ring's start radius (inside the dot)
const VOICE_BLOOM_MAX_R = 10; // px — growth past the dot edge (→ r + 10)
const VOICE_BLOOM_MAX_A = 0.9; // the bloom's start alpha (fades to 0)
const BLIND_SOLID_FRACTION = 0.25; // share of a blind's window the overlay
//                                  HOLDS at its peak before it fades
//                                  back to the team color
const BLIND_PEAK_ALPHA = 0.6; // the flash overlay's PEAK alpha: the dot
//                              gets LIGHTER (the team color still shows
//                              through) — never a solid white disc
const DEATH_X_HALF = 7; // px — half-diagonal of a death marker
// Plant/defuse PROGRESS ring (drawPlayers, after the follow ring): a
// partial arc around the arming planter / defusing CT. The color names
// the ACTION, never the player's side: RED while planting, GREEN while
// defusing (the defuse green is style.css's --success).
const ACTION_RING_R = DOT_R + 4; // px — radius (inside the follow ring's r+5)
const ACTION_RING_W = 3; // px — stroke width (round caps)
const ACTION_RING_PLANT = '#ff4d4d';
const ACTION_RING_DEFUSE = '#4caf7d';
const BOMB_ICON_PX = 12; // px — the extracted C4 icon's screen size
const DOT_C4_ICON_PX = 10; // px — the carried-C4 badge on a player dot
const NADE_ICON_PX = 16; // px — the extracted utility icon's screen size
// Drop-layer marker sizes (drawDrops) — the same fixed-screen-size,
// aspect-preserving convention as BOMB_ICON_PX/NADE_ICON_PX: guns sit
// slightly under a nade so a cluster of dropped guns stays readable,
// and a dropped util IS a grenade icon (NADE_ICON_PX — the same art
// drawGrenades paints), never side-tinted.
const DROP_GUN_ICON_PX = 14;
const DROP_UTIL_ICON_PX = NADE_ICON_PX;
// DROP_KIT_ICON_PX — the dropped DEFUSE KIT's marker size: the drop
// family's gun size (a kit is a body-sized ground item, not a
// grenade), never the nade's. Its VISUAL language is the owner's kit
// rule — a plain white icon + the elevation indicator behind it, the
// same neutral treatment the dropped C4 gets MINUS its ring/pulse/dash
// (see drawDrops: the throbber stays C4's alone).
const DROP_KIT_ICON_PX = 14;
const DROP_AMMO_GAP = 11; // px — gun icon's bottom edge → the ammo baseline
const DROP_AMMO_ELEV = 5; // px — extra baseline drop when an elevation bar
//                            sits below the marker (the name-label's
//                            ELEV_NAME_DROP trick, same clearance rule)
// --- Radar layers (multi-floor packs — meta.layers) ---------------------------
const LAYER_GAP = 32; // image px between side-by-side layer panels: the
//                     // camera space spans the combined extent, so the
//                     // gutter scales with zoom like the panels do
// --- Elevation indicators (T / ⊥ — CS2.md "Radar elevation indicators") -------
// Fixed CSS-px geometry: the marks never scale with zoom, so they stay
// legible at every camera level. Orientation is the SETTLED CS2 rule:
// entity ABOVE the level → ⊥ (bar at the bottom, stem up) drawn BELOW
// the marker; entity BELOW → T (bar on top, stem down) drawn ABOVE it —
// the flat bar reads as the LEVEL relative to the entity (the game's own
// .PI_Above y:8px / .PI_Below y:−8px placement), scaled up for our
// fixed-size dots.
// Geometry (user-defined 2026-11-08): the mark is drawn BY HAND on the
// canvas — the extracted Valve glyph (map_bomb_above/below) looked poor
// and the ⊥/T text glyphs are font-dependent — as two monoline strokes:
// a STEM from the entity's CENTER outward ELEV_IND_STEM px, terminated
// by the flat BAR. The caller paints this BEFORE the entity, so the dot
// covers the stem's first DOT_R px (a lower canvas level than the entity
// it belongs to). Size (user-tuned 2026-11-08): roughly HALF the first
// iteration — a 13 px bar on a 2 px monoline. Vertical extent halved the
// same day (ELEV_IND_STEM 27 → 13.5, user request): the ⊥ bar now lands
// ~cy+12.5..14.5 — tucked between the dot's edge (cy+9) and the name
// baseline (cy+r+13 ≈ cy+22), so the name text (painted after, over the
// stem in drawPlayers) would draw across the bar's top — drawPlayers now
// drops that label ELEV_NAME_DROP when a mark is drawn — and the T bar
// lands ~cy−14.5..−12.5, clear above the dot. The BAR WIDTH stays 13:
// only the stem (the up/down extent that distinguishes ⊥ from T) was
// halved.
const ELEV_IND_STEM = 13.5; // px — entity CENTER → the bar's centre line
//                        // (HALVED from 27 on 2026-11-08 — see above)
const ELEV_IND_BAR_W = 13; // px — the flat BAR's width (the "level" line)
const ELEV_IND_BAR_T = 2; // px — monoline weight: the bar's thickness AND
//                        // the stem's width (the dark halo is +2 on both)
const ELEV_NAME_DROP = 5; // px — drawPlayers drops the player name label
//                        // by this much ONLY when the slot's elevation
//                        // mark is drawn (either direction — the rule is
//                        // "a mark is present"). Derived from the ⊥ bar:
//                        // its body bottom is cy + ELEV_IND_STEM +
//                        // ELEV_IND_BAR_T/2 = cy+14.5 (the dark halo
//                        // reaches cy+15.5), while the 11 px label's top
//                        // ≈ baseline − 11 sits at cy+11 at the plain
//                        // baseline cy+r+13 (DOT_R 9 → cy+22); +5 moves
//                        // it to ≈ cy+16 — ~1.5 px of air below the bar
//                        // (and clear of the halo). No mark → no drop.
const ELEV_IND_TINT = '#d0d6e0'; // neutral light body (the game's #CCC) —
//                                // never a team color; the dark halo pass
//                                // gives it contrast on radar + light theme
const KILL_MARKER_FALLBACK_S = 180; // s — death-X cleanup when the round's
//                                    round_end row was never loaded
//                                    (longer than any round: it can
//                                    never cut a live round short)
// --- Kill feed (drawKillFeed — the top-right overlay) ------------------------
const KILL_FEED_MAX = 6; // entries shown — the NEWEST 6 (the cap drops the
//                          OLDEST, so a new kill never evicts a fresh row)
const KILL_FEED_LH = 18; // px per entry line (the box's HEIGHT)
const KILL_FEED_PITCH = 22; // px between entry TOPS: the 18 px box + a
//                            4 px gap — entries must not stack touching
const KILL_FEED_EDGE = 8; // px from the stage's edge: top/right for the
//                          feed, bottom/left for the chat (drawChat)
const KILL_FEED_INSET = 6; // px of padding inside an entry
const KILL_FEED_GAP = 12; // px of breathing room between EVERY pair of cells
//                        on a row (name ↔ glyph ↔ name). An image cell
//                        reserves its PAINTED width (KILL_FEED_ICON ·
//                        iconAspect + the 1 px halo drawIcon adds each
//                        side — iconAspect/drawIcon), so a wide sprite
//                        (AWP, aspect 3.4) gets the same 12 px margin on
//                        BOTH sides instead of punching through into the
//                        names; 8 px still read as the mark hugging the
//                        names, so the mark got its own beat on both sides
const KILL_FEED_ICON = 14; // px — a feed image's HEIGHT on a line (the
//                          weapon/indicator art); its width follows
//                          iconAspect, never a 1:1 squash
const KILL_FEED_R = 4; // px — entry corner radius (hudBox uses 6)
// KILL_FEED_FONT — the feed AND chat entry font: both overlays read
// identically (killFeedLayout's measure pass sets it, both paint passes
// set it again), so there is one spelling of the entry text style.
const KILL_FEED_FONT = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
// The four scoped sniper rifles: the noscope indicator only applies to
// them. The game's noscope flag may already be gated this way, but the
// spec names exactly these four — belt and braces, one list here.
const NOSCOPE_WEAPONS = new Set(['AWP', 'SSG 08', 'SCAR-20', 'G3SG1']);
// --- Chat (drawChat — the bottom-left overlay) --------------------------------
// The chat REUSES the kill feed's entry geometry (KILL_FEED_MAX/LH/
// PITCH/EDGE/INSET/R): it must look exactly like the feed — same box
// height, pitch, inset, corner radius, dark fill and hairline border —
// only the anchoring differs (the stage's BOTTOM-left corner, the
// NEWEST message at the bottom, growing upward).
const CHAT_MAX = KILL_FEED_MAX; // visible messages — one stack cap for both entry overlays
// message text draws SECONDARY_TEXT (the HUD's neutral secondary tone —
// the kill feed's fallback arrow already uses it on this same background)
const CHAT_MAX_W = 0.4; // share of cssW one entry may span before the
//                        message text is cut with an ellipsis

function teamColor(side) {
  if (side === 'ct') return CT_COLOR;
  if (side === 't') return T_COLOR;
  return OTHER_COLOR;
}

// sideFromFlags — THE canonical per-frame side rule:
// the q16 side bits (flags bits 2-3: 1 = t, 2 = ct) with a
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

// trailConnects — the pure continuity + speed rule drawTrails applies
// per segment: does the trail draw between frame f and f+1 of one slot?
// `ticks` is the store's tick array, `pos` that slot's interleaved
// Float32Array [x, y, z, yaw] per frame, `tickRate` the engine's ticks
// per second (REQUIRED — it converts the gap into seconds for the
// TRAIL_MIN_SPEED gate; there is deliberately no default, so a stale
// call can never draw un-gated trails: a missing/invalid rate fails
// closed). False breaks the polyline here (teleport / stalled sampling /
// movement slower than TRAIL_MIN_SPEED); the chain restarts at the next
// segment, so trails across a round reset or a death→respawn never
// connect — the first post-respawn segments start fresh at spawn — and
// history covered slow/walking (or standing still) contributes no trail
// at all. Pure, no side effects. Exported for the headless test in
// src/lib/renderer.test.js.
export function trailConnects(ticks, pos, f, tickRate) {
  if (f < 0 || f + 1 >= ticks.length) return false;
  const gap = ticks[f + 1] - ticks[f];
  if (gap <= 0 || gap > TRAIL_MAX_TICK_GAP) return false;
  if (!(tickRate > 0)) return false; // fail closed — never an ungated trail
  const b = f * 4;
  const pb = (f + 1) * 4;
  const dx = pos[b] - pos[pb];
  const dy = pos[b + 1] - pos[pb + 1];
  const step2 = dx * dx + dy * dy;
  // Speed gate (BOUNDARY IS ≥): horizontal speed over the segment is
  // step / (gap / tickRate), so drawing requires
  //   step ≥ TRAIL_MIN_SPEED · gap / tickRate
  // squared to stay sqrt-free: step2 ≥ (TRAIL_MIN_SPEED·gap/tickRate)².
  const minStep = (TRAIL_MIN_SPEED * gap) / tickRate;
  if (step2 < minStep * minStep) return false; // too slow — no trail here
  return step2 <= TRAIL_MAX_STEP2; // …and no streaking across a teleport
}

// smartMarginFor — the smart camera's SIZE-AWARE breathing room (pure;
// head-tested in renderer.test.js beside smartCamTarget's pins): derived
// from the canvas dimensions ALONE — the renderer never needs to know
// it is a dock.
// The fixed 56 px framed full-size stages perfectly but ate a
// proportionally huge slice of the mini-player dock's ~320×190 frame
// (56 px per side left only 78 of 190 px vertically — the radar sat
// needlessly zoomed out). Formula:
//   margin = clamp(SMART_MARGIN * shortSide / SMART_MARGIN_REF,
//                  SMART_MARGIN_MIN, SMART_MARGIN)
// — a linear scale over the canvas's SHORT side that converges to
// EXACTLY today's 56 px at the 480 px reference and above (full-size
// behavior is bit-identical — the existing large-size pins stay green),
// tightens below it (~22 px at the dock's 190 px short side, lifting
// the dock's vertical room from 78 to ≈146 px), and never drops under
// the 10 px floor. Stateless by construction: same canvas → same
// margin, wherever that canvas lives.
export function smartMarginFor(cssW, cssH) {
  const short = Math.max(1, Math.min(cssW, cssH));
  if (!Number.isFinite(short)) return SMART_MARGIN; // degenerate input → the full-size value
  return Math.max(
    SMART_MARGIN_MIN,
    Math.min(SMART_MARGIN, (SMART_MARGIN * short) / SMART_MARGIN_REF),
  );
}

// smartCamTarget — the smart camera's FIT algorithm (pure; head-tested
// in renderer.test.js). `box` is the entity bounding box in IMAGE px,
// cssW/cssH the canvas size, cfg { margin, minZoom, maxZoom, extW, extH }.
// Returns the target camera state { cx, cy, s } where s is the ABSOLUTE
// scale (screen px per image px = cam.fit * cam.zoom): the box is padded
// by `margin` on every side (cfg override; the default is the
// size-aware smartMarginFor above) and scaled to fit the canvas
// (clamped to the smart zoom band), then the center is clamped so a
// view that FITS INSIDE the image extent never shows void outside it —
// a view wider than the image centers on the image instead (the
// entities are inside the image either way, so they stay on screen).
export function smartCamTarget(box, cssW, cssH, cfg = {}) {
  const margin = cfg.margin ?? smartMarginFor(cssW, cssH);
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

// flightSplits — where a grenade THROW→DETONATE flight changes radar
// LAYERS, as [{t0, t1, layer}] spans over the flight parameter t ∈ [0,1]
// (t0/t1 inclusive ends, ascending; spans tile the whole flight). A nade
// CAN cross floors — a player at Nuke's bottom ramp throws to top ramp —
// and one dashed line drawn panel-to-panel would cross the gutter and lie
// about where the nade is, so the renderer draws ONE segment per span,
// each on the floor it belongs to (a same-floor flight is a single span
// = exactly the old one-segment line).
//
// The math: z interpolates linearly (the same zFlight the flight icon
// rides) and the bands are intervals, so the layer can only change at a
// band edge — solve z(t)=edge for every panel edge, keep the interior
// solutions, then merge consecutive spans whose midpoint-evaluated layer
// agrees. A release exactly ON an edge is an instant crossing: the
// origin dot keeps the entity's own layer (its z), the flight spans start
// on the side the flight travels to. Unknown z on either end → ONE span
// on the known end's layer (default when both are unknown) — the same
// rule the flight icon uses, never a guessed split. Pure — node-tested.
export function flightSplits(z0, z1, panels) {
  const list = Array.isArray(panels) && panels.length ? panels : [null];
  const both = Number.isFinite(z0) && Number.isFinite(z1);
  if (!both) {
    const layer = layerIndexForZ(Number.isFinite(z0) ? z0 : z1, list);
    return [{ t0: 0, t1: 1, layer }];
  }
  const bounds = [0];
  if (z0 !== z1) {
    for (const p of list) {
      if (!p) continue;
      for (const edge of [p.zMin, p.zMax]) {
        if (!Number.isFinite(edge)) continue;
        const t = (edge - z0) / (z1 - z0);
        if (t > 0 && t < 1) bounds.push(t);
      }
    }
    bounds.sort((a, b) => a - b);
  }
  bounds.push(1);
  const spans = [];
  let start = 0;
  let startLayer = layerIndexForZ(z0, list); // the throw's own layer — the dot's panel
  for (let i = 0; i < bounds.length - 1; i++) {
    const tm = (bounds[i] + bounds[i + 1]) / 2;
    const layer = layerIndexForZ(z0 + (z1 - z0) * tm, list);
    if (layer !== startLayer) {
      spans.push({ t0: bounds[start], t1: bounds[i], layer: startLayer });
      start = i;
      startLayer = layer;
    }
  }
  spans.push({ t0: bounds[start], t1: bounds[bounds.length - 1], layer: startLayer });
  return spans;
}

// rowEntity — the projectile entity id a grenade row carries (extract
// stamps it into detail_json for grenade_throw / grenade / grenade_bounce
// rows; the view hydrates it onto the row as `entity`). 0 = unknown —
// never a guess. Pure.
function rowEntity(r) {
  const e = Number(r && r.entity);
  return Number.isFinite(e) && e > 0 ? e : 0;
}

// joinBounceVerts — THE throw → bounces → detonation vertex join for one
// flight (pure; setLandmarks calls it once per paired throw). Returns the
// vertex list [throw, bounce₁…bounceₙ, det] in tick order — drawGrenades
// then walks it segment by segment (per-segment constant speed, one
// flightSplits pass per segment).
//
// JOIN RULE, in order:
//  1. ENTITY (preferred): the projectile entity id all three row kinds
//     carry in detail_json (extract's grenadeThrown / grenadeBlast /
//     grenadeBounced — the SAME id on every side, measured 979/979 on
//     golden). A bounce joins only when BOTH sides carry an id and they
//     AGREE — a mismatch is a different projectile and never joins.
//  2. FALLBACK (entity missing on either side): the EXISTING pairing
//     rule — same round + same weapon (sameUtilityWeapon — Molotov ≡
//     Incendiary) inside the [throw, det] tick window. Bounce rows carry
//     NO thrower (extract stores none — agg.grenadeBounced stamps no
//     attacker), so the thrower half of that rule is unavailable by
//     construction; the same-round window is what keeps the fallback
//     from wandering (never guess wildly — same-round only).
// Rows outside the window or in another round never join. `to` may be
// null (an unpaired throw) — the list then ends at the last bounce and
// the draw side still draws no flight (its `to` gate), exactly as
// before. Pure — unit-tested by src/lib/renderer.test.js.
export function joinBounceVerts(from, to, bounces) {
  if (!from || !Number.isFinite(from.tick)) return [];
  const verts = [from];
  const chain = rowEntity(from) || rowEntity(to);
  const round = Number.isFinite(from.round) ? from.round : null;
  const hi = to && Number.isFinite(to.tick) ? to.tick : Infinity;
  const cands = [];
  for (const b of bounces || []) {
    if (!b || !Number.isFinite(b.tick)) continue;
    if (b.tick < from.tick || b.tick > hi) continue;
    if (round != null && Number.isFinite(b.round) && b.round !== round) continue;
    cands.push(b);
  }
  cands.sort((a, b) => a.tick - b.tick);
  for (const b of cands) {
    const e = rowEntity(b);
    if (chain > 0 && e > 0) {
      if (e !== chain) continue; // another projectile's bounce
    } else if (!sameUtilityWeapon(from.weapon, b.weapon)) {
      continue; // the fallback rule (see above)
    }
    verts.push(b);
  }
  if (to) verts.push(to);
  return verts;
}

// flightPointAt — the flight icon's world position at `tick` over a
// vertex list (pure; the renderer draws the icon here and the tests pin
// the geometry through it). The segment CONTAINING the playhead is
// interpolated at a PER-SEGMENT constant speed (progress is pure tick
// math inside that segment), so the icon arrives EXACTLY at each
// recorded bounce tick — the bounce sound and the icon land together. A
// segment whose ends share a tick (or has no usable end) snaps to its
// START vertex — a division by zero never happens and nothing is
// invented. Past the last vertex the point HOLDS at that vertex: after
// the last bounce the path to the detonation has ≈0 length, so the icon
// rests until the detonation pops. Returns {x, y, z} or null (no usable
// vertex — the caller falls back to the origin dot).
export function flightPointAt(verts, tick) {
  if (!Array.isArray(verts) || !verts.length || !Number.isFinite(tick)) return null;
  let i = 0;
  for (let k = 0; k + 1 < verts.length; k++) {
    const a = verts[k];
    if (a && Number.isFinite(a.tick) && tick >= a.tick) i = k;
  }
  const v0 = verts[i];
  if (!v0 || !Number.isFinite(v0.x) || !Number.isFinite(v0.y)) return null;
  const v1 = verts[i + 1];
  const usable =
    v1 &&
    Number.isFinite(v1.x) &&
    Number.isFinite(v1.y) &&
    Number.isFinite(v0.tick) &&
    Number.isFinite(v1.tick) &&
    v1.tick > v0.tick;
  if (!usable) return { x: v0.x, y: v0.y, z: v0.z }; // hold at the vertex
  const p = Math.max(0, Math.min(1, (tick - v0.tick) / (v1.tick - v0.tick)));
  const z =
    Number.isFinite(v0.z) && Number.isFinite(v1.z)
      ? v0.z + (v1.z - v0.z) * p
      : Number.isFinite(v0.z)
        ? v0.z
        : v1.z; // unknown z on one end keeps the known one (never a guess)
  return { x: v0.x + (v1.x - v0.x) * p, y: v0.y + (v1.y - v0.y) * p, z };
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
// `out` (optional) is a 3-slot point array to fill instead of allocating
// one per dot per frame (drawPlayers' chevScratch); omit it for an owned
// value — the pre-scratch contract every test uses.
export function chevronPath(cx, cy, angleRad, size, out) {
  const s = Math.max(0, Number(size) || 0);
  const back = s * 0.4; // how far the arm ends sit back from the apex
  const spread = s * 0.5; // their perpendicular half-spread
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const pts = out && out.length >= 3 ? out : [[0, 0], [0, 0], [0, 0]];
  // The three local-frame points (arm-end-left, APEX, arm-end-right:
  // +x along the look direction, +y to its right) written straight into
  // `pts` — no intermediate arrays, so the hot path allocates nothing.
  let lx = s - back;
  let ly = -spread;
  pts[0][0] = cx + lx * cos - ly * sin;
  pts[0][1] = cy + lx * sin + ly * cos;
  lx = s;
  ly = 0;
  pts[1][0] = cx + lx * cos - ly * sin;
  pts[1][1] = cy + lx * sin + ly * cos;
  lx = s - back;
  ly = spread;
  pts[2][0] = cx + lx * cos - ly * sin;
  pts[2][1] = cy + lx * sin + ly * cos;
  return pts;
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

// muzzleRays — the tracer geometry: `count` short radial ticks fanned
// ±`spreadRad` around the look direction, each from `inner` to `outer`
// screen px out from the ORIGIN point (outer > inner; a degenerate size
// yields no rays). Returns count [x1, y1, x2, y2] segments. Pure —
// head-tested in src/lib/renderer.test.js; the bullet tracer builds its
// PATH with count=1, spread=0 — from the fire position out
// r+MUZZLE_REACH along the shot's yaw (drawBulletTracers) — and the
// traveling dash (strokeTracer) rides that path.
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
// effects (e.g. the damage flash): 1 at the event's tick, linear
// decay to 0 at `durS` seconds of DEMO time, 0 outside the window
// (before the event — a scrub past it — and after it). Pure, tick-only:
// seek-correct by construction and self-clearing (nothing to reset).
// (The tracers no longer window through it — their lifetime is the
// TRAVEL_S travel, see strokeTracer/tracerProgress.)
// `tickRate <= 0` or a non-finite start yields 0 (never a stuck flash).
export function windowAlpha(tick, startTick, tickRate, durS) {
  if (!Number.isFinite(tick) || !Number.isFinite(startTick)) return 0;
  if (!(tickRate > 0) || !(durS > 0)) return 0;
  const age = (tick - startTick) / tickRate;
  if (age < 0 || age >= durS) return 0;
  return 1 - age / durS;
}

// blindAlpha — THE flash-overlay envelope for a blinded player's dot:
// the overlay reaches BLIND_PEAK_ALPHA (0.6 — the dot gets LIGHTER, the
// team color still reads through, never a solid white disc) and HOLDS
// there for the first BLIND_SOLID_FRACTION of the blind's `ms` window,
// then fades linearly back to the normal color until the window closes.
// Pure and tick-derived exactly like windowAlpha — seek-correct in both
// directions (scrubbing backwards into the window re-renders the same
// overlay, nothing is sticky). Returns an alpha in
// [0, BLIND_PEAK_ALPHA]; `tickRate <= 0`, a non-finite start or a
// non-positive ms → 0.
export function blindAlpha(tick, startTick, tickRate, ms) {
  if (!Number.isFinite(tick) || !Number.isFinite(startTick)) return 0;
  if (!(tickRate > 0) || !(ms > 0)) return 0;
  const ageMs = ((tick - startTick) / tickRate) * 1000;
  if (ageMs < 0 || ageMs >= ms) return 0;
  const k = ageMs / ms;
  if (k <= BLIND_SOLID_FRACTION) return BLIND_PEAK_ALPHA;
  return BLIND_PEAK_ALPHA * (1 - (k - BLIND_SOLID_FRACTION) / (1 - BLIND_SOLID_FRACTION));
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
// drawPlayers BENEATH the dot (it paints the bloom first, before the
// chevron/fill/rim — the dot sits on top of its bloom).
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

// shotBloom — the EVENT-ANCHORED twin of voiceBloom (exported next to
// it on purpose): the SAME white-bloom recipe — identical
// VOICE_BLOOM_* constants, identical { k, radius, alpha } shape — but
// the phase runs from an EVENT tick (age = (tick − shotTick)/tr) instead
// of the clock-global loop, and it is SINGLE-CYCLE: one bloom per sound,
// returning null before the shot and once VOICE_BLOOM_PERIOD_S of demo
// time has passed (nothing loops after the sound, nothing is sticky
// across a scrub — a scrub into the window re-renders the same phase).
// `anchorR` is the anchor's radius (the dot's r for a player, half the
// decoy icon for a fake gunshot — the decoy plan draws these). Pure —
// head-tested in src/lib/renderer.test.js; drawn by drawGrenades.
export function shotBloom(tick, startTick, tickRate, anchorR) {
  if (!Number.isFinite(tick) || !Number.isFinite(startTick) || !(tickRate > 0)) return null;
  if (!Number.isFinite(anchorR) || !(anchorR > 0)) return null;
  const age = tick - startTick;
  if (age < 0) return null; // before the sound — nothing to bloom
  const period = VOICE_BLOOM_PERIOD_S;
  const secs = age / tickRate;
  if (secs >= period) return null; // the one cycle is over
  const k = secs / period;
  return {
    k,
    radius: VOICE_BLOOM_MIN_R + k * (anchorR + VOICE_BLOOM_MAX_R - VOICE_BLOOM_MIN_R),
    alpha: VOICE_BLOOM_MAX_A * (1 - k),
  };
}

// fireJump — the seek/frame-jump detector — was removed with the
// attack-edge firing indicator: tracers no longer arm from state edges
// (bullets.js's pre-derived rows are seek-correct by construction —
// nothing to re-seed across a scrub). Shot derivation and its own
// continuity rules are pinned by src/lib/bullets.test.js.

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
// the demo without ever cutting a live round short.
//
// The two boundary SCANS are delegated to roundcut.js (sameRoundEndTick /
// nextRoundStartTick — the primitives roundCutTick composes), so this
// rule and the round-cut cleanup of roundcut.js can never drift. What
// stays here is the MIN between the two: killEndTick is pinned to it by
// its characterization test (a same-round round_end landing AFTER the
// next round's start must still lose to that start) — behavior pins win
// over consolidation, so the roundCutTick ELSE semantics is NOT adopted
// here. Pure — head-tested in src/lib/renderer.test.js; drawn by
// drawDeaths.
export function killEndTick(row, tickRate, roundEnds, roundStarts) {
  if (!row || !Number.isFinite(row.tick)) return 0;
  const tr = tickRate > 0 ? tickRate : 64;
  const end = sameRoundEndTick(row, roundEnds);
  const next = nextRoundStartTick(row.tick, roundStarts);
  if (end === null && next === null) return row.tick + KILL_MARKER_FALLBACK_S * tr;
  if (end === null) return next;
  if (next === null) return end;
  return Math.min(end, next);
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

// ellipsize — THE string cut rule: trim `text` to at most `maxW` pixels
// (measured by `measure`), appending '…' when anything was cut, one
// measurement per candidate. Two callers share it: drawChat's message
// body (with its ': ' head — the cut never widens the entry past
// CHAT_MAX_W) and drawHUD's team names (C1 — the score box's gap clamp
// above). Returns '' when not even the ellipsis fits, so no caller can
// paint past its budget; the degenerate tail is the one behavior the
// chat's inline loop shared differently (it kept ': …' over budget) —
// nothing that wide is reachable at any supported stage width.
function ellipsize(text, maxW, measure) {
  if (!(maxW > 0)) return '';
  if (measure(text) <= maxW) return text;
  for (let k = text.length - 1; k >= 0; k--) {
    const out = text.slice(0, k) + '…';
    if (measure(out) <= maxW) return out;
  }
  return '';
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

// defaultPanel — one radar PANEL (see the panels state in
// createRenderer): the default layer with no Z band (indicators come
// from elevation_regions only — a panel never carries thresholds) and
// offset 0. Used for the pre-layers initial state, the
// single-panel pack, and the no-pack grid fallback; reproject() rebuilds
// richer panels from packTf.layers when the pack has them.
function defaultPanel(offsetX, width, height, tf, img) {
  return {
    id: 'default',
    name: null,
    zMin: null,
    zMax: null,
    img: img || null,
    tf: tf || { pos_x: 0, pos_y: 0, scale: 1 },
    offsetX,
    width,
    height,
  };
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
  //                    pack→{posX,posY,scale,width,height,layers,…} derivation
  let radar = null; // Image, when the pack ships one
  let layerImgs = []; // per-layer Images parallel to packTf.layers (index 0
  //                    // is the default layer's radar.png); [] when the
  //                    // caller passes none (setPack falls back to `radar`)
  // Radar PANELS — one per layer, laid side by side inside this one
  // canvas (multi-floor packs), rebuilt by reproject() from packTf.
  // Single-layer packs build exactly ONE panel at offsetX 0, so every
  // combined-space number below equals the pre-layers geometry.
  // Shape: {id, name, zMin, zMax, img, tf:{pos_x,pos_y,scale},
  //         offsetX, width, height}.
  let panels = [
    defaultPanel(0, 1024, 1024),
  ];
  let regions = []; // pack elevation_regions (world-space boxes) — see
  //                  // lib/replay/layers.js elevationFor; [] when absent
  let landmarks = [];
  let polylines = []; // grenade throw→…→detonate flights ({from, to, verts})
  let dets = []; // grenade detonations
  let lands = []; // grenade LANDINGS (bucket 'land' — the decoy's rest
  //                // activation row; a throw pairing candidate, NEVER a
  //                // detonation: it feeds no visual of its own)
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
  // roundStarts rides along: bombEvidenceAt's round scope is the
  // canonical roundcut.js roundCutTick (round_end, else next round_start).
  let bombEv = { drops: [], pickups: [], plants: [], roundEnds: [], roundStarts: [] };
  // The death-drop evidence (lib/replay/drops.js dropEvidenceAt) —
  // weapon_drop / weapon_pickup rows in their OWN 'wdrop'/'wpickup'
  // buckets, never mixed with the C4 lists above. roundEnds/roundStarts
  // are shared with the bomb bundle (one boundary row serves every
  // consumer; roundcut.js is the one terminator home).
  let wdrops = [];
  let wpickups = [];
  let wdropEv = { drops: [], pickups: [], roundEnds: [], roundStarts: [] };
  // Derived INDICES over the match-static rows (both rebuilt in
  // setLandmarks, both pure lookups at draw time):
  //   dropWins — each drop row → its visibility window (drops.js
  //              dropWindow, the SAME rule dropEvidenceAt answers), so
  //              drawDrops is an O(1) test per row instead of a
  //              rescanning query per row per frame;
  //   killEnds — each kill row → its death-X cutoff (killEndTick), so
  //              drawDeaths is a Map read per kill instead of the
  //              O(rounds) terminator scan per kill per frame.
  let dropWins = new Map();
  let killEnds = new Map();
  // roundCuts — the unified round-boundary cutoffs (roundcut.js
  // ROUND_POLICY + entityEndTick), precomputed beside dropWins/killEnds
  // so no draw loop ever re-scans the round rows per frame:
  //   areaCuts  — 'area' policy rows (P1): min(own lifetime, round cut);
  //   popCuts   — 'pop' policy rows (P2): the next round_start only;
  //   decoyCuts — the decoy PLAN entries (the 'land' bucket's only draw
  //               site — the plan carries landTick, not a bucketed row).
  // Rebuilt by rebuildRoundCuts() from BOTH setLandmarks (rows and round
  // boundaries changed) and setDecoyPlan (the plan changed), so either
  // setter arriving last leaves all three consistent.
  let areaCuts = new Map();
  let popCuts = new Map();
  let decoyCuts = new Map();
  // The layer toggle: which drop categories draw at all (the toolbar's
  // Guns/Utility/Kits popover → setDropLayers; ALL OFF by default = the
  // feature is opt-in, matching the pref's unset state).
  let dropLayers = { guns: false, util: false, kits: false };
  // kitWins — the DEFUSE-KIT evidence windows (lib/replay/kits.js
  // buildKitEvidence: Map<kit drop row, {from, to}> — the nearest-death
  // back-propagation + buytime rule, precomputed once per push). Kit
  // rows deliberately do NOT read dropWins above: drops.js's
  // best-evidence rule hides a drop at ANY later same-name pickup,
  // which would let a mid-round kit BUY terminate a dropped kit. Empty
  // until setKitEvidence pushes the view's build — no evidence → no
  // kit marker, never a guessed window.
  let kitWins = new Map();
  // kitHasAt — the kit-POSSESSION probe from the same bundle (kits.js
  // buildKitEvidence's tri-state hasKitAt(steamId, tick) → true | false |
  // null), retained by setKitEvidence for the defuse ring's duration
  // (bomb.js actionDurationTicks: only an answered `true` buys the 5 s
  // denominator). null until evidence arrives / a match with no kit rows
  // → the ring reads NO kit (10 s), the conservative side.
  let kitHasAt = null;

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
  // older import with no state stream: the carried-C4 badge degrades to
  // nothing). Consumed through slotStateAt in drawPlayers (the badge);
  // tracers do NOT read it — they come from setBullets (bullets.js is
  // the one filter).
  let stateIndex = null;
  // Deaths (bucket 'kill') and damage ticks grouped by VICTIM slot —
  // both rebuilt by setLandmarks, both rendered as pure functions of
  // tick (see drawDeaths / drawPlayers' hit flash).
  let kills = [];
  let damages = []; // damages[slot] = [tick, …]
  // Plant/defuse ATTEMPT intervals grouped by the ACTOR's slot —
  // rebuilt by setLandmarks from bomb.js actionIntervals (THE one
  // interval rule — visibility only), rendered as a pure function of
  // tick by drawPlayers' progress ring (see drawActionRing; the arc's
  // FRACTION is elapsed over bomb.js actionDurationTicks' fixed game
  // duration, kit resolved at draw from setKitEvidence's hasKitAt). An
  // actor we cannot resolve to a slot has no dot to ring — skipped,
  // never guessed.
  let actionBySlot = new Map();
  // Decoy plan (setDecoyPlan — lib/replay/decoy.js buildDecoyPlan): the
  // rest-to-explosion rows ({landTick, detTick, x, y, side, weapon,
  // shots}) stored verbatim like `bullets` — pure data, redraw on set;
  // drawGrenades renders the rest icon + one white noise pulse per shot
  // as pure functions of tick (seek-correct, nothing sticky).
  let decoyPlan = [];
  // Hit-shot tracers (bucket 'damage'): the rows that can show a
  // shooter→victim segment — {tick, attacker, victim, x, y} with x/y the
  // row's stored VICTIM hit position (the shooter's position is read
  // from the stream at draw time, see drawHitTracers). Deduped on
  // (tick, attacker, victim) when built: a shotgun's pellet rows to the
  // SAME victim at the SAME tick are one line, a second victim gets her
  // own. Rebuilt by setLandmarks, rendered as a pure function of tick.
  let hitTracers = [];
  // Flash-white overlay (setBlinds): blinds[slot] = [{tick, ms}] — the
  // blind windows bucketed per victim slot, like `damages`. Rebuilt by
  // setBlinds, rendered as a pure function of tick (drawPlayers' white
  // overlay via blindAlpha), so any scrub is correct.
  let blinds = [];
  // In-game text chat (setChat): the RAW ChatRow rows ({tick, round,
  // steamId, name, text} — MatchService.GetChat with round -1 = all
  // rounds), stored verbatim like `blinds` (pure data, redraw on set):
  // drawChat scopes them to the round containing the playhead and
  // resolves each speaker's side itself at the message tick.
  let chats = [];
  // chatFitCache — the cut message + measured widths per chat row,
  // keyed `id|cssW` (see drawChat): invalidated wherever those inputs
  // change — setChat (new rows), resize (the stage width), setData (the
  // speaker's side feeds the head, and the head compare re-checks it).
  let chatFitCache = new Map();
  // steamId → slot, from the sidecar slot table (meta.players, slot
  // order) — resolves a kill/damage row's victim to the dot it marks.
  const slotOfSteam = new Map();
  (players || []).forEach((p, i) => {
    if (p && p.steamId) slotOfSteam.set(String(p.steamId), i);
  });
  // bullets: the tracer rows from setBullets ({tick, frame, slot,
  // weapon} — lib/replay/bullets.js deriveBullets output, stored
  // verbatim like `hitTracers`: pre-filtered (gun-only, freeze-time),
  // EVERY row rendered as a traveling dash in drawBulletTracers).
  // Cleared by setData (frame indices belong to the old dataset,
  // exactly like the landmark rows' assumptions about `store`).
  let bullets = [];
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
  let followZ = null; // their Z at that position — the panel the camera
  //                    // centers on for a multi-floor pack
  // Camera mode: 'smart' (the default — eases the view to keep every
  // alive player + the active bomb framed) or 'free' (manual pan/zoom).
  // Follow overrides both (explicit user intent) and smart resumes when
  // follow releases. Panning/zooming while smart takes over to free and
  // notifies the caller (onUserCamera) so its selector follows — the
  // pref keeps whatever the user picked there explicitly. The wheel
  // ZOOM is exempt while follow is engaged: it changes only the scale,
  // anchored on the followed player (see zoomAt).
  let camMode = 'free';
  let easeRaf = 0; // the smart settle loop's pending frame (0 = idle)
  let lastEaseT = 0; // last eased draw, for the dt of the next step
  let smartConverged = true;
  // The camera as of the LAST radar draw — drawRadar's motion signal for
  // the smoothing-quality policy (see drawRadar); null until the first
  // radar draw records it.
  const camSeen = { cx: null, cy: null, zoom: null };
  // Effective world→image transform + image extent, rebuilt by reproject()
  // from packTf (makeTransform's canonical derivation) or sample bounds.
  // `tf` is the SHARED map transform (the grid fallback's, and the value
  // every panel inherits unless a pack overrides one layer's transform);
  // extW/extH are the CAMERA'S extent — for a layered pack the COMBINED
  // side-by-side span (panels own their offsets). The numeric fields —
  // not an allocating toImage() call — keep the per-frame paths
  // (drawTrails) allocation-free.
  const tf = { pos_x: 0, pos_y: 0, scale: 1 };
  let extW = 1024;
  let extH = 1024;

  const tmp = {};

  // chevScratch — chevronPath's `out` for drawPlayers: the 3 chevron
  // points are read straight back within the same slot iteration, so one
  // per renderer replaces the per-dot allocation.
  const chevScratch = [[0, 0], [0, 0], [0, 0]];

  // panelForZ — the panel an entity at world Z belongs to (layers.js
  // layerIndexForZ: half-open bands, default layer for unknown Z). z
  // omitted/unknown → panels[0] — for a single-layer pack that is THE
  // panel, so every pre-layers call site behaves exactly as before.
  function panelForZ(z) {
    return panels[layerIndexForZ(z, panels)] || panels[0];
  }

  // scaleForZ — world units per image px on the entity's panel (the
  // smoke/fire area radii): the shared transform unless a pack overrides
  // that layer's transform.
  function scaleForZ(z) {
    return panelForZ(z).tf.scale;
  }

  // worldToImage — world → the camera's COMBINED image space: the point
  // projects through ITS OWN layer's panel (per-layer transform when the
  // pack overrides one, else the shared map transform) plus that panel's
  // side-by-side offsetX. Optional `z` picks the panel; without it (or
  // with an unknown Z) the default panel claims the point.
  function worldToImage(wx, wy, out, z) {
    const p = panelForZ(z);
    out.x = (wx - p.tf.pos_x) / p.tf.scale + p.offsetX;
    out.y = (p.tf.pos_y - wy) / p.tf.scale;
    return out;
  }

  const imgPt = { x: 0, y: 0 };
  // Screen-space SCRATCH for the hot projection paths — the `tmp`
  // precedent above: worldToScreen/panelToScreen take an optional `out`
  // and write into it instead of allocating a {x, y} per call (50–200 of
  // them per frame). Callers that need TWO projected points AT ONCE must
  // pass two different scratches (scr1/scr2/scr3 below); a caller that
  // reads its point before the next projection may share one. Tests (and
  // any caller wanting an owned value) omit `out` → a fresh object, the
  // pre-scratch contract.
  const scr1 = { x: 0, y: 0 };
  const scr2 = { x: 0, y: 0 };
  const scr3 = { x: 0, y: 0 };
  // panelToScreen — one panel's projection of a world point into screen
  // space: THE canonical world→screen step, shared by worldToScreen and
  // the per-panel flight segments (never a second copy of the formula).
  function panelToScreen(p, wx, wy, out) {
    const s = cam.fit * cam.zoom;
    const ix = (wx - p.tf.pos_x) / p.tf.scale + p.offsetX;
    const iy = (p.tf.pos_y - wy) / p.tf.scale;
    const o = out || { x: 0, y: 0 };
    o.x = cssW / 2 + (ix - cam.cx) * s;
    o.y = cssH / 2 + (iy - cam.cy) * s;
    return o;
  }

  function worldToScreen(wx, wy, z, out) {
    return panelToScreen(panelForZ(z), wx, wy, out);
  }

  function screenToImage(sx, sy) {
    const s = cam.fit * cam.zoom;
    imgPt.x = cam.cx + (sx - cssW / 2) / s;
    imgPt.y = cam.cy + (sy - cssH / 2) / s;
    return imgPt;
  }

  // reproject derives the effective transform + extent from whatever we have:
  // the pack transform (via makeTransform — packTf) ± radar size, else
  // sample bounds (the no-pack fallback stays renderer-only). It also
  // rebuilds the PANELS — the side-by-side layout offsets, per-panel
  // transforms and images (buildPanels).
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
      buildPanels();
    } else {
      // Blank coordinate grid: invent an image space from sample extents.
      const scale = Math.max(spanX, spanY) / 900;
      tf.pos_x = b.minX - spanX * 0.05;
      tf.pos_y = b.maxY + spanY * 0.05;
      tf.scale = scale > 0 ? scale : 1;
      extW = Math.max(64, (spanX * 1.1) / tf.scale);
      extH = Math.max(64, (spanY * 1.1) / tf.scale);
      // No pack → no layers: one default panel over the invented space
      // (a copy of tf, so panel math and tf stay identical here).
      panels = [
        defaultPanel(0, extW, extH, { pos_x: tf.pos_x, pos_y: tf.pos_y, scale: tf.scale }),
      ];
      regions = [];
    }
  }

  // buildPanels — one panel per packTf.layers entry (default first — the
  // extractor's sortSections order), laid out LEFT→RIGHT with LAYER_GAP
  // between them; extW/extH become the COMBINED extent the camera pans/
  // fits over. A pack WITHOUT layers builds the single default panel —
  // offset 0, the radar's own size — so single-layer geometry is
  // byte-identical to the pre-layers code. Images come from setPack's
  // layerImages (panel 0 falls back to `radar`); a layer whose image is
  // absent still gets its panel (entities place correctly; drawRadar
  // skips the missing pixels and the grid shows through).
  function buildPanels() {
    regions = Array.isArray(packTf.regions) ? packTf.regions : [];
    const defs = Array.isArray(packTf.layers) && packTf.layers.length ? packTf.layers : [null];
    const next = [];
    let x = 0;
    for (let i = 0; i < defs.length; i++) {
      const d = defs[i];
      const width = (d && d.width) || packTf.width;
      const height = (d && d.height) || packTf.height;
      const src = (d && d.tf) || packTf;
      const p = defaultPanel(
        x,
        width,
        height,
        {
          pos_x: src.posX,
          pos_y: src.posY,
          // the same degenerate-scale guard as tf above
          scale: src.scale > 0 ? src.scale : 1,
        },
        layerImgs[i] || (i === 0 ? radar : null),
      );
      if (d) {
        p.id = d.id || 'default';
        p.name = d.name || null;
        p.zMin = d.zMin; // makeTransform already normalized to number|null
        p.zMax = d.zMax;
      }
      // (No per-panel thresholds: elevation is region-only — regions
      // were loaded above and apply across every panel.)
      next.push(p);
      x += width + LAYER_GAP;
    }
    panels = next;
    extW = Math.max(1, x - LAYER_GAP);
    extH = Math.max(...next.map((p) => p.height));
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
    chatFitCache.clear(); // the stage width is half of every cache key
    fit();
    draw();
  }

  // setPack(meta, image, transform, layerImages): transform is the
  // makeTransform() output loadMapPack already built (Replay passes it
  // through); a caller handing us a bare meta gets it derived here —
  // either way makeTransform is the single pack→transform reader.
  // layerImages: the decoded per-layer images parallel to meta.layers
  // (optional — panel 0 falls back to `image`, the radar.png decode;
  // older callers passing three args behave as before).
  function setPack(newPack, image, transform, layerImages) {
    pack = newPack || null;
    radar = image || null;
    packTf = transform || (pack ? makeTransform(pack) : null);
    layerImgs = Array.isArray(layerImages) ? layerImages : [];
    fit();
  }

  function setLandmarks(list) {
    // Rows arrive PRE-BUCKLETED (lib/replay/landmarks.js normalizeEvent
    // stamps `bucket`) — no classification happens in the render path.
    // Two passes: bucket everything, then pair throws against the
    // COMPLETE pairing pool (a single pass would scan a half-populated
    // raw list and re-classify every row per throw).
    landmarks = list || [];
    polylines = [];
    dets = [];
    lands = [];
    smokes = [];
    fires = [];
    plants = [];
    explodes = [];
    defuses = [];
    drops = [];
    pickups = [];
    wdrops = [];
    wpickups = [];
    roundEnds = [];
    roundStarts = [];
    kills = [];
    damages = [];
    hitTracers = [];
    const hitSeen = new Set();
    const throws = [];
    // Bounce vertices of the grenade flights (bucket 'bounce') — a
    // throw's path is [throw, bounce₁…bounceₙ, det], so the rows are
    // collected here and joined AFTER the throw→det pairing pool is
    // complete (joinBounceVerts).
    const bounces = [];
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
            // …and the hit-SHOT tracer (the shooter→victim segment): the
            // row carries the victim's hit position (extract stamps
            // PlayerHurt's victim position → normalizeEvent x/y) but NO
            // attacker position (events.apos_* is kill-only —
            // models/dto.go + store/queries.go), so the shooter's side
            // is resolved from the position stream at draw time. No
            // attacker key (world/fall/self damage — extract's
            // keyStr(0) = '') or no stored hit position → no line, never
            // a guessed one. Dedupe on (tick, attacker, victim): pellet
            // rows of one shot at one victim are ONE line.
            if (
              l.attacker &&
              Number.isFinite(l.tick) &&
              Number.isFinite(l.x) &&
              Number.isFinite(l.y)
            ) {
              const key = `${l.tick}|${l.attacker}|${l.victim || ''}`;
              if (!hitSeen.has(key)) {
                hitSeen.add(key);
                hitTracers.push({
                  tick: l.tick,
                  attacker: l.attacker,
                  victim: l.victim || '',
                  x: l.x,
                  y: l.y,
                  z: l.z, // the victim's hit-position Z — their panel
                });
              }
            }
          }
          break;
        case 'detonation':
        case 'flash':
        case 'he':
          dets.push(l);
          break;
        case 'land':
          // A grenade coming to REST (the decoy's activation — bucket
          // 'land', NOT in DETONATION_BUCKETS): it draws nothing itself
          // (the rest icon + noise pulses come from the decoy PLAN), it
          // only joins the throw-pairing pool below so a decoy's arc
          // ends at the rest position instead of at the explosion.
          lands.push(l);
          break;
        case 'bounce':
          // A projectile BOUNCE (models.EventGrenadeBounce): it draws no
          // marker of its own — it is a VERTEX of the flight path the
          // throw pairing below builds (joinBounceVerts), so it only
          // joins the collection pool here.
          bounces.push(l);
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
        case 'wdrop':
          // A death-drop row (the map's drop layer). The gun|util
          // classification and the gun's ammo were JOINED onto this row
          // by the view (getDropDetails — extract stamps cat on
          // detail_json from models.IsUtilityWeapon; the renderer never
          // re-derives the util rule). A row without the join (failed /
          // skipped side channel) keeps dropCat '' → drawDrops draws
          // nothing — an unknown category is never guessed.
          wdrops.push(l);
          break;
        case 'wpickup':
          wpickups.push(l);
          break;
        case 'round':
          roundEnds.push(l);
          break;
        case 'start':
          // Stored ONLY for the next-round cutoffs — killEndTick (death
          // X) and bombEndTick (planted C4) — a round_start row is never
          // drawn as a world marker and never becomes a scrubber marker
          // (landmarks.scrubberMarkerClass).
          roundStarts.push(l);
          break;
      }
    }
    // The plant/defuse ATTEMPT intervals (bomb.js actionIntervals —
    // THE begin → completion/abort/round-end rule), grouped by the
    // ACTOR's slot for the per-dot progress ring. Rebuilt with the rest
    // of the landmark buckets so the per-frame path only looks up this
    // small map; an actor outside the roster has no dot to ring.
    actionBySlot = new Map();
    for (const iv of actionIntervals(list)) {
      const slot = slotOfSteam.get(String(iv.steamId || ''));
      if (slot == null) continue;
      const arr = actionBySlot.get(slot);
      if (arr) arr.push(iv);
      else actionBySlot.set(slot, [iv]);
    }
    // The bomb evidence bundle for bomb.js (dropped reconstruction +
    // planted round-end cleanup). One rebuild per setLandmarks call —
    // the per-frame paths only scan these small arrays. roundStarts
    // rides along for bombEvidenceAt's round scope (roundcut.js
    // roundCutTick — same-round round_end, else the next round_start).
    bombEv = { drops, pickups, plants, roundEnds, roundStarts };
    // The drop-layer evidence bundle (drops.js dropEvidenceAt) — built
    // with the bomb one above; roundEnds/roundStarts are the shared
    // round cleanup (the ONE roundcut.js composition, never scanned
    // here).
    wdropEv = { drops: wdrops, pickups: wpickups, roundEnds, roundStarts };
    // Derived lookups for the per-frame paths (all over match-static
    // rows — pure functions of these buckets, rebuilt whenever they are):
    //   dropWins — drops.js buildDropWindows: each drop row → its
    //              [from, to) visibility window, so drawDrops is O(1)
    //              per row (it used to run a one-row dropEvidenceAt
    //              query — a pickups + round_end rescan — per row per
    //              frame);
    //   killEnds — killEndTick per kill row: the death-X cutoff, so
    //              drawDeaths is a Map read per kill (it used to rescan
    //              the round_end/round_start rows per kill per frame);
    //   roundCuts — roundcut.js ROUND_POLICY + entityEndTick per
    //              policy row: the P1 area cutoffs (min(own lifetime,
    //              round cut)) and the P2 pop cutoffs (the next
    //              round_start), plus the decoy plan's window cut — so
    //              drawGrenades/drawBomb gate on one Map read per row.
    // tickRate is the engine's own (killEndTick defaults an invalid one
    // to 64 exactly as drawDeaths' live call would).
    dropWins = buildDropWindows(wdropEv);
    killEnds = new Map();
    for (const k of kills) {
      killEnds.set(k, killEndTick(k, engine ? engine.tickRate : 0, roundEnds, roundStarts));
    }
    rebuildRoundCuts();
    // Pairing pool: detonations AND landings. A landing row's weapon is
    // "Decoy Grenade", so sameUtilityWeapon only ever pairs it with a
    // DECOY throw (every other grenade's nearest candidate stays its own
    // detonation — unchanged); the decoy's arc then ends at the REST
    // position while the explosion still animates from the UNPAIRED
    // detonation row (the HE-style ring at decoy_detonate).
    const pairPool = lands.length ? dets.concat(lands) : dets;
    for (const l of throws) {
      // pair with the nearest detonation/landing of same
      // round+thrower+weapon (weapon equality is sameUtilityWeapon —
      // Molotov ≡ Incendiary, see landmarks.js)
      let best = null;
      let bestDelta = Infinity;
      for (const d of pairPool) {
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
      polylines.push({ from: l, to: best, verts: joinBounceVerts(l, best, bounces) });
    }
  }

  // rebuildRoundCuts — the unified round-boundary cutoffs (roundcut.js:
  // ROUND_POLICY picks the rule per pre-bucketed row, entityEndTick
  // applies min(own end, cut)). Precomputed exactly like killEnds /
  // dropWins so every gated draw loop is ONE Map read per row per frame,
  // never an O(rounds) terminator scan. Called from BOTH setLandmarks
  // (rows / round boundaries changed) and setDecoyPlan (the plan is the
  // 'land' bucket's only draw site) — Replay.svelte arrives in either
  // order, so whichever setter runs last rebuilds all three maps from the
  // inputs it then has.
  function rebuildRoundCuts() {
    const tr = engine ? engine.tickRate : 0;
    areaCuts = new Map();
    popCuts = new Map();
    for (const l of landmarks) {
      const rules = ROUND_POLICY[l.bucket]; // rows arrive bucketed — no
      if (!rules) continue; //                    runtime classification
      if (rules.includes('area')) {
        areaCuts.set(
          l,
          entityEndTick(
            l,
            { policy: 'area', lifetimeS: LIFETIME_S_BY_BUCKET[l.bucket], tickRate: tr },
            roundEnds,
            roundStarts,
          ),
        );
      }
      if (rules.includes('pop')) {
        popCuts.set(l, entityEndTick(l, { policy: 'pop' }, roundEnds, roundStarts));
      }
    }
    decoyCuts = new Map();
    for (const p of decoyPlan) {
      // ROUND_POLICY 'land' → 'pop' (the P2 rule): the plan carries the
      // rest tick, not a bucketed row, so the cut is computed from
      // landTick with the same helper — the decoy's rest/noise window
      // never survives the next round_start either.
      decoyCuts.set(p, entityEndTick({ tick: p.landTick }, { policy: 'pop' }, roundEnds, roundStarts));
    }
  }

  // areaEnd / popEnd — the precomputed roundCuts read for ONE row, with
  // the canonical roundcut rule as the fallback for any row a map somehow
  // misses (the killEnds fallback pattern: both are built together in
  // rebuildRoundCuts, so the fallback never actually runs).
  function areaEnd(l, lifetimeS) {
    return (
      areaCuts.get(l) ??
      entityEndTick(
        l,
        { policy: 'area', lifetimeS, tickRate: engine ? engine.tickRate : 0 },
        roundEnds,
        roundStarts,
      )
    );
  }

  function popEnd(l) {
    return popCuts.get(l) ?? entityEndTick(l, { policy: 'pop' }, roundEnds, roundStarts);
  }

  function setData(newData) {
    store = newData;
    // New frames/ticks: bullet rows carry frame indices into the OLD
    // dataset — clear them (the view re-pushes via setBullets), exactly
    // like the edge-state re-seed this replaced.
    bullets = [];
    chatFitCache.clear(); // the speaker's side (→ head) comes from the store
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

  // setChat(rows): the in-game chat input — raw ChatRow rows (the view
  // fetched ALL rounds with round -1; the renderer scopes them to the
  // round containing the playhead, the same clearing/scrub rule the kill
  // feed uses). Pure data like setBlinds/setLandmarks: stored verbatim —
  // no side, no normalization, no filtering happens here (drawChat
  // resolves each speaker's side at the message tick and composes the
  // row's channel tag — [ALL]/[T]/[CT] — from the row's own `channel`)
  // and redraws.
  function setChat(rows) {
    chats = rows || [];
    chatFitCache.clear(); // new rows → new cuts (the key space changes)
    draw();
  }

  // setBullets(rows): the tracer rows — {tick, frame, slot, weapon},
  // globally tick-sorted, gun-only and freeze-filtered by lib/replay/
  // bullets.js deriveBullets (the ONE filter: magAmmo step = a bullet —
  // see bullets.js's header; the sfx engine gets the SAME rows, so a
  // tracer and its gunshot can never disagree). Every row animates a
  // tracer now (the `draw` selection was retired by spec). Stored
  // verbatim like setLandmarks: pure data, redraw on set; the renderer
  // re-derives NOTHING here — it only travels and paints what arrives.
  // Absent/null clears the tracers.
  function setBullets(rows) {
    bullets = rows || [];
    draw();
  }

  // setDecoyPlan(plan): the decoy rest/noise rows from lib/replay/decoy.js
  // buildDecoyPlan ({landTick, detTick, x, y, side, weapon, shots} — world
  // coords, one entry per decoy that came to rest AND whose explosion the
  // demo recorded). Stored verbatim like setBullets (pure data, redraw on
  // set): the renderer re-derives NOTHING — drawGrenades windows the rows
  // by tick (rest icon while landTick ≤ tick < detTick, one white
  // shotBloom per shot; plus the roundcut P2 cut at the next round_start,
  // so the window never survives into the next round) and the sfx engine
  // plays the SAME shots (the bullets.js one-plan-two-consumers pattern).
  // Absent/null clears.
  function setDecoyPlan(plan) {
    decoyPlan = plan || [];
    rebuildRoundCuts(); // the plan is the 'land' bucket's only draw site
    draw();
  }

  // setStateIndex(index): lib/replay/state.js buildStateIndex output (or
  // null — no state stream / older import). Only the carried-C4 badge
  // reads it now (slotStateAt in drawPlayers); tracers are NOT armed
  // from the state stream — they arrive pre-derived via setBullets.
  function setStateIndex(index) {
    stateIndex = index || null;
    draw();
  }

  function panBy(dx, dy) {
    if (camMode === 'smart') takeOver(); // manual drag → free camera
    const s = cam.fit * cam.zoom;
    cam.cx -= dx / s;
    cam.cy -= dy / s;
  }

  function zoomAt(factor, sx, sy) {
    // FOLLOW keeps the camera: the wheel changes ONLY the scale — it
    // never takeOver()s to free (that would release follow through
    // onUserCamera) and never anchors on the cursor. draw() re-centers
    // on the followed player every frame, so the zoom reads as scaling
    // around THEM. Free (and the non-following smart takeover below)
    // keep the cursor-anchored behavior exactly.
    const following = engine.state.followSlot != null;
    if (!following && camMode === 'smart') takeOver(); // manual wheel → free camera
    let bx = 0;
    let by = 0;
    if (!following) {
      screenToImage(sx, sy);
      bx = imgPt.x;
      by = imgPt.y;
    }
    // Clamp the on-screen scale (fit-relative zoom × fit), not the raw
    // ratio: ZOOM_MIN/MAX are about how much map is visible, so they
    // must mean the same thing whatever the canvas/image size is.
    const eff = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, cam.fit * cam.zoom * factor));
    cam.zoom = eff / cam.fit;
    if (following) return; // the center belongs to the followed player
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

  // setDropLayers({guns, util, kits}) — the drop layer's visibility
  // toggle (the FIRST layer toggle in this file: everything else draws
  // whatever rows arrive, but drops are opt-in per category — the
  // toolbar popover's three checkboxes, ALL OFF by default / unset pref).
  // Only gates WHICH categories drawDrops paints; the rows themselves
  // keep arriving via setLandmarks either way, so flipping a box is a
  // pure visibility change — redraw now, and every later draw re-derives
  // from tick alone (scrub-safe like every layer).
  function setDropLayers(layers) {
    dropLayers = {
      guns: !!(layers && layers.guns),
      util: !!(layers && layers.util),
      kits: !!(layers && layers.kits),
    };
    draw();
  }

  // setKitEvidence(ev) — the defuse-kit evidence bundle (the view
  // builds it ONCE with lib/replay/kits.js buildKitEvidence and pushes
  // it beside setLandmarks). ev.drops is Map<kit drop row, {from, to}>;
  // anything else (absent / malformed / a match with no kit rows) reads
  // as an EMPTY map, so drawDrops draws no kit marker — fail-soft to
  // nothing, never a guessed window. ev.hasKitAt (the tri-state
  // possession probe) is RETAINED too: the defuse ring's denominator
  // (bomb.js actionDurationTicks — 5 s with a kit, 10 s without) resolves
  // it for the defuser at the attempt's start tick. Both inputs are
  // match-static, so a repeat push just rebuilds the same lookups.
  //
  // TWO-SETTER ORDERING: setLandmarks builds actionBySlot (the
  // intervals) and this arrives separately, in either order. The ring's
  // duration is therefore stamped LAZILY AT DRAW, where both are in
  // scope — no rebuild-on-arrival coupling, and whichever setter lands
  // last just triggers the next draw with everything present. Absent
  // hasKitAt reads as NO kit (10 s) — the conservative side.
  function setKitEvidence(ev) {
    kitWins = ev && ev.drops instanceof Map ? ev.drops : new Map();
    kitHasAt = ev && typeof ev.hasKitAt === 'function' ? ev.hasKitAt : null;
    draw();
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
    const add = (wx, wy, z) => {
      worldToImage(wx, wy, img, z); // the entity's OWN panel (multi-floor)
      if (img.x < minX) minX = img.x;
      if (img.x > maxX) maxX = img.x;
      if (img.y < minY) minY = img.y;
      if (img.y > maxY) maxY = img.y;
    };
    for (let slot = 0; slot < store.slots.length; slot++) {
      engine.lerpAt(slot, tmp);
      if (tmp.alive && Number.isFinite(tmp.x)) add(tmp.x, tmp.y, tmp.z);
    }
    const tr = engine.tickRate;
    const tick = engine.state.tick;
    for (const l of plants) {
      if (!hasPos(l)) continue;
      // INCLUSIVE of the cutoff tick, deliberately: at the cutoff (the
      // explosion, or the round's end) the bomb is still the thing the
      // frame must frame — the blast is what the viewer needs to see —
      // and one tick later the next round's players own the view. No
      // boundary-stuck risk here (unlike drawBomb): easing a camera
      // point is not a painted marker, so the death-X `>=` rule does not
      // apply — see drawBomb for the drawing boundary.
      if (tick >= l.tick && tick <= bombEndTick(l, tr, explodes, defuses, roundEnds, roundStarts)) {
        add(l.x, l.y, l.z);
      }
    }
    const ev = bombEvidenceAt(bombEv, tick);
    if (ev && ev.state === 'dropped' && hasBombPos(ev)) add(ev.x, ev.y, ev.z);
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
    if (drawRaf) {
      cancelAnimationFrame(drawRaf);
      drawRaf = 0;
    }
    drawDirty = false;
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
    // extent border — ONE per panel (a layered pack outlines each radar;
    // a single panel draws exactly the old rect).
    ctx.strokeStyle = 'rgba(58, 67, 86, 0.9)';
    ctx.lineWidth = 2;
    const oy = cssH / 2 - cam.cy * s;
    for (const p of panels) {
      const ox = cssW / 2 + (p.offsetX - cam.cx) * s;
      ctx.strokeRect(ox, oy, p.width * s, p.height * s);
    }
  }

  // drawRadar — every panel's image at its side-by-side offset, then the
  // layer LABELS (multi-panel packs only — a single-layer map must look
  // exactly as it did before layers existed). Returns whether any panel
  // pixels were drawn (false → the caller draws the grid instead).
  function drawRadar() {
    if (!panels.length) return false;
    const s = cam.fit * cam.zoom;
    const y = cssH / 2 - cam.cy * s;
    ctx.imageSmoothingEnabled = true;
    // RESAMPLE QUALITY POLICY (approved): 'high' while the camera is
    // settled, 'medium' while it eases/moves (smart ease, follow, a
    // manual pan/zoom) — the browser's best filter is the expensive
    // resample, so a moving view pays for it only while it is actually
    // moving. The signal is the camera's own delta since the previous
    // radar draw, held to the SAME tolerances camConverged declares a
    // settle (SMART_EPS_*), so a converged smart camera — and every
    // paused frame — keeps 'high' exactly as before. camSeen starts
    // unset: the FIRST radar draw records without reacting and paints at
    // 'high' like it always did (one-frame-stale initialisation).
    const moving =
      camSeen.cx != null &&
      (Math.abs(cam.cx - camSeen.cx) > SMART_EPS_CENTER ||
        Math.abs(cam.cy - camSeen.cy) > SMART_EPS_CENTER ||
        Math.abs(cam.zoom - camSeen.zoom) > SMART_EPS_ZOOM * Math.max(camSeen.zoom, 1e-9));
    camSeen.cx = cam.cx;
    camSeen.cy = cam.cy;
    camSeen.zoom = cam.zoom;
    // The extractor ships radar PNGs above their logical size (2× as of
    // the owner's 2026-11 upscale matrix); the
    // webview downscales at fit/low zoom (aliasing) and upscales when
    // zoomed (blur). The context default is 'low' (plain bilinear) —
    // ask for the browser's best filter while it is worth it.
    ctx.imageSmoothingQuality = moving ? 'medium' : 'high';
    let drew = false;
    for (const p of panels) {
      if (!p.img) continue;
      const x = cssW / 2 + (p.offsetX - cam.cx) * s;
      ctx.drawImage(p.img, x, y, p.width * s, p.height * s);
      drew = true;
    }
    if (panels.length > 1) drawLayerLabels(s);
    return drew;
  }

  // LAYER_LABEL_MIN_Y — px floor for a layer label's y (C5 of the
  // overlay audit): everything above this line is the TOP BAND the
  // score box and the kill feed own (region map above), so a label
  // never paints into it — see drawLayerLabels.
  const LAYER_LABEL_MIN_Y = 40;

  // drawLayerLabels — "Upper"/"Lower" over each panel's top edge, canvas-
  // drawn (no DOM). The label's natural spot is just above the panel's
  // top edge, but when zooming INTO a panel pushes that edge up into the
  // top band (sy < LAYER_LABEL_MIN_Y) the label drops to the PANEL'S
  // VERTICAL CENTRE instead of pinning to the band — it stays over its
  // own floor either way; the final floor keeps the invariant when a
  // panel rides entirely above the line. Culled horizontally when the
  // panel is out of sight. Dark-shadowed like the name labels so it
  // reads on radar and light theme alike.
  function drawLayerLabels(s) {
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (const p of panels) {
      if (!p.name) continue;
      const sx = cssW / 2 + (p.offsetX + p.width / 2 - cam.cx) * s;
      if (sx < -60 || sx > cssW + 60) continue;
      const panelTop = cssH / 2 - cam.cy * s; // the same y drawRadar paints at
      let sy = panelTop - 6; // just above the panel's top edge
      if (sy < LAYER_LABEL_MIN_Y) sy = panelTop + (p.height * s) / 2; // → its centre
      sy = Math.max(LAYER_LABEL_MIN_Y, sy);
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur = 3;
      ctx.fillStyle = '#d7dde8';
      ctx.fillText(p.name, sx, sy);
      ctx.shadowBlur = 0;
    }
  }

  // sideAtFrame resolves a slot's side at frame f through the ONE
  // canonical rule (module-level sideFromFlags): the per-frame side bits
  // (q16 — sides flip at halftime), falling back to the slot's final
  // side from meta. The fallback is not a legacy shim: the side bits are
  // 0 (unknown) whenever the slot carries no payload that frame (dead
  // player) or the extractor saw an unassigned team, and the final-side
  // table is all we have for those frames.
  function sideAtFrame(slot, f) {
    return sideFromFlags(store.slots[slot].flags[f], slotSides[slot]);
  }

  // throwerSideAt — the util-flight tint source: the THROWER's side at
  // the throw tick, resolved through the SAME machinery the death X and
  // the kill feed use (slotOfSteam → sideAtFrame at the row's tick).
  // Returns '' when the attacker is missing, unresolvable or the tick is
  // unusable — the caller then keeps the neutral trail color; a side is
  // NEVER guessed for a thrower we cannot place. Pure.
  function throwerSideAt(steamId, tick) {
    if (!steamId || !Number.isFinite(tick)) return '';
    const slot = slotOfSteam.get(String(steamId));
    if (slot == null || slot >= store.slots.length) return '';
    const frame = engine.frameForTick(Math.max(engine.firstTick, tick));
    return sideAtFrame(slot, frame);
  }

  // smokeColorRGB — the tint of ONE detonated smoke (its lingering area
  // AND its detonation bloom ring — same row, same visual): the THROWER's
  // side at the smoke's tick through throwerSideAt, blended 50/50 with the
  // neutral smoke gray (SMOKE_CT / SMOKE_T constants above). Unknown or
  // unresolvable thrower → SMOKE_GRAY verbatim (the pre-tint color): a
  // side is NEVER guessed. Pure — unit-tested by renderer.test.js.
  function smokeColorRGB(l) {
    const side = throwerSideAt(l.attacker, l.tick);
    if (side === 'ct') return SMOKE_CT;
    if (side === 't') return SMOKE_T;
    return SMOKE_GRAY;
  }

  function drawTrails(frame) {
    const from = Math.max(0, frame - TRAIL_FRAMES);
    const s = cam.fit * cam.zoom;
    for (let slot = 0; slot < store.slots.length; slot++) {
      const p = store.slots[slot].pos;
      const color = teamColor(sideAtFrame(slot, frame));
      // Previous point as SCALARS (the old prev = [x, y] allocated one
      // array per step — ~1,400 per frame): read straight into moveTo.
      let hasPrev = false;
      let prevX = 0;
      let prevY = 0;
      let prevPanel = null;
      // Alpha-band batching: the open path carries ONE band; a band
      // change strokes the previous one (styles differ) and starts a
      // new path. Walk order is unchanged — newest → oldest — so the
      // paint order over the other layers is exactly what it was.
      let band = -1;
      let open = false;
      for (let f = frame; f >= from; f--) {
        if (!(store.masks[f] & (1 << slot))) {
          hasPrev = false;
          prevPanel = null;
          continue;
        }
        const b = f * 4;
        // Layer-aware: each frame's Z picks ITS panel (multi-floor), so
        // a trail follows its owner across floors instead of pinning to
        // the default radar. Single-layer packs resolve to the one panel
        // — the exact pre-layers arithmetic.
        const panel = panelForZ(p[b + 2]);
        const ix = (p[b] - panel.tf.pos_x) / panel.tf.scale + panel.offsetX;
        const iy = (panel.tf.pos_y - p[b + 1]) / panel.tf.scale;
        const sx = cssW / 2 + (ix - cam.cx) * s;
        const sy = cssH / 2 + (iy - cam.cy) * s;
        // prev is frame f+1 (the loop is contiguous and only alive frames
        // set it); trailConnects breaks the chain across a round reset /
        // respawn teleport instead of drawing the streaking line — and it
        // gates on SPEED per segment: only travel at ≥ TRAIL_MIN_SPEED
        // (135 u/s) strokes, so slow/walking history leaves no trail
        // (tickRate comes from the engine, like every other tick math
        // here). A PANEL change (floor transition) breaks it too: the two
        // points live in different panels and a line across the gutter
        // would be a lie. A chain break simply leaves the current band's
        // path open — a later segment starts a new SUBPATH in it, which
        // strokes identically (no join is shared across subpaths).
        if (hasPrev && prevPanel === panel && trailConnects(store.ticks, p, f, engine.tickRate)) {
          const bIdx = trailBandIndex((frame - f) / TRAIL_FRAMES);
          if (bIdx !== band) {
            if (open) ctx.stroke();
            band = bIdx;
            ctx.strokeStyle = color;
            ctx.globalAlpha = trailBandAlpha(band);
            ctx.lineWidth = 2;
            ctx.beginPath();
            open = true;
          }
          ctx.moveTo(prevX, prevY);
          ctx.lineTo(sx, sy);
        }
        prevX = sx;
        prevY = sy;
        hasPrev = true;
        prevPanel = panel;
      }
      if (open) ctx.stroke();
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
  // lands on the right spot; the line and the icon carry the THROWER's
  // team color, see throwerSideAt — a decoy's arc ENDS at its REST
  // position, paired to the grenade_land row), then the decoy PLAN's
  // rest icon + one white noise pulse per fake gunshot (setDecoyPlan —
  // the same shots the sfx engine plays), then ONE distinct detonation
  // visual per type (detonationStyleOf): HE expanding ring (the type a
  // decoy explosion also renders as — BaseGrenade.Explode), flash white
  // pop, team-tinted smoke bloom (the same thrower tint as the lingering
  // smoke area it hands off to), fire ring.
  function drawGrenades(tick) {
    const tr = engine.tickRate;
    // smoke / fire areas first (under the lines)
    for (const l of smokes) {
      if (!hasPos(l)) continue;
      const age = (tick - l.tick) / tr;
      if (age < 0) continue;
      // P1 round-end cleanup (roundcut.js): the area dies at the EARLIER
      // of its 18 s lifetime and the round cut (round_end, else the next
      // round_start) — gone AT the cutoff, its own tick always draws, so
      // a paused seek to the boundary clears it and a backwards scrub
      // re-derives it (nothing sticky).
      const end = areaEnd(l, SMOKE_LIFETIME_S);
      if (tick >= end && tick !== l.tick) continue;
      const c = worldToScreen(l.x, l.y, l.z, scr1);
      const r = (SMOKE_RADIUS / scaleForZ(l.z)) * cam.fit * cam.zoom;
      const fade = age > SMOKE_LIFETIME_S - 2 ? (SMOKE_LIFETIME_S - age) / 2 : 1;
      // team-tinted (the thrower's side, 50/50 with the smoke gray — see
      // SMOKE_CT/SMOKE_T) at the SAME 0.3/0.55 alphas as the old neutral;
      // an unresolvable thrower keeps that neutral gray verbatim.
      const rgb = smokeColorRGB(l);
      ctx.fillStyle = `rgba(${rgb}, ${0.3 * fade})`;
      ctx.strokeStyle = `rgba(${rgb}, ${0.55 * fade})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    for (const l of fires) {
      if (!hasPos(l)) continue;
      const age = (tick - l.tick) / tr;
      if (age < 0) continue;
      // same P1 rule as the smoke area above, with the 7 s fire lifetime
      const end = areaEnd(l, FIRE_LIFETIME_S);
      if (tick >= end && tick !== l.tick) continue;
      const c = worldToScreen(l.x, l.y, l.z, scr1);
      const r = (FIRE_RADIUS / scaleForZ(l.z)) * cam.fit * cam.zoom;
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
    // air" (from throw tick to detonation tick) — a MULTI-SEGMENT path
    // over [throw, bounce₁…bounceₙ, det] (joinBounceVerts): one hop per
    // recorded bounce, each traversed at its OWN constant speed so the
    // icon lands EXACTLY on the bounce tick (the bounce sound and the
    // icon stay in sync), then the final ≈0-length hop to the detonation
    // where the icon rests at the last bounce position. A flight with no
    // bounces is exactly the old two-vertex segment; equal/unknown pair
    // ticks keep the origin dot only.
    // The trail (and the icon riding it) is tinted by the THROWER's side
    // at the throw tick (throwerSideAt — slotOfSteam + sideAtFrame, the
    // canonical rule): CT blue / T orange, and the NEUTRAL orange line
    // with the untinted icon when the thrower cannot be resolved — a
    // side is never guessed. Lingering FIRE areas and the fire/HE
    // detonation visuals stay type-colored (drawn above); the lingering
    // SMOKE area and its bloom take the thrower's tint too (the SAME
    // rule — smokeColorRGB), neutral gray when the side is unknown.
    for (const pl of polylines) {
      if (!hasPos(pl.from)) continue;
      if (tick < pl.from.tick) continue;
      if (pl.to && tick > pl.to.tick) continue;
      // P2 (roundcut.js): an arc that outlives its round is cut at the
      // NEXT round_start only — round_end deliberately never terminates a
      // pop/arc (bomb_explode-on-end_tick rule), and with no round rows
      // loaded there is no cut at all.
      const cut = popEnd(pl.from);
      if (cut != null && tick >= cut && tick !== pl.from.tick) continue;
      const a = worldToScreen(pl.from.x, pl.from.y, pl.from.z, scr1);
      const flight =
        pl.to &&
        hasPos(pl.to) &&
        Number.isFinite(pl.from.tick) &&
        Number.isFinite(pl.to.tick) &&
        pl.to.tick > pl.from.tick;
      if (flight) {
        // The vertex list the pairing built (joinBounceVerts); a polyline
        // without one (defensive — every setter path supplies it) falls
        // back to the plain throw→det pair, i.e. the pre-bounce behavior.
        const verts =
          Array.isArray(pl.verts) && pl.verts.length >= 2 ? pl.verts : [pl.from, pl.to];
        const side = throwerSideAt(pl.from.steamId, pl.from.tick);
        const team = side === 'ct' || side === 't' ? teamColor(side) : null;
        ctx.strokeStyle = team || 'rgba(251, 172, 24, 0.4)';
        if (team) ctx.globalAlpha = 0.55; // same subtlety as the movement trails
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        // Per-SEGMENT, per-LAYER spans: every consecutive vertex pair is
        // its own flight, so flightSplits runs with THAT hop's z ends (a
        // floor crossing is resolved hop by hop; a same-floor hop is ONE
        // span — and a bounce-free flight is exactly the old single
        // segment). A nade CAN cross floors — bottom ramp → top ramp on
        // Nuke — and one line drawn from one panel to the other would
        // cross the gutter and lie about where the nade is, so each span
        // draws on its own floor's panel.
        for (let i = 0; i + 1 < verts.length; i++) {
          const v0 = verts[i];
          const v1 = verts[i + 1];
          if (!hasPos(v0) || !hasPos(v1)) continue;
          for (const seg of flightSplits(v0.z, v1.z, panels)) {
            const pa = panels[seg.layer] || panels[0];
            // One scratch for both ends: moveTo copies the numbers into
            // the path before s1 reuses the object, so nothing aliases.
            const s0 = panelToScreen(
              pa,
              v0.x + (v1.x - v0.x) * seg.t0,
              v0.y + (v1.y - v0.y) * seg.t0,
              scr3,
            );
            ctx.moveTo(s0.x, s0.y);
            const s1 = panelToScreen(
              pa,
              v0.x + (v1.x - v0.x) * seg.t1,
              v0.y + (v1.y - v0.y) * seg.t1,
              scr3,
            );
            ctx.lineTo(s1.x, s1.y);
          }
        }
        ctx.stroke();
        ctx.setLineDash([]);
        if (team) ctx.globalAlpha = 1;
        // The icon rides the CONTAINING hop at that hop's constant speed
        // (flightPointAt — arrival exactly at each recorded bounce tick,
        // hold at rest past the last vertex, never a divide-by-zero). Its
        // Z lerps with the same progress when both hop ends know it
        // (a floor-crossing hop), else the one that does — unknown → the
        // default panel, never a guess.
        const at = flightPointAt(verts, tick);
        const img = iconFor(pl.from.weapon) || iconFor(pl.to.weapon);
        let drawn = false;
        if (img && at) {
          const c = worldToScreen(at.x, at.y, at.z, scr2); // `a` (scr1) stays live for the fallback dot below
          drawn = drawIcon(img, c.x, c.y, NADE_ICON_PX, team);
        }
        if (!drawn) {
          // no icon for this weapon (or no drawable vertex) — today's
          // vector drawing (the orange origin dot), never an error.
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
    // Decoy plan (setDecoyPlan — lib/replay/decoy.js): the REST icon
    // while landTick ≤ tick < detTick, tinted by the thrower's side
    // through the SAME rule as the flight line above (teamColor for
    // 'ct'/'t', the amber thrower-side tint as the unresolvable-side
    // fallback — a side is never guessed), plus ONE white mic-talk bloom
    // per scheduled fake gunshot (shotBloom — the event-anchored
    // voiceBloom recipe, exactly one cycle per sound). Drawn INSIDE
    // drawGrenades, BEFORE the detonation loop below (the HE-style
    // explosion at detTick paints over the icon's last frame) and
    // therefore beneath the dots (draw() calls drawGrenades before
    // drawPlayers). A position-less plan row draws nothing (hasPos —
    // never a guessed spot); the icon falls back to the same amber origin
    // dot the flight path uses when the icon pipeline has no art.
    for (const p of decoyPlan) {
      if (!Number.isFinite(p.landTick) || !Number.isFinite(p.detTick)) continue;
      if (tick < p.landTick || tick >= p.detTick) continue;
      // P2 (roundcut.js ROUND_POLICY 'land'): the rest/noise window is
      // cut at the next round_start, never at round_end — same rule as
      // every other pop/arc, read from the precomputed decoyCuts map.
      const cut =
        decoyCuts.get(p) ??
        entityEndTick({ tick: p.landTick }, { policy: 'pop' }, roundEnds, roundStarts);
      if (cut != null && tick >= cut && tick !== p.landTick) continue;
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      const c = worldToScreen(p.x, p.y, p.z, scr1); // p.z → its radar layer
      // Elevation indicator for the LANDED decoy — this loop is the REST
      // window (landTick ≤ tick < detTick); the in-flight arc/icon above
      // draws no mark, so util is only ever marked at rest. Same rules
      // as the dots/bomb: behind the icon, a region box only
      // (elevationFor — a decoy with unknown z or an XY outside every
      // region draws nothing).
      const elev = elevationFor(p.x, p.y, p.z, regions);
      if (elev) drawElevationIndicator(c.x, c.y, elev);
      const team = p.side === 'ct' || p.side === 't' ? teamColor(p.side) : null;
      const img = iconFor('Decoy Grenade');
      const drawn = img ? drawIcon(img, c.x, c.y, NADE_ICON_PX, team || 'rgba(251, 172, 24, 0.85)') : false;
      if (!drawn) {
        ctx.fillStyle = 'rgba(251, 172, 24, 0.8)';
        ctx.beginPath();
        ctx.arc(c.x, c.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      for (const s of p.shots || []) {
        const bloom = shotBloom(tick, s.tick, tr, NADE_ICON_PX / 2);
        if (!bloom) continue; // outside this sound's single cycle
        ctx.strokeStyle = '#ffffff';
        ctx.globalAlpha = bloom.alpha;
        ctx.lineWidth = 2.5 * (1 - bloom.k) + 1; // shrinks as it expands
        ctx.beginPath();
        ctx.arc(c.x, c.y, bloom.radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.globalAlpha = 0.7 * (1 - bloom.k);
        ctx.beginPath();
        ctx.arc(c.x, c.y, 3 * (1 - bloom.k) + 1, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    // Detonations — one visual per type (smoke/fire also linger above;
    // their bloom hands the area off to it). Every branch is a function
    // of the event tick: scrubbing replays it, nothing is sticky.
    // P2 (roundcut.js): a pop that outlives its round dies at the NEXT
    // round_start — never at round_end (bomb_explode sits exactly on the
    // end_tick, and a post-round detonation gets its freezetime grace).
    for (const l of dets) {
      if (!hasPos(l)) continue;
      const cut = popEnd(l);
      if (cut != null && tick >= cut && tick !== l.tick) continue;
      const age = (tick - l.tick) / tr;
      if (age < 0) continue;
      const c = worldToScreen(l.x, l.y, l.z, scr1);
      const style = detonationStyleOf(l);
      if (style === 'smoke') {
        const dur = 0.9; // s — the bloom racing out to the smoke radius
        if (age > dur) continue;
        const k = age / dur;
        const r = 6 + k * (SMOKE_RADIUS / scaleForZ(l.z)) * cam.fit * cam.zoom;
        // the same thrower-team tint as the lingering area it hands off
        // to (neutral gray when the side is unknown — never guessed)
        ctx.strokeStyle = `rgba(${smokeColorRGB(l)}, ${0.8 * (1 - k)})`;
        ctx.lineWidth = 3 * (1 - k) + 1;
        ctx.beginPath();
        ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
        ctx.stroke();
      } else if (style === 'fire') {
        const dur = 0.6; // s — molotov/incendiary spread
        if (age > dur) continue;
        const k = age / dur;
        const r = 6 + k * (FIRE_RADIUS / scaleForZ(l.z)) * cam.fit * cam.zoom;
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
      } else {
        // HE (and any unknown weapon — INCLUDING a decoy detonation:
        // detonationStyle('Decoy Grenade') = 'he', the game plays
        // BaseGrenade.Explode): the classic expanding ring —
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

  // drawCarrierBadge — the carried-C4 marker on a player's DOT: the
  // small white C4 image (same 'C4' lookup + text fallback as
  // drawBombIcon) anchored by its TOP-RIGHT corner at the dot bounding
  // box's top-right + 1 px — (c.x + r + 1, c.y − r − 1) — and growing
  // left/down from there, ~10 px, so it hugs the dot's shoulder outside
  // the circle. Purely presentational: the CALLER decides from the state
  // stream's inventory whether this slot carries the bomb (drawPlayers),
  // which is also why a dropped/planted bomb — nobody's inventory has
  // 'C4' — shows no badge while drawBomb renders the world bomb.
  function drawCarrierBadge(c, r) {
    const size = DOT_C4_ICON_PX;
    const right = c.x + r + 1;
    const top = c.y - r - 1;
    const src = iconFor('C4');
    if (src) {
      const w = size * iconAspect(src);
      // drawIcon centers on (cx, cy) — derive the center from the anchor
      if (drawIcon(src, right - w / 2, top + size / 2, size, '#ffffff')) return;
    }
    // no image (or no tintable canvas) → a tiny 'C4' label in the same
    // box, exactly drawBombIcon's fallback convention.
    ctx.fillStyle = '#fbac18';
    ctx.font = 'bold 8px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('C4', right - size / 2, top + 8);
  }

  // drawElevationIndicator — CS2's radar elevation marks (T / ⊥ — CS2.md
  // "Radar elevation indicators") painted BEHIND the entity it belongs
  // to (the caller draws this first — the marker covers the stem's first
  // DOT_R px, so the mark sits on a lower canvas level than the entity).
  // The stem runs from the entity's CENTER (cx, cy) outward
  // ELEV_IND_STEM px into the flat bar — drawn entirely from canvas
  // paths (see the constants block: no extracted image, no text glyph),
  // at half the first iteration's visual weight — the bar lands clear of
  // the marker: for players just under the dot, behind the top of the
  // name label (⊥, stem halved 27 → 13.5 on 2026-11-08), well above the
  // dot (T).
  // The FLAT BAR reads as the LEVEL relative to the entity — the SETTLED
  // orientation (2026-11-08): entity ABOVE the level → ⊥ (bar at the
  // bottom, stem rising) drawn BELOW the marker; entity BELOW → T (bar
  // on top, stem descending) drawn ABOVE it — matching the game's own
  // .PI_Above (y: 8px, below) / .PI_Below (y: −8px, above) placement.
  // Size is FIXED in CSS px — never scaled by zoom, so it stays legible
  // at every camera level. Callers gate on elevationFor (no region box
  // at the XY → no draw).
  function drawElevationIndicator(cx, cy, dir) {
    const above = dir === 'above';
    // The bar's centre line ELEV_IND_STEM px from the entity's centre:
    // the stem ORIGINATES at (cx, cy), as specified — never a detached
    // mark floating by the name label.
    const barY = above ? cy + ELEV_IND_STEM : cy - ELEV_IND_STEM;
    // Two strokes make the whole glyph — no image, no text:
    //   STEM  (cx, cy) → (cx, barY)      grows out of the entity;
    //   BAR   (cx ± W/2, barY)           the flat "level" line.
    // The first pass is the dark halo (+2 on the monoline weight, +1px
    // past each bar end — the same contrast convention drawIcon uses, so
    // it reads on the dark radar and the light theme); the second is the
    // tinted body. Both in one path per pass: the stem/bar junction
    // composites as a single op — no double-blended seam.
    const mark = (color, width, pad) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx, barY);
      ctx.moveTo(cx - ELEV_IND_BAR_W / 2 - pad, barY);
      ctx.lineTo(cx + ELEV_IND_BAR_W / 2 + pad, barY);
      ctx.stroke();
    };
    mark('rgba(8, 10, 14, 0.85)', ELEV_IND_BAR_T + 2, 1); // halo
    mark(ELEV_IND_TINT, ELEV_IND_BAR_T, 0); // body
  }

  function drawBomb(tick, now) {
    const tr = engine.tickRate;
    for (const l of plants) {
      if (!hasPos(l)) continue;
      // Visible from plant until the first terminator — detonation,
      // defuse, the ROUND END, or the next round's start (the planted-C4
      // cleanup: a round that ends before the bomb resolves no longer
      // keeps the marker on screen, and a plant past its round's end
      // dies with the next round). bomb.js bombEndTick owns the rule; the
      // 40 s C4 timer is its no-terminator fallback.
      const endTick = bombEndTick(l, tr, explodes, defuses, roundEnds, roundStarts);
      // The boundary is the DEATH-X fix's (drawDeaths, commit 5dc0f93):
      // gone AT the cutoff, not one tick after it — a paused seek to the
      // ribbon's next-round startTick must clear the marker, and the
      // plant's OWN tick always draws even when the cutoff lands on it
      // (a plant stamped on its round_end/bomb_explode tick still marks
      // the spot for that one tick; `tick !== l.tick` also keeps a
      // NaN-tick row — bombEndTick → 0 — from ever drawing).
      if (tick < l.tick || (tick >= endTick && tick !== l.tick)) continue;
      const c = worldToScreen(l.x, l.y, l.z, scr1);
      // Elevation indicator BEHIND the bomb (drawn before its ring/icon
      // — same behind-the-entity rule as the player dots); only when a
      // region box claims the XY (never a guessed Z — see layers.js).
      const elev = elevationFor(l.x, l.y, l.z, regions);
      if (elev) drawElevationIndicator(c.x, c.y, elev);
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
      const c = worldToScreen(ev.x, ev.y, ev.z, scr1);
      const elev = elevationFor(ev.x, ev.y, ev.z, regions);
      if (elev) drawElevationIndicator(c.x, c.y, elev);
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
    // The blast ring and the defuse pop are POPS (roundcut.js P2): the
    // 3 s / 2 s windows are their own, and a round that ends while they
    // play only cuts them at the NEXT round_start — a round_end cut would
    // kill the blast ring on bomb_explode's own end_tick.
    for (const l of explodes) {
      if (!hasPos(l)) continue;
      const cut = popEnd(l);
      if (cut != null && tick >= cut && tick !== l.tick) continue;
      const age = (tick - l.tick) / tr;
      if (age < 0 || age > 3) continue;
      const c = worldToScreen(l.x, l.y, l.z, scr1);
      const r = 12 + age * 28;
      ctx.strokeStyle = `rgba(224, 91, 91, ${0.9 - age * 0.3})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const l of defuses) {
      if (!hasPos(l)) continue;
      const cut = popEnd(l);
      if (cut != null && tick >= cut && tick !== l.tick) continue;
      const age = (tick - l.tick) / tr;
      if (age < 0 || age > 2) continue;
      const c = worldToScreen(l.x, l.y, l.z, scr1);
      ctx.fillStyle = `rgba(90, 169, 230, ${0.8 - age * 0.4})`;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // drawDrops — the map's optional drop layer: every inferred death drop
  // still on the ground at `tick` (drops.js: the row's visibility
  // WINDOW was precomputed in setLandmarks — dropWindow, the SAME rule
  // dropEvidenceAt answers for a one-row bundle — so this loop is an O(1)
  // window test per row instead of a rescanning query per row per
  // frame; each dropped item is still its own marker, pickup-terminated
  // and round-end cleaned up per row, pure function of tick).
  // Drawn like the dropped-C4 marker (bombEvidenceAt's 'dropped' branch)
  // minus the throbber: NO ring, NO pulse, NO dash — a static white,
  // NEVER side-tinted item icon (iconFor + drawIcon's neutral
  // '#ffffff' tint, aspect-preserving at DROP_GUN/DROP_UTIL/DROP_KIT_ICON_PX)
  // with the elevation indicator behind it exactly like the dropped C4
  // (elevationFor + drawElevationIndicator — "basically the same as
  // dropped C4 except without the extra throbber" includes the floor
  // mark). Per-category gate first (setDropLayers): a gun needs
  // {guns}, a util needs {util}, a KIT needs {kits}, and a row whose
  // STORED cat the view never joined (dropCat '') draws nothing — the
  // classification is never re-derived here.
  // Guns additionally label their ammo state at death (detail_json
  // mag/reserve, joined as row.dropAmmo) — small, neutral, shadowed
  // like the player-name micro-label (the renderer's one label
  // convention; there is no zoom-gated label pattern to follow), and
  // clear of a below-marker elevation bar via DROP_AMMO_ELEV.
  //
  // DEFUSE KITS (cat 'kit') take the same draw call but their OWN
  // window and their OWN look: kitWins (lib/replay/kits.js — the
  // nearest-death back-propagation, never drops.js's best-evidence
  // window, which a mid-round kit BUY would terminate), and a plain
  // WHITE ICON + the elevation indicator behind it — NO ring, NO pulse,
  // NO dash (the owner's kit rule: the dashed-pulse throbber stays the
  // dropped C4's alone; a CT dot holding a kit gets NO dot indicator —
  // the kit badge lives on the player CARD only).
  function drawDrops(tick) {
    if (!dropLayers.guns && !dropLayers.util && !dropLayers.kits) return;
    for (const d of wdrops) {
      const row = d;
      const cat = row.dropCat;
      const isKit = cat === 'kit';
      // The precomputed window IS the reconstruction answer for this
      // row: [from, to) — absent (never visible: no position / no usable
      // tick / no kit evidence) or out of scope now → not on the ground.
      const win = isKit ? kitWins.get(row) : dropWins.get(row);
      if (!win || tick < win.from || tick >= win.to) continue;
      const want = isKit
        ? dropLayers.kits
        : cat === 'gun'
          ? dropLayers.guns
          : cat === 'util'
            ? dropLayers.util
            : false;
      if (!want) continue;
      const z = row.z ?? null; // dropEvidenceAt's own z spelling (null when absent)
      const c = worldToScreen(row.x, row.y, z, scr1);
      const elev = elevationFor(row.x, row.y, z, regions);
      // Elevation indicator BEHIND the icon (the behind-the-entity rule).
      if (elev) drawElevationIndicator(c.x, c.y, elev);
      const size = isKit ? DROP_KIT_ICON_PX : cat === 'gun' ? DROP_GUN_ICON_PX : DROP_UTIL_ICON_PX;
      const img = iconFor(row.weapon);
      if (!img || !drawIcon(img, c.x, c.y, size, '#ffffff')) {
        // No extracted icon → the neutral name label (the drawBombIcon
        // text-fallback convention, kept NEUTRAL — never a side color).
        ctx.font = 'bold 8px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.shadowColor = 'rgba(0,0,0,0.9)';
        ctx.shadowBlur = 3;
        ctx.fillStyle = '#d7dde8';
        ctx.fillText(String(row.weapon || '?'), c.x, c.y + 3);
        ctx.shadowBlur = 0;
        continue; // the ammo baseline would sit under text of unknown extent
      }
      if (cat === 'gun' && row.dropAmmo && Number.isFinite(row.dropAmmo.mag)) {
        ctx.font = '9px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.shadowColor = 'rgba(0,0,0,0.9)';
        ctx.shadowBlur = 3;
        ctx.fillStyle = '#d7dde8'; // neutral — ammo belongs to no side
        ctx.fillText(
          `${row.dropAmmo.mag}/${row.dropAmmo.reserve}`,
          c.x,
          c.y + size / 2 + DROP_AMMO_GAP + (elev ? DROP_AMMO_ELEV : 0),
        );
        ctx.shadowBlur = 0;
      }
    }
  }

  // stepFiring / the attack-edge arming was removed with the tracer
  // rework: tracers no longer arm per-draw from state edges. The rows
  // come pre-derived from setBullets (lib/replay/bullets.js — the ONE
  // shot filter, tested in src/lib/bullets.test.js), so there is no
  // edge state to re-seed across a seek and no per-draw detector.

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

  // drawActionRing — the plant/defuse PROGRESS arc around a player dot:
  // a partial arc from 12 o'clock sweeping CLOCKWISE by `progress` of a
  // full turn, ROUND-capped (the first partial-arc stroke in this file —
  // every other arc here is a full circle). `progress` arrives clamped
  // to (0, 1] from bomb.js actionProgressAt (elapsed over the fixed
  // game duration — never past a full turn, so this arc math cannot
  // sweep beyond 2π). The color names the ACTION:
  // RED while planting, GREEN while defusing — never the player's side.
  // No dark track under it: the arc sits at r+4, just inside the follow
  // ring at r+5, and a full-circle underlay would paint over the
  // followed player's amber ring. Pure function of (progress, action) —
  // a scrub re-renders the same arc, nothing is sticky. The caller owns
  // globalAlpha (the arc draws at full alpha).
  function drawActionRing(x, y, radius, action, progress) {
    ctx.lineCap = 'round';
    ctx.lineWidth = ACTION_RING_W;
    ctx.strokeStyle = action === 'defuse' ? ACTION_RING_DEFUSE : ACTION_RING_PLANT;
    ctx.beginPath();
    ctx.arc(x, y, radius, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    ctx.stroke();
    ctx.lineCap = 'butt'; // restore the default for everything after it
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
      // The cutoff was precomputed in setLandmarks (killEnds — the SAME
      // killEndTick rule, one Map read instead of the O(rounds)
      // terminator scan per kill per frame); the fallback keeps the
      // canonical function as the answer for any row the index somehow
      // does not hold (it never happens — both are built together).
      const end = killEnds.get(k) ?? killEndTick(k, tr, roundEnds, roundStarts);
      if (tick >= end && tick !== k.tick) continue;
      const slot = slotOfSteam.get(String(k.victim || ''));
      if (slot == null || slot >= store.slots.length) continue; // no dot to mark
      const c = worldToScreen(k.x, k.y, k.z, scr1);
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

  // tracerProgress — the SHARED travel math for both tracer kinds:
  // progress = (tick − row.tick) / (TRAVEL_S · tickrate), pure tick math
  // so the dash is seek-correct in both directions and frozen while
  // paused (repo rule). Returns null when the row is not yet live
  // (scrubbed BEFORE its shot/hit — nothing draws before the origin) or
  // the travel is over (progress ≥ 1 — a miss has faded out at the end
  // point, a hit's dash has arrived and is gone); otherwise the
  // progress clamped to [0, 1).
  function tracerProgress(tick, startTick, tr) {
    if (!Number.isFinite(tick) || !Number.isFinite(startTick)) return null;
    if (!(tr > 0)) return null;
    const age = tick - startTick;
    if (age < 0) return null;
    const p = age / (TRAVEL_S * tr);
    return p < 1 ? p : null;
  }

  // tracerColor — the stroke color BOTH tracer kinds share: the resolved
  // side through the ONE teamColor rule (CT blue / T amber), WHITE when
  // the side is unknown — a side is NEVER guessed (white is the old
  // neutral tracer color, not a stand-in for "probably T").
  function tracerColor(side) {
    return side === 'ct' || side === 't' ? teamColor(side) : TRACER_UNKNOWN;
  }

  // strokeTracer — THE tracer paint, shared by BOTH tracer kinds so they
  // can never drift apart: it owns the traveling-DASH geometry. The path
  // runs (ax, ay) → (bx, by); at progress p ∈ [0, 1] the dash is the
  // fixed-length window [head − TRACER_DASH_PX, head] whose head slides
  // from the path START (p = 0: the full dash sits at the origin) to the
  // path END (p → 1: it sits at the destination) — a SEGMENT anchored on
  // the path, never a growing line. The mapping keeps a full-length
  // dash at both ends (butt caps paint a zero-length segment as nothing)
  // and puts the dash's CENTER exactly at the path midpoint at p = 0.5.
  // Passes: the dark 4 px underlay first, then the caller's STROKE COLOR
  // 2 px on top (the shooter's side color — tracerColor). The CALLER
  // owns globalAlpha (the miss-fade / no-fade policy) and resets it; a
  // degenerate path (zero length) paints nothing. No marching dashes —
  // the trailing setLineDash([])/lineDashOffset=0 is a belt-and-braces
  // reset so no consumer (or future canvas state) can leave the NEXT
  // stroke dashed.
  function strokeTracer(ax, ay, bx, by, progress, color) {
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (!(len > 0)) return; // degenerate path — nothing sane to travel
    const p = progress > 0 ? (progress < 1 ? progress : 1) : 0; // defensive clamp
    const d = Math.min(TRACER_DASH_PX, len); // a dash never outgrows a short path
    const head = d + p * (len - d); // head ∈ [d, len]; tail = head − d ≥ 0
    const ux = dx / len;
    const uy = dy / len;
    const x1 = ax + ux * (head - d);
    const y1 = ay + uy * (head - d);
    const x2 = ax + ux * head;
    const y2 = ay + uy * head;
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
  }

  // drawBulletTracers — the bullet tracers: a traveling dash for EVERY
  // row (the old `draw` selection — semi every shot, auto first + every
  // 3rd — was retired by spec: "animate all tracers") — from where the
  // shot was FIRED (the shooter's sampled position at row.frame) along
  // that frame's yaw to r + MUZZLE_REACH: a trace of the shot's ORIGIN,
  // not of the dot, which has moved on by the time the travel paints.
  // The rows arrive pre-derived from setBullets (lib/replay/bullets.js
  // is the ONE filter: gun-only, freeze-time filtered — the renderer
  // re-derives NOTHING, mirroring the sfx engine that consumes the SAME
  // rows).
  //
  // Positions: row.frame indexes the position stream directly (the row
  // carries its own frame — no frameForTick round-trip). The store only
  // samples ALIVE slots, so a frame with no mask bit for the slot draws
  // NOTHING: no guessed fallback (same rule as drawHitTracers).
  //
  // Timing/alpha: tracerProgress over TRAVEL_S — pure tick math, so the
  // dash is seek-correct and frozen while paused like every other world
  // effect; before the shot tick or once the travel has ended it costs
  // one call and no lookups or transforms. A MISS fades out on its way
  // to the end point — LINEAR 1 − progress (the house envelope style:
  // windowAlpha/blindAlpha are linear too), 1 at the shot tick and
  // exactly 0 at arrival. Stroke = the shooter's side at row.frame
  // (sideAtFrame → tracerColor). Painted WITH drawHitTracers, BEFORE
  // drawPlayers (see draw()): the dots sit on top, so the dash reads as
  // emerging from under the shooter's dot and never covers a name. The
  // caller owns globalAlpha and resets it.
  function drawBulletTracers(tick) {
    const tr = engine.tickRate;
    const r = DOT_R; // the dot radius — reach = r + MUZZLE_REACH from the origin
    for (const b of bullets) {
      const p = tracerProgress(tick, b.tick, tr);
      if (p == null) continue; // not shot yet / travel over — the cheap gate
      const slot = b.slot;
      if (!Number.isInteger(slot) || slot < 0 || slot >= store.slots.length) continue;
      const f = b.frame;
      if (!Number.isInteger(f) || f < 0 || f >= store.frames) continue;
      if (!(store.masks[f] & (1 << slot))) continue; // no sample → no line
      const ppos = store.slots[slot].pos;
      const o = f * 4;
      const a = worldToScreen(ppos[o], ppos[o + 1], ppos[o + 2], scr1);
      const angle = (-ppos[o + 3]) * Math.PI / 180; // engine yaw → screen (drawPlayers' convention)
      // The PATH runs from the ORIGIN (inner 0), reach r + MUZZLE_REACH
      // along the frame's aim — the dash rides it (strokeTracer).
      const rays = muzzleRays(a.x, a.y, angle, 0, r + MUZZLE_REACH, 1, 0);
      if (!rays.length) continue;
      ctx.globalAlpha = 1 - p; // MISS fade — 0 exactly at the end point
      strokeTracer(a.x, a.y, rays[0][2], rays[0][3], p, tracerColor(sideAtFrame(slot, f)));
      ctx.globalAlpha = 1;
    }
  }

  // drawHitTracers — the hit-shot tracer: a traveling dash from the
  // SHOOTER's sampled position to the VICTIM's stored hit position for
  // every damage row whose travel is live — the bullet tracer's
  // counterpart that shows WHO hit WHOM (the bullet tracer draws at the
  // shot's origin; this is the shot's line to its target, so a hit
  // always draws — there is no per-row selection on either kind anymore).
  //
  // Positions: the row carries the VICTIM's hit position (extract stamps
  // PlayerHurt's victim position → normalizeEvent x/y); the shooter has
  // NO stored apos on damage rows (events.apos_* is kill-only —
  // models/dto.go, store/queries.go), so its position is read from the
  // position stream at the hit's tick — the same authoritative samples
  // the dots draw from. A row with no attacker key (world/fall damage),
  // an attacker outside the roster, no stored victim position, or no
  // stream sample for the shooter at that frame (the store only samples
  // ALIVE slots) draws NOTHING: no guessed fallback.
  //
  // Timing/alpha: tracerProgress over TRAVEL_S — so the dash is
  // seek-correct and frozen while paused; a row outside the travel
  // costs one call and no lookups or transforms. A HIT never fades:
  // full alpha until the head arrives, then nothing (progress ≥ 1 stops
  // drawing — see tracerProgress). Stroke = the attacker's side at the
  // hit's tick (throwerSideAt: steamId → slot → side; unresolvable →
  // white, never guessed). Painted BEFORE drawPlayers (see draw()): the
  // dots and name labels stay on top, so the dash reads as emerging
  // from under the shooter's dot instead of crossing a face. The caller
  // owns globalAlpha and resets it.
  function drawHitTracers(tick) {
    const tr = engine.tickRate;
    for (const h of hitTracers) {
      const p = tracerProgress(tick, h.tick, tr);
      if (p == null) continue; // not hit yet / dash arrived and gone
      const slot = slotOfSteam.get(String(h.attacker));
      if (slot == null || slot >= store.slots.length) continue;
      const f = engine.frameForTick(Math.max(engine.firstTick, h.tick));
      if (!(store.masks[f] & (1 << slot))) continue; // no sample → no line
      const ppos = store.slots[slot].pos;
      const b = f * 4;
      const a = worldToScreen(ppos[b], ppos[b + 1], ppos[b + 2], scr1);
      const v = worldToScreen(h.x, h.y, h.z, scr2); // both ends live until strokeTracer
      ctx.globalAlpha = 1; // HIT — no fade, full alpha until arrival
      strokeTracer(a.x, a.y, v.x, v.y, p, tracerColor(throwerSideAt(h.attacker, h.tick)));
      ctx.globalAlpha = 1;
    }
  }

  function drawPlayers() {
    const st = engine.state;
    const tick = st.tick;
    const tr = engine.tickRate;
    // Carrier badges (the carried-C4 marker) are COLLECTED here and
    // painted AFTER the whole slot loop — the two-pass rule (C2): a
    // badge inside the loop sat under every dot drawn after its own
    // slot, so a neighbour's dot/label could cover the objective
    // marker. The pass paints them above EVERY dot, name label and ring
    // of the frame. `c` is the shared worldToScreen scratch, so the
    // badge records its own x/y copy.
    const badges = [];
    for (let slot = 0; slot < store.slots.length; slot++) {
      engine.lerpAt(slot, tmp);
      if (!tmp.alive) continue;
      const c = worldToScreen(tmp.x, tmp.y, tmp.z, scr1);
      if (c.x < -60 || c.y < -60 || c.x > cssW + 60 || c.y > cssH + 60) continue;
      // Elevation indicator (T / ⊥) — the FIRST thing painted for this
      // slot, so every part of the dot (bloom, chevron, fill, rim,
      // overlays, name) draws ON TOP of it: the mark can never obscure
      // the identity/team color. Its stem starts at the dot's CENTER and
      // runs outward (the dot covers the first DOT_R px — a lower canvas
      // level than the entity). For ⊥ the bar lands at cy+14.5, inside
      // the name-label band (baseline cy+22), so the label at the bottom
      // of this loop drops ELEV_NAME_DROP whenever `elev` is set — either
      // direction, the rule is "a mark is present", this same result,
      // never re-derived — clearing the bar. Only when a region box
      // claims this entity's XY, and never for an unknown Z (layers.js
      // elevationFor returns null — no guessed indicator).
      const elev = elevationFor(tmp.x, tmp.y, tmp.z, regions);
      if (elev) drawElevationIndicator(c.x, c.y, elev);
      const color = teamColor(sideAtFrame(slot, st.frame));
      // Constant radius (DOT_R): a crouching player's dot is the same
      // size as a standing one (the duck flag stays on `tmp` for every
      // other consumer — it only ever shrank the dot here).
      const r = DOT_R;
      const angle = (-tmp.yaw) * Math.PI / 180; // engine yaw → screen

      // 26 — talking BLOOM: a WHITE ring expanding OUTWARD FROM THE
      // DOT'S CENTER and fading, looping as long as this slot speaks —
      // the flashbang detonation style anchored at (c.x, c.y), plus a
      // small fading white core. Pure tick math (voiceBloom), so a scrub
      // re-renders the same phase and nothing is sticky; drawn ONLY
      // while voiceSpeaking says this slot talks. This is the FIRST
      // thing painted for the slot: the bloom sits BENEATH the dot —
      // the chevron, fill, rim and every overlay draw on top of it, so
      // only the part outside the dot's edge (up to r + 10) reads as a
      // halo blooming from behind the dot.
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
          ctx.arc(c.x, c.y, 3 * (1 - bloom.k) + 1, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }

      // 27 — view CHEVRON: an open ">" of two arms meeting at the apex
      // pointing along the look direction (no shaft), CENTERED on the
      // dot. Sized at r · 1.8 so the arm ends sit just outside the dot
      // edge (0.6·size along the look ≈ r + 0.7, ±0.5·size across —
      // radius ≈ 0.78·size ≈ 12.6 px at r = 9) instead of floating far
      // away; a 2.75 px stroke at near-opaque team color keeps it
      // clearly visible without competing with the dot itself.
      const pts = chevronPath(c.x, c.y, angle, r * 1.8, chevScratch);
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
      // Flash overlay: while a blind window is open a WHITE layer lifts
      // the dot toward white — PEAK alpha 0.6 (BLIND_PEAK_ALPHA: the
      // team color still reads through, the dot gets lighter rather
      // than turning solid), held for the first quarter of the window,
      // then a linear fade back to the team color (blindAlpha — a pure
      // function of tick, so scrubbing backwards re-renders it and
      // nothing is sticky).
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

      // (24 retired) — the firing indicator is GONE from the dot:
      // tracers are bullet rows (setBullets → drawBulletTracers)
      // painted UNDER the dots in draw(), not a per-dot stub armed by
      // an attack edge.

      // follow ring
      if (st.followSlot === slot) {
        ctx.strokeStyle = '#fbac18';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(c.x, c.y, r + 5, 0, Math.PI * 2);
        ctx.stroke();
      }

      // 31 — plant/defuse PROGRESS ring: while this player is arming
      // the C4 (RED) or defusing (GREEN), a round-capped partial arc
      // grows around the dot from 12 o'clock — a pure function of tick
      // (bomb.js actionProgressAt over the setLandmarks intervals), so
      // a scrub replays the same phase and nothing is sticky. Outside
      // the attempt's [start, end) there is no arc at all; the interval
      // itself is derived ONCE in setLandmarks from bomb.js
      // actionIntervals (begin → completion | abort | round end).
      // Progress is elapsed over the FIXED game duration, not the
      // interval's span (bomb.js actionDurationTicks — 3.125 s plant,
      // defuse 10 s / 5 s by kit): the span bounds VISIBILITY only, so
      // a tapped/faked attempt shows a brief sliver instead of racing
      // to full. The kit resolves HERE at draw — see the two-setter
      // ordering note in setKitEvidence (setLandmarks owns the
      // interval, setKitEvidence owns hasKitAt; both are closure state
      // by the time any frame renders). The defuser's kit is read at
      // the attempt's START tick; null (unanswerable) → NO kit → 10 s.
      // Drawn after the follow ring (r+4 sits inside the follow ring's
      // r+5) and before the carried-C4 badge (which the second pass
      // after the loop paints above everything).
      const actionIvs = actionBySlot.get(slot);
      if (actionIvs) {
        for (const iv of actionIvs) {
          const kit =
            iv.action === 'defuse' && kitHasAt ? kitHasAt(iv.steamId, iv.start) : null;
          const p = actionProgressAt(iv, tick, actionDurationTicks(iv.action, kit, tr));
          if (p == null) continue;
          drawActionRing(c.x, c.y, ACTION_RING_R, iv.action, p);
          break; // at most one live attempt per player
        }
      }

      // 30 — carried-C4 BADGE: this slot's INVENTORY at the playhead
      // (state.js slotStateAt — the per-slot series setStateIndex pushed)
      // still lists 'C4', so this is the bomb carrier. COLLECTED, not
      // painted: the badge is drawn in the second pass after the loop,
      // above every dot/label/ring of the frame (see `badges` above).
      // Dead players never reach here (drawPlayers skips them) and a
      // dropped/planted bomb leaves every inventory, so the badge clears
      // itself; drawBomb owns the world bomb.
      if (stateIndex) {
        const inv = slotStateAt(stateIndex, slot, st.frame).inventory;
        if (Array.isArray(inv) && inv.includes('C4')) badges.push({ x: c.x, y: c.y, r });
      }

      // name label — baseline cy+r+13 (cy+22), dropped ELEV_NAME_DROP
      // (→ cy+27) when THIS slot's elevation mark was drawn (`elev`, the
      // same result that produced the mark above): the 11 px text's top
      // ≈ baseline−11 then sits at ≈ cy+16, ~1.5 px clear of the ⊥ bar's
      // bottom (cy+14.5). No indicator → the label stays at cy+22.
      const name = slotNames[slot] || `#${slot}`;
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur = 3;
      ctx.fillStyle = '#d7dde8';
      ctx.fillText(name, c.x, c.y + r + 13 + (elev ? ELEV_NAME_DROP : 0));
      ctx.shadowBlur = 0;
    }

    // Second pass — the collected carrier badges (C2): painted after the
    // loop so a C4 badge sits ABOVE every dot, name label and ring of
    // the frame (inside the loop it was covered by any slot drawn after
    // its own). The kit badge is deliberately NOT here — a CT dot with a
    // defuse kit gets no dot indicator (the kit lives on the card).
    for (const b of badges) drawCarrierBadge(b, b.r);
  }

  // --- Stage overlay regions (the ratified region map) ------------------------
  // Every overlay owns ONE region. The independent 8-px anchor literals
  // (HUD_PAD, KILL_FEED_EDGE, the DOM theater-exit's top/left 8, the DOM
  // control group's right/bottom 8, the chat's bottom/left 8) are ONE
  // documented table — no overlay may invent its own edge inset:
  //   top-left      — THEATER-EXIT BUTTON, DOM (Replay.svelte
  //                   .rp-theater-exit): top/left 8 px, rendered only
  //                   while theater mode is on — the stage's only
  //                   control then, never gated by any overlay gate
  //                   (master setOverlaysVisible or per-element
  //                   setOverlayLayers).
  //                   The canvas cannot measure DOM, so drawHUD keeps
  //                   this region clear: TOP_LEFT_RESERVE_PX (the
  //                   button's measured width, see the constant below)
  //                   plus the same 8 px is the score box's LEFT bound —
  //                   a FIXED reservation of the region (the canvas
  //                   measures no DOM either way), sized to this ONE
  //                   occupant: a small icon cell (~36 px, below) that
  //                   exists only while theater mode is on (the region
  //                   is empty otherwise). It used to be the control
  //                   group's 0.28 × cssW share (7450c5b, when
  //                   .rp-ctrl-list sat TOP-LEFT); b5d21bf moved that
  //                   group bottom-right and left this button behind —
  //                   keeping the share skewed the score box rightward
  //                   whenever the stage narrowed (events panel open).
  //   top-center    — score + round clock box (drawHUD), HUD_PAD anchors.
  //   top-right     — kill feed (drawKillFeed), KILL_FEED_EDGE anchors —
  //                   the gameplay record: it NEVER ellipsizes, and the
  //                   score box yields to it: the feed's widest row is
  //                   measured FIRST every frame (killFeedLayout) and the
  //                   box lays into [leftBound, feedLeft − SCORE_FEED_GAP].
  //   bottom-left   — in-game chat (drawChat), KILL_FEED_EDGE anchors.
  //                   The bottom playback readout that used to
  //                   stack above it is gone: follow / loop / skip-freeze
  //                   / camera / packNote are DOM rows of the control
  //                   group, so snapshots and clips carry gameplay only.
  //   bottom-right  — CONTROL GROUP, DOM (Replay.svelte .rp-ctrl-list):
  //                   right/bottom 8 px, max-width 0.28 × stage — at its
  //                   widest its left edge lands at 72% of the stage,
  //                   clear of the chat's 40% cap — one row per
  //                   non-default control state, display-only, while its
  //                   own gate is open (the UI popover's stage-indicator
  //                   flag + rows + active); otherwise intentionally
  //                   empty (the group
  //                   renders no box at all when every row is in its
  //                   default state — documented, no code).
  //   above/below   — DOM chrome (.replay-topbar / .replay-transport),
  //                   unchanged.
  // --- HUD -------------------------------------------------------------------
  // ONE box, a pure function of the engine state + the setHud payload:
  //   top-center   — team score + round clock, CENTERED on the stage
  //                  (x = the centered position clamped into the region
  //                  gap above, HUD_PAD from the top).
  //                  The score line is SCORE-ANCHORED (scoreLineLayout):
  //                  the '‹ct› – ‹t›' segment sits dead-center of the
  //                  box, the longer-name side defines the box's extent
  //                  on its side and the shorter side absorbs the slack
  //                  as padding (names stay adjacent to the score); the
  //                  clock line centers as a block. When the box cannot
  //                  fit the gap, the longer team name(s) are cut with
  //                  an ellipsis (ellipsize over scoreLineWidth's name
  //                  term) — the feed never yields, the score does.
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
  // Before the first setHud call the renderer draws NO HUD box at all —
  // the other createRenderer callers (node tests, stubs) never supply
  // one.
  let hud = null;

  // CS2 competitive round clock (CS2.md "Competitive round clock"):
  // 115 s of round time (mp_roundtime_defuse 1.92 min) counted from
  // freeze-time end. The C4's 40 s belongs to bombEndTick
  // (lib/replay/bomb.js) — this constant is ONLY the round-time length.
  const ROUND_TIME_S = 115;
  const HUD_LH = 15; // px per HUD line
  const HUD_PAD = 8; // px inside/around a HUD box — ALSO the region table's
  //                  // top/left anchor (see the region map above)
  const HUD_ICON_PX = 12; // px — an icon's size on an icon+text line
  const HUD_ICON_GAP = 4; // px — icon → text gap on an icon+text line
  // C1 — the score box's gap constraints (region map above): the box
  // yields to BOTH neighbours — the stage's top-left DOM region (the
  // theater-exit button) on the left and the kill feed on the right.
  // TOP_LEFT_RESERVE_PX is that button's MEASURED width: style.css
  // .rp-theater-exit is padding 8+8 px + border 1+1 px + one codicon at
  // font-size 1em (the glyph's advance is exactly 1em — codicon.ttf
  // upem 300, advance 300) = 18 + the root font size = 31/33/35 px
  // across the 13/15/17 px font scale (lib/fontsize.js), so 36 covers
  // the widest. Its old value was 0.28 × cssW — CTRL_GROUP_BUDGET
  // mirroring .rp-ctrl-list's CSS max-width — which dated from
  // 7450c5b, when that control group sat TOP-LEFT; b5d21bf moved the
  // group bottom-right and only the button kept the slot, but the share
  // stayed reserved and skewed the box rightward as the stage narrowed
  // (e.g. the events panel open). The canvas cannot measure DOM, so a
  // fixed constant stays — sized to the occupant, not to the stage.
  // SCORE_FEED_GAP is the 8 px clearance the score box keeps from the
  // feed's LEFT edge (KILL_FEED_EDGE's mirror-image literal, named for
  // the pair it separates).
  const TOP_LEFT_RESERVE_PX = 36; // px — theater-exit button width (region map above)
  const SCORE_FEED_GAP = 8; // px — score box → kill feed clearance
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
  // camera already use — never a second bomb rule. INCLUSIVE at the
  // cutoff on purpose: AT the terminator tick the line must still be
  // the C4 countdown reading 0:00 (the blast moment) — the death-X
  // `>=` would drop it a tick early and let the 115 s round clock flash
  // back before detonatedAt takes over.
  function plantedEndAt(tick, tr, roundNumber) {
    for (const l of plants) {
      if (!l || l.round !== roundNumber || !Number.isFinite(l.tick)) continue;
      if (tick < l.tick) continue;
      const end = bombEndTick(l, tr, explodes, defuses, roundEnds, roundStarts);
      if (tick <= end) return end;
    }
    return null;
  }

  // detonatedAt — true once a plant of this round has EXPLODED at
  // `tick`: the plant's bombEndTick terminator IS a bomb_explode row
  // (bomb.js owns the terminator rule — its 40 s C4 timer is the
  // fallback for MISSING terminator rows only, never a cap over a
  // present one: the recorded plant → blast interval is 41 s, and a
  // 40 s cap truncated `end` before the explosion so this gate never
  // matched and the 115 s round clock resurrected in the round-over
  // tail — the freeze-clock bug). A defused / round-ended /
  // next-round-start-terminated plant is NOT a detonation and keeps
  // today's behavior — a round_start cutoff can only ever make `end`
  // EARLIER, and the explode-row equality below still gates the flag).
  // Keys off the plant's explode tick — never the round's recorded
  // endTick, which can precede the detonation — so the window between
  // the explosion and the next round's start reads 0:00 instead of the
  // 115 s round clock. Inclusive at `tick === end` like plantedEndAt:
  // the explosion tick itself still counts as the detonation.
  function detonatedAt(tick, tr, roundNumber) {
    for (const l of plants) {
      if (!l || l.round !== roundNumber || !Number.isFinite(l.tick)) continue;
      if (tick < l.tick) continue;
      const end = bombEndTick(l, tr, explodes, defuses, roundEnds, roundStarts);
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
  // explicit gap): the ONE measurement measureLine (box width) and hudBox
  // (segment positions) both step by.
  function segWidths(ln) {
    return ln.segs.map((s) => measureHudSeg(s) + (s.gap || 0));
  }

  // measureLine — ONE line's measurement, the single spelling the box
  // width AND hudBox's layout step by: {w} for a plain / icon line,
  // {w, segs} for a {segs} run (the per-segment widths the draw advances
  // `cx` by, so the centered box never re-measures what it already
  // measured). One pass per line per frame: hudBox used to re-measure
  // every centered line — and the score line its segments again — with
  // its own measureText calls after the box width had already measured
  // them.
  function measureLine(ln) {
    if (typeof ln === 'string') return { w: ctx.measureText(ln).width };
    if (ln.segs) {
      const segs = segWidths(ln);
      let w = 0;
      for (const sw of segs) w += sw;
      // The SCORE-ANCHORED line ({segs, scoreAnchor}) measures
      // scoreLineWidth instead of the plain sum: the box has to reach
      // past the LONGER name (see scoreLineWidth), never just hug the
      // block.
      if (ln.scoreAnchor && ln.segs.length === 3) w = scoreLineWidth(segs[0], segs[1], segs[2]);
      return { w, segs };
    }
    // An {img, text} line reserves the icon slot ahead of its text.
    return { w: HUD_ICON_PX + HUD_ICON_GAP + ctx.measureText(ln.text).width };
  }

  // boxWidthOf — the full box width from an ALREADY measured pass
  // (widest line + padding).
  function boxWidthOf(metrics) {
    let w = 0;
    for (const m of metrics) w = Math.max(w, m.w);
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
  // instead of pushing the score off-center; the default 'left' keeps
  // each line's own HUD_PAD inset (the retired bottom readout's style —
  // every current caller centers, both spellings stay).
  // `metrics` (optional) is the caller's measureLine pass for these
  // lines — pass it whenever the caller already measured (drawHUD's
  // centered box), so a box never measures the same line twice; `w` the
  // caller's box width (defaults to the width of a fresh measure).
  function hudBox(lines, x, y, w, align = 'left', metrics = null) {
    const ms = metrics || lines.map(measureLine);
    const boxW = w != null ? w : boxWidthOf(ms);
    const bh = hudBoxHeight(lines.length);
    ctx.fillStyle = 'rgba(14, 17, 22, 0.78)';
    ctx.strokeStyle = 'rgba(35, 42, 55, 0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    // roundRect is baseline in modern WebKit; fall back for older builds
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, boxW, bh, 6);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(x, y, boxW, bh);
      ctx.strokeRect(x, y, boxW, bh);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const baseFont = ctx.font;
    lines.forEach((ln, i) => {
      const y0 = y + HUD_PAD + i * HUD_LH;
      const color = i === 0 ? '#fbac18' : SECONDARY_TEXT;
      ctx.fillStyle = color;
      // content start: the centered box centers every line's measured
      // content (segments then step from here by their own widths); the
      // left box keeps its HUD_PAD inset.
      let cx = x + HUD_PAD;
      if (align === 'center') cx = x + (boxW - ms[i].w) / 2;
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
          const [leftW, scoreW, rightW] = ms[i].segs;
          const lay = scoreLineLayout(leftW, scoreW, rightW, x + boxW / 2);
          xs = [lay.leftX, lay.scoreX, lay.rightX];
        }
        ln.segs.forEach((s, si) => {
          ctx.font = s.font || baseFont;
          ctx.fillStyle = s.color || color;
          const sx = xs ? xs[si] : cx;
          ctx.fillText(s.text, sx, y0);
          if (!xs) {
            // same step the width was measured with (incl. an explicit gap)
            cx += ms[i].segs[si];
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

  // --- deferred draws (the scrub-drag coalescing) ----------------------------
  // requestDraw marks the canvas dirty and schedules ONE rAF draw; while
  // that mark is up, setHud stores its payload but SKIPS its synchronous
  // draw (the rAF paints the latest engine state instead). Replay's
  // onScrub marks BEFORE the seek, so a drag's whole input burst — each
  // event's synchronous onChange → setHud cascade — costs one draw per
  // display frame instead of one per event. The engine state itself is
  // still updated per event (seek semantics are untouched: engine.js),
  // the flush lands on the NEXT frame (no added latency to the final
  // position of a drag), and outside a burst nothing defers: every other
  // setHud draws synchronously exactly as before, so the playing cadence
  // is unchanged. destroy() cancels a pending flush.
  let drawDirty = false;
  let drawRaf = 0;

  function flushDraw() {
    drawRaf = 0;
    drawDirty = false;
    draw();
  }

  function requestDraw() {
    drawDirty = true;
    if (!drawRaf) drawRaf = requestAnimationFrame(flushDraw);
  }

  // setHud(payload): score/round context for the top-center HUD box —
  // additive like the other setters (redraws on set). A null/absent
  // payload clears it: the renderer then draws the playback box (and no
  // kill feed) alone — the state before any view supplied a score line.
  function setHud(payload) {
    hud = payload || null;
    if (drawDirty) return; // the pending frame paints the burst's latest
    draw();
  }

  // setOverlaysVisible(on): the MASTER overlay gate — pushed by the
  // keep-alive dock rule (collapse → world-only frame, expand → back;
  // boolean `active` in Replay.svelte), never by a single element. While
  // false, draw() skips the whole overlay group (HUD box, kill feed,
  // chat — the DOM control-group rows go with them, gated view-side);
  // the gameplay layers are NEVER gated, and TOP_LEFT_RESERVE_PX stays
  // reserved so the score box's x-position does not jump when the group
  // comes back. BOOLEAN, exactly as before: per-element hiding rides
  // setOverlayLayers BELOW (a boolean `on !== false` contract — callers
  // may keep passing plain booleans). Additive like setHud: payloads
  // keep flowing while hidden (the engine's per-change setHud still
  // stores its payload), so re-enabling repaints the CURRENT state
  // without a re-push. The drawDirty guard mirrors setHud's: the pending
  // frame paints the burst's latest instead of a synchronous draw per
  // event.
  let overlaysVisible = true;
  function setOverlaysVisible(on) {
    overlaysVisible = on !== false;
    if (drawDirty) return; // the pending frame paints the burst's latest
    draw();
  }

  // Per-layer overlay state — the E3 popover's per-ELEMENT half, UNDER
  // the master gate above (master off ⇒ nothing paints whatever these
  // say). {hud: score box, feed: kill feed, chat} maps the view's
  // {score, feed, chat} flags (Replay's setUiLayer pushes score→hud);
  // the fourth popover element (stage indicators / .rp-ctrl-list) is
  // DOM-only and never reaches the renderer. Defaults ALL ON — the
  // view pushes its current flags beside every master push, exactly like
  // setDropLayers/setHud (a repeat call is additive and harmless).
  // NOTE draw()'s gate still runs killFeedLayout()/chatLayout() even
  // when their layer is hidden: feed.left is the score box's right-hand
  // bound, so hiding the feed must NOT move the score box (the same
  // philosophy as TOP_LEFT_RESERVE_PX's fixed reservation).
  let overlayLayers = { hud: true, feed: true, chat: true };
  function setOverlayLayers(f) {
    if (f) overlayLayers = { ...overlayLayers, ...f }; // spread-merge: one flag, whole triple pushed
    if (drawDirty) return; // the pending frame paints the burst's latest
    draw();
  }

  function drawHUD(feed) {
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
        // ONE measurement pass for the box: hudBox takes the same
        // metrics for its centering instead of re-measuring each line.
        let ms = top.map(measureLine);
        let w = boxWidthOf(ms);
        // C1 — the box lays into the gap the region map leaves: the
        // top-left DOM region's right bound (TOP_LEFT_RESERVE_PX — the
        // theater-exit button's width) on the left, the kill feed's
        // left edge − SCORE_FEED_GAP on the right. The button's own
        // `left: 8 px` anchor is the SAME 8 px literal as HUD_PAD (the
        // region table's shared anchor), so reserve + pad lands the
        // box's left edge at/after the button's right edge: 36 + 8 = 44
        // ≥ 8 + 35 (the button at the widest font-size setting).
        // `feed` was measured FIRST this frame (killFeedLayout, called
        // by draw() before this); with no feed in scope the stage's own
        // right edge bounds the box.
        const rightBound = (feed ? feed.left : cssW) - SCORE_FEED_GAP;
        const leftBound = TOP_LEFT_RESERVE_PX + HUD_PAD;
        const line = top[0];
        if (w > rightBound - leftBound && line.scoreAnchor && ms[0].segs) {
          // The gap is too narrow for the line: cut the LONGER team
          // name — scoreLineWidth's name term is 2·max(name) + score —
          // down to the half of the gap the score segment leaves over.
          // Both sides are cut when both exceed it (equal long names),
          // because scoreLineWidth keys off the MAX. The clock line is
          // short enough to shift without a cut; the clamp below keeps
          // its right edge clear regardless.
          const room = (rightBound - leftBound - HUD_PAD * 2 - ms[0].segs[1]) / 2;
          for (const i of [0, 2]) {
            if (ms[0].segs[i] > room) {
              line.segs[i].text = ellipsize(line.segs[i].text, room, (s) => ctx.measureText(s).width);
            }
          }
          ms = top.map(measureLine);
          w = boxWidthOf(ms);
        }
        // The clamp: centered, but never under the top-left DOM region and
        // never over the feed. When the two bounds cross (a feed row
        // wider than the gap) the FEED wins — x then pins the box's
        // RIGHT edge to the bound, which is the invariant the property
        // test pins at every stage width.
        const x = Math.min(Math.max((cssW - w) / 2, leftBound), rightBound - w);
        hudBox(top, x, HUD_PAD, w, 'center', ms);
      }
    }
  }

  // --- Entry boxes (the shared kill-feed / chat surface) ----------------------
  // entryBox — the ONE entry-box painter both dark overlays share: the
  // kill feed and the chat (drawChat) are the SAME surface (dark
  // transparent fill, KILL_FEED_R rounded corners, 1 px hairline border
  // in the caller's color — the killer's / speaker's team color), so
  // the paint lives here once instead of twice. Fill and stroke run on
  // ONE path (roundRect, plain-rect fallback), so they always share the
  // exact outline. Returns nothing; the caller draws its text after.
  function entryBox(x, y, w, h, border) {
    ctx.fillStyle = 'rgba(14,17,22,0.78)';
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, h, KILL_FEED_R);
    } else {
      ctx.rect(x, y, w, h);
    }
    ctx.fill();
    ctx.stroke();
  }

  // --- Kill feed -------------------------------------------------------------
  // Top-right, canvas-drawn (snapshots and clip recordings capture ONLY
  // the canvas): the kills of the ROUND CONTAINING the playhead that have
  // already happened — round-scoped AND tick ≤ playhead, so a round
  // change clears the feed and a backwards scrub re-derives it (nothing
  // sticky, nothing remembered). Rows run OLDEST → NEWEST top-anchored on
  // the edge: a fresh kill APPENDS at the BOTTOM and the rows already on
  // screen never move (the cap keeps the NEWEST KILL_FEED_MAX — the
  // oldest falls off the top, exactly chatLayout's rule for the chat).
  // One line each, cells left → right:
  //   (blind) attacker (+ assister) (airborne) weapon (noscope)
  //   (through-smoke) (wallbang) (headshot) victim
  // over a dark transparent box (entryBox) outlined in the KILLER's team
  // color (neutral when unknown); names are tinted by their own side AT
  // THE KILL TICK (sideAtFrame — the same rule the death markers use).
  // Two short glyph + victim rows replace the whole line (C4 checked
  // FIRST):
  //   • C4 death:   C4 icon + victim — no killer/assister/attacker-side
  //                 flags at all; outlined in T ORANGE (teamColor('t')):
  //                 the bomb always belongs to the T side, this is NOT a
  //                 killer's side (there is none).
  //   • Suicide:    weapon !== 'C4' AND (attacker empty OR attacker ===
  //                 victim) — world/fall ('World'), own utility and plain
  //                 self-kills: (suicide) victim, outlined in the VICTIM's
  //                 side (the killer IS the victim / there is none).
  // The parenthesized indicators are IMAGES from the icon manifest
  // (iconFor('blind_kill') before the killer, iconFor('airborne') after
  // it, then the weapon's glyph, iconFor('noscope'/'throughsmoke'/
  // 'wallbang'/'headshot') after the weapon — internal/mappack/icons.go
  // extracts them from panorama/images/hud/deathnotice/; the C4 row's
  // glyph is the shared 'C4' image, never 'planted_c4' — deliberately
  // not extracted, see its branch); a row whose glyph isn't extracted
  // yet draws WITHOUT it — no space reserved, so the other cells never
  // shift (degradation must not move what's on screen).
  // killFeedLayout — the feed's ONE per-frame layout pass: the scope
  // rule (round-scoped, tick ≤ playhead, oldest first, newest
  // KILL_FEED_MAX kept), every visible row's CELLS (the whole build —
  // colors resolved at the kill tick) and its measured width + left
  // edge at the feed's font. draw() runs it BEFORE drawHUD: the score
  // box's C1 clamp reads `left` (the leftmost edge any row reaches
  // this frame), and drawKillFeed then paints exactly what was measured
  // — one measure pass per row per frame serves both. Returns null on
  // the paint pass's old early-outs (no hud.round / nothing in scope):
  // no feed → no bound, no paint.
  function killFeedLayout() {
    if (!hud || !hud.round || !Number.isFinite(hud.round.number)) return null;
    const st = engine.state;
    const rn = hud.round.number;
    const rows = [];
    for (const k of kills) {
      if (!k || k.round !== rn || !Number.isFinite(k.tick) || k.tick > st.tick) continue;
      rows.push(k);
    }
    if (!rows.length) return null;
    // oldest first: a new kill appends BELOW the rows already shown
    // (the old newest-first order pushed the whole stack down on every
    // kill), and the cap below drops the oldest — the NEWEST 6 stay.
    rows.sort((a, b) => a.tick - b.tick);
    const shown = rows.slice(-KILL_FEED_MAX);
    // No position store (a caller that never fed data) → no side to
    // resolve: every name/border degrades to the neutral color instead
    // of throwing — sideAtFrame needs the store.
    const nSlots = (store && store.slots && store.slots.length) || 0;

    // Measured at the FEED's font (the paint pass sets the same one),
    // then restored: drawHUD's box measurement must not inherit it.
    const prevFont = ctx.font;
    ctx.font = KILL_FEED_FONT;
    const out = [];
    for (const k of shown) {
      // Side at the kill tick (frame BEFORE the kill — the victim may
      // already be unalived on the kill frame; drawDeaths' reasoning).
      const frame = engine.frameForTick(Math.max(engine.firstTick, k.tick - 1));
      const ks = slotOfSteam.get(String(k.attacker || ''));
      const vs = slotOfSteam.get(String(k.victim || ''));
      const kSide = ks != null && ks < nSlots ? sideAtFrame(ks, frame) : '';
      const vSide = vs != null && vs < nSlots ? sideAtFrame(vs, frame) : '';
      const victim = k.victimName || k.victim || '?';
      const img = iconFor(k.weapon); // canonical name → manifest image
      // The indicators: only when the ROW asks for them AND the manifest
      // has them (a pre-re-extraction install lacks the glyphs). A
      // missing image contributes NO cell — not even a gap — so a row
      // without the glyph is pixel-identical to a row that never had the
      // flag (the feed's degradation rule).
      const blindImg = k.attackerBlind ? iconFor('blind_kill') : null;
      const airborneImg = k.attackerInAir ? iconFor('airborne') : null;
      // noscope only on the four scoped snipers (NOSCOPE_WEAPONS — the
      // spec names them; belt and braces against a stray game flag).
      const nsImg =
        k.noscope && NOSCOPE_WEAPONS.has(k.weapon) ? iconFor('noscope') : null;
      const smokeImg = k.throughSmoke ? iconFor('throughsmoke') : null;
      const wbImg = k.wallbang ? iconFor('wallbang') : null;
      const hsImg = k.headshot ? iconFor('headshot') : null;
      // outlineSide: the box's team color — the KILLER's side normally,
      // overridden for the two glyph + victim rows (see the header
      // comment).
      let outlineSide = kSide;
      let cells;
      if (k.weapon === 'C4') {
        // Bomb death: NO killer name, NO assister, NO attacker-side
        // flags. Outlined in T ORANGE — the bomb belongs to the T side
        // (NOT the killer's side: there is none). The row shows the C4
        // WEAPON icon (canonical key 'C4' — never 'planted_c4', which is
        // deliberately not extracted; internal/mappack/icons.go) beside
        // the victim, because that is what CS2's deathnotice binds for a
        // bomb death (CS2.md "Kill-feed indicator glyphs"). The hud
        // 'explosion' blast pip is dropped from this row: its artwork is
        // 48×126 squeezed into a 14 px line → a ~3 px invisible speck
        // that conveys nothing at this geometry (it never made the row
        // read as "C4").
        outlineSide = 't';
        cells = [];
        const c4Img = iconFor('C4');
        if (c4Img) cells.push({ img: c4Img }); // same skip-a-missing-glyph rule
        cells.push({ text: victim, fill: teamColor(vSide) });
      } else if (!k.attacker || k.attacker === k.victim) {
        // Suicide: world/fall (weapon 'World'), own utility, plain
        // self-kills — the killer IS the victim or does not exist, so
        // there is no killer name and the outline takes the VICTIM's
        // side. (C4 above takes precedence.)
        outlineSide = vSide;
        cells = [];
        const suicide = iconFor('suicide');
        if (suicide) cells.push({ img: suicide });
        cells.push({ text: victim, fill: teamColor(vSide) });
      } else {
        const killer = k.attackerName || k.attacker || '?';
        // spec's "killer (+ assister)": the addition FOLLOWS the killer in
        // ONE fillText, so the whole cell keeps the killer-side color.
        const killerCell = k.assisterName ? `${killer} + ${k.assisterName}` : killer;
        cells = [];
        if (blindImg) cells.push({ img: blindImg }); // before the killer's name
        cells.push({ text: killerCell, fill: teamColor(kSide) });
        if (airborneImg) cells.push({ img: airborneImg }); // after the name
        // no image for this weapon — a simple arrow, never an error
        cells.push(img ? { img } : { text: '→', fill: SECONDARY_TEXT });
        if (nsImg) cells.push({ img: nsImg });
        if (smokeImg) cells.push({ img: smokeImg });
        if (wbImg) cells.push({ img: wbImg });
        if (hsImg) cells.push({ img: hsImg }); // after the weapon's flags
        cells.push({ text: victim, fill: teamColor(vSide) });
      }
      // cellWidth — an image cell reserves its ACTUAL painted width
      // (KILL_FEED_ICON · iconAspect + 2: drawIcon paints the body
      // size·aspect wide plus a 1 px halo each side — iconAspect/drawIcon),
      // and a text cell its measured width. The image is then centered in
      // that slot, which is what makes the margin on EACH side exactly
      // KILL_FEED_GAP — the old fixed 14 px slot let wide sprites (AWP,
      // aspect 3.42 → ~48 px) punch through both gaps into the names.
      const cellWidth = (cell) =>
        cell.img ? KILL_FEED_ICON * iconAspect(cell.img) + 2 : ctx.measureText(cell.text).width;
      const widths = cells.map(cellWidth);
      const w =
        KILL_FEED_INSET * 2 +
        widths.reduce((a, b) => a + b, 0) +
        KILL_FEED_GAP * (cells.length - 1);
      out.push({ outlineSide, cells, widths, w, x: cssW - KILL_FEED_EDGE - w });
    }
    ctx.font = prevFont;
    return {
      rows: out,
      // the leftmost edge the feed reaches — drawHUD's right-hand bound
      left: out.reduce((min, r) => Math.min(min, r.x), cssW),
    };
  }

  // drawKillFeed — the PAINT pass over killFeedLayout's measurement
  // (the cells/widths/edges are precomputed there, so this never
  // re-measures): a box + its cells per row, oldest at the top.
  function drawKillFeed(feed) {
    if (!feed) return;
    ctx.font = KILL_FEED_FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (let i = 0; i < feed.rows.length; i++) {
      const { outlineSide, cells, widths, w, x } = feed.rows[i];
      // oldest at the top, entries on the PITCH (box height + gap) so they
      // read as separate lines instead of one touching stack
      const y = KILL_FEED_EDGE + i * KILL_FEED_PITCH;

      // box: the shared dark surface outlined in the row's team color
      entryBox(x, y, w, KILL_FEED_LH, teamColor(outlineSide));

      let tx = x + KILL_FEED_INSET;
      for (let c = 0; c < cells.length; c++) {
        const cell = cells[c];
        if (cell.img) {
          // centered in the reserved slot: the halo fills [tx, tx+width]
          // exactly, so BOTH gaps come out to KILL_FEED_GAP
          drawIcon(cell.img, tx + widths[c] / 2, y + KILL_FEED_LH / 2, KILL_FEED_ICON);
        } else {
          ctx.fillStyle = cell.fill;
          ctx.fillText(cell.text, tx, y + 4);
        }
        tx += widths[c] + KILL_FEED_GAP;
      }
    }
    ctx.textBaseline = 'alphabetic';
  }

  // --- In-game chat (drawChat — the bottom-left overlay) ----------------------
  // Bottom-left, canvas-drawn exactly like the kill feed (snapshots and
  // clip recordings capture ONLY the canvas): the chat lines of the
  // ROUND CONTAINING the playhead that have already happened —
  // round-scoped AND tick ≤ playhead, the same clearing/scrub rule as
  // drawKillFeed, which is also the "clear chat between rounds" rule
  // (pure tick math: a round change empties the stack, a backwards scrub
  // re-derives it). One entry per message over the feed's dark surface
  // (entryBox — the SHARED painter), outlined in the SPEAKER's team
  // color AT THE MESSAGE TICK (slotOfSteam → sideAtFrame, exactly how
  // the feed resolves the killer; an unresolvable speaker gets the
  // neutral outline — a side is never guessed).

  // chatLayout — the chat's scope + stack geometry, the ONE rule
  // drawChat (painting it) steps by. Rows are sorted chronologically and
  // capped at CHAT_MAX with the OLDEST dropped, so the NEWEST message
  // sits at the bottom-left corner (adjacent to the edge) and the stack
  // grows upward on the feed's PITCH. Returns { rows, top } where `top`
  // is the stack's top edge — cssH when nothing is in scope (the empty
  // rows short-circuit drawChat before `top` matters). The bottom-left
  // corner is the CHAT's alone now: the playback readout that used to
  // stack 8 px above this moved to the DOM control group, so nothing
  // else reads `top`.
  function chatLayout() {
    if (!hud || !hud.round || !Number.isFinite(hud.round.number)) return { rows: [], top: cssH };
    const st = engine.state;
    const rn = hud.round.number;
    const rows = [];
    for (const c of chats) {
      if (!c || c.round !== rn || !Number.isFinite(c.tick) || c.tick > st.tick) continue;
      rows.push(c);
    }
    rows.sort((a, b) => a.tick - b.tick); // chronological — oldest first
    if (rows.length > CHAT_MAX) rows.splice(0, rows.length - CHAT_MAX); // drop the oldest above
    if (!rows.length) return { rows, top: cssH };
    return {
      rows,
      top: cssH - KILL_FEED_EDGE - KILL_FEED_LH - (rows.length - 1) * KILL_FEED_PITCH,
    };
  }

  function drawChat(chat) {
    const { rows, top } = chat;
    if (!rows.length) return;
    // No position store (a caller that never fed data) → no side to
    // resolve: every name/border degrades to the neutral color instead
    // of throwing — sideAtFrame needs the store (same as the feed).
    const nSlots = (store && store.slots && store.slots.length) || 0;
    const budget = cssW * CHAT_MAX_W;

    ctx.font = KILL_FEED_FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (let i = 0; i < rows.length; i++) {
      const c = rows[i];
      // The speaker's side AT THE MESSAGE TICK — no kill-frame −1 here:
      // nothing dies on a chat line (the feed's −1 exists because the
      // victim may already be unalived on the kill frame).
      const frame = engine.frameForTick(Math.max(engine.firstTick, c.tick));
      const slot = slotOfSteam.get(String(c.steamId || ''));
      const side = slot != null && slot < nSlots ? sideAtFrame(slot, frame) : '';
      const name = c.name || '?';
      // THE chat display rule on canvas: `name[ tag]: message` — the tag
      // is fmt.chatTag over the row's channel and the ALREADY-resolved
      // live side ('[ALL]' for all chat, the speaker's SIDE '[T]'/'[CT]'
      // for team chat, none when either is unknown — never guessed), so
      // the tag sits in the SAME side color as the name. The name+tag
      // segment measures as ONE head: a long message is cut (with an
      // ellipsis) so one entry never spans more than CHAT_MAX_W of the
      // stage: the stack hugs the corner either way.
      const head = (() => {
        const tag = chatTag(c.channel || '', side);
        return tag ? `${name} ${tag}` : name;
      })();
      // The cut — and both widths — is CACHED per row + stage width
      // (chatFitCache): rows are static per match (setChat) and the head
      // is a pure function of the row + the store's side, so the
      // measureText loop that walks ONE character per measurement runs
      // once per row per width instead of every frame (a long chat used
      // to cost hundreds of measureText calls per frame against a ~27
      // baseline). The head compare is the correctness guard: a changed
      // head (a reloaded position store) recomputes instead of serving
      // a stale cut. A row without an id never joins the cache — no
      // shared key.
      const key = c.id != null ? `${c.id}|${cssW}` : null;
      let fit = key != null ? chatFitCache.get(key) : null;
      if (!fit || fit.head !== head) {
        const headW = ctx.measureText(head).width;
        const msg = c.text == null ? '' : String(c.text);
        // THE cut rule (ellipsize) over the entry's remaining room:
        // whatever CHAT_MAX_W leaves after both insets and the measured
        // name+tag head decides how much of ': '+message survives — one
        // measurement per candidate, exactly as the inline loop cost.
        const body = msg
          ? ellipsize(
              `: ${msg}`,
              budget - KILL_FEED_INSET * 2 - headW,
              (s) => ctx.measureText(s).width,
            )
          : '';
        fit = { head, headW, body, bodyW: ctx.measureText(body).width };
        if (key != null) chatFitCache.set(key, fit);
      }
      const headW = fit.headW;
      const body = fit.body;
      const w = KILL_FEED_INSET * 2 + headW + fit.bodyW;
      const y = top + i * KILL_FEED_PITCH;

      // box: the shared dark surface outlined in the speaker's color
      entryBox(KILL_FEED_EDGE, y, w, KILL_FEED_LH, teamColor(side));

      let tx = KILL_FEED_EDGE + KILL_FEED_INSET;
      ctx.fillStyle = teamColor(side);
      ctx.fillText(head, tx, y + 4);
      tx += headW;
      if (body) {
        ctx.fillStyle = SECONDARY_TEXT;
        ctx.fillText(body, tx, y + 4);
      }
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
          followX = followY = followZ = null;
        }
        engine.lerpAt(st.followSlot, tmp);
        // Hold the last ALIVE position while they are dead (respawn /
        // round transition): lerpAt leaves x/y untouched for dead frames
        // and tmp is shared with drawPlayers, so without this hold the
        // camera would jump to whichever slot drew last.
        if (tmp.alive && Number.isFinite(tmp.x)) {
          followX = tmp.x;
          followY = tmp.y;
          followZ = tmp.z; // their panel — the camera follows the FLOOR too
        }
        if (followX != null) {
          worldToImage(followX, followY, imgPt, followZ);
          cam.cx = imgPt.x;
          cam.cy = imgPt.y;
        }
      } else {
        followFor = -1;
      }
      drawTrails(st.frame);
      drawGrenades(st.tick);
      // Death X UNDER the bomb layer: the dropped/planted C4 icon and
      // its rings must render ABOVE a victim's X (an X overlapping the
      // bomb read as a stray mark on it).
      drawDeaths(st.tick); // the victim's team-color X (spec 28)
      // Drop markers ABOVE the death X (same read as death-X-under-bomb:
      // an item icon over an X reads as the X's stray mark), and drawn
      // BEFORE drawBomb so the C4 markers keep the topmost ground-item
      // slot they've always had over death markers.
      drawDrops(st.tick); // the inferred death drops (opt-in layer)
      drawBomb(st.tick, now);
      // Bullet tracers UNDER the players, painted WITH the hit-shot
      // tracer: both must read as coming out of the shooter's dot, and
      // a line painted over the dots would cross both faces and their
      // name labels — so the dots paint on top of their endpoints (the
      // tracer moved OUT of drawPlayers with the rework: it is a shot
      // trace from the fire position, not a per-dot stub).
      drawBulletTracers(st.tick);
      drawHitTracers(st.tick);
      drawPlayers();
    }
    // The feed is laid out BEFORE the HUD paints (its leftmost edge is
    // the score box's right-hand bound — drawHUD's C1 clamp) and then
    // painted from exactly that measurement; ONE chatLayout() per frame
    // for the same reason — each scope/geometry computed once instead of
    // once per phase. TWO gates: the MASTER (setOverlaysVisible) skips
    // the whole group (the keep-alive dock rule), then the per-layer
    // flags (setOverlayLayers — the E3 popover's elements) pick WHICH of
    // the three paint. Both layouts still run for a HIDDEN layer
    // whenever the master is on: feed.left is the score box's
    // right-hand bound (hiding the kill feed must not move the score
    // box) and chatLayout is the chat's stack geometry — the same
    // fixed-reservation philosophy as TOP_LEFT_RESERVE_PX. The gameplay
    // layers above are never gated.
    if (overlaysVisible) {
      const feed = killFeedLayout();
      const chat = chatLayout();
      if (overlayLayers.hud) drawHUD(feed);
      if (overlayLayers.feed) drawKillFeed(feed);
      if (overlayLayers.chat) drawChat(chat); // in-game chat — the same overlay group as the kill feed
    }
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
    requestDraw,
    resize,
    fit,
    setPack,
    setLandmarks,
    setHud,
    setOverlaysVisible,
    setOverlayLayers,
    setIcons,
    setVoices,
    setBlinds,
    setChat,
    setBullets,
    setDecoyPlan,
    setDropLayers,
    setKitEvidence,
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
