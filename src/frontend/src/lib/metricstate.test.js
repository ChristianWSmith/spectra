// State-machine unit tests for the metric value slots (stored-metrics
// design §5): pure `state + row + unit coverage → presentation`,
// pinned to the design's precedence (processing → failed → fresh row →
// no-data → behind), to the presentation's EXACT key set (a stamp
// field cannot sneak into a render — the no-version pin at the shape
// level), and to the state/progress helpers every view shares.
// Run: node --test src/lib/metricstate.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  METRIC_STATES,
  metricPresentation,
  metricStateTitle,
  liveMetricState,
  metricProgressFrac,
  metricProgressStage,
} from './metricstate.js';

const ROW = { steamId: '76561198000000001', value: 4.25, n: 13 };

test('the vocabulary is exactly the five design states', () => {
  assert.deepEqual(METRIC_STATES, ['processing', 'failed', 'fresh', 'no-data', 'behind']);
});

// --- Precedence (design §5's table, in order) -------------------------------

test('processing wins in lieu of everything — even over a fresh row', () => {
  // Design §5 state 1: never a stale number, never bare no-data
  // mid-flight. A row present (a closure recompute of a live metric)
  // must NOT render while the sweep is on it.
  assert.deepEqual(metricPresentation('processing', ROW, true), {
    kind: 'chip',
    state: 'processing',
  });
  assert.deepEqual(metricPresentation('processing', null, false), {
    kind: 'chip',
    state: 'processing',
  });
});

test('failed wins over a row (no fresh row exists on a failure, but never a number)', () => {
  assert.deepEqual(metricPresentation('failed', null, true), { kind: 'chip', state: 'failed' });
  // A row can coexist only via a stale generation the read would never
  // serve; the state still takes precedence.
  assert.deepEqual(metricPresentation('failed', ROW, true), { kind: 'chip', state: 'failed' });
});

test('fresh renders the VALUE with its sample size', () => {
  assert.deepEqual(metricPresentation('fresh', ROW, true), {
    kind: 'value',
    value: 4.25,
    n: 13,
  });
  // A value-kind presentation never carries a state word or a stamp.
  assert.deepEqual(Object.keys(metricPresentation('fresh', ROW, true)).sort(), [
    'kind',
    'n',
    'value',
  ]);
});

test('no-data renders the dash — never a fabricated 0', () => {
  // Metric fresh for the unit, no row for THIS player → '—'.
  assert.deepEqual(metricPresentation('fresh', null, true), { kind: 'nodata' });
  // The empty-library state is also a dash (nothing to compute over).
  assert.deepEqual(metricPresentation('no-data', null, false), { kind: 'nodata' });
  // Behind with no rows is NOT no-data — it gets the chip.
  assert.notDeepEqual(metricPresentation('behind', null, false), { kind: 'nodata' });
});

test('behind renders the chip (never computed / outdated / rules-behind — one word)', () => {
  // No fresh rows for the UNIT → the chip (design §5 state 5).
  assert.deepEqual(metricPresentation('behind', null, false), {
    kind: 'chip',
    state: 'behind',
  });
  // ... but a covered unit with a player missing a row is state 4
  // (no-data), even while the metric is behind SOMEWHERE else: this
  // unit has rows, this player simply has none — the '—', never a
  // number and never a recompute promise about another unit.
  assert.deepEqual(metricPresentation('behind', null, true), { kind: 'nodata' });
});

test('an unknown/absent state renders the neutral dash — never a guessed chip', () => {
  assert.deepEqual(metricPresentation('', null, false), { kind: 'nodata' });
  assert.deepEqual(metricPresentation('wat', null, false), { kind: 'nodata' });
});

// --- Shape: no stamp can reach a render ------------------------------------

test('every presentation carries EXACTLY its documented keys (no stamp field)', () => {
  const shapes = [
    metricPresentation('processing', null, false),
    metricPresentation('failed', null, false),
    metricPresentation('fresh', ROW, true),
    metricPresentation('fresh', null, true),
    metricPresentation('behind', null, false),
    metricPresentation('', null, false),
  ];
  for (const pres of shapes) {
    const keys = Object.keys(pres).sort();
    const allowed =
      pres.kind === 'value' ? ['kind', 'n', 'value'] : pres.kind === 'chip' ? ['kind', 'state'] : ['kind'];
    assert.deepEqual(keys, allowed, `unexpected keys on ${JSON.stringify(pres)}`);
    for (const k of keys) {
      assert.ok(
        !/version|stamp|computed/i.test(k),
        `presentation key ${k} looks like an internal stamp`,
      );
    }
  }
});

test('state titles never carry a digit — no version number is expressible', () => {
  // Design §5: no chip, tooltip, header or title ever contains a
  // version number or a computed-at timestamp. The fixed copy is
  // digit-free by construction; 'fresh' has NO fixed title (the caller
  // builds "formula — sample size n=…" itself), and the failed title is
  // the engine's error text (checked separately at the DOM level for
  // version-shaped leaks).
  for (const state of ['processing', 'failed', 'no-data', 'behind']) {
    const title = metricStateTitle(state, state === 'failed' ? 'boom: reference missing' : '');
    assert.ok(title.length > 0, `${state} has a title`);
    assert.ok(!/\d/.test(title), `${state} title carries a digit: ${JSON.stringify(title)}`);
  }
  assert.equal(metricStateTitle('fresh', ''), '', 'fresh titles are the caller’s formula + n');
  // failed → the error text verbatim (its tooltip IS the failure).
  assert.equal(metricStateTitle('failed', 'upstream vanished'), 'upstream vanished');
  // An absent error still yields honest copy, never 'undefined'.
  assert.equal(metricStateTitle('failed', ''), 'compute failed');
  // Unknown state → no title (the caller renders the plain dash).
  assert.equal(metricStateTitle('', ''), '');
});

// --- The two state sources (live feed vs refetched word) --------------------

test('liveMetricState: the progress feed wins over the refetched word', () => {
  const progress = new Map([[7, { metricId: 7, stage: 'compute', done: 2, total: 5 }]]);
  const states = new Map([[7, { metricId: 7, state: 'behind' }]]);
  assert.equal(liveMetricState(progress, states, 7), 'processing');
  assert.equal(liveMetricState(progress, states, 8), '', 'a metric with no state is unknown');
  assert.equal(liveMetricState(new Map(), states, 7), 'behind');
  assert.equal(liveMetricState(null, null, 7), '', 'no sources → unknown, never a guess');
});

test('metricProgressFrac is honest k/N (null without a denominator)', () => {
  const progress = new Map([
    [7, { metricId: 7, stage: 'compute', done: 3, total: 7 }],
    [8, { metricId: 8, stage: 'remove', done: 0, total: 0 }],
  ]);
  assert.equal(metricProgressFrac(progress, 7), 3 / 7);
  assert.equal(metricProgressFrac(progress, 8), null, '0/0 has no denominator — never NaN');
  assert.equal(metricProgressFrac(progress, 9), null, 'absent feed entry → null');
  assert.equal(metricProgressFrac(null, 7), null);
  assert.equal(metricProgressStage(progress, 7), 'compute');
  assert.equal(metricProgressStage(progress, 9), '');
});
