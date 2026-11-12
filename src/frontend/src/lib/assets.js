// assets.js — THE shared CS2 asset-extraction driver: the three-family
// sequence (radar map packs → equipment icons → replay sounds), the step
// labels the ONE progress widget (StatusChip) renders, the
// spectra:asset-progress family each step's payloads carry, and the
// aggregated outcome wording. Settings' CS2 assets section and the
// launch prompt (MapPackPrompt.svelte) both run it — one home for the
// step order, the per-family aggregation and the result message, so the
// two surfaces can never drift apart.
//
// All three extractors serialize on the Go side (mappack's extractMu),
// so a run started here simply queues behind Replay's background icon
// auto-extract or another surface's run. Valve IP stays local — see
// internal/mappack.
import { extractMapPacks, extractIcons, extractSounds, errText } from './services.js';

// The three families in extraction order. `label` is the step text the
// caller shows while the family runs; `family` is the payload family
// that step's extractor emits on spectra:asset-progress (mappackservice.go's
// shared emitter — all three emit now), which the renderers gate their
// determinate bar on through assetFamilyForStep; `failKey` prefixes that
// family's entry in the aggregated error; `noun` is the singular result
// word ("3 map packs", "1 icon").
const ASSET_FAMILIES = [
  {
    family: 'map-packs',
    label: 'radar map packs',
    failKey: 'map packs',
    noun: 'map pack',
    run: (dir) => extractMapPacks(dir),
    count: (out) => (out && out.maps ? out.maps.length : 0),
    errors: (out) => (out && out.errors) || [],
  },
  {
    family: 'icons',
    label: 'equipment icons',
    failKey: 'icons',
    noun: 'icon',
    run: (dir) => extractIcons(dir),
    count: (out) => (out && out.count) || 0,
    errors: (out) => (out && out.note ? [out.note] : []),
  },
  {
    family: 'sounds',
    label: 'replay sounds',
    failKey: 'sounds',
    noun: 'sound',
    run: (dir) => extractSounds(dir),
    count: (out) => (out && out.count) || 0,
    errors: (out) => (out && out.note ? [out.note] : []),
  },
];

// assetFamilyForStep maps a step label (what onStep fired before each
// awaited family) to the spectra:asset-progress family its payloads
// carry — THE step→family gate both renderers use, so the determinate
// bar only ever shows numbers for the family actually running: a stale
// payload from the previous step, or a concurrent run's payload for
// another family, never drives it. Unknown/empty step → '' (no family
// matches → the indeterminate bar).
export function assetFamilyForStep(label) {
  return ASSET_FAMILIES.find((f) => f.label === label)?.family || '';
}

// extractAllAssets runs the three extractions SEQUENTIALLY (one call
// into the shared Go lock at a time) under the caller's busy gate:
// onStep(label) fires before each family starts (the caller clears the
// label when the run ends), and every part is attempted even when an
// earlier one fails. Resolves with:
//   msg    — "Extracted 3 map packs, 120 icons, 45 sounds." ("" when
//            nothing succeeded), and
//   error  — the aggregated failure text ("" when every part succeeded),
//            or "Nothing extracted." when no family reported anything.
// The caller owns the busy flag, the progress subscription and the
// post-run refreshes — this function only sequences and aggregates.
export async function extractAllAssets({ dir = '', onStep = () => {} } = {}) {
  const done = [];
  const failed = [];
  for (const fam of ASSET_FAMILIES) {
    onStep(fam.label);
    try {
      const out = await fam.run(dir);
      const n = fam.count(out);
      const errs = fam.errors(out);
      if (n > 0) done.push(`${n} ${fam.noun}${n === 1 ? '' : 's'}`);
      if (errs.length) failed.push(`${fam.failKey}: ${errs[0]}`);
      else if (n === 0) failed.push(`${fam.failKey}: nothing extracted`);
    } catch (e) {
      failed.push(`${fam.failKey}: ${errText(e)}`);
    }
  }
  const msg = done.length ? `Extracted ${done.join(', ')}.` : '';
  const error = failed.length
    ? `${failed.join('; ')}.`
    : !done.length && !failed.length
      ? 'Nothing extracted.'
      : '';
  return { msg, error };
}
