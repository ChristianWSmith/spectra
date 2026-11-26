  import { metricStateTitle, metricPresentation, listMetrics, getProfile, DEFAULT_CARDS, composedSequence } from '../../builtinhelpers.js';
// shared.js — the presentation rules the Profile panels share. A panel reads
// its values through `spectra.metric()` (a MetricRead: state, value, rows),
// and this module maps one read onto what a cell shows: a value, the honest
// dash, or a state chip. NULL is a dash, never a zero (owner ruling 23); a
// live sweep on a metric shows as processing (lib/metricstate.js precedence).

// defaultCardDefs: the profile-scope metric definitions of the default selection
// (DEFAULT_CARDS.profile), in the default sequence. The Career cards and their
// read both take their names from it, so they cannot disagree.
export function defaultCardDefs(defs) {
  return composedSequence('profile', defs)
    .filter((e) => e.kind === 'metric' && DEFAULT_CARDS.profile.includes(e.name))
    .map((e) => e.def);
}

const NO_DATA_TITLE = 'no data for this player';

// liveState: the word a cell shows for its metric. A sweep running on the
// metric right now (the live progress feed, keyed by metric id) wins over
// the read's own state.
function liveState(def, read, progress) {
  if (def && progress && progress.has(def.id)) return 'processing';
  return read ? read.state : '';
}

// cell maps one value cell onto its presentation. `value` is the fresh
// number for this cell, or null when the fresh read has no row for it.
export function cell(def, read, progress, value) {
  const pres = metricPresentation(liveState(def, read, progress), value != null ? { value } : null, false);
  if (pres.kind === 'value') return { kind: 'value', value, title: def ? def.title || def.name : '' };
  if (pres.kind === 'nodata') return { kind: 'nodata', title: NO_DATA_TITLE };
  return { kind: 'chip', state: pres.state, title: metricStateTitle(pres.state, read ? read.error : '') };
}

// readCell is the cell of a whole-subject read (one value per player): the value
// is the read's own, and only a fresh read has one.
export function readCell(def, read, progress) {
  return cell(def, read, progress, read && read.state === 'fresh' ? read.value : null);
}

// emptyChip: a table with no rows shows the chip of the winning live state
// across its own metrics (processing, then failed, then behind). Null keeps
// the up-to-date empty text. `defs` and `reads` are Maps by metric name.
export function emptyChip(defs, reads, progress, names) {
  for (const state of ['processing', 'failed', 'behind']) {
    for (const n of names) {
      const def = defs.get(n);
      const read = reads.get(n);
      if (!def && !read) continue;
      if (liveState(def, read, progress) === state) return { state, def, read };
    }
  }
  return null;
}

// loadProfile reads the metric catalog and one player's profile together: the catalog
// names the cards, the profile carries the headline numbers.
export function loadProfile(spectra, sid) {
  return spectra.track(Promise.all([listMetrics(), getProfile(sid)]));
}

// loadSplit reads a split table's catalog and its seed metrics for the
// context's player: the catalog read, then loadSeeds over it. The three split
// panels (sides, maps, weapons) load through this one chain.
export function loadSplit(spectra, names) {
  return spectra.track(listMetrics()).then((rows) => loadSeeds(spectra, names, rows || []));
}

// loadSeeds reads the named metrics of a split table (sides, maps, weapons)
// for the context's player. A name the catalog does not carry is never read:
// its cells show the honest dash, not an error. Each read is one metric()
// call, so its dims come back in `rows`.
export async function loadSeeds(spectra, names, catalog) {
  const defs = new Map(catalog.filter((d) => d && names.includes(d.name)).map((d) => [d.name, d]));
  const found = [...defs.keys()];
  return { defs, reads: await spectra.readMetrics(found) };
}

// dimValue is one split cell's fresh number: the read's row for the dim,
// scaled to display (a percent seed stores the 0..1 fraction; the tables
// render 0..100). Null when the fresh read has no row for the dim.
export function dimValue(def, read, dim) {
  const row = read && read.rows ? read.rows.find((r) => r.dim === dim) : null;
  if (!row || row.value == null) return null;
  return def && def.format === 'percent' ? row.value * 100 : row.value;
}

// dimsOf is the union of the dims the fresh reads carry, in first-seen order.
export function dimsOf(reads, names) {
  const dims = new Set();
  for (const n of names) for (const r of reads.get(n)?.rows ?? []) if (r.dim) dims.add(r.dim);
  return [...dims];
}
