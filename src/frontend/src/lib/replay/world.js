// lib/replay/world.js — THE replay WORLD dataset: the match-static half
// of the replay, decoupled from the landmark feed (the product owner's
// top priority — the two products share one event vocabulary and
// nothing else).
//
//   OWNS  · the once-per-match fetch: the kinds:DRAW_KINDS anchor read
//           + its side channels (the death-drop payload projection, the
//           per-kill victimHelmet stamp from the state stream, the
//           grenade-entity hydration, and the buytime_ended boundary the
//           kit evidence needs);
//         · the canonical world NORMALIZATION (landmarks.normalizeWorld
//           — no claim gate, no round policy, no category stamp: the
//           feed's rules never reach the world);
//         · the world PUSHES at startEngine: renderer.setLandmarks +
//           setKitEvidence + setDecoyPlan, and the sfx engine's
//           setLandmarks + setDecoyPlan — both halves take the SAME
//           world object, so the two consumers can never see different
//           rows.
//
//   LOADS ONCE, PUSHES ONCE: load() creates the world once per match
//   load; the pushes run in startEngine (and the sfx microtask), never
//   on a filter edit — the dataset has no filter dependency to react
//   with. Its identity is the session's: the live-stats cursor and the
//   kit evidence key off it (Replay's drawNorm/kitEv deriveds are
//   aliases of world.rows / world.kitEv).
//
//   DOES NOT OWN: the decoy plan's DERIVATION (decoy.js is pure, but
//   the plan needs Replay's engine/sideAt closures — Replay computes it
//   and passes it into the pushes), the live-stats rows (a $derived over
//   world.rows), and the pre-engine fail-soft decoy re-push in load()
//   (rows may not exist yet; startEngine re-pushes the real one).
//
// Every read here is fail-soft: a failed side channel yields its empty
// value (no stamps → no drop markers, no helmet cues, "no buy evidence")
// and never a load error — the exact contract the inline code had.
import { getEvents, getDropDetails, getGenericEvents } from '../services.js';
import { DRAW_KINDS, normalizeWorld } from './landmarks.js';
import { slotAliveHelmetAt } from './sfx.js';
import { buildKitEvidence, buyEndsFromRows } from './kits.js';

// The grenade kinds whose rows carry a projectile entity (the bulk
// EventDetail read hydrates it — see hydrateGrenadeEntities).
const GRENADE_KINDS = new Set(['grenade_throw', 'grenade', 'grenade_bounce']);

// BULK_CHUNK — the ids per GetEventDetails IPC call: the same number as
// the store's IN-list chunk (internal/store inListChunk), so one call is
// one SQL statement and neither side has to split the other's payload.
// Exported for world-hydration.test.js, which pins the chunk boundary.
export const BULK_CHUNK = 400;

// HYDRATION_UNIT — the onProgress unit for the hydration denominator,
// lowercase-plural like the preload ledger's other units ('images' in
// the pack stage, 'bytes' in positions): one unit per unique grenade
// detail id ATTEMPTED. 'grenade reads' names the work the denominator
// actually counts — the bulk GetEventDetails reads, not rows or bytes.
const HYDRATION_UNIT = 'grenade reads';

// loadWorld — the ONE match-static world fetch. Sequential like the
// inline code it replaces: the anchor read and its side channel first,
// then the grenade hydration, then the buytime boundary (the kit
// evidence's second input) — so startEngine's pushes always see a
// complete world.
//
//   matchId   — the match to load.
//   players   — meta.players (the sidecar slot table): the victimHelmet
//               stamp resolves the victim's STEAM id through it to a
//               slot (EventRow carries no slot).
//   stateIndex— the parsed position stream (null = no stream): the
//               helmet read needs it, and without it every kill stamps
//               helmet null → silence, never a guess.
//   ticks     — data.ticks: the LAST frame ≤ the kill tick (the stamp's
//               binary search); null → no stamps.
//   tickRate  — meta.tickRate: the kit evidence's window arithmetic.
//   onProgress — OPTIONAL, additive: {done, total, unit} reports in the
//               preload ledger's vocabulary (preload.js: the pack stage
//               reports unit 'images', positions unit 'bytes'; this one
//               reports unit 'grenade reads' — one unit per unique
//               grenade detail id ATTEMPTED). Absent (default) = zero
//               reports, exactly today's behavior. It fires ONCE with
//               {done: 0, total: <unique grenade ids>, unit} immediately
//               BEFORE the bulk chunk reads start — and only when they
//               WILL run: an unresolvable binding or a match with no
//               bounce rows reports NOTHING (indeterminate is honest;
//               claiming work that never ran is not) — then once per
//               chunk SETTLE: each chunk adds its own length to done
//               whether it RESOLVED or REJECTED (fail-soft contract: a
//               failed chunk's ids were attempted work, so done reaches
//               total even when every chunk rejects — the bar never
//               sticks below 100%). The anchor/drop/buytime reads are
//               single IPC calls with no honest count → never reported
//               (an invented step denominator is the fake-stage this
//               ledger refuses). The bar may reach 100% while the
//               trailing buytime read + normalize still finish — the
//               denominator counts the hydration reads; the stage
//               completes when the whole load resolves — honest, since
//               every counted id was really attempted.
export async function loadWorld({ matchId, players, stateIndex, ticks, tickRate, onProgress }) {
  const [rows, dropDetails] = await Promise.all([
    getEvents({ matchId, kinds: DRAW_KINDS, offset: 0, limit: 0 }).catch(() => []),
    getDropDetails(matchId).catch(() => []),
  ]);
  const dropsBySeq = new Map((dropDetails || []).map((d) => [d.seq, d]));
  // The slot table the helmet stamp resolves through (meta.players — the
  // SAME table buildStateIndex numbers slots by).
  const slotBySteam = new Map();
  (players || []).forEach((p, i) => {
    if (p && p.steamId != null) slotBySteam.set(String(p.steamId), i);
  });
  const stamped = (rows || []).map((r) => {
    const d = dropsBySeq.get(r.seq);
    const withDrop = d
      ? { ...r, dropCat: d.cat, dropAmmo: { mag: d.mag, reserve: d.reserve } }
      : r;
    return stampVictimHelmet(withDrop, { slotBySteam, stateIndex, ticks });
  });
  const hydrated = await hydrateGrenadeEntities(stamped, onProgress);
  // buytime_ended — the ONE generic read the defuse-kit evidence needs:
  // the per-round buy-window boundary that separates a kit bought on the
  // buy menu from one taken off a dead CT (both are the SAME item_pickup
  // row — only buytime tells them apart, lib/replay/kits.js). Round -1 =
  // all rounds in ONE call; limit 0 = the store's default page (500).
  // Fail-soft: an error → [] → an EMPTY boundary map, and a round with
  // no row reads as "no buy evidence" (never an invented buy window).
  const bt = await getGenericEvents(matchId, 'buytime_ended', -1, 0, 0).catch(() => []);
  return buildWorld(hydrated, buyEndsFromRows(bt), tickRate);
}

// buildWorld — raw (stamped) anchor rows → THE world object: the
// canonical normalization once, plus the match-static kit evidence built
// from it (both inputs are match-static, so it never rebuilds). kitEv
// stays null while there is no boundary at all — an unknown answer,
// never a guessed one — exactly the tri-state the cards read.
function buildWorld(rawRows, buyEnds, tickRate) {
  const rows = (rawRows || []).map((r) => normalizeWorld(r)).filter(Boolean);
  return {
    rows,
    buyEnds: buyEnds || null,
    kitEv: buyEnds ? buildKitEvidence(rows, buyEnds, tickRate) : null,
  };
}

// stampVictimHelmet — the headshot-cue input: every kill row gets
// `victimHelmet` (true/false/null) from the sidecar state stream —
// sfx.js headshotKillCues keys its dink/bare pair off it, and
// normalizeWorld's `...ev` spread carries it onto the cue input.
// Resolve the victim's STEAM id to a slot (meta.players), map the kill
// tick onto the position stream's LAST frame ≤ tick (sideAtTick's binary
// search — the engine does not exist yet at load time) and read the
// helmet through slotAliveHelmetAt (sfx.js): the victim's last record
// while hp > 0, so the death sample's as-read zeroing (hp 0/helmet false
// on the killing blow — internal/sidecar state_test.go deadSample) can
// never flip a helmeted victim to bare. Unknown inputs (no stream, no
// victim slot, no frame, no alive sample) stamp null → silence — never
// a guess. Only kill rows carry it.
function stampVictimHelmet(row, { slotBySteam, stateIndex, ticks }) {
  if (String(row.kind || '') !== 'kill') return row;
  let helmet = null;
  const slot = slotBySteam.get(String(row.victim || ''));
  const t = Number(row.tick);
  if (stateIndex && slot != null && Number.isFinite(t) && ticks && ticks.length) {
    let lo = 0;
    let hi = ticks.length - 1;
    let frame = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ticks[mid] <= t) {
        frame = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (frame >= 0) helmet = slotAliveHelmetAt(stateIndex, slot, frame);
  }
  return { ...row, victimHelmet: helmet };
}

// grenadeEntity — the projectile entity id out of one row's
// detail_json (extract stamps it on grenade_throw / grenade /
// grenade_bounce rows: the ONE id the throw, every bounce and the
// blast share — extract/handlers.go). models.EventRow stays
// payload-free, so the value reaches the view through the EventDetail
// read (BULK in hydrateGrenadeEntities); 0/absent = unknown and the
// renderer falls back to its round+weapon pairing (never a guessed id).
function grenadeEntity(detailJson) {
  if (!detailJson) return 0;
  try {
    const e = Number(JSON.parse(detailJson).entity);
    return Number.isFinite(e) && e > 0 ? e : 0;
  } catch {
    return 0; // malformed payload → unknown, never a throw
  }
}

// hydrateGrenadeEntities — stamps `entity` onto the draw rows the
// renderer's flight join reads (renderer.joinBounceVerts: throw →
// bounces → det by projectile). Worth doing ONLY when the match
// actually HAS bounce rows (a pre-bounce import has none → zero extra
// reads), because the payloads live on the detail read, not on the list
// read.
//
// The read is BULK — one GetEventDetails call per BULK_CHUNK ids, the
// chunks in parallel — instead of the one-IPC-round-trip-per-row N+1 it
// replaces (2,534 getEvent calls on the measured sample match, each a
// full binding call + JSON EventDetail on the load's critical path). The
// rows are fed through the SAME grenadeEntity normalization the per-row
// path used, so the output is byte-identical: a missing / malformed / 0
// payload leaves the row entity-less (the renderer's fallback pairing),
// an id with no detail row is skipped upstream (the store never
// fabricates one).
//
// Fail-soft, at the same granularity as before: the binding resolves
// LAZILY (a dynamic import — the world path treats an unresolvable
// binding exactly like a failed read: no stamps, never a load error) and
// each chunk catches its own failure, so a failed chunk leaves exactly
// its rows entity-less while the rest still stamp.
//
// onProgress (loadWorld's optional callback) reports the ONE honest
// denominator this phase has — the unique grenade detail ids, counted as
// ATTEMPTED work:
//   · {done: 0, total: ids.length, unit: 'grenade reads'} fires once,
//     AFTER the binding import resolves and the chunks are about to run
//     — an unresolvable binding reports nothing (no reads will run, so
//     there is nothing to report; the stage stays indeterminate).
//   · every chunk adds its own length to done when it SETTLES, resolved
//     OR rejected — a failed chunk's ids were still attempted work, so
//     done always reaches total (even when every chunk rejects: the bar
//     never sticks below 100% forever).
//   · the no-bounce/no-target early return reports nothing at all.
// The other loadWorld phases (anchor read, drop details, buytime
// boundary) are single IPC calls with no honest count → never reported.
async function hydrateGrenadeEntities(rows, onProgress) {
  const targets = rows.filter((r) => GRENADE_KINDS.has(r.kind) && Number.isFinite(r.id));
  if (!targets.length || !rows.some((r) => r.kind === 'grenade_bounce')) return rows;
  const ids = [...new Set(targets.map((r) => r.id))];
  const chunks = [];
  for (let i = 0; i < ids.length; i += BULK_CHUNK) chunks.push(ids.slice(i, i + BULK_CHUNK));
  let bindings;
  try {
    bindings = await import('../../../bindings/github.com/ChristianWSmith/spectra');
  } catch {
    return rows; // fail-soft: no resolvable binding → no stamps, never an error
  }
  // The reads are about to run — the denominator lands now (total = the
  // UNIQUE ids after dedupe, done counting ids ATTEMPTED per settle).
  const total = ids.length;
  let done = 0;
  if (onProgress) onProgress({ done: 0, total, unit: HYDRATION_UNIT });
  const lists = await Promise.all(
    chunks.map(async (chunk) => {
      try {
        return await bindings.MatchService.GetEventDetails(chunk);
      } catch {
        return []; // fail-soft: that chunk's rows stay entity-less
      } finally {
        // Attempted, not succeeded: a rejected chunk's ids were real
        // work, so done reaches total either way.
        done += chunk.length;
        if (onProgress) onProgress({ done, total, unit: HYDRATION_UNIT });
      }
    }),
  );
  const byId = new Map();
  for (const list of lists) {
    for (const d of list || []) {
      const e = grenadeEntity(d && d.detailJson);
      if (e > 0 && Number.isFinite(d.id)) byId.set(d.id, e);
    }
  }
  if (!byId.size) return rows;
  return rows.map((r) => (byId.has(r.id) ? { ...r, entity: byId.get(r.id) } : r));
}

// pushWorldToRenderer — THE renderer half of the world pushes (the
// startEngine site): landmarks + the defuse-kit evidence + the decoy
// plan, all from the ONE world object. The setters are additive and
// tolerate a repeat call (a startEngine rebuild re-pushes the same
// rows); they are never called from a filter edit — the dataset has no
// filter dependency. `decoyPlan` is computed by the caller (the plan
// needs Replay's engine/sideAt closures — see decoyPlanFor there).
export function pushWorldToRenderer(renderer, world, decoyPlan) {
  renderer.setLandmarks(world.rows);
  // Defuse-kit evidence beside the landmarks (the same additive-setter
  // contract): the precomputed [from,to) windows the kit marker reads.
  // load() always resolves the buytime_ended read BEFORE startEngine,
  // so the world carries it; the setter still treats null/absent as an
  // EMPTY window map (no kit marker, never a guessed one).
  renderer.setKitEvidence(world.kitEv);
  renderer.setDecoyPlan(decoyPlan);
}

// pushWorldToSfx — THE sfx half: the SAME world rows and the SAME plan
// the renderer just got (the bullets.js one-derivation-two-consumers
// pattern), so a map marker and its sound can never disagree. Called
// from the sfx engine's construction microtask (engine exists then).
export function pushWorldToSfx(sfx, world, decoyPlan) {
  // world.rows' kill rows carry the pre-normalization victimHelmet
  // stamp (loadWorld's join), so the headshot cue list rebuilds from the
  // same rows as everything else.
  sfx.setLandmarks(world.rows);
  sfx.setDecoyPlan(decoyPlan);
}
