// Node tests for the player-card presentation rules
// (src/lib/replay/playercard.js) — the pure half; the rendered half is
// test/player-card.dom.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ammoText,
  armorChip,
  carriesC4,
  connectedAt,
  heldItemOf,
  hpBand,
  hpPct,
  indexConnections,
  mainAmmoText,
  mainOf,
  moneyText,
  presentAt,
  reloadProgress,
  STATS_TITLE,
  statsText,
  utilityOf,
  weaponName,
} from './replay/playercard.js';

// The state stream's shape for one slot at one frame (state.js
// slotStateAt): every key present, null = unknown — never zero.
const st = (over = {}) => ({
  hp: 100,
  armor: 100,
  helmet: false,
  weapon: 'AK-47',
  weaponIndex: 0,
  magAmmo: 30,
  reserveAmmo: 90,
  inventory: ['AK-47'],
  money: 3250,
  attack: false,
  ...over,
});

test('utilityOf groups grenades and drops everything else', () => {
  const inv = ['AK-47', 'Smoke Grenade', 'Flashbang', 'Knife', 'Smoke Grenade', 'C4', 'Molotov'];
  assert.deepEqual(utilityOf(inv), [
    { name: 'Smoke Grenade', count: 2 },
    { name: 'Flashbang', count: 1 },
    { name: 'Molotov', count: 1 },
  ]);
});

test('utilityOf: unknown inventory is null, known-empty is []', () => {
  assert.equal(utilityOf(null), null, 'null inventory must stay unknown');
  assert.equal(utilityOf(undefined), null);
  assert.deepEqual(utilityOf(['AK-47', 'Knife', 'Defuse Kit']), [], 'a known inventory with no grenades is a fact');
  assert.deepEqual(utilityOf([]), []);
});

test('utilityOf: the sidecar "Unknown" sentinel is not utility', () => {
  assert.deepEqual(utilityOf(['Unknown']), []);
});

test('hpPct / hpBand: known values clamp, unknown stays unknown', () => {
  assert.equal(hpPct(100), 100);
  assert.equal(hpPct(0), 0);
  assert.equal(hpPct(37), 37);
  assert.equal(hpPct(null), null, 'unknown must not become 0');
  assert.equal(hpPct(undefined), null);
  assert.equal(hpBand(null), 'unknown');
  assert.equal(hpBand(100), 'high');
  assert.equal(hpBand(51), 'high');
  assert.equal(hpBand(50), 'mid');
  assert.equal(hpBand(21), 'mid');
  assert.equal(hpBand(20), 'low');
  assert.equal(hpBand(0), 'low');
});

test('ammoText renders mag / reserve and keeps a real 0', () => {
  assert.equal(ammoText(st()), '30 / 90');
  assert.equal(ammoText(st({ magAmmo: 0 })), '0 / 90', 'an empty magazine is a fact');
  assert.equal(ammoText(st({ reserveAmmo: null })), '30 / —', 'one unknown side renders inline');
  assert.equal(ammoText(st({ magAmmo: null, reserveAmmo: null })), '—');
  assert.equal(ammoText(null), '—', 'no state is never 0 / 0');
});

test('armorChip follows the helmet flag and never guesses an icon', () => {
  assert.deepEqual(armorChip(st({ helmet: true })), {
    icon: 'Kevlar + Helmet',
    text: 'Kevlar + Helmet',
  });
  assert.deepEqual(armorChip(st({ helmet: false })), {
    icon: 'Kevlar Vest',
    text: 'Kevlar Vest',
  });
  assert.deepEqual(armorChip(st({ helmet: null })), { icon: null, text: 'Armor' }, 'unknown helmet gets no icon');
  assert.deepEqual(armorChip(null), { icon: null, text: 'Armor' });
});

test('moneyText uses the canonical formatter and never fakes $0', () => {
  assert.equal(moneyText(st()), '$3,250');
  assert.equal(moneyText(st({ money: 0 })), '$0', 'a real 0 balance is a fact');
  assert.equal(moneyText(st({ money: null })), '—');
  assert.equal(moneyText(null), '—');
});

test('weaponName hides the sidecar "Unknown" sentinel', () => {
  assert.equal(weaponName(st()), 'AK-47');
  assert.equal(weaponName(st({ weapon: 'Unknown' })), null, 'unnamed weapon renders as unknown');
  assert.equal(weaponName(st({ weapon: null })), null);
  assert.equal(weaponName(null), null);
});

test('heldItemOf: only a held item ACTIVE in hand prefixes the weapon row', () => {
  // Mode 1 (ordinary block): a firearm active, an unnamed weapon, or no
  // state at all → null, so the card keeps today's icon+name+ammo row.
  assert.equal(heldItemOf(st()), null, 'a firearm active is not a held item');
  assert.equal(heldItemOf(st({ weapon: 'M4A4' })), null);
  assert.equal(heldItemOf(st({ weapon: 'Unknown' })), null, 'the sentinel never claims a held item');
  assert.equal(heldItemOf(st({ weapon: null })), null);
  assert.equal(heldItemOf(null), null);
  // Modes 2/3 (held prefix): knife, any grenade, C4.
  assert.equal(heldItemOf(st({ weapon: 'Knife' })), 'Knife');
  assert.equal(heldItemOf(st({ weapon: 'Flashbang' })), 'Flashbang');
  assert.equal(heldItemOf(st({ weapon: 'Smoke Grenade' })), 'Smoke Grenade');
  assert.equal(heldItemOf(st({ weapon: 'Molotov' })), 'Molotov');
  assert.equal(heldItemOf(st({ weapon: 'C4' })), 'C4');
});

test('mainOf: primary ?? secondary ?? null — never an invented starter', () => {
  assert.equal(mainOf(st({ inventory: ['Knife', 'USP-S', 'AK-47'] })), 'AK-47', 'first primary wins');
  assert.equal(mainOf(st({ inventory: ['USP-S', 'AK-47'] })), 'AK-47', 'the primary beats an earlier sidearm');
  assert.equal(mainOf(st({ inventory: ['Knife', 'USP-S'] })), 'USP-S', 'secondary is the fallback');
  assert.equal(mainOf(st({ inventory: ['Knife'] })), null, 'knife round → no main (no starter guess)');
  assert.equal(mainOf(st({ inventory: [] })), null);
  assert.equal(mainOf(st({ inventory: null })), null, 'unknown inventory → unknown, never a pistol');
  assert.equal(mainOf(null), null);
});

test('mainAmmoText renders the MAIN weapon pair with ammoText honesty', () => {
  assert.equal(mainAmmoText(st({ mainMag: 30, mainReserve: 90 })), '30 / 90');
  assert.equal(mainAmmoText(st({ mainMag: 0, mainReserve: 90 })), '0 / 90', 'an empty main magazine is a fact');
  assert.equal(mainAmmoText(st({ mainMag: null, mainReserve: 90 })), '— / 90', 'one unknown side renders inline');
  assert.equal(mainAmmoText(st({ mainMag: 30, mainReserve: null })), '30 / —');
  assert.equal(mainAmmoText(st({ mainMag: null, mainReserve: null })), '—', 'both unknown → plain —');
  assert.equal(mainAmmoText(null), '—', 'no state is never 0 / 0');
});

test("the three weapon-row modes' inputs (held / main / neither)", () => {
  // Mode 1: no held item → the ordinary active-weapon block.
  assert.equal(heldItemOf(st()), null);
  // Mode 2: held item + a carried main → main block, held icon after the gun.
  const m2 = st({ weapon: 'Flashbang', inventory: ['AK-47', 'Flashbang'] });
  assert.equal(heldItemOf(m2), 'Flashbang');
  assert.equal(mainOf(m2), 'AK-47');
  // Mode 3: held item, no firearm carried → bare held icon.
  const m3 = st({ weapon: 'Knife', inventory: ['Knife'] });
  assert.equal(heldItemOf(m3), 'Knife');
  assert.equal(mainOf(m3), null);
});

test('carriesC4 reads the inventory SEPARATELY from utilityOf', () => {
  // The bomb rides the card next to the util, but utilityOf still drops
  // 'C4' on purpose (the test above pins that) — the two answers differ
  // by design.
  assert.equal(carriesC4(['AK-47', 'C4', 'Flashbang']), true);
  assert.equal(carriesC4(['C4']), true);
  assert.equal(carriesC4(['AK-47', 'Flashbang']), false);
  assert.deepEqual(utilityOf(['C4']), [], 'C4 is not utility');
  // Unknown inventory never claims a bomb the stream did not say.
  assert.equal(carriesC4(null), false);
  assert.equal(carriesC4(undefined), false);
  assert.equal(carriesC4('C4'), false);
});

test('statsText renders the live row and never fakes an unknown ADR', () => {
  assert.equal(statsText({ k: 12, d: 5, a: 3, adr: 87.4375 }), 'K/D/A 12/5/3 · ADR 87.4');
  assert.equal(
    statsText({ k: 0, d: 0, a: 0, adr: null }),
    'K/D/A 0/0/0 · ADR —',
    '0 counted rounds started → honest "—", never 0',
  );
  assert.equal(
    statsText({ k: 0, d: 0, a: 0, adr: 0 }),
    'K/D/A 0/0/0 · ADR 0.0',
    '0 damage over started rounds IS a fact',
  );
  assert.equal(statsText(null), 'K/D/A — · ADR —');
  assert.equal(statsText(undefined), 'K/D/A — · ADR —');
  assert.equal(statsText({ k: 'x', d: null, a: NaN, adr: NaN }), 'K/D/A —/—/— · ADR —');
});

test('STATS_TITLE documents the exact formula the row shows', () => {
  assert.match(STATS_TITLE, /counted rounds started/);
  assert.match(STATS_TITLE, /friendly fire/);
  assert.match(STATS_TITLE, /ADR = Σdamage/);
});

// --- Connection (card presence) --------------------------------------------
// BEHAVIOR RE-PIN, labeled (knife/warmup discard, Phase 3): the rows
// below are the nuke demo's ACTUAL player_connect / player_disconnect
// events AS STORED NOW — every demo's initial connects lived in the
// discarded knife round (tick 1, round −2), so they are gone from a
// fresh import and the fixture drops them too: initial presence derives
// from the ROSTER instead (meta.players — no row needed). What remains
// are the COUNTED-round rows: Kr3shProSkuf disconnects at 23467 and
// reconnects at 28801; the bot Crew joins late at 25155 and leaves at
// 28801 — the roster keeps both slots the whole demo, which is exactly
// why the rule exists (six CT cards otherwise).
const K3SH = '76561198067285210';
const CREW = '18374686479671623692';
const conn = (kind, tick, attacker) => ({ kind, tick, attacker });
const nukeConnRows = [
  conn('player_disconnect', 23467, K3SH),
  conn('player_connect', 25155, CREW),
  conn('player_disconnect', 28801, CREW),
  conn('player_connect', 28801, K3SH),
  conn('player_disconnect', 182637, K3SH),
];

test('indexConnections groups the typed rows per player, in tick order', () => {
  const idx = indexConnections(nukeConnRows);
  assert.deepEqual(idx.get(K3SH), [
    { tick: 23467, connected: false },
    { tick: 28801, connected: true },
    { tick: 182637, connected: false },
  ]);
  assert.deepEqual(idx.get(CREW), [
    { tick: 25155, connected: true },
    { tick: 28801, connected: false },
  ]);
  assert.equal(idx.size, 2, 'only the players the rows name are indexed');
  // The identity is EventRow.attacker — the SAME spelling as
  // meta.players[].steamId, so a bot id matches its roster slot.
  assert.equal(idx.get(CREW)[0].tick, 25155);
});

test('indexConnections drops rows that say nothing about presence', () => {
  const idx = indexConnections([
    conn('player_death', 10, K3SH), // another kind
    conn('player_disconnect', 20, ''), // no identity
    conn('player_disconnect', NaN, CREW), // no tick
    null,
    { kind: 'player_connect' }, // no tick at all
  ]);
  assert.equal(idx.size, 0);
  assert.deepEqual(indexConnections(null), new Map());
  assert.deepEqual(indexConnections([]), new Map());
});

test('connectedAt: a disconnect hides the card until the reconnect unhides it', () => {
  const kr3sh = indexConnections(nukeConnRows).get(K3SH);
  // Before the first recorded event the answer is ROSTER presence (true)
  // — the discarded tick-1 connect row used to be the evidence here.
  assert.equal(connectedAt(kr3sh, 1), true);
  assert.equal(connectedAt(kr3sh, 23466), true, 'last tick before the disconnect');
  assert.equal(connectedAt(kr3sh, 23467), false, 'the disconnect itself hides it');
  assert.equal(connectedAt(kr3sh, 28800), false, 'still hidden through the gap');
  assert.equal(connectedAt(kr3sh, 28801), true, 'the reconnect unhides it');
  assert.equal(connectedAt(kr3sh, 182636), true);
  assert.equal(connectedAt(kr3sh, 182637), false, 'the tail disconnect hides it again');
  // Scrubbing BACK is the same pure function — never a sticky state.
  assert.equal(connectedAt(kr3sh, 23466), true, 'back before the disconnect → visible again');
});

// BEHAVIOR RE-PIN, labeled (knife/warmup discard, Phase 3): connectedAt
// no longer hides a card BEFORE its player's first recorded event —
// every demo's initial connects were discarded at ingest, so "no connect
// row yet" cannot mean "has not joined" anymore: the ROSTER is the
// initial-presence evidence and only a recorded event says otherwise.
// (Crew here stands in for any player with rows — a rejoiner's early
// rounds keep their cards this way.) The bot LATE-JOIN hide lives in
// presentAt's exception — pinned below ("never present before its
// connect") — where a recorded connect still brackets the absence.
test('connectedAt: before the first recorded event the card is PRESENT (roster)', () => {
  const crew = indexConnections(nukeConnRows).get(CREW);
  assert.equal(connectedAt(crew, 0), true, 'roster presence, no row needed');
  assert.equal(connectedAt(crew, 25154), true, 'still present until an event says otherwise');
  assert.equal(connectedAt(crew, 25155), true, 'visible from the connect tick');
  assert.equal(connectedAt(crew, 28800), true);
  assert.equal(connectedAt(crew, 28801), false, 'hidden from its disconnect');
});

test('connectedAt: no events is connected — absence is never a disconnect', () => {
  const idx = indexConnections(nukeConnRows);
  assert.equal(
    connectedAt(idx.get('76561198999999999'), 0),
    true,
    'a player no row ever names stays visible',
  );
  assert.equal(connectedAt(undefined, 999), true, 'an unindexed slot stays visible');
  assert.equal(connectedAt([], 0), true);
  // A first event that is a DISCONNECT means they were in the match
  // before it — visible up to it, never hidden for "no connect seen".
  const leaver = indexConnections([conn('player_disconnect', 500, 'x')]).get('x');
  assert.equal(connectedAt(leaver, 0), true);
  assert.equal(connectedAt(leaver, 499), true);
  assert.equal(connectedAt(leaver, 500), false);
  // An unknown playhead hides nothing (no evidence at a non-tick).
  assert.equal(connectedAt(indexConnections(nukeConnRows).get(CREW), NaN), true);
});

// --- Card presence: the humans-only rule + the replay exception -----------
// presentAt is THE one question the columns and the follow dropdown ask.
// The roster below is the nuke demo's shape: Kr3sh (CT human) out in
// [23467, 28801), Crew (CT bot) covering exactly that gap from 25155, and
// a T-side human who never leaves.
const OTHER = '76561198000000009';
const nukeRoster = [
  { steamId: K3SH, name: 'Kr3shProSkuf', side: 'ct' },
  { steamId: OTHER, name: 'tside', side: 't' },
  { steamId: CREW, name: 'Crew', side: 'ct', isBot: true },
];
const nukeIdx = () => indexConnections(nukeConnRows);

test('presentAt: a human slot keeps connectedAt exactly', () => {
  const idx = nukeIdx();
  assert.equal(presentAt(idx, nukeRoster, 0, 23466), true);
  assert.equal(presentAt(idx, nukeRoster, 0, 23467), false, 'the disconnect hides it');
  assert.equal(presentAt(idx, nukeRoster, 0, 28800), false);
  assert.equal(presentAt(idx, nukeRoster, 0, 28801), true, 'the reconnect unhides it');
  assert.equal(presentAt(idx, nukeRoster, 0, 182636), true);
  assert.equal(presentAt(idx, nukeRoster, 0, 182637), false, 'the tail disconnect');
  assert.equal(presentAt(idx, nukeRoster, 1, 182637), true, 'the T-side human never left');
  assert.equal(presentAt(idx, nukeRoster, 1, NaN), true, 'unknown playhead hides nothing');
});

test('presentAt: the substitute bot is listed ONLY inside the gap it covers', () => {
  const idx = nukeIdx();
  assert.equal(presentAt(idx, nukeRoster, 2, 25154), false, 'before its connect');
  assert.equal(presentAt(idx, nukeRoster, 2, 25155), true, 'connects while Kr3sh is out');
  assert.equal(presentAt(idx, nukeRoster, 2, 28800), true, 'still covering');
  assert.equal(presentAt(idx, nukeRoster, 2, 28801), false, 'Kr3sh is back / the bot left');
  assert.equal(presentAt(idx, nukeRoster, 2, 0), false, 'never present before its connect');
  // Scrubbing back is pure — never sticky.
  assert.equal(presentAt(idx, nukeRoster, 2, 25154), false);
});

test('presentAt: a bot with no bracketing human disconnect is never listed', () => {
  // A DemoRecorder/GOTV-style occupant: connects at tick 1 and never
  // leaves. Even while Kr3sh is out, its connect precedes her disconnect,
  // so no human's absence brackets it.
  const recorder = [{ tick: 1, connected: true }];
  const idx = nukeIdx();
  idx.set('18374686479671623699', recorder);
  const roster = [
    { steamId: K3SH, name: 'Kr3shProSkuf', side: 'ct' },
    { steamId: '18374686479671623699', name: 'DemoRecorder', side: 'ct', isBot: true },
  ];
  for (const tick of [0, 23467, 25155, 28800, 40000]) {
    assert.equal(presentAt(idx, roster, 1, tick), false, `recorder visible at ${tick}`);
  }
  // A bot with NO connection rows at all is not a substitute either.
  const noRows = [{ steamId: '18374686479671623698', name: 'mystery', side: 'ct', isBot: true }];
  assert.equal(presentAt(idx, [...roster, ...noRows], 2, 28800), false);
});

test('presentAt: the pairing requires the SAME side, both sides known', () => {
  const idx = nukeIdx();
  // Same rows, but the leaver is on the other side → no pairing.
  const crossed = [
    { steamId: K3SH, name: 'Kr3shProSkuf', side: 't' },
    { steamId: OTHER, name: 'tside', side: 't' },
    { steamId: CREW, name: 'Crew', side: 'ct', isBot: true },
  ];
  assert.equal(presentAt(idx, crossed, 2, 26000), false, 'opposite-side leaver never pairs');
  // An unknown side fails the pairing rather than guessing one.
  const unknown = [
    { steamId: K3SH, name: 'Kr3shProSkuf', side: '' },
    { steamId: CREW, name: 'Crew', side: 'ct', isBot: true },
  ];
  assert.equal(presentAt(idx, unknown, 1, 26000), false, 'unknown side → not listed');
  // The T-side human never leaves → never justifies the bot.
  assert.equal(presentAt(idx, nukeRoster, 1, 26000), true, 'control: the human is in');
});

test('presentAt: bot-ness falls back to the synthetic id when the flag is absent', () => {
  // Same slot, no isBot (a roster row that never carried the flag) — the
  // id shape still routes it through the exception.
  const noFlag = nukeRoster.map((p) => {
    const { isBot: _drop, ...rest } = p;
    return rest;
  });
  assert.equal(presentAt(nukeIdx(), noFlag, 2, 26000), true, 'still the substitute rule');
  assert.equal(presentAt(nukeIdx(), noFlag, 2, 40000), false, 'and still never after the gap');
});

test('presentAt: missing data never hides a human card, and never fakes the exception', () => {
  assert.equal(presentAt(new Map(), [], 0, 123), true, 'no roster row → visible');
  assert.equal(presentAt(nukeIdx(), null, 0, 123), true);
  assert.equal(presentAt(null, nukeRoster, 0, 123), true, 'no index → a human stays visible');
  // A bot slot with no index has no evidence of a leaver to bracket it —
  // the exception needs positive evidence (bots fail toward NOT listed),
  // so an empty read hides it while humans never hide.
  assert.equal(presentAt(null, nukeRoster, 2, 123), false);
  assert.equal(presentAt(new Map(), nukeRoster, 2, 28800), false);
});

// --- Reload ring (the gun icon's grey progress arc) ----------------------
// reloadProgress reads ONE slot's `reloading` series — the shape
// state.js buildStateIndex keeps ({frames, values}, records only at
// CHANGES, booleans only; "unknown" lives before the first record and
// therefore outside the series) — and returns the 0..1 fill at a frame,
// or null = the ring hides. The formula (run start by walking back, the
// look-ahead end, the clamp) is documented in playercard.js; these cases
// pin it. The frames are literal position-stream frames.
const reloadSeries = (frames, values) => ({ frames, values });

test('reloadProgress: hidden unless the field says true at the playhead', () => {
  // Never reloading (a seed that stays false) → hidden at every frame.
  const never = reloadSeries([0, 500], [false, false]);
  assert.equal(reloadProgress(never, 0), null);
  assert.equal(reloadProgress(never, 250), null);
  assert.equal(reloadProgress(never, 1e9), null, 'after the last record the last value stands');
  // Missing field / no series at all → hidden, never a guessed ring.
  assert.equal(reloadProgress(null, 100), null);
  assert.equal(reloadProgress(undefined, 100), null);
  assert.equal(reloadProgress(reloadSeries([], []), 100), null);
  // A run that has not started yet (playhead before its first record):
  // the field is unknown there — unknown is NEVER drawn as a fact.
  const late = reloadSeries([1000, 1200], [true, false]);
  assert.equal(reloadProgress(late, 999), null);
});

test('reloadProgress: a completed run fills 0 → 1 across [start, end)', () => {
  const run = reloadSeries([100, 200], [true, false]); // start 100, end 200
  assert.equal(reloadProgress(run, 100), 0, 'at the start frame the fill is 0');
  assert.equal(reloadProgress(run, 150), 0.5);
  assert.equal(reloadProgress(run, 175), 0.75);
  assert.ok(reloadProgress(run, 199) >= 0.99 && reloadProgress(run, 199) < 1, 'just under the end');
  // At/after the end the flag is false → the ring hides, never a stale
  // arc lingering after the reload finished.
  assert.equal(reloadProgress(run, 200), null);
  assert.equal(reloadProgress(run, 5000), null);
});

test('reloadProgress: the run anchor walks back, run by run', () => {
  // Two runs in one series: the fill must anchor at the CURRENT run's
  // first true record, not at the series' start.
  const two = reloadSeries([0, 100, 200, 300, 400], [false, true, false, true, false]);
  assert.equal(reloadProgress(two, 150), (150 - 100) / (200 - 100));
  assert.equal(reloadProgress(two, 350), (350 - 300) / (400 - 300), 'second run anchors at 300');
  assert.equal(reloadProgress(two, 90), null, 'between the runs → hidden');
  // A run that opens the series (no preceding false record).
  const open = reloadSeries([50, 150], [true, false]);
  assert.equal(reloadProgress(open, 100), 0.5);
});

test('reloadProgress: a weapon switch cancelling mid-run just ends the run', () => {
  // true → false on the weapon change IS the cancellation (the stream
  // only carries demoinfocs' flag): the run closes at the switch frame
  // and the ring hides from it on — no cancellation special case.
  const cancelled = reloadSeries([0, 100, 160], [false, true, false]);
  assert.equal(reloadProgress(cancelled, 130), (130 - 100) / (160 - 100));
  assert.equal(reloadProgress(cancelled, 160), null, 'the switch frame hides it');
  assert.equal(reloadProgress(cancelled, 200), null, 'and it stays hidden');
});

test('reloadProgress: the stream ending mid-reload clamps to 0 (duration unknown)', () => {
  // The demo itself cuts while the flag is still true: there is no end
  // record, so the denominator is unknown — the ring shows the reload
  // RUNNING at fill 0 rather than fabricating a percentage.
  const cut = reloadSeries([0, 100], [false, true]);
  assert.equal(reloadProgress(cut, 150), 0);
  assert.equal(reloadProgress(cut, 1e6), 0, 'even far past the last record (value stands)');
  // The division is exact, unrounded — the arc is continuous.
  const odd = reloadSeries([0, 3], [true, false]);
  assert.equal(reloadProgress(odd, 1), 1 / 3);
  assert.equal(reloadProgress(odd, 2), 2 / 3);
});
