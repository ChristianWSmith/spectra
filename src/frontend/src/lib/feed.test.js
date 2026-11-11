// Tests for the feed RUNTIME (lib/replay/feed.js): THE one filter →
// query composer, the source interface (jobs / fetch / normalize / rank
// / paging), the merge and the ?sel= + export shaping. The VOCABULARY
// (registry, buckets, row shapes, filter <-> URL) stays in
// landmarks.test.js.
// Run: node --test src/lib/feed.test.js   (from frontend/; the lib test
// glob src/lib/*.test.js picks it up too).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { registerHooks } from 'node:module';
import { installEsmDirHook } from '../../test/esm-dir-hook.mjs';

// Pure vocabulary imports (no services/bindings in their graph) — safe
// before the hook install below.
import {
  parseLandmarkFilter,
  defaultFilter,
  normalizeEvent,
  normalizeChat,
  normalizeGeneric,
  typedKindsFor,
  killRoleFor,
} from './replay/landmarks.js';

installEsmDirHook();

// feed.js imports services.js (the three source reads) — the real
// bindings talk to a live Wails backend, so redirect them to the test
// stubs before the module graph loads (the sfx.test.js pattern; hooks
// are per-process, this file runs alone).
const stub = (name) => new URL(`../../test/stubs/${name}`, import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@wailsio/runtime') return { url: stub('wails-runtime.mjs'), shortCircuit: true };
    if (specifier.includes('bindings/github.com')) return { url: stub('bindings.mjs'), shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const {
  PAGE,
  srcRound,
  buildFeedQuery,
  FEED_SOURCES,
  feedJobs,
  pageSlice,
  runFeedJob,
  mergeSourceRows,
  composeFeedRows,
  entrySelection,
  landmarkExportRows,
  precomposeChatLabels,
} = await import('./replay/feed.js');

// --- buildFeedQuery: THE one composer -------------------------------------

test('buildFeedQuery maps the filter onto the EventFilter wire shape', () => {
  const f = parseLandmarkFilter({
    cat: 'kills,deaths',
    roundFrom: '3',
    roundTo: '7',
    player: '76561198012345678',
    weapon: 'AWP',
    distMin: '10',
    distMax: '50',
    hs: '1',
    bbox: '1,2,3,4',
    side: 'ct',
    team: 't',
  });
  assert.deepEqual(buildFeedQuery(5, f), {
    matchId: 5,
    // the union of the enabled categories' kinds (kills + deaths share
    // 'kill' → one entry) …
    kinds: typedKindsFor(f.cats),
    roundFrom: 3,
    roundTo: 7,
    steamId: '76561198012345678',
    // …and the role both of them imply (both enabled → 'any').
    killRole: killRoleFor(f.cats),
    side: 'ct',
    team: 't',
    weapon: 'AWP',
    distanceMin: 10,
    distanceMax: 50,
    headshotOnly: true,
    bbox: { minX: 1, minY: 2, maxX: 3, maxY: 4 },
  });
  // The derived halves really are the registry's derivations.
  assert.deepEqual(buildFeedQuery(5, f).kinds, ['kill']);
  assert.equal(buildFeedQuery(5, f).killRole, 'any');
});

test('buildFeedQuery: deaths-only drives kinds + killRole, defaults stay defaults', () => {
  const deaths = buildFeedQuery(1, parseLandmarkFilter({ cat: 'deaths' }));
  assert.deepEqual(deaths.kinds, ['kill']);
  assert.equal(deaths.killRole, 'victim'); // "X's deaths" → the victim endpoint
  const kills = buildFeedQuery(1, parseLandmarkFilter({ cat: 'kills' }));
  assert.equal(kills.killRole, 'attacker'); // "X's kills"

  const d = buildFeedQuery(1, defaultFilter());
  // typedKindsFor returns the KIND the category claims, not its id.
  assert.deepEqual(d.kinds, ['round_start']);
  assert.equal(d.killRole, 'any');
  assert.equal(d.roundFrom, 0);
  assert.equal(d.steamId, '');
  assert.equal(d.weapon, '');
  assert.equal(d.headshotOnly, false);
  // An absent bbox is OMITTED, never sent as an empty rect.
  assert.equal(buildFeedQuery(1, defaultFilter()).bbox, undefined);
});

// --- srcRound: the chat/generic single-round scope ------------------------

test('srcRound scopes a single-round range and stays match-wide otherwise', () => {
  assert.equal(srcRound(parseLandmarkFilter({ roundFrom: '3', roundTo: '3' })), 3);
  assert.equal(srcRound(parseLandmarkFilter({ roundFrom: '3', roundTo: '5' })), -1);
  assert.equal(srcRound(parseLandmarkFilter({ roundFrom: '3' })), -1); // one-sided ≠ exact
  assert.equal(srcRound(parseLandmarkFilter({})), -1);
  assert.equal(srcRound(undefined), -1);
});

// --- THE source interface --------------------------------------------------

test('FEED_SOURCES: one descriptor per path, ranks in merge order', () => {
  assert.deepEqual(FEED_SOURCES.map((s) => s.id), ['event', 'chat', 'generic']);
  assert.deepEqual(FEED_SOURCES.map((s) => s.rank), [0, 1, 2]);
  for (const s of FEED_SOURCES) {
    for (const fn of ['jobs', 'fetch', 'normalize', 'seqOf']) {
      assert.equal(typeof s[fn], 'function', `${s.id}.${fn}`);
    }
  }
  // Paging specs: the typed and generic paths page (the +1 probe rule);
  // the chat read is one unpaged call.
  assert.deepEqual(FEED_SOURCES[0].page, { size: PAGE });
  assert.deepEqual(FEED_SOURCES[2].page, { size: PAGE });
  assert.equal(FEED_SOURCES[1].page, null);
});

test('feedJobs: the job list IS the enabled check (one gate, not two)', () => {
  // The sparse default (round_starts — an event category) → one event job.
  const def = feedJobs(parseLandmarkFilter({}));
  assert.equal(def.length, 1);
  assert.equal(def[0].key, 'event');
  assert.equal(def[0].source.id, 'event');

  // Chat only → the chat job (match-wide: no exact round in the filter).
  const chat = feedJobs(parseLandmarkFilter({ cat: 'chat' }));
  assert.deepEqual(chat.map((j) => j.key), ['chat']);
  assert.equal(chat[0].round, -1);

  // A single-round range scopes the chat/generic reads to that round.
  const scoped = feedJobs(parseLandmarkFilter({ cat: 'chat', roundFrom: '4', roundTo: '4' }));
  assert.equal(scoped[0].round, 4);

  // Generic: one job per distinct NAME, carrying the owning category.
  const team = feedJobs(parseLandmarkFilter({ cat: 'team_changes' }));
  assert.deepEqual(team.map((j) => [j.key, j.name, j.catId]), [['generic:player_team', 'player_team', 'team_changes']]);
  // The gname picker's category takes the URL's gname …
  const picked = feedJobs(parseLandmarkFilter({ cat: 'game_events', gname: 'weapon_fire' }));
  assert.deepEqual(picked.map((j) => [j.key, j.name]), [['generic:weapon_fire', 'weapon_fire']]);
  // … and with no gname it yields NOTHING (an empty name is not a read).
  assert.deepEqual(feedJobs(parseLandmarkFilter({ cat: 'game_events' })), []);

  // Two categories naming the SAME generic → ONE job, first-in-registry
  // order owns the stamp (the old inline dedupe rule, preserved).
  const dup = feedJobs(parseLandmarkFilter({ cat: 'team_changes,game_events', gname: 'player_team' }));
  assert.equal(dup.length, 1, JSON.stringify(dup));
  assert.equal(dup[0].catId, 'team_changes');

  // No categories enabled → no work at all (and no marker job either:
  // an empty kinds list would mean "every kind" in the store contract).
  assert.deepEqual(feedJobs(parseLandmarkFilter({ cat: '' })), []);
  // Two sources on → two jobs, in rank order.
  const both = feedJobs(parseLandmarkFilter({ cat: 'kills,chat' }));
  assert.deepEqual(both.map((j) => j.source.id), ['event', 'chat']);
});

test('pageSlice: the ONE paging rule (the +1 probe row)', () => {
  assert.deepEqual(pageSlice([1, 2, 3], 2), { rows: [1, 2], hasMore: true });
  assert.deepEqual(pageSlice([1, 2], 2), { rows: [1, 2], hasMore: false });
  assert.deepEqual(pageSlice([], 2), { rows: [], hasMore: false });
  assert.deepEqual(pageSlice(null, 2), { rows: [], hasMore: false });
  // An unpaged source slices with Infinity: everything back, no more.
  assert.deepEqual(pageSlice([1, 2, 3], Infinity), { rows: [1, 2, 3], hasMore: false });
});

test('runFeedJob applies its source paging rule and passes the offset through', async () => {
  const seen = [];
  const source = {
    id: 'fake',
    rank: 9,
    page: { size: 2 },
    jobs: () => [{ key: 'fake' }],
    fetch: (matchId, filter, job, offset) => {
      seen.push([matchId, offset]);
      return Promise.resolve(['a', 'b', 'c']);
    },
    normalize: (r) => r,
    seqOf: (r) => 0,
  };
  const job = { key: 'fake', source };
  const first = await runFeedJob(7, {}, job, 0);
  assert.deepEqual(first, { rows: ['a', 'b'], hasMore: true });
  const next = await runFeedJob(7, {}, job, 2);
  assert.deepEqual(next, { rows: ['a', 'b'], hasMore: true });
  assert.deepEqual(seen, [[7, 0], [7, 2]]);
  // An unpaged source (page: null) never reports more.
  const unpaged = { ...source, page: null };
  assert.deepEqual(await runFeedJob(7, {}, { key: 'fake', source: unpaged }), {
    rows: ['a', 'b', 'c'],
    hasMore: false,
  });
});

// --- The merge (rank + seq key now live on the SOURCES) --------------------

test('mergeSourceRows orders by tick, then the source rank, then the sequence key', () => {
  const ev = (id, tick) => normalizeEvent({ id, seq: id, tick, round: 1, kind: 'kill' }, {});
  const chat = (id, tick) => normalizeChat({ id, tick, round: 1, name: 'a', text: 'x' });
  const gen = (rowId, tick) =>
    normalizeGeneric({ rowId, name: 'player_team', tick, round: 1, payloadJson: '{}' }, 'team_changes');

  const merged = mergeSourceRows([
    ev(1, 300), ev(2, 100),
    chat(5, 100), chat(6, 200),
    gen(9, 100),
  ]);
  // Same tick → event < chat < generic (the SOURCES' ranks); within a
  // source → its own seq/id/rowId order.
  assert.deepEqual(
    merged.map((r) => r.key),
    ['e:2', 'c:5', 'g:9', 'c:6', 'e:1'],
  );
  assert.deepEqual(merged.map((r) => r.tick), [100, 100, 100, 200, 300]);
  // Empty input merges cleanly; holes are skipped, never thrown on.
  assert.deepEqual(mergeSourceRows([]), []);
  assert.equal(mergeSourceRows([ev(1, 1), null, undefined]).length, 1);
  // A row from a source the registry does not know keeps a stable tail
  // rank (3) instead of crashing the sort.
  const mystery = { ...ev(7, 100), source: 'mystery' };
  assert.equal(mergeSourceRows([mystery, ev(8, 100)])[0].key, 'e:8', 'unknown source sorts last');
});

// --- The list derivation ----------------------------------------------------

test('composeFeedRows: normalize per source → merge → the round-visibility pref', () => {
  const filter = parseLandmarkFilter({ cat: 'kills' });
  const [job] = feedJobs(filter); // the event job (the only one on)
  const pages = {
    [job.key]: {
      job,
      rows: [
        { id: 1, seq: 1, tick: 300, round: 2, kind: 'kill' },
        { id: 2, seq: 2, tick: 100, round: 1, kind: 'kill' },
        { id: 3, seq: 3, tick: 150, round: -1, kind: 'kill' }, // warmup row
        { id: 4, seq: 4, tick: 160, round: 1, kind: 'teleport' }, // unclaimed → dropped
      ],
      hasMore: false,
    },
  };
  const rbn = new Map([
    [-1, { number: -1, warmup: true }],
    [1, { number: 1 }],
    [2, { number: 2 }],
  ]);
  const ctx = { roundsByNumber: rbn, cats: filter.cats, showKnifeWarmup: false };
  const rows = composeFeedRows(pages, ctx);
  // merged by tick, warmup hidden, unclaimed kind gated out, kill stamped
  // with the ENABLED claim ('kills').
  assert.deepEqual(rows.map((r) => r.key), ['e:2', 'e:1']);
  assert.equal(rows[0].category, 'kills');
  // Pref ON → the warmup row returns (the visibility rule is additional,
  // never a replacement for the category opt-in rules).
  const shown = composeFeedRows(pages, { ...ctx, showKnifeWarmup: true });
  assert.deepEqual(shown.map((r) => r.key), ['e:2', 'e:3', 'e:1']);
  // No pages → no rows (never a throw).
  assert.deepEqual(composeFeedRows({}, ctx), []);
});

// --- The ?sel= resolution ---------------------------------------------------

test('entrySelection: the loaded row first, else the typed id, else nothing', () => {
  const rows = [
    { key: 'e:1', tick: 10 },
    { key: 'c:2', tick: 20 },
  ];
  assert.deepEqual(entrySelection('e:1', rows), { row: rows[0] });
  assert.deepEqual(entrySelection('c:2', rows), { row: rows[1] });
  // Beyond the loaded pages: a typed landmark resolves by id.
  assert.deepEqual(entrySelection('e:42', rows), { id: 42 });
  // Nothing to select: a chat/generic key past the pages, a malformed id
  // and an absent selection all resolve to null (never a guess).
  assert.equal(entrySelection('c:99', rows), null);
  assert.equal(entrySelection('e:abc', rows), null);
  assert.equal(entrySelection('e:-3', rows), null);
  assert.equal(entrySelection('', rows), null);
  assert.equal(entrySelection(null, null), null);
});

// --- The export projection (moved here from landmarks.js) -------------------

test('landmarkExportRows flattens the feed into canonical columns', () => {
  const rows = [
    normalizeEvent({ id: 1, seq: 0, tick: 10, round: 1, kind: 'kill', attackerName: 'a', victimName: 'b', weapon: 'ak47', dmg: 100 }, {}),
    normalizeChat({ id: 2, tick: 11, round: 1, name: 'alice', text: 'gl hf', kind: 'chat', channel: 'all' }),
  ];
  const out = landmarkExportRows(rows);
  assert.deepEqual(out[0], ['time', 'round', 'source', 'type', 'event', 'player', 'details', 'weapon', 'damage']);
  assert.deepEqual(out[1], [10, 1, 'event', 'kills', 'kill', '', '', 'ak47', 100]);
  // DELIBERATE pin: the chat `label` is the PRECOMPOSED line — the
  // canonical fmt.chatLine (`name [tag]: text`) — while `who` stays the
  // bare name (owner's export contract; matches what the UI renders).
  assert.deepEqual(out[2], [11, 1, 'chat', 'chat', 'chat', 'alice', 'alice [ALL]: gl hf', '', '']);
  // The `type` column carries the STAMPED category: a deaths-only
  // selection's kill row exports as 'deaths' while the `event` column
  // keeps the demo kind (the enabled-claim stamp).
  const drow = normalizeEvent(
    { id: 3, seq: 2, tick: 12, round: 1, kind: 'kill', attackerName: 'a' },
    { cats: ['deaths'] },
  );
  const dout = landmarkExportRows([drow]);
  assert.equal(dout[1][3], 'deaths');
  assert.equal(dout[1][4], 'kill');
});

test('export chat labels side-indicate: [ALL] always, [T]/[CT] from the side inputs', () => {
  // 14 counted rounds so switch 1 (after round 12) is in range —
  // round 13 is second-half, round 1 first-half.
  const rounds = Array.from({ length: 14 }, (_, i) => ({ number: i + 1 }));
  const sideCtx = {
    players: [
      { steamId: '1', name: 'alice', side: 'ct' },
      { steamId: '2', name: 'bob', side: 't' },
    ],
    sideSwitches: 1,
    rounds,
  };
  const all = normalizeChat({ id: 1, tick: 5, round: 13, steamId: '1', name: 'alice', text: 'gg', kind: 'chat', channel: 'all' });
  const teamCT = normalizeChat({ id: 2, tick: 6, round: 13, steamId: '1', name: 'alice', text: 'b site', kind: 'chat', channel: 'team' });
  const teamT = normalizeChat({ id: 3, tick: 7, round: 1, steamId: '1', name: 'alice', text: 'mid', kind: 'chat', channel: 'team' });
  const system = normalizeChat({ id: 4, tick: 8, round: 1, name: '', text: 'Match is live', kind: 'system' });
  const out = landmarkExportRows([all, teamCT, teamT, system], sideCtx);
  // all chat → [ALL] regardless of who spoke (alice is CT here)
  assert.equal(out[1][6], 'alice [ALL]: gg');
  // team chat → the SPEAKER'S SIDE at that round: alice finished ct, so
  // round 13 (second half) is [CT] and round 1 (first half) is [T].
  assert.equal(out[2][6], 'alice [CT]: b site');
  assert.equal(out[3][6], 'alice [T]: mid');
  // system row → plain text, no bracket, no colon
  assert.equal(out[4][6], 'Match is live');
  // `who` stays the BARE name in every chat row (the tag lives in label)
  assert.deepEqual(out.slice(1).map((r) => r[5]), ['alice', 'alice', 'alice', '']);

  // No side inputs (a surface without them) → team chat exports the line
  // WITHOUT a bracket — never a guessed side; [ALL] still applies.
  const noCtx = landmarkExportRows([all, teamCT]);
  assert.equal(noCtx[1][6], 'alice [ALL]: gg');
  assert.equal(noCtx[2][6], 'alice: b site');
});

test('precomposeChatLabels is the JSON export shape (label composed, others untouched)', () => {
  const rows = [
    normalizeEvent({ id: 1, seq: 0, tick: 10, round: 1, kind: 'kill', attackerName: 'a' }, {}),
    normalizeChat({ id: 2, tick: 11, round: 1, name: 'alice', text: 'gl hf', kind: 'chat', channel: 'all' }),
  ];
  const out = precomposeChatLabels(rows);
  assert.equal(out[0], rows[0], 'event rows pass through untouched');
  assert.equal(out[1].label, 'alice [ALL]: gl hf', 'chat label precomposed for JSON');
  assert.equal(out[1].who, 'alice', 'who stays the bare name');
  assert.equal(out[1].text, 'gl hf', 'the raw text column is preserved');
  assert.equal(rows[1].label, 'gl hf', 'the input rows are not mutated');
});

// --- The composer invariant (fs-scan) ---------------------------------------

test('no second composer: only feed.js maps a filter onto query params', () => {
  // The invariant from buildFeedQuery's contract: nothing outside
  // feed.js (the composer) and landmarks.js (which only DERIVES the
  // pieces) may build query params from a landmark filter. Views and
  // helpers are scanned; tests are excluded (they legitimately call the
  // derivations to pin them).
  const root = new URL('./', import.meta.url); // src/lib/
  const skip = new Set(['replay/feed.js', 'replay/landmarks.js']);
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(fileURLToPath(dir), { withFileTypes: true })) {
      const rel = `${dir.pathname.split('/src/lib/')[1] || ''}${entry.name}`;
      if (entry.isDirectory()) {
        walk(new URL(`${entry.name}/`, dir));
      } else if (entry.name.endsWith('.test.js')) {
        continue; // tests may call the derivations
      } else if ((entry.name.endsWith('.js') || entry.name.endsWith('.svelte')) && !skip.has(rel)) {
        files.push([rel, readFileSync(fileURLToPath(new URL(entry.name, dir)), 'utf8')]);
      }
    }
  };
  walk(root);
  assert.ok(files.length > 20, `walked only ${files.length} files — the scan is broken`);
  const forbidden = ['typedKindsFor(', 'killRoleFor(', 'distanceMin:'];
  for (const [rel, src] of files) {
    for (const token of forbidden) {
      assert.ok(!src.includes(token), `${rel} composes query params (${token}) — use buildFeedQuery`);
    }
  }
});
