// assets.js unit tests: THE shared CS2 asset-extraction driver — the
// step→family map (assetFamilyForStep) the renderers gate their
// determinate spectra:asset-progress bar on, pinned to the Go emitter's
// payload families (mappackservice.go assetFamilyMapPacks /
// assetFamilyIcons / assetFamilySounds — a rename on either side must
// fail here), plus extractAllAssets' fixed step order, dir forwarding
// and aggregated counts-only result line.
//
// services.js is loaded against TEST STUBS for its two runtime
// dependencies (test/stubs/) — the real bindings talk to a live Wails
// backend. services.js/assets.js themselves are the real modules.
// Run: node --test src/lib/assets.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import { registerHooks } from 'node:module';
import { installEsmDirHook } from '../../test/esm-dir-hook.mjs';

installEsmDirHook();

const stub = (name) => new URL(`../../test/stubs/${name}`, import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@wailsio/runtime') return { url: stub('wails-runtime.mjs'), shortCircuit: true };
    if (specifier.includes('bindings/github.com')) return { url: stub('bindings.mjs'), shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const assets = await import('./assets.js');
const bindings = await import('../../test/stubs/bindings.mjs');

test('assetFamilyForStep: every step label maps to its Go-emitted payload family', () => {
  // The wire values are the Go consts in mappackservice.go — all three
  // families emit spectra:asset-progress through the one shared emitter.
  assert.equal(assets.assetFamilyForStep('radar map packs'), 'map-packs');
  assert.equal(assets.assetFamilyForStep('equipment icons'), 'icons');
  assert.equal(assets.assetFamilyForStep('replay sounds'), 'sounds');
  // Unknown/empty step (before onStep fires, after the run ends) matches
  // no payload family → the renderers fall back to the indeterminate bar
  // (total 0 → StatusChip's animated bar, never a fabricated percentage).
  assert.equal(assets.assetFamilyForStep(''), '');
  assert.equal(assets.assetFamilyForStep('something else'), '');
});

test('extractAllAssets: fixed step order, dir forwarded, counts-only result', async () => {
  bindings.resetCalls();
  bindings.handlers.ExtractMapPacks = () => ({ maps: ['de_mirage', 'de_nuke'], errors: [] });
  bindings.handlers.ExtractIcons = () => ({ count: 120, note: '' });
  bindings.handlers.ExtractSounds = () => ({ count: 45, note: '' });

  const steps = [];
  const out = await assets.extractAllAssets({
    dir: '/games/cs2',
    onStep: (label) => steps.push(label),
  });

  assert.deepEqual(steps, ['radar map packs', 'equipment icons', 'replay sounds']);
  assert.deepEqual(
    bindings.calls.map((c) => c.method),
    ['ExtractMapPacks', 'ExtractIcons', 'ExtractSounds'],
  );
  for (const c of bindings.calls) assert.equal(c.args[0], '/games/cs2');
  assert.equal(out.msg, 'Extracted 2 map packs, 120 icons, 45 sounds.');
  assert.equal(out.error, '');
});

test('extractAllAssets: a failing family is aggregated, the rest still run', async () => {
  bindings.resetCalls();
  bindings.handlers.ExtractMapPacks = () => ({ maps: [], errors: ["de_mirage: decode failed"] });
  bindings.handlers.ExtractIcons = () => ({ count: 0, note: 'VPK unreadable' });
  bindings.handlers.ExtractSounds = () => ({ count: 5, note: '' });

  const out = await assets.extractAllAssets({ dir: '' });

  assert.deepEqual(
    bindings.calls.map((c) => c.method),
    ['ExtractMapPacks', 'ExtractIcons', 'ExtractSounds'],
  );
  assert.equal(out.msg, 'Extracted 5 sounds.');
  assert.equal(out.error, 'map packs: de_mirage: decode failed; icons: VPK unreadable.');
});
